import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const userPreferenceSchema = new mongoose.Schema({
  // Plugin name
  plugin: {
    type: String,
    required: true,
    index: true
  },
  
  // User identifier (could be userId, sessionId, etc.)
  userId: {
    type: String,
    required: true,
    index: true
  },
  
  // Preference category
  category: {
    type: String,
    required: true,
    index: true
  },
  
  // Preference data (flexible structure)
  preferences: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  
  // Metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },

  // Version tracking for preferences
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

// Compound index for efficient lookups
userPreferenceSchema.index({ plugin: 1, userId: 1, category: 1 }, { unique: true });

// Historical changes schema
const userPreferenceHistorySchema = new mongoose.Schema({
  plugin: String,
  userId: String,
  category: String,
  preferences: Map,
  version: Number,
  changedAt: {
    type: Date,
    default: Date.now
  }
});

const UserPreferenceHistory = mongoose.model('UserPreferenceHistory', userPreferenceHistorySchema);

// Static method to get preferences
userPreferenceSchema.statics.getPreferences = async function(plugin, userId, category) {
  try {
    const pref = await this.findOne({ plugin, userId, category });
    return pref ? pref.preferences : new Map();
  } catch (error) {
    logger.error('Error getting preferences:', error);
    return new Map();
  }
};

// Static method to set preferences
userPreferenceSchema.statics.setPreferences = async function(plugin, userId, category, preferences) {
  try {
    const currentPref = await this.findOne({ plugin, userId, category });
    if (currentPref) {
      await UserPreferenceHistory.create({
        plugin,
        userId,
        category,
        preferences: currentPref.preferences,
        version: currentPref.version
      });
    }
    const result = await this.findOneAndUpdate(
      { plugin, userId, category },
      {
        preferences,
        $inc: { version: 1 },
        $set: { updatedAt: new Date() }
      },
      { upsert: true, new: true }
    );
    return result;
  } catch (error) {
    logger.error('Error setting preferences:', error);
    throw error;
  }
};

/**
 * Retrieve the history of changes for a specific user's preferences.
 * @param {String} plugin - The plugin name.
 * @param {String} userId - The user identifier.
 * @param {String} category - The preference category.
 * @returns {Array} - An array of historical preference changes.
 */
userPreferenceSchema.statics.getPreferenceHistory = async function(plugin, userId, category) {
  try {
    const history = await UserPreferenceHistory.find({ plugin, userId, category }).sort({ changedAt: -1 });
    return history;
  } catch (error) {
    logger.error('Error retrieving preference history:', error);
    throw error;
  }
};

/**
 * Rollback preferences to a specific version.
 * @param {String} plugin - The plugin name.
 * @param {String} userId - The user identifier.
 * @param {String} category - The preference category.
 * @param {Number} targetVersion - The version to rollback to.
 * @returns {Object} - The updated preferences document.
 */
userPreferenceSchema.statics.rollbackPreferences = async function(plugin, userId, category, targetVersion) {
  try {
    const historyEntry = await UserPreferenceHistory.findOne({ plugin, userId, category, version: targetVersion });
    if (!historyEntry) {
      throw new Error(`No history entry found for version ${targetVersion}`);
    }

    const result = await this.findOneAndUpdate(
      { plugin, userId, category },
      {
        preferences: historyEntry.preferences,
        version: targetVersion,
        $set: { updatedAt: new Date() }
      },
      { new: true }
    );

    return result;
  } catch (error) {
    logger.error('Error rolling back preferences:', error);
    throw error;
  }
};

const UserPreference = mongoose.model('UserPreference', userPreferenceSchema);

export default UserPreference;
