import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

/**
 * MQTT Broker Connection Configuration
 * Stores settings for both the built-in broker and external connections
 */
const mqttBrokerSchema = new mongoose.Schema({
  // Unique identifier for this broker connection
  brokerId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Display name
  name: {
    type: String,
    required: true
  },

  // Type: 'internal' (built-in Aedes) or 'external' (remote broker)
  type: {
    type: String,
    enum: ['internal', 'external'],
    required: true
  },

  // Connection enabled/disabled
  enabled: {
    type: Boolean,
    default: true
  },

  // Connection settings (for external brokers)
  connection: {
    host: { type: String, default: 'localhost' },
    port: { type: Number, default: 1883 },
    protocol: { type: String, enum: ['mqtt', 'mqtts', 'ws', 'wss'], default: 'mqtt' },
    username: String,
    password: String,  // Will be encrypted
    clientId: String,
    keepalive: { type: Number, default: 60 },
    reconnectPeriod: { type: Number, default: 5000 },
    connectTimeout: { type: Number, default: 30000 }
  },

  // TLS settings
  tls: {
    enabled: { type: Boolean, default: false },
    rejectUnauthorized: { type: Boolean, default: true },
    ca: String,      // CA certificate
    cert: String,    // Client certificate
    key: String      // Client key
  },

  // Internal broker settings (only for type: 'internal')
  brokerSettings: {
    port: { type: Number, default: 1883 },
    wsPort: { type: Number, default: 8883 },  // WebSocket port
    requireAuth: { type: Boolean, default: false },
    maxConnections: { type: Number, default: 100 },
    allowedUsers: [{
      username: String,
      password: String,  // Hashed
      acl: [{
        topic: String,
        permissions: { type: String, enum: ['read', 'write', 'readwrite'], default: 'readwrite' }
      }]
    }]
  },

  // Topics to subscribe to (for external brokers)
  subscriptions: [{
    topic: String,       // Supports wildcards: home/+/temperature, sensors/#
    qos: { type: Number, enum: [0, 1, 2], default: 0 },
    handler: { type: String, enum: ['store', 'process', 'forward', 'ignore'], default: 'store' }
  }],

  // Connection status (runtime, not persisted on restart)
  status: {
    connected: { type: Boolean, default: false },
    lastConnected: Date,
    lastDisconnected: Date,
    lastError: String,
    clientCount: { type: Number, default: 0 },  // For internal broker
    messagesReceived: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 }
  },

  // Rolling performance history, one sample per minute, capped at the last
  // 100 samples (~1.5h) via $slice in recordMetricsSample. Written by
  // mqttService's metrics sampler — never by per-message writes.
  metrics: {
    connectionHistory: [{
      timestamp: Date,
      count: Number
    }],
    messageRateHistory: [{
      timestamp: Date,
      received: Number,   // messages in the sample interval
      sent: Number
    }],
    errorHistory: [{
      timestamp: Date,
      type: String,
      count: Number
    }]
  },

  // Metadata
  description: String,
  tags: [String],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update timestamp on save
mqttBrokerSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Indexes
mqttBrokerSchema.index({ type: 1 });
mqttBrokerSchema.index({ enabled: 1 });

/**
 * Check whether an MQTT topic filter is syntactically valid.
 * Wildcards may only occupy an entire level, and '#' must be the final level.
 *
 * @param {String} filter - MQTT topic name or topic filter
 * @param {Boolean} allowWildcards - Whether '+' and '#' are permitted
 * @returns {Boolean} Whether the filter is valid
 */
function isValidMqttFilter(filter, allowWildcards = true) {
  if (typeof filter !== 'string' || filter.length === 0 || filter.includes('\u0000')) {
    return false;
  }

  const levels = filter.split('/');
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];

    if (level.includes('+') && (level !== '+' || !allowWildcards)) {
      return false;
    }
    if (level.includes('#') && (level !== '#' || !allowWildcards || index !== levels.length - 1)) {
      return false;
    }
  }

  return true;
}

/**
 * Determine whether an ACL filter covers a requested MQTT topic or subscription.
 *
 * @param {String} aclFilter - Filter from the ACL rule
 * @param {String} requestedFilter - Topic or subscription being authorized
 * @returns {Boolean} Whether the ACL grants coverage
 */
function mqttFilterMatches(aclFilter, requestedFilter) {
  if (!isValidMqttFilter(aclFilter) || !isValidMqttFilter(requestedFilter)) {
    return false;
  }

  const aclLevels = aclFilter.split('/');
  const requestedLevels = requestedFilter.split('/');

  // MQTT 4.7.2: wildcards at the first level never match topics beginning with '$'.
  if (requestedLevels[0].startsWith('$') && (aclLevels[0] === '+' || aclLevels[0] === '#')) {
    return false;
  }

  for (let index = 0; index < aclLevels.length; index += 1) {
    const aclLevel = aclLevels[index];
    const requestedLevel = requestedLevels[index];

    if (aclLevel === '#') {
      return true;
    }
    if (requestedLevel === undefined) {
      return false;
    }
    // A requested wildcard is a SUBSCRIPTION to everything at that level, so it is
    // only covered by an ACL wildcard at least as broad: '+' by '+' (or '#'),
    // '#' only by '#'. Letting a requested '+' match a literal ACL level would let
    // an ACL for 'a/b/c' authorise a subscription to 'a/+/c'.
    if (requestedLevel === '#') {
      return false;
    }
    if (requestedLevel === '+') {
      if (aclLevel === '+') continue;
      return false;
    }
    if (aclLevel === '+' || aclLevel === requestedLevel) {
      continue;
    }
    return false;
  }

  return aclLevels.length === requestedLevels.length;
}

/**
 * Authorize a user's access to an MQTT topic.
 * Password handling intentionally remains outside this method.
 *
 * @param {String} username - Internal broker username
 * @param {String} topic - MQTT topic name or subscription filter
 * @param {String} operation - 'read' for subscribe or 'write' for publish
 * @returns {{authorized: Boolean, matchedRule: Object|null}} Authorization result
 */
mqttBrokerSchema.methods.authorizeTopicAccess = function(username, topic, operation) {
  const result = { authorized: false, matchedRule: null };

  if (this.type !== 'internal' ||
      typeof username !== 'string' ||
      !username ||
      !['read', 'write'].includes(operation) ||
      // Publish targets a topic NAME — wildcards are only legal in subscriptions.
      !isValidMqttFilter(topic, operation === 'read')) {
    return result;
  }

  const user = (this.brokerSettings?.allowedUsers || [])
    .find(allowedUser => allowedUser?.username === username);

  if (!user) {
    return result;
  }

  const rule = (user.acl || []).find(candidate => {
    if (!candidate || !mqttFilterMatches(candidate.topic, topic)) {
      return false;
    }
    return candidate.permissions === operation || candidate.permissions === 'readwrite';
  });

  if (rule) {
    result.authorized = true;
    result.matchedRule = {
      topic: rule.topic,
      permissions: rule.permissions
    };
  }

  return result;
};

/**
 * Add a new subscription to the broker
 * @param {Object} subscription - The subscription object containing topic, qos, and handler
 */
mqttBrokerSchema.methods.addSubscription = async function(subscription) {
  try {
    this.subscriptions.push(subscription);
    await this.save();
    logger.info(`Subscription added: ${subscription.topic}`);
  } catch (error) {
    logger.error(`Failed to add subscription: ${error.message}`);
    throw error;
  }
};

/**
 * Remove a subscription from the broker
 * @param {String} topic - The topic of the subscription to remove
 */
mqttBrokerSchema.methods.removeSubscription = async function(topic) {
  try {
    this.subscriptions = this.subscriptions.filter(sub => sub.topic !== topic);
    await this.save();
    logger.info(`Subscription removed: ${topic}`);
  } catch (error) {
    logger.error(`Failed to remove subscription: ${error.message}`);
    throw error;
  }
};

/**
 * Update an existing subscription
 * @param {String} topic - The topic of the subscription to update
 * @param {Object} updates - The updates to apply to the subscription
 */
mqttBrokerSchema.methods.updateSubscription = async function(topic, updates) {
  try {
    const subscription = this.subscriptions.find(sub => sub.topic === topic);
    if (!subscription) {
      throw new Error(`Subscription not found for topic: ${topic}`);
    }
    Object.assign(subscription, updates);
    await this.save();
    logger.info(`Subscription updated: ${topic}`);
  } catch (error) {
    logger.error(`Failed to update subscription: ${error.message}`);
    throw error;
  }
};

const METRICS_HISTORY_CAP = 100;

/**
 * Summarize a broker's stored metrics history for dashboard consumption.
 * Pure function, exported for tests.
 */
export function summarizeBrokerMetrics(metrics = {}) {
  const connections = metrics.connectionHistory || [];
  const rates = metrics.messageRateHistory || [];
  const errors = metrics.errorHistory || [];

  const peakConnections = connections.length
    ? Math.max(...connections.map(c => c.count || 0))
    : 0;
  const currentConnections = connections.length
    ? (connections[connections.length - 1].count || 0)
    : 0;

  let messageRate = { received: 0, sent: 0 };
  if (rates.length) {
    messageRate = {
      received: Number((rates.reduce((s, r) => s + (r.received || 0), 0) / rates.length).toFixed(2)),
      sent: Number((rates.reduce((s, r) => s + (r.sent || 0), 0) / rates.length).toFixed(2))
    };
  }

  const errorDistribution = {};
  for (const e of errors) {
    errorDistribution[e.type] = (errorDistribution[e.type] || 0) + (e.count || 0);
  }

  return {
    sampleCount: rates.length,
    windowStart: rates[0]?.timestamp || connections[0]?.timestamp || null,
    windowEnd: rates[rates.length - 1]?.timestamp || connections[connections.length - 1]?.timestamp || null,
    currentConnections,
    peakConnections,
    messageRate,   // average messages per sample interval (1 min)
    errorDistribution,
    totalErrors: Object.values(errorDistribution).reduce((s, n) => s + n, 0)
  };
}

/**
 * Record one metrics sample atomically ($push + $slice — matches the
 * service's updateOne write pattern; no doc load, no save() races).
 * @param {String} brokerId
 * @param {Object} sample - { connections, received, sent, errors: [{type, count}] }
 */
mqttBrokerSchema.statics.recordMetricsSample = async function(brokerId, { connections, received, sent, errors = [] } = {}) {
  const now = new Date();
  const push = {
    'metrics.connectionHistory': { $each: [{ timestamp: now, count: connections || 0 }], $slice: -METRICS_HISTORY_CAP },
    'metrics.messageRateHistory': { $each: [{ timestamp: now, received: received || 0, sent: sent || 0 }], $slice: -METRICS_HISTORY_CAP }
  };
  if (errors.length > 0) {
    push['metrics.errorHistory'] = {
      $each: errors.map(e => ({ timestamp: now, type: e.type, count: e.count })),
      $slice: -METRICS_HISTORY_CAP
    };
  }
  await this.updateOne({ brokerId }, { $push: push });
};

/**
 * Raw metrics history for a broker
 */
mqttBrokerSchema.statics.getBrokerMetrics = async function(brokerId) {
  const broker = await this.findOne({ brokerId }).lean();
  if (!broker) {
    throw new Error(`Broker not found: ${brokerId}`);
  }
  return {
    brokerId: broker.brokerId,
    name: broker.name,
    type: broker.type,
    status: broker.status,
    metrics: broker.metrics || {}
  };
};

/**
 * Formatted metrics summary (averages, peaks, error distribution) suitable
 * for dashboard consumption
 */
mqttBrokerSchema.statics.getMetricsSummary = async function(brokerId) {
  const broker = await this.findOne({ brokerId }).lean();
  if (!broker) {
    throw new Error(`Broker not found: ${brokerId}`);
  }
  return {
    brokerId: broker.brokerId,
    name: broker.name,
    type: broker.type,
    connected: broker.status?.connected || false,
    timestamp: new Date(),
    ...summarizeBrokerMetrics(broker.metrics)
  };
};

export default mongoose.model('MqttBroker', mqttBrokerSchema);
