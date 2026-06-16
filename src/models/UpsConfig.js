import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

const upsConfigSchema = new mongoose.Schema({
  // UPS identification
  upsName: { type: String, required: true, unique: true, index: true },
  displayName: { type: String, default: '' },

  // NUT connection settings
  host: { type: String, default: 'localhost' },
  port: { type: Number, default: 3493 },

  // Monitoring settings
  enabled: { type: Boolean, default: true },
  pollInterval: { type: Number, default: 30000 },  // 30 seconds in ms

  // Alert thresholds
  thresholds: {
    lowBattery: { type: Number, default: 30 },       // Percentage - warning level
    criticalBattery: { type: Number, default: 10 },  // Percentage - critical level
    shutdownBattery: { type: Number, default: 5 },   // Percentage - initiate shutdown
    lowRuntime: { type: Number, default: 300 },      // Seconds - 5 minutes
    criticalRuntime: { type: Number, default: 120 }, // Seconds - 2 minutes
    highLoad: { type: Number, default: 90 },         // Percentage
    highTemperature: { type: Number, default: 45 }   // Celsius
  },

  // Notification settings
  notifications: {
    enabled: { type: Boolean, default: true },
    onBattery: { type: Boolean, default: true },
    lowBattery: { type: Boolean, default: true },
    criticalBattery: { type: Boolean, default: true },
    powerRestored: { type: Boolean, default: true },
    overload: { type: Boolean, default: true },
    temperatureWarning: { type: Boolean, default: true },
    channels: [{
      type: String,
      enum: ['telegram', 'email', 'mqtt', 'webhook']
    }],
    severityChannelMapping: {
      low: { type: [String], default: ['email'] },
      medium: { type: [String], default: ['email', 'telegram'] },
      high: { type: [String], default: ['telegram', 'webhook'] }
    },
    cooldownMinutes: { type: Number, default: 5 }  // Min time between same notifications
  },

  // Escalation policies — applied in order; the highest minDurationMinutes the alert has
  // exceeded wins. Lets ops route prolonged alerts to extra channels with a custom message.
  escalationPolicies: [{
    minDurationMinutes: { type: Number, required: true }, // Threshold (alert age in minutes)
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'any'],
      default: 'any'
    },
    channels: [{
      type: String,
      enum: ['telegram', 'email', 'mqtt', 'webhook']
    }],
    messagePrefix: String // Prepended to the standard alert message
  }],

  // Auto-shutdown settings
  autoShutdown: {
    enabled: { type: Boolean, default: false },
    triggerOn: {
      type: String,
      enum: ['battery_level', 'runtime', 'both'],
      default: 'both'
    },
    batteryThreshold: { type: Number, default: 10 },   // Percentage
    runtimeThreshold: { type: Number, default: 180 },  // Seconds - 3 minutes
    command: { type: String, default: 'shutdown -h +1 "UPS battery critical - initiating safe shutdown"' },
    delaySeconds: { type: Number, default: 60 },       // Delay before executing shutdown
    notifyBeforeShutdown: { type: Boolean, default: true }
  },

  // MQTT publishing settings
  mqtt: {
    enabled: { type: Boolean, default: true },
    statusTopic: { type: String, default: 'lanagent/ups/{upsName}/status' },
    eventTopic: { type: String, default: 'lanagent/ups/{upsName}/event' },
    publishInterval: { type: Number, default: 60000 }  // 1 minute
  },

  // Current state cache (updated by service)
  lastStatus: {
    batteryCharge: Number,
    batteryRuntime: Number,
    load: Number,
    inputVoltage: Number,
    outputVoltage: Number,
    temperature: Number,
    status: String,
    statusDescription: String,
    upsModel: String,
    manufacturer: String,
    serialNumber: String,
    firmwareVersion: String
  },
  lastPollAt: Date,
  lastStatusChange: Date,
  lastErrorAt: Date,
  lastError: String,
  consecutiveErrors: { type: Number, default: 0 },

  // Notification cooldown tracking
  lastNotifications: {
    type: Map,
    of: Date,
    default: new Map()
  }
}, {
  timestamps: true
});

// Cache for UPS status to reduce redundant DB writes
const upsStatusCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Static methods

/**
 * Get all enabled UPS configurations
 */
upsConfigSchema.statics.getEnabled = async function() {
  return this.find({ enabled: true }).lean();
};

/**
 * Get or create default UPS configuration
 */
upsConfigSchema.statics.getOrCreateDefault = async function(upsName = 'ups') {
  let config = await this.findOne({ upsName });
  if (!config) {
    config = await this.create({
      upsName,
      displayName: 'Primary UPS',
      notifications: {
        enabled: true,
        channels: ['telegram']
      }
    });
  }
  return config;
};

/**
 * Update UPS status
 */
upsConfigSchema.statics.updateStatus = async function(upsName, status) {
  const cacheKey = `upsStatus:${upsName}`;
  const cachedStatus = upsStatusCache.get(cacheKey);

  // Skip DB write if status hasn't changed
  if (cachedStatus && JSON.stringify(cachedStatus) === JSON.stringify(status)) {
    return null;
  }

  const result = await retryOperation(() => this.findOneAndUpdate(
    { upsName },
    {
      lastStatus: status,
      lastPollAt: new Date(),
      lastError: null,
      consecutiveErrors: 0
    },
    { new: true }
  ));

  upsStatusCache.set(cacheKey, status);
  return result;
};

/**
 * Record error
 */
upsConfigSchema.statics.recordError = async function(upsName, error) {
  return retryOperation(() => this.findOneAndUpdate(
    { upsName },
    {
      lastErrorAt: new Date(),
      lastError: error,
      $inc: { consecutiveErrors: 1 }
    },
    { new: true }
  ));
};

/**
 * Check if notification should be sent (cooldown check)
 */
upsConfigSchema.methods.shouldNotify = function(notificationType) {
  if (!this.notifications.enabled) return false;

  const lastNotification = this.lastNotifications?.get(notificationType);
  if (!lastNotification) return true;

  const cooldownMs = this.notifications.cooldownMinutes * 60 * 1000;
  return (Date.now() - lastNotification.getTime()) > cooldownMs;
};

/**
 * Record notification sent
 */
upsConfigSchema.methods.recordNotification = async function(notificationType) {
  if (!this.lastNotifications) {
    this.lastNotifications = new Map();
  }
  this.lastNotifications.set(notificationType, new Date());
  await this.save();
};

/**
 * Determine notification channels based on UPS status severity
 */
upsConfigSchema.methods.getNotificationChannels = function(severity) {
  const mapping = this.notifications.severityChannelMapping;
  return mapping[severity] || [];
};

/**
 * Apply escalation policy based on alert duration and severity.
 * Returns the highest-threshold policy whose minDurationMinutes the alert has
 * exceeded and whose severity matches (or is 'any').
 *
 * @param {number} alertDurationMinutes
 * @param {string} severity - 'low' | 'medium' | 'high'
 * @returns {{ channels: string[], messagePrefix?: string } | null}
 */
upsConfigSchema.methods.applyEscalationPolicy = function(alertDurationMinutes, severity) {
  if (!Array.isArray(this.escalationPolicies) || this.escalationPolicies.length === 0) {
    return null;
  }

  const matched = this.escalationPolicies
    .filter(p =>
      (p.severity === 'any' || p.severity === severity) &&
      p.minDurationMinutes <= alertDurationMinutes
    )
    .sort((a, b) => b.minDurationMinutes - a.minDurationMinutes); // Highest threshold first

  if (matched.length === 0) return null;

  const policy = matched[0];
  return {
    channels: Array.isArray(policy.channels) ? [...policy.channels] : [],
    messagePrefix: policy.messagePrefix
  };
};

export const UpsConfig = mongoose.model('UpsConfig', upsConfigSchema);
export default UpsConfig;
