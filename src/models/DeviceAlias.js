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

// Positive cache for resolved aliases
const aliasCache = new NodeCache({ stdTTL: 300 });
// Negative cache for misses — prevents thundering-herd hits on absent aliases
const aliasNegativeCache = new NodeCache({ stdTTL: 60 });
// In-flight promise dedup so concurrent resolves for the same alias share a query
const inFlight = new Map();

deviceAliasSchema.methods.recordUsage = async function() {
  this.usageCount++;
  this.lastUsed = new Date();
  await this.save();
};

deviceAliasSchema.statics.resolveAlias = async function(aliasName, plugin = 'govee') {
  const normalized = aliasName.toLowerCase().trim();
  const cacheKey = `${plugin}:${normalized}`;

  const cached = aliasCache.get(cacheKey);
  if (cached) {
    this.updateOne(
      { _id: cached._id },
      { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
    ).catch(err => logger.error('Error recording alias usage:', err));
    return cached.deviceName;
  }

  // Negative cache: known-missing aliases short-circuit immediately
  if (aliasNegativeCache.get(cacheKey)) return null;

  // In-flight dedup: concurrent resolves for the same key share one DB query
  if (inFlight.has(cacheKey)) return await inFlight.get(cacheKey);

  const promise = (async () => {
    try {
      const alias = await retryOperation(
        () => this.findOne({ alias: normalized, plugin }),
        { retries: 3 }
      );
      if (alias) {
        aliasCache.set(cacheKey, { _id: alias._id, deviceName: alias.deviceName });
        alias.recordUsage().catch(err => logger.error('Error recording alias usage:', err));
        return alias.deviceName;
      }
      aliasNegativeCache.set(cacheKey, true);
      return null;
    } catch (error) {
      logger.error('Error resolving alias:', error);
      return null; // don't negative-cache on error — allow retry
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return await promise;
};

deviceAliasSchema.statics.resolveAliases = async function(aliasNames, plugin = 'govee') {
  const results = {};
  const toQuery = [];
  const queryByNormalized = new Map(); // normalized → [originalName, ...]

  // First pass: positive cache, negative cache, build query for the rest
  for (const aliasName of aliasNames) {
    const normalized = aliasName.toLowerCase().trim();
    const cacheKey = `${plugin}:${normalized}`;

    const cached = aliasCache.get(cacheKey);
    if (cached) {
      results[aliasName] = cached.deviceName;
      this.updateOne(
        { _id: cached._id },
        { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
      ).catch(err => logger.error('Error recording alias usage:', err));
      continue;
    }
    if (aliasNegativeCache.get(cacheKey)) {
      results[aliasName] = null;
      continue;
    }
    toQuery.push({ alias: normalized, plugin });
    if (!queryByNormalized.has(normalized)) queryByNormalized.set(normalized, []);
    queryByNormalized.get(normalized).push(aliasName);
  }

  if (toQuery.length > 0) {
    try {
      const aliases = await retryOperation(() => this.find({ $or: toQuery }), { retries: 3 });
      const foundNormalized = new Set();
      for (const alias of aliases) {
        foundNormalized.add(alias.alias);
        const cacheKey = `${plugin}:${alias.alias}`;
        aliasCache.set(cacheKey, { _id: alias._id, deviceName: alias.deviceName });
        for (const originalName of queryByNormalized.get(alias.alias) || []) {
          results[originalName] = alias.deviceName;
        }
        alias.recordUsage().catch(err => logger.error('Error recording alias usage:', err));
      }
      // Negative-cache any normalized aliases that weren't found
      for (const [normalized, originalNames] of queryByNormalized.entries()) {
        if (!foundNormalized.has(normalized)) {
          aliasNegativeCache.set(`${plugin}:${normalized}`, true);
          for (const originalName of originalNames) {
            if (!(originalName in results)) results[originalName] = null;
          }
        }
      }
    } catch (error) {
      logger.error('Error resolving aliases:', error);
      // On error, populate nulls without negative-caching so callers can retry next time
      for (const originalNames of queryByNormalized.values()) {
        for (const originalName of originalNames) {
          if (!(originalName in results)) results[originalName] = null;
        }
      }
    }
  }

  return results;
};

deviceAliasSchema.statics.setAlias = async function(aliasName, deviceName, plugin = 'govee', userId = 'system', expirationDate = null) {
  const cacheKey = `${plugin}:${aliasName.toLowerCase().trim()}`;

  const updateFields = {
    deviceName: deviceName,
    userId: userId,
    plugin: plugin,
    expirationDate: expirationDate
  };

  const result = await retryOperation(() => this.findOneAndUpdate(
    {
      alias: aliasName.toLowerCase().trim(),
      plugin: plugin
    },
    updateFields,
    {
      new: true,
      upsert: true
    }
  ), { retries: 3 });
  
  aliasCache.del(cacheKey);
  aliasNegativeCache.del(cacheKey);

  return result;
};

deviceAliasSchema.statics.clearCache = function() {
  aliasCache.flushAll();
  aliasNegativeCache.flushAll();
};

/**
 * Remove expired aliases from the database and cache.
 * Called by the scheduler (Agenda) — not self-scheduling to avoid circular imports.
 */
deviceAliasSchema.statics.cleanupExpiredAliases = async function() {
  try {
    const now = new Date();
    const expiredAliases = await retryOperation(() => this.find({
      expirationDate: { $ne: null, $lte: now }
    }), { retries: 3 });

    if (expiredAliases.length > 0) {
      const idsToRemove = expiredAliases.map(alias => alias._id);
      await this.deleteMany({ _id: { $in: idsToRemove } });

      expiredAliases.forEach(alias => {
        const cacheKey = `${alias.plugin}:${alias.alias}`;
        aliasCache.del(cacheKey);
        aliasNegativeCache.del(cacheKey);
        logger.info(`Removed expired alias: ${alias.alias} for plugin: ${alias.plugin}`);
      });

      logger.info(`Cleaned up ${expiredAliases.length} expired device alias(es)`);
    }
  } catch (error) {
    logger.error('Error during cleanup of expired aliases:', error);
  }
};

export const DeviceAlias = mongoose.model('DeviceAlias', deviceAliasSchema);
