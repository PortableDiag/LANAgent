import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

// Module-level cache for rule queries
const ruleCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

/**
 * Event Rule Schema
 * Defines automation rules for the Event Engine
 * Supports IF-THEN logic with conditions and actions
 */
const eventRuleSchema = new mongoose.Schema({
  // Unique rule identifier
  ruleId: {
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

  // Description
  description: String,

  // Rule enabled/disabled
  enabled: {
    type: Boolean,
    default: true,
    index: true
  },

  // Rule priority (higher = evaluated first)
  priority: {
    type: Number,
    default: 0,
    index: true
  },

  // Trigger type
  triggerType: {
    type: String,
    enum: ['mqtt', 'schedule', 'state_change', 'webhook', 'manual'],
    required: true
  },

  // MQTT trigger configuration
  mqttTrigger: {
    topic: String,           // Topic pattern (supports + and # wildcards)
    brokerId: String,        // Specific broker or 'any'
    payloadFilter: {         // Optional payload filtering
      type: { type: String, enum: ['equals', 'contains', 'regex', 'json_path', 'numeric'] },
      value: mongoose.Schema.Types.Mixed,
      jsonPath: String,      // For json_path type
      operator: String       // For numeric: gt, lt, gte, lte, eq, neq
    }
  },

  // Schedule trigger configuration (cron-style)
  scheduleTrigger: {
    cron: String,            // Cron expression
    timezone: { type: String, default: 'UTC' },
    agendaJobId: String      // Reference to Agenda job
  },

  // State change trigger
  stateChangeTrigger: {
    deviceId: String,
    attribute: String,       // Which attribute to watch
    changeType: { type: String, enum: ['any', 'to', 'from', 'between'] },
    fromValue: mongoose.Schema.Types.Mixed,
    toValue: mongoose.Schema.Types.Mixed
  },

  // Conditions (all must be true for rule to fire)
  conditions: [{
    type: {
      type: String,
      enum: ['state', 'time', 'day', 'sun', 'template', 'and', 'or', 'not']
    },
    // State condition
    state: {
      deviceId: String,
      topic: String,
      attribute: String,
      operator: { type: String, enum: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'not_contains', 'regex'] },
      value: mongoose.Schema.Types.Mixed
    },
    // Time condition
    time: {
      after: String,         // HH:MM format
      before: String,
      weekdays: [Number]     // 0-6 (Sunday-Saturday)
    },
    // Sun condition
    sun: {
      condition: { type: String, enum: ['after_sunrise', 'before_sunrise', 'after_sunset', 'before_sunset'] },
      offset: Number         // Minutes offset
    },
    // Nested conditions for and/or/not
    conditions: mongoose.Schema.Types.Mixed
  }],

  // Actions to perform when rule fires
  actions: [{
    type: {
      type: String,
      enum: ['mqtt_publish', 'device_command', 'delay', 'notify', 'webhook', 'set_variable', 'run_rule'],
      required: true
    },
    // MQTT publish action
    mqttPublish: {
      topic: String,
      payload: mongoose.Schema.Types.Mixed,
      qos: { type: Number, enum: [0, 1, 2], default: 0 },
      retain: { type: Boolean, default: false },
      brokerId: String
    },
    // Device command action
    deviceCommand: {
      deviceId: String,
      command: String,
      parameters: mongoose.Schema.Types.Mixed
    },
    // Delay action
    delay: {
      duration: Number,      // Milliseconds
      cancelOnRetrigger: { type: Boolean, default: true }
    },
    // Notification action
    notify: {
      channel: { type: String, enum: ['email', 'sms', 'push', 'discord', 'slack'] },
      message: String,
      title: String,
      data: mongoose.Schema.Types.Mixed
    },
    // Webhook action
    webhook: {
      url: String,
      method: { type: String, enum: ['GET', 'POST', 'PUT'], default: 'POST' },
      headers: mongoose.Schema.Types.Mixed,
      body: mongoose.Schema.Types.Mixed
    },
    // Set variable action
    setVariable: {
      name: String,
      value: mongoose.Schema.Types.Mixed
    },
    // Run another rule
    runRule: {
      ruleId: String
    }
  }],

  // Throttling
  throttle: {
    enabled: { type: Boolean, default: false },
    interval: { type: Number, default: 60000 },  // Milliseconds
    maxFirings: { type: Number, default: 1 }
  },

  // Debounce (wait for value to stabilize)
  debounce: {
    enabled: { type: Boolean, default: false },
    delay: { type: Number, default: 1000 }       // Milliseconds
  },

  // Statistics
  stats: {
    fireCount: { type: Number, default: 0 },
    lastFiredAt: Date,
    lastTriggeredBy: String,
    errorCount: { type: Number, default: 0 },
    lastErrorAt: Date,
    lastError: String,
    avgExecutionTime: { type: Number, default: 0 }
  },

  // Last throttle/debounce state
  runtimeState: {
    lastThrottledAt: Date,
    throttleCount: { type: Number, default: 0 },
    debounceTimer: String,   // Timer ID for cancellation
    pendingActions: mongoose.Schema.Types.Mixed
  },

  // Tags for organization
  tags: [String],

  // Category/folder
  category: String,

  // Created by (user or system)
  createdBy: {
    type: { type: String, enum: ['user', 'system', 'ai'] },
    identifier: String
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update timestamp on save
eventRuleSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Invalidate cache after save
eventRuleSchema.post('save', function() {
  ruleCache.flushAll();
});

// Invalidate cache after delete
eventRuleSchema.post('deleteOne', function() {
  ruleCache.flushAll();
});

eventRuleSchema.post('deleteMany', function() {
  ruleCache.flushAll();
});

eventRuleSchema.post('findOneAndUpdate', function() {
  ruleCache.flushAll();
});

eventRuleSchema.post('findOneAndDelete', function() {
  ruleCache.flushAll();
});

// Indexes for efficient queries
eventRuleSchema.index({ triggerType: 1, enabled: 1 });
eventRuleSchema.index({ 'mqttTrigger.topic': 1 });
eventRuleSchema.index({ 'mqttTrigger.brokerId': 1 });
eventRuleSchema.index({ category: 1 });
eventRuleSchema.index({ tags: 1 });
eventRuleSchema.index({ priority: -1, enabled: 1 });

// Static method to invalidate rule cache
eventRuleSchema.statics.invalidateCache = function() {
  ruleCache.flushAll();
};

// Static method to find rules matching a topic (with caching and retry)
eventRuleSchema.statics.findMatchingRules = async function(topic, brokerId = null) {
  const cacheKey = `matchingRules:${topic}:${brokerId || 'any'}`;
  const cached = ruleCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const rules = await retryOperation(() => this.find({
    enabled: true,
    triggerType: 'mqtt'
  }).sort({ priority: -1 }));

  const matchingRules = rules.filter(rule => {
    if (!rule.mqttTrigger?.topic) return false;

    // Check broker filter
    if (brokerId && rule.mqttTrigger.brokerId && rule.mqttTrigger.brokerId !== 'any') {
      if (rule.mqttTrigger.brokerId !== brokerId) return false;
    }

    // Check topic pattern match
    return this.topicMatches(rule.mqttTrigger.topic, topic);
  });

  ruleCache.set(cacheKey, matchingRules);
  return matchingRules;
};

// Static method to check if a topic matches a pattern
eventRuleSchema.statics.topicMatches = function(pattern, topic) {
  const patternParts = pattern.split('/');
  const topicParts = topic.split('/');

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];

    // # matches everything remaining
    if (patternPart === '#') {
      return true;
    }

    // + matches single level
    if (patternPart === '+') {
      if (i >= topicParts.length) return false;
      continue;
    }

    // Exact match required
    if (i >= topicParts.length || patternPart !== topicParts[i]) {
      return false;
    }
  }

  // Must have matched all topic parts
  return patternParts.length === topicParts.length ||
         patternParts[patternParts.length - 1] === '#';
};

// Method to record a firing
eventRuleSchema.methods.recordFiring = async function(triggeredBy, executionTime) {
  this.stats.fireCount += 1;
  this.stats.lastFiredAt = new Date();
  this.stats.lastTriggeredBy = triggeredBy;

  // Update rolling average execution time
  const alpha = 0.1;  // Smoothing factor
  this.stats.avgExecutionTime = alpha * executionTime + (1 - alpha) * this.stats.avgExecutionTime;

  await this.save();
};

// Method to record an error
eventRuleSchema.methods.recordError = async function(error) {
  this.stats.errorCount += 1;
  this.stats.lastErrorAt = new Date();
  this.stats.lastError = error.message || String(error);
  await this.save();
};

// Method to check throttle
eventRuleSchema.methods.shouldThrottle = function() {
  if (!this.throttle?.enabled) return false;

  const lastThrottled = this.runtimeState?.lastThrottledAt;
  if (!lastThrottled) return false;

  const elapsed = Date.now() - new Date(lastThrottled).getTime();
  return elapsed < this.throttle.interval;
};

export default mongoose.model('EventRule', eventRuleSchema);
