import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const deviceAliasSchema = new mongoose.Schema({
  alias: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  deviceName: {
    type: String,
    required: true,
    trim: true
  },
  plugin: {
    type: String,
    required: true,
    default: 'govee',
    index: true
  },
  deviceId: {
    type: String,
    required: false
  },
  userId: {
    type: String,
    required: false,
    default: 'system'
  },
  metadata: {
    type: Object,
    default: {}
  },
  usageCount: {
    type: Number,
    default: 0
  },
  lastUsed: {
    type: Date,
    default: null
  },
  expirationDate: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

deviceAliasSchema.index({ plugin: 1, alias: 1 });

const aliasCache = new NodeCache({ stdTTL: 300 });

deviceAliasSchema.methods.recordUsage = async function() {
  this.usageCount++;
  this.lastUsed = new Date();
  await this.save();
};

deviceAliasSchema.statics.resolveAlias = async function(aliasName, plugin = 'govee') {
  const cacheKey = `${plugin}:${aliasName.toLowerCase().trim()}`;
  const cached = aliasCache.get(cacheKey);
  if (cached) {
    this.updateOne(
      { _id: cached._id },
      { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
    ).catch(err => logger.error('Error recording alias usage:', err));
    return cached.deviceName;
  }
  
  const alias = await this.findOne({ 
    alias: aliasName.toLowerCase().trim(),
    plugin: plugin 
  });
  
  if (alias) {
    aliasCache.set(cacheKey, {
      _id: alias._id,
      deviceName: alias.deviceName
    });
    alias.recordUsage().catch(err => logger.error('Error recording alias usage:', err));
    return alias.deviceName;
  }
  
  return null;
};

deviceAliasSchema.statics.resolveAliases = async function(aliasNames, plugin = 'govee') {
  const cacheResults = {};
  const dbQueries = [];
  const dbQueryAliases = [];

  aliasNames.forEach(aliasName => {
    const cacheKey = `${plugin}:${aliasName.toLowerCase().trim()}`;
    const cached = aliasCache.get(cacheKey);
    if (cached) {
      cacheResults[aliasName] = cached.deviceName;
    } else {
      dbQueries.push({ alias: aliasName.toLowerCase().trim(), plugin: plugin });
      dbQueryAliases.push(aliasName);
    }
  });

  if (dbQueries.length > 0) {
    try {
      const aliases = await retryOperation(() => this.find({ $or: dbQueries }), { retries: 3 });
      aliases.forEach(alias => {
        const cacheKey = `${plugin}:${alias.alias}`;
        aliasCache.set(cacheKey, {
          _id: alias._id,
          deviceName: alias.deviceName
        });
        cacheResults[alias.alias] = alias.deviceName;
        alias.recordUsage().catch(err => logger.error('Error recording alias usage:', err));
      });
    } catch (error) {
      logger.error('Error resolving aliases:', error);
    }
  }

  return cacheResults;
};

deviceAliasSchema.statics.setAlias = async function(aliasName, deviceName, plugin = 'govee', userId = 'system', expirationDate = null) {
  const cacheKey = `${plugin}:${aliasName.toLowerCase().trim()}`;

  const updateFields = {
    deviceName: deviceName,
    userId: userId,
    plugin: plugin,
    expirationDate: expirationDate
  };

  const result = await this.findOneAndUpdate(
    {
      alias: aliasName.toLowerCase().trim(),
      plugin: plugin
    },
    updateFields,
    {
      new: true,
      upsert: true
    }
  );
  
  aliasCache.del(cacheKey);
  
  return result;
};

deviceAliasSchema.statics.clearCache = function() {
  aliasCache.flushAll();
};

/**
 * Remove expired aliases from the database and cache.
 * Called by the scheduler (Agenda) — not self-scheduling to avoid circular imports.
 */
deviceAliasSchema.statics.cleanupExpiredAliases = async function() {
  try {
    const now = new Date();
    const expiredAliases = await this.find({
      expirationDate: { $ne: null, $lte: now }
    });

    if (expiredAliases.length > 0) {
      const idsToRemove = expiredAliases.map(alias => alias._id);
      await this.deleteMany({ _id: { $in: idsToRemove } });

      expiredAliases.forEach(alias => {
        const cacheKey = `${alias.plugin}:${alias.alias}`;
        aliasCache.del(cacheKey);
        logger.info(`Removed expired alias: ${alias.alias} for plugin: ${alias.plugin}`);
      });

      logger.info(`Cleaned up ${expiredAliases.length} expired device alias(es)`);
    }
  } catch (error) {
    logger.error('Error during cleanup of expired aliases:', error);
  }
};

export const DeviceAlias = mongoose.model('DeviceAlias', deviceAliasSchema);