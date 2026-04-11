import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';
import { jsonClone } from '../utils/jsonUtils.js';

/**
 * PluginSettings model with built-in caching using node-cache
 * 
 * Migration guide for existing code:
 * - Replace PluginSettings.findOne() with PluginSettings.getCached()
 * - Replace PluginSettings.findOneAndUpdate() with PluginSettings.setCached()
 * - Cache is automatically invalidated on updates
 * 
 * Example:
 *   const settings = await PluginSettings.getCached('email', 'notificationSettings');
 *   await PluginSettings.setCached('email', 'notificationSettings', newSettings);
 */

// Initialize cache with 5-minute default TTL
const settingsCache = new NodeCache({ 
  stdTTL: 300, // 5 minutes default
  checkperiod: 60, // Check for expired keys every minute
  useClones: false // Don't clone for performance
});

// Log cache statistics periodically
setInterval(() => {
  const stats = settingsCache.getStats();
  if (stats.keys > 0) {
    logger.debug(`PluginSettings cache stats: ${stats.keys} keys, ${stats.hits} hits, ${stats.misses} misses`);
  }
}, 300000); // Every 5 minutes

const pluginSettingsSchema = new mongoose.Schema({
  // Plugin identifier
  pluginName: {
    type: String,
    required: true,
    index: true
  },
  
  // Settings key
  settingsKey: {
    type: String,
    required: true
  },
  
  // Settings value (stored as JSON)
  settingsValue: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  
  // Metadata
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  },

  // Versioning
  version: {
    type: Number,
    default: 1
  },

  // History of changes
  history: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  }
}, {
  timestamps: true
});

// Create compound index for plugin and key
pluginSettingsSchema.index({ pluginName: 1, settingsKey: 1 }, { unique: true });

// Update the updatedAt field before saving
pluginSettingsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Clear cache on save
pluginSettingsSchema.post('save', function(doc) {
  const cacheKey = `${doc.pluginName}:${doc.settingsKey}`;
  settingsCache.del(cacheKey);
  logger.debug(`Cleared cache for ${cacheKey} after save`);
});

// Clear cache on update
pluginSettingsSchema.post('findOneAndUpdate', function(doc) {
  if (doc) {
    const cacheKey = `${doc.pluginName}:${doc.settingsKey}`;
    settingsCache.del(cacheKey);
    logger.debug(`Cleared cache for ${cacheKey} after update`);
  }
});

// Clear cache on delete
pluginSettingsSchema.post('findOneAndDelete', function(doc) {
  if (doc) {
    const cacheKey = `${doc.pluginName}:${doc.settingsKey}`;
    settingsCache.del(cacheKey);
    logger.debug(`Cleared cache for ${cacheKey} after delete`);
  }
});

/**
 * Get cached settings for a plugin
 * @param {string} pluginName - Plugin name
 * @param {string} settingsKey - Settings key
 * @param {number} ttl - Optional TTL in seconds (default: 300)
 * @returns {Promise<any>} Settings value or null
 */
pluginSettingsSchema.statics.getCached = async function(pluginName, settingsKey, ttl = 300) {
  const cacheKey = `${pluginName}:${settingsKey}`;
  
  // Check cache first
  const cached = settingsCache.get(cacheKey);
  if (cached !== undefined) {
    logger.debug(`Cache hit for ${cacheKey}`);
    return cached;
  }
  
  // Load from database
  logger.debug(`Cache miss for ${cacheKey}, loading from database`);
  const doc = await this.findOne({ pluginName, settingsKey });
  
  if (doc) {
    // Store in cache with custom or default TTL
    settingsCache.set(cacheKey, doc.settingsValue, ttl);
    return doc.settingsValue;
  }
  
  return null;
};

/**
 * Set cached settings for a plugin
 * @param {string} pluginName - Plugin name
 * @param {string} settingsKey - Settings key
 * @param {any} settingsValue - Settings value
 * @returns {Promise<any>} Updated document
 */
pluginSettingsSchema.statics.setCached = async function(pluginName, settingsKey, settingsValue) {
  const doc = await this.findOne({ pluginName, settingsKey });

  if (doc) {
    // Save current state to history
    const historyEntry = {
      version: doc.version,
      settingsValue: jsonClone(doc.settingsValue),
      updatedAt: doc.updatedAt
    };
    doc.history.push(historyEntry);

    // Update document
    doc.settingsValue = settingsValue;
    doc.version += 1;
    doc.updatedAt = new Date();
    await doc.save();
  } else {
    // Create new document
    await this.create({
      pluginName,
      settingsKey,
      settingsValue,
      version: 1
    });
  }

  // Cache will be cleared by the post hook
  return doc;
};

/**
 * Rollback to a specific version of settings
 * @param {string} pluginName - Plugin name
 * @param {string} settingsKey - Settings key
 * @param {number} version - Version number to rollback to
 * @returns {Promise<any>} Rolled back document
 */
pluginSettingsSchema.statics.rollbackToVersion = async function(pluginName, settingsKey, version) {
  const doc = await this.findOne({ pluginName, settingsKey });

  if (!doc) {
    throw new Error(`No settings found for plugin: ${pluginName}, key: ${settingsKey}`);
  }

  const historyEntry = doc.history.find(entry => entry.version === version);

  if (!historyEntry) {
    throw new Error(`Version ${version} not found in history for plugin: ${pluginName}, key: ${settingsKey}`);
  }

  // Rollback to the specified version
  doc.settingsValue = historyEntry.settingsValue;
  doc.version = historyEntry.version;
  doc.updatedAt = new Date();
  await doc.save();

  // Cache will be cleared by the post hook
  return doc;
};

/**
 * Get history of settings changes
 * @param {string} pluginName - Plugin name
 * @param {string} settingsKey - Settings key
 * @returns {Promise<Array>} History of changes
 */
pluginSettingsSchema.statics.getHistory = async function(pluginName, settingsKey) {
  const doc = await this.findOne({ pluginName, settingsKey });

  if (!doc) {
    throw new Error(`No settings found for plugin: ${pluginName}, key: ${settingsKey}`);
  }

  return doc.history;
};

/**
 * Compare two versions of settings and resolve conflicts
 * @param {string} pluginName - Plugin name
 * @param {string} settingsKey - Settings key
 * @param {number} version1 - First version number
 * @param {number} version2 - Second version number
 * @returns {Promise<object>} Comparison result and resolution options
 */
pluginSettingsSchema.statics.compareAndResolveVersions = async function(pluginName, settingsKey, version1, version2) {
  const doc = await this.findOne({ pluginName, settingsKey });

  if (!doc) {
    throw new Error(`No settings found for plugin: ${pluginName}, key: ${settingsKey}`);
  }

  const entry1 = doc.history.find(entry => entry.version === version1);
  const entry2 = doc.history.find(entry => entry.version === version2);

  if (!entry1 || !entry2) {
    throw new Error(`One or both versions not found in history for plugin: ${pluginName}, key: ${settingsKey}`);
  }

  // Compare settings values
  const differences = this.calculateDifferences(entry1.settingsValue, entry2.settingsValue);

  return {
    differences,
    resolutionOptions: {
      keepVersion1: () => this.rollbackToVersion(pluginName, settingsKey, version1),
      keepVersion2: () => this.rollbackToVersion(pluginName, settingsKey, version2),
      merge: (mergeFunction) => this.mergeVersions(pluginName, settingsKey, entry1, entry2, mergeFunction)
    }
  };
};

/**
 * Calculate differences between two settings values
 * @param {object} value1 - First settings value
 * @param {object} value2 - Second settings value
 * @returns {object} Differences between the two values
 */
pluginSettingsSchema.statics.calculateDifferences = function(value1, value2) {
  // Implement a real difference calculation logic
  // For simplicity, using JSON.stringify comparison (not suitable for complex objects)
  const diff = {};
  for (const key in value1) {
    if (value1[key] !== value2[key]) {
      diff[key] = { from: value1[key], to: value2[key] };
    }
  }
  for (const key in value2) {
    if (!(key in value1)) {
      diff[key] = { from: undefined, to: value2[key] };
    }
  }
  return diff;
};

/**
 * Merge two versions of settings using a custom merge function
 * @param {string} pluginName - Plugin name
 * @param {string} settingsKey - Settings key
 * @param {object} entry1 - First version entry
 * @param {object} entry2 - Second version entry
 * @param {function} mergeFunction - Custom merge function
 * @returns {Promise<any>} Merged document
 */
pluginSettingsSchema.statics.mergeVersions = async function(pluginName, settingsKey, entry1, entry2, mergeFunction) {
  const mergedValue = mergeFunction(entry1.settingsValue, entry2.settingsValue);
  return this.setCached(pluginName, settingsKey, mergedValue);
};

/**
 * Clear cache for specific plugin or all
 * @param {string} pluginName - Optional plugin name
 */
pluginSettingsSchema.statics.clearCache = function(pluginName) {
  if (pluginName) {
    const keys = settingsCache.keys();
    const pluginKeys = keys.filter(key => key.startsWith(`${pluginName}:`));
    pluginKeys.forEach(key => settingsCache.del(key));
    logger.info(`Cleared ${pluginKeys.length} cache entries for plugin ${pluginName}`);
  } else {
    settingsCache.flushAll();
    logger.info('Cleared all plugin settings cache');
  }
};

/**
 * Get cache statistics
 * @returns {object} Cache statistics
 */
pluginSettingsSchema.statics.getCacheStats = function() {
  return settingsCache.getStats();
};

export const PluginSettings = mongoose.model('PluginSettings', pluginSettingsSchema);