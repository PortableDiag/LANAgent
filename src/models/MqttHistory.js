import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

/**
 * MQTT Message History
 * Time-series storage for MQTT messages
 * Uses TTL index for automatic cleanup
 */
const mqttHistorySchema = new mongoose.Schema({
  // Topic path
  topic: {
    type: String,
    required: true,
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

  // Message payload
  payload: {
    raw: String,
    parsed: mongoose.Schema.Types.Mixed,
    type: { type: String, enum: ['string', 'json', 'number', 'boolean', 'binary'], default: 'string' }
  },

  // Numeric value (for easy aggregation of sensor data)
  numericValue: {
    type: Number,
    sparse: true,
    index: true
  },

  // QoS level
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

  // Timestamp (indexed for time-series queries)
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },

  // Expiration date for TTL
  expiresAt: {
    type: Date
  },

  // Source information
  source: {
    clientId: String,
    ip: String
  }
});

// Compound indexes for efficient time-series queries
mqttHistorySchema.index({ topic: 1, timestamp: -1 });
mqttHistorySchema.index({ deviceId: 1, timestamp: -1 });
mqttHistorySchema.index({ brokerId: 1, timestamp: -1 });

// TTL index - documents expire based on expiresAt field
mqttHistorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Cache for storing recent queries
 */
mqttHistorySchema.statics.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Static method to record a message
 */
mqttHistorySchema.statics.recordMessage = async function(topic, brokerId, payload, options = {}) {
  const {
    qos = 0,
    retained = false,
    deviceId = null,
    ttlDays = 7,  // Default 7 days retention
    clientId = null,
    ip = null
  } = options;

  // Parse payload
  let parsed = null;
  let payloadType = 'string';
  let numericValue = null;
  const raw = typeof payload === 'string' ? payload : payload.toString();

  try {
    parsed = JSON.parse(raw);
    payloadType = 'json';

    // Extract numeric value if it's a simple number or has a value field
    if (typeof parsed === 'number') {
      numericValue = parsed;
    } else if (typeof parsed === 'object' && parsed !== null) {
      // Try common value field names
      for (const key of ['value', 'val', 'state', 'temperature', 'humidity', 'power', 'energy']) {
        if (typeof parsed[key] === 'number') {
          numericValue = parsed[key];
          break;
        }
      }
    }
  } catch {
    // Not JSON, check if numeric
    if (!isNaN(raw) && raw.trim() !== '') {
      numericValue = parseFloat(raw);
      parsed = numericValue;
      payloadType = 'number';
    } else if (raw === 'true' || raw === 'false') {
      parsed = raw === 'true';
      payloadType = 'boolean';
      numericValue = parsed ? 1 : 0;  // Store boolean as 1/0 for aggregation
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  return retryOperation(async () => {
    return this.create({
      topic,
      brokerId,
      deviceId,
      payload: { raw, parsed, type: payloadType },
      numericValue,
      qos,
      retained,
      timestamp: now,
      expiresAt,
      source: { clientId, ip }
    });
  });
};

/**
 * New feature: Batch processing of MQTT messages
 * @param {Array} messages - Array of message objects to be processed
 */
mqttHistorySchema.statics.recordMessagesBatch = async function(messages) {
  const bulkOperations = messages.map(message => {
    const {
      topic,
      brokerId,
      payload,
      qos = 0,
      retained = false,
      deviceId = null,
      ttlDays = 7,
      clientId = null,
      ip = null
    } = message;

    // Parse payload
    let parsed = null;
    let payloadType = 'string';
    let numericValue = null;
    const raw = typeof payload === 'string' ? payload : payload.toString();

    try {
      parsed = JSON.parse(raw);
      payloadType = 'json';

      // Extract numeric value if it's a simple number or has a value field
      if (typeof parsed === 'number') {
        numericValue = parsed;
      } else if (typeof parsed === 'object' && parsed !== null) {
        // Try common value field names
        for (const key of ['value', 'val', 'state', 'temperature', 'humidity', 'power', 'energy']) {
          if (typeof parsed[key] === 'number') {
            numericValue = parsed[key];
            break;
          }
        }
      }
    } catch {
      // Not JSON, check if numeric
      if (!isNaN(raw) && raw.trim() !== '') {
        numericValue = parseFloat(raw);
        parsed = numericValue;
        payloadType = 'number';
      } else if (raw === 'true' || raw === 'false') {
        parsed = raw === 'true';
        payloadType = 'boolean';
        numericValue = parsed ? 1 : 0;  // Store boolean as 1/0 for aggregation
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    return {
      insertOne: {
        document: {
          topic,
          brokerId,
          deviceId,
          payload: { raw, parsed, type: payloadType },
          numericValue,
          qos,
          retained,
          timestamp: now,
          expiresAt,
          source: { clientId, ip }
        }
      }
    };
  });

  try {
    await retryOperation(async () => {
      await this.bulkWrite(bulkOperations);
    });
    logger.info('Batch of MQTT messages recorded successfully.');
  } catch (error) {
    logger.error('Error recording batch of MQTT messages:', error);
    throw error;
  }
};

// Static method to get time-series data for a topic
mqttHistorySchema.statics.getTimeSeries = async function(topic, options = {}) {
  const {
    startTime = new Date(Date.now() - 24 * 60 * 60 * 1000),  // Default last 24h
    endTime = new Date(),
    limit = 1000,
    aggregation = null  // 'minute', 'hour', 'day'
  } = options;

  const cacheKey = `timeSeries:${topic}:${startTime.toISOString()}:${endTime.toISOString()}:${limit}:${aggregation}`;
  const cachedData = this.cache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  let result;
  if (aggregation) {
    // Aggregate data
    const groupId = {
      minute: { $dateToString: { format: '%Y-%m-%d %H:%M', date: '$timestamp' } },
      hour: { $dateToString: { format: '%Y-%m-%d %H:00', date: '$timestamp' } },
      day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
    }[aggregation];

    result = await this.aggregate([
      {
        $match: {
          topic,
          timestamp: { $gte: startTime, $lte: endTime },
          numericValue: { $ne: null }
        }
      },
      {
        $group: {
          _id: groupId,
          avg: { $avg: '$numericValue' },
          min: { $min: '$numericValue' },
          max: { $max: '$numericValue' },
          count: { $sum: 1 },
          first: { $first: '$numericValue' },
          last: { $last: '$numericValue' }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: limit }
    ]);
  } else {
    // Return raw data
    result = await this.find({
      topic,
      timestamp: { $gte: startTime, $lte: endTime }
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  }

  this.cache.set(cacheKey, result);
  return result;
};

// Static method to get statistics for a topic
mqttHistorySchema.statics.getStatistics = async function(topic, startTime, endTime) {
  const cacheKey = `statistics:${topic}:${startTime.toISOString()}:${endTime.toISOString()}`;
  const cachedData = this.cache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  const result = await this.aggregate([
    {
      $match: {
        topic,
        timestamp: { $gte: startTime, $lte: endTime },
        numericValue: { $ne: null }
      }
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        avg: { $avg: '$numericValue' },
        min: { $min: '$numericValue' },
        max: { $max: '$numericValue' },
        stdDev: { $stdDevPop: '$numericValue' }
      }
    }
  ]);

  const statistics = result[0] || { count: 0, avg: null, min: null, max: null, stdDev: null };
  this.cache.set(cacheKey, statistics);
  return statistics;
};

/**
 * New feature: Advanced data filtering and querying
 * Allows filtering of MQTT message history based on payload content, QoS levels, and retained flags.
 */
mqttHistorySchema.statics.advancedQuery = async function(criteria = {}, options = {}) {
  const {
    startTime = new Date(Date.now() - 24 * 60 * 60 * 1000),  // Default last 24h
    endTime = new Date(),
    limit = 1000
  } = options;

  const query = {
    timestamp: { $gte: startTime, $lte: endTime }
  };

  if (criteria.topic) {
    query.topic = criteria.topic;
  }
  if (criteria.brokerId) {
    query.brokerId = criteria.brokerId;
  }
  if (criteria.deviceId) {
    query.deviceId = criteria.deviceId;
  }
  if (criteria.qos !== undefined) {
    query.qos = criteria.qos;
  }
  if (criteria.retained !== undefined) {
    query.retained = criteria.retained;
  }
  if (criteria.payloadContent) {
    query['payload.raw'] = { $regex: criteria.payloadContent, $options: 'i' };
  }

  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

export default mongoose.model('MqttHistory', mqttHistorySchema);