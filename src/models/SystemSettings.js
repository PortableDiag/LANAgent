import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const cache = new NodeCache({ stdTTL: 300, checkperiod: 320 });

const systemSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  description: {
    type: String
  },
  category: {
    type: String,
    default: 'general'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

const systemSettingsHistorySchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    index: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  version: {
    type: Number,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Simple pre-save to update timestamp
systemSettingsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Get a setting value by key, utilizing cache for performance
 * @param {String} key - The key of the setting
 * @param {Mixed} defaultValue - The default value if setting is not found
 * @returns {Mixed} - The value of the setting or defaultValue
 */
systemSettingsSchema.statics.getSetting = async function(key, defaultValue = null) {
  try {
    const cachedValue = cache.get(key);
    if (cachedValue !== undefined) {
      return cachedValue;
    }
    const setting = await this.findOne({ key });
    if (setting) {
      cache.set(key, setting.value);
      return setting.value;
    }
    return defaultValue;
  } catch (error) {
    logger.error(`Error getting setting ${key}:`, error);
    return defaultValue;
  }
};

/**
 * Set a setting value by key and update cache
 * @param {String} key - The key of the setting
 * @param {Mixed} value - The value to set
 * @param {String} description - Description of the setting
 * @param {String} category - Category of the setting
 * @returns {Object} - The updated or created setting
 */
systemSettingsSchema.statics.setSetting = async function(key, value, description = null, category = 'general') {
  try {
    const existingSetting = await this.findOne({ key });
    
    if (existingSetting) {
      const SystemSettingsHistory = mongoose.model('SystemSettingsHistory');
      const version = await SystemSettingsHistory.countDocuments({ key }) + 1;
      
      await SystemSettingsHistory.create({
        key: existingSetting.key,
        value: existingSetting.value,
        version: version,
        timestamp: new Date()
      });
    }
    
    const setting = await this.findOneAndUpdate(
      { key },
      { 
        value, 
        description: description || `Setting: ${key}`,
        category,
        updatedAt: new Date()
      },
      { 
        upsert: true, 
        new: true,
        setDefaultsOnInsert: true
      }
    );
    cache.set(key, value);
    return setting;
  } catch (error) {
    logger.error(`Error setting ${key}:`, error);
    throw error;
  }
};

/**
 * Get version history for a setting
 * @param {String} key - The key of the setting
 * @returns {Array} - Array of version history
 */
systemSettingsSchema.statics.getSettingHistory = async function(key) {
  try {
    const SystemSettingsHistory = mongoose.model('SystemSettingsHistory');
    const history = await SystemSettingsHistory.find({ key }).sort({ version: -1 });
    return history;
  } catch (error) {
    logger.error(`Error getting history for ${key}:`, error);
    return [];
  }
};

/**
 * Rollback a setting to a previous version
 * @param {String} key - The key of the setting to rollback
 * @param {Number} version - The version number to rollback to
 * @returns {Object} - The rolled back setting
 */
systemSettingsSchema.statics.rollbackSetting = async function(key, version) {
  try {
    const history = await SystemSettingsHistory.findOne({ key, version });
    if (!history) {
      throw new Error(`No history found for key ${key} with version ${version}`);
    }
    const setting = await this.findOneAndUpdate(
      { key },
      { 
        value: history.value,
        updatedAt: new Date()
      },
      { 
        new: true
      }
    );
    cache.set(key, history.value);
    return setting;
  } catch (error) {
    logger.error(`Error rolling back setting ${key} to version ${version}:`, error);
    throw error;
  }
};

/**
 * Bulk update system settings
 * @param {Array} settingsArray - Array of settings objects to update
 * @returns {Array} - Array of updated settings
 */
systemSettingsSchema.statics.bulkUpdateSettings = async function(settingsArray) {
  const results = [];
  for (const setting of settingsArray) {
    const { key, value, description, category } = setting;
    try {
      const updatedSetting = await retryOperation(() => this.setSetting(key, value, description, category), { retries: 3 });
      results.push(updatedSetting);
    } catch (error) {
      logger.error(`Failed to update setting ${key}:`, error);
    }
  }
  return results;
};

/**
 * Export all system settings in a structured JSON format
 * @returns {Object} - All settings organized by category
 */
systemSettingsSchema.statics.exportSettings = async function() {
  try {
    const settings = await this.find({});
    const exported = {};
    
    settings.forEach(setting => {
      if (!exported[setting.category]) {
        exported[setting.category] = {};
      }
      exported[setting.category][setting.key] = {
        value: setting.value,
        description: setting.description,
        createdAt: setting.createdAt,
        updatedAt: setting.updatedAt
      };
    });
    
    return exported;
  } catch (error) {
    logger.error('Error exporting settings:', error);
    throw error;
  }
};

/**
 * Import system settings from a structured JSON format
 * @param {Object} settingsData - Settings data organized by category
 * @param {String} strategy - Import strategy: 'merge' or 'replace'
 * @returns {Object} - Import result with counts
 */
systemSettingsSchema.statics.importSettings = async function(settingsData, strategy = 'merge') {
  try {
    if (!settingsData || typeof settingsData !== 'object' || Array.isArray(settingsData)) {
      throw new Error('settingsData must be an object keyed by category');
    }
    if (!['merge', 'replace'].includes(strategy)) {
      throw new Error(`Unknown import strategy: ${strategy}`);
    }

    const settingsToImport = [];
    for (const [category, settings] of Object.entries(settingsData)) {
      for (const [key, settingData] of Object.entries(settings)) {
        settingsToImport.push({
          key,
          value: settingData.value,
          description: settingData.description,
          category
        });
      }
    }

    if (strategy === 'replace') {
      // Clear all existing settings (only after the payload parsed cleanly)
      await this.deleteMany({});
      cache.flushAll();
    }

    // bulkUpdateSettings swallows per-key failures and returns successes only
    const results = await this.bulkUpdateSettings(settingsToImport);

    return {
      success: true,
      processed: results.length,
      skipped: settingsToImport.length - results.length,
      errors: []
    };
  } catch (error) {
    logger.error('Error importing settings:', error);
    throw error;
  }
};

export const SystemSettingsHistory = mongoose.model('SystemSettingsHistory', systemSettingsHistorySchema);
export const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);
