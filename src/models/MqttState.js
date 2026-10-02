import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

/**
 * MQTT State Store
 * Stores the latest state for each topic
 * Provides fast lookups for current device states
 */
const mqttStateSchema = new mongoose.Schema({
  // Topic path (unique key)
  topic: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Associated broker
  brokerId: {
    type: String,
    required: true,
    index: true
  },

  // Associated device (if known)
  deviceId: {
    type: String,
    sparse: true,
    index: true
  },

  // Current payload
  payload: {
    raw: String,              // Raw string payload
    parsed: mongoose.Schema.Types.Mixed,  // Parsed JSON (if applicable)
    type: { type: String, enum: ['string', 'json', 'number', 'boolean', 'binary'], default: 'string' }
  },

  // QoS level of last message
  qos: {
    type: Number,
    enum: [0, 1, 2],
    default: 0
  },

  // Retain flag
  retained: {
    type: Boolean,
    default: false
  },

  // Timestamps
  receivedAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  // Previous value (for change detection)
  previousPayload: {
    raw: String,
    parsed: mongoose.Schema.Types.Mixed,
    changedAt: Date
  },

  // Statistics
  stats: {
    updateCount: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    changeCount: { type: Number, default: 0 }  // Times the value actually changed
  },

  // Metadata extracted from topic
  topicMetadata: {
    segments: [String],       // Topic split by /
    baseTopic: String,        // First segment
    leafTopic: String         // Last segment
  }
});

// Pre-save hook to parse topic metadata
mqttStateSchema.pre('save', function(next) {
  if (this.topic) {
    const segments = this.topic.split('/');
    this.topicMetadata = {
      segments,
      baseTopic: segments[0],
      leafTopic: segments[segments.length - 1]
    };
  }
  next();
});

// Indexes for efficient queries
mqttStateSchema.index({ 'topicMetadata.baseTopic': 1 });
mqttStateSchema.index({ brokerId: 1, receivedAt: -1 });
mqttStateSchema.index({ deviceId: 1, receivedAt: -1 });

// Initialize cache with configuration from environment variables
const envSize = parseInt(process.env.MQTT_PATTERN_CACHE_SIZE, 10);
const envTtl = parseInt(process.env.MQTT_PATTERN_CACHE_TTL, 10);
const CACHE_SIZE = Number.isFinite(envSize) ? envSize : 1000;
const CACHE_TTL = Number.isFinite(envTtl) ? envTtl : 300; // 5 minutes; 0 = no expiry

// Create cache instance for pattern queries
const patternCache = new NodeCache({
  stdTTL: CACHE_TTL,
  maxKeys: CACHE_SIZE,
  checkperiod: 60, // Check for expired keys every minute
  useClones: false // Mongoose documents must not be deep-cloned
});

// Cache statistics tracking
let cacheHits = 0;
let cacheMisses = 0;

// Static method to update state with change tracking
mqttStateSchema.statics.updateState = async function(topic, brokerId, payload, options = {}) {
  const { qos = 0, retained = false, deviceId = null } = options;

  // Parse payload
  let parsed = null;
  let payloadType = 'string';
  const raw = typeof payload === 'string' ? payload : payload.toString();

  try {
    parsed = JSON.parse(raw);
    payloadType = 'json';
  } catch {
    // Not JSON, check other types
    if (!isNaN(raw) && raw.trim() !== '') {
      parsed = parseFloat(raw);
      payloadType = 'number';
    } else if (raw === 'true' || raw === 'false') {
      parsed = raw === 'true';
      payloadType = 'boolean';
    }
  }

  const now = new Date();

  // Find existing state
  const existing = await this.findOne({ topic });

  if (existing) {
    // Check if value changed
    const valueChanged = existing.payload.raw !== raw;

    const update = {
      payload: { raw, parsed, type: payloadType },
      qos,
      retained,
      receivedAt: now,
      $inc: { 'stats.updateCount': 1 }
    };

    if (valueChanged) {
      update.previousPayload = {
        raw: existing.payload.raw,
        parsed: existing.payload.parsed,
        changedAt: existing.receivedAt
      };
      update.$inc['stats.changeCount'] = 1;
    }

    if (deviceId) {
      update.deviceId = deviceId;
    }

    const result = await this.findOneAndUpdate({ topic }, update, { new: true });
    
    // Invalidate cache for this topic's patterns
    invalidateTopicPatterns(topic);
    
    return result;
  } else {
    // Create new state
    const result = await this.create({
      topic,
      brokerId,
      deviceId,
      payload: { raw, parsed, type: payloadType },
      qos,
      retained,
      receivedAt: now,
      stats: {
        updateCount: 1,
        firstSeenAt: now,
        changeCount: 0
      }
    });
    
    // Invalidate cache for this topic's patterns
    invalidateTopicPatterns(topic);
    
    return result;
  }
};

// Helper function to invalidate cached patterns for a topic
function invalidateTopicPatterns(topic) {
  // Get all keys (patterns) currently in cache
  const keys = patternCache.keys();
  
  // For each pattern, check if this topic would match it
  for (const pattern of keys) {
    try {
      // Convert MQTT wildcard pattern to regex
      const regexPattern = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // Escape regex chars
        .replace(/\\\+/g, '[^/]+')               // + = single level
        .replace(/\\#/g, '.*');                  // # = multi level
      
      const regex = new RegExp(`^${regexPattern}$`);
      
      // If topic matches pattern, invalidate the cache entry
      if (regex.test(topic)) {
        patternCache.del(pattern);
        logger.debug(`Invalidated cache for pattern: ${pattern} due to topic update: ${topic}`);
      }
    } catch (error) {
      logger.warn(`Failed to check pattern invalidation for ${pattern}: ${error.message}`);
    }
  }
}

// Static method to get states by topic pattern with caching
mqttStateSchema.statics.findByPattern = async function(pattern) {
  // Check if result is cached
  const cachedResult = patternCache.get(pattern);
  if (cachedResult !== undefined) {
    cacheHits++;
    logger.debug(`Cache HIT for pattern: ${pattern}`);
    return cachedResult;
  }

  cacheMisses++;
  logger.debug(`Cache MISS for pattern: ${pattern}`);

  // Convert MQTT wildcard pattern to regex
  // + matches single level, # matches multiple levels
  const regexPattern = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // Escape regex chars
    .replace(/\\\+/g, '[^/]+')                // + = single level
    .replace(/\\#/g, '.*');                   // # = multi level

  // Perform the query with retry logic
  const results = await retryOperation(
    () => this.find({ topic: { $regex: `^${regexPattern}$` } }),
    { retries: 3 }
  );

  // Cache the result (set() throws ECACHEFULL at maxKeys — never fail the read for that)
  try {
    patternCache.set(pattern, results);
    logger.debug(`Cached results for pattern: ${pattern} (${results.length} items)`);
  } catch (error) {
    logger.debug(`Skipped caching pattern ${pattern}: ${error.message}`);
  }

  return results;
};

/**
 * Find state documents within an age range, ordered from freshest to stalest.
 *
 * maxAgeMs limits results to states received no earlier than that many
 * milliseconds ago. minAgeMs limits results to states received at least that
 * many milliseconds ago. Supplying both creates a bounded age window.
 *
 * @param {Object} options Query options
 * @param {string} [options.brokerId] Restrict results to a broker
 * @param {string} [options.deviceId] Restrict results to a device
 * @param {number} [options.maxAgeMs] Maximum permitted state age
 * @param {number} [options.minAgeMs] Minimum permitted state age
 * @param {number} [options.limit=100] Maximum number of documents to return (capped at 1000)
 * @param {string} [options.topicPrefix] Restrict results to topics with this prefix
 * @returns {Promise<Array>} Matching MQTT state documents
 */
mqttStateSchema.statics.findByFreshness = async function(options = {}) {
  const {
    brokerId,
    deviceId,
    maxAgeMs,
    minAgeMs,
    limit,
    topicPrefix = options.prefix
  } = options;

  const query = {};
  const now = Date.now();

  if (brokerId !== undefined && brokerId !== null) {
    query.brokerId = brokerId;
  }

  if (deviceId !== undefined && deviceId !== null) {
    query.deviceId = deviceId;
  }

  if (topicPrefix !== undefined && topicPrefix !== null) {
    if (typeof topicPrefix !== 'string') {
      throw new TypeError('topicPrefix must be a string');
    }

    query.topic = {
      $regex: `^${topicPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    };
  }

  const hasMaxAge = maxAgeMs !== undefined && maxAgeMs !== null;
  const hasMinAge = minAgeMs !== undefined && minAgeMs !== null;

  if (hasMaxAge && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)) {
    throw new TypeError('maxAgeMs must be a non-negative finite number');
  }

  if (hasMinAge && (!Number.isFinite(minAgeMs) || minAgeMs < 0)) {
    throw new TypeError('minAgeMs must be a non-negative finite number');
  }

  if (hasMaxAge || hasMinAge) {
    query.receivedAt = {};

    if (hasMaxAge) {
      query.receivedAt.$gte = new Date(now - maxAgeMs);
    }

    if (hasMinAge) {
      query.receivedAt.$lte = new Date(now - minAgeMs);
    }
  }

  // Bounded by default: mongoose treats limit(0) as "no limit", so 0 is rejected.
  const resultLimit = limit === undefined || limit === null ? 100 : limit;
  if (!Number.isInteger(resultLimit) || resultLimit < 1) {
    throw new TypeError('limit must be a positive integer');
  }

  // Build the query inside the retry: a mongoose Query cannot be executed twice.
  return retryOperation(
    () => this.find(query).sort({ receivedAt: -1 }).limit(Math.min(resultLimit, 1000)),
    { retries: 3 }
  );
};

/**
 * Summarize fresh and stale state counts grouped by broker or device.
 *
 * States newer than maxAgeMs are fresh; all older states are stale.
 * By default, freshness is measured against a five-minute threshold.
 *
 * @param {Object} options Aggregation options
 * @param {string} [options.groupBy='broker'] Group results by broker or device
 * @param {number} [options.maxAgeMs=300000] Freshness threshold in milliseconds
 * @param {string} [options.brokerId] Restrict results to a broker
 * @param {string} [options.deviceId] Restrict results to a device
 * @param {string} [options.topicPrefix] Restrict results to topics with this prefix
 * @returns {Promise<Array>} Fresh, stale, and total counts by group
 */
mqttStateSchema.statics.getFreshnessSummary = async function(options = {}) {
  const {
    groupBy = 'broker',
    maxAgeMs = 5 * 60 * 1000,
    brokerId,
    deviceId,
    topicPrefix = options.prefix
  } = options;

  if (groupBy !== 'broker' && groupBy !== 'device') {
    throw new TypeError('groupBy must be either "broker" or "device"');
  }

  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError('maxAgeMs must be a non-negative finite number');
  }

  const match = {};

  if (brokerId !== undefined && brokerId !== null) {
    match.brokerId = brokerId;
  }

  if (deviceId !== undefined && deviceId !== null) {
    match.deviceId = deviceId;
  }

  if (topicPrefix !== undefined && topicPrefix !== null) {
    if (typeof topicPrefix !== 'string') {
      throw new TypeError('topicPrefix must be a string');
    }

    match.topic = {
      $regex: `^${topicPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    };
  }

  const freshSince = new Date(Date.now() - maxAgeMs);
  const groupField = groupBy === 'broker' ? '$brokerId' : '$deviceId';

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: groupField,
        fresh: {
          $sum: {
            $cond: [{ $gte: ['$receivedAt', freshSince] }, 1, 0]
          }
        },
        stale: {
          $sum: {
            $cond: [{ $lt: ['$receivedAt', freshSince] }, 1, 0]
          }
        },
        total: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ];

  return retryOperation(() => this.aggregate(pipeline), { retries: 3 });
};

// Static method to get cache statistics
mqttStateSchema.statics.getCacheStats = function() {
  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: cacheHits + cacheMisses > 0 ? (cacheHits / (cacheHits + cacheMisses)) * 100 : 0,
    cacheSize: patternCache.keys().length,
    maxCacheSize: CACHE_SIZE,
    ttl: CACHE_TTL
  };
};

// Static method to clear the pattern cache
mqttStateSchema.statics.clearPatternCache = function() {
  const itemCount = patternCache.keys().length;
  patternCache.flushAll();
  cacheHits = 0;
  cacheMisses = 0;
  logger.info(`Cleared MQTT pattern cache (${itemCount} items)`);
  return { clearedItems: itemCount };
};

// Static method for batch updates (high-throughput scenarios)
mqttStateSchema.statics.batchUpdateStates = async function(updates) {
  const bulkOps = updates.map(update => {
    const { topic, brokerId, payload, options = {} } = update;
    const { qos = 0, retained = false, deviceId = null } = options;

    // Parse payload
    let parsed = null;
    let payloadType = 'string';
    const raw = typeof payload === 'string' ? payload : payload.toString();

    try {
      parsed = JSON.parse(raw);
      payloadType = 'json';
    } catch {
      if (!isNaN(raw) && raw.trim() !== '') {
        parsed = parseFloat(raw);
        payloadType = 'number';
      } else if (raw === 'true' || raw === 'false') {
        parsed = raw === 'true';
        payloadType = 'boolean';
      }
    }

    const now = new Date();
    const segments = topic.split('/');

    return {
      updateOne: {
        filter: { topic },
        update: {
          $set: {
            brokerId,
            payload: { raw, parsed, type: payloadType },
            qos,
            retained,
            receivedAt: now,
            deviceId,
            topicMetadata: {
              segments,
              baseTopic: segments[0],
              leafTopic: segments[segments.length - 1]
            }
          },
          $inc: { 'stats.updateCount': 1 },
          $setOnInsert: {
            'stats.firstSeenAt': now,
            'stats.changeCount': 0
          }
        },
        upsert: true
      }
    };
  });

  const result = await this.bulkWrite(bulkOps);
  
  // Invalidate cache for all updated topics
  updates.forEach(update => {
    invalidateTopicPatterns(update.topic);
  });
  
  return result;
};

export default mongoose.model('MqttState', mqttStateSchema);
