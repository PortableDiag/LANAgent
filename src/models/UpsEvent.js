import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const upsEventSchema = new mongoose.Schema({
  // Event identification
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => `ups_event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  upsName: { type: String, required: true, index: true },

  // Event type and severity
  eventType: {
    type: String,
    enum: [
      'power_loss',         // Utility power lost
      'power_restored',     // Utility power restored
      'on_battery',         // UPS switched to battery
      'low_battery',        // Battery below low threshold
      'battery_critical',   // Battery below critical threshold
      'shutdown_initiated', // Auto-shutdown triggered
      'status_change',      // General status change
      'communication_lost', // Lost connection to UPS
      'communication_restored', // Connection restored
      'overload',           // UPS overloaded
      'test',               // Self-test event
      'battery_replace'     // Battery needs replacement
    ],
    required: true,
    index: true
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info'
  },

  // UPS status snapshot at event time
  statusSnapshot: {
    batteryCharge: Number,      // Percentage (0-100)
    batteryRuntime: Number,     // Seconds remaining
    load: Number,               // Percentage (0-100)
    inputVoltage: Number,       // Volts
    outputVoltage: Number,      // Volts
    temperature: Number,        // Celsius
    status: String,             // Raw NUT status (OL, OB, LB, etc.)
    statusDescription: String,  // Human-readable status
    upsModel: String,
    manufacturer: String,
    serialNumber: String
  },

  // Event metadata
  message: String,
  previousStatus: String,
  actionsTaken: [String],       // e.g., ["notification_sent", "shutdown_initiated"]
  notificationsSent: [{
    channel: String,            // telegram, email, mqtt
    sentAt: Date,
    success: Boolean
  }],

  // Timestamps
  createdAt: { type: Date, default: Date.now, index: true },
  resolvedAt: Date,
  duration: Number,             // Duration of event in seconds
  acknowledged: { type: Boolean, default: false },
  acknowledgedAt: Date,
  acknowledgedBy: String
}, {
  timestamps: true
});

// Compound indexes for efficient queries
upsEventSchema.index({ eventType: 1, createdAt: -1 });
upsEventSchema.index({ upsName: 1, createdAt: -1 });
upsEventSchema.index({ severity: 1, resolvedAt: 1 });
upsEventSchema.index({ acknowledged: 1, severity: 1 });

/**
 * Correlate events to identify patterns and potential root causes
 * @param {Array} events - List of events to correlate
 * @returns {Object} - Correlation results with potential root causes
 */
upsEventSchema.statics.correlateEvents = async function(events) {
  try {
    const correlationResults = {};
    // Example correlation logic (to be expanded with real analysis)
    events.forEach(event => {
      if (!correlationResults[event.eventType]) {
        correlationResults[event.eventType] = 0;
      }
      correlationResults[event.eventType]++;
    });
    return correlationResults;
  } catch (error) {
    logger.error('Error correlating events', { error });
    throw error;
  }
};

/**
 * Get recent events within specified hours
 */
upsEventSchema.statics.getRecentEvents = async function(hours = 24, upsName = null) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const query = { createdAt: { $gte: since } };
  if (upsName) query.upsName = upsName;

  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
};

/**
 * Get unresolved/active events
 */
upsEventSchema.statics.getUnresolvedEvents = async function() {
  return this.find({
    resolvedAt: null,
    eventType: { $in: ['on_battery', 'low_battery', 'battery_critical', 'communication_lost', 'overload'] }
  })
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * Get unacknowledged critical events
 */
upsEventSchema.statics.getUnacknowledgedCritical = async function() {
  return this.find({
    acknowledged: false,
    severity: 'critical'
  })
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * Record a new event
 */
upsEventSchema.statics.recordEvent = async function(eventData) {
  const event = new this(eventData);
  await retryOperation(() => event.save(), { retries: 3 });
  return event;
};

/**
 * Resolve an event (e.g., power restored after power_loss)
 */
upsEventSchema.statics.resolveEvent = async function(eventId) {
  const event = await this.findOne({ eventId });
  if (event && !event.resolvedAt) {
    event.resolvedAt = new Date();
    event.duration = Math.floor((event.resolvedAt - event.createdAt) / 1000);
    await retryOperation(() => event.save(), { retries: 3 });
  }
  return event;
};

/**
 * Acknowledge an event
 */
upsEventSchema.statics.acknowledgeEvent = async function(eventId, acknowledgedBy = 'user') {
  return this.findOneAndUpdate(
    { eventId },
    {
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy
    },
    { new: true }
  );
};

/**
 * Get event statistics
 */
upsEventSchema.statics.getStats = async function(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const stats = await this.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$eventType',
        count: { $sum: 1 },
        avgDuration: { $avg: '$duration' }
      }
    }
  ]);

  const totalEvents = await this.countDocuments({ createdAt: { $gte: since } });
  const criticalCount = await this.countDocuments({
    createdAt: { $gte: since },
    severity: 'critical'
  });

  return {
    byType: stats,
    total: totalEvents,
    critical: criticalCount,
    periodDays: days
  };
};

/**
 * Cleanup old events
 */
upsEventSchema.statics.cleanup = async function(retentionDays = 90) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await this.deleteMany({
    createdAt: { $lt: cutoff },
    severity: { $ne: 'critical' }  // Keep critical events longer
  });
  return result.deletedCount;
};

export const UpsEvent = mongoose.model('UpsEvent', upsEventSchema);
export default UpsEvent;
