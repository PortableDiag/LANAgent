import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const MAX_TIMELINE_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMELINE_LIMIT = 500;
const MAX_TIMELINE_LIMIT = 1000;
const DEFAULT_PROXIMITY_MINUTES = 15;

const SEVERITY_RANK = {
  info: 0,
  warning: 1,
  critical: 2
};

const FAILURE_EVENT_TYPES = new Set([
  'power_loss',
  'on_battery',
  'low_battery',
  'battery_critical',
  'shutdown_initiated',
  'communication_lost',
  'overload',
  'battery_replace'
]);

// A recovery event clears every failure it ends. Mains returning ends the whole
// outage, including the battery-level and shutdown events recorded during it.
// overload and battery_replace have no recovery event in upsService, so an
// incident made only of those is closed by the proximity gap.
const RECOVERY_EVENT_TYPES = new Map([
  ['power_restored', ['power_loss', 'on_battery', 'low_battery', 'battery_critical', 'shutdown_initiated']],
  ['communication_restored', ['communication_lost']]
]);

const upsEventSchema = new mongoose.Schema({
  // Event identification
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => `ups_event_${Date.now()}_${new mongoose.Types.ObjectId().toString()}`
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
 * Build operational incidents by grouping temporally related UPS events and
 * correlating failure events with their recovery events.
 *
 * @param {Object} options - Timeline options
 * @param {string} [options.upsName] - Restrict results to one UPS
 * @param {Date|string} [options.start] - Inclusive start date
 * @param {Date|string} [options.end] - Inclusive end date
 * @param {Date|string} [options.startDate] - Alias for start
 * @param {Date|string} [options.endDate] - Alias for end
 * @param {number} [options.limit=500] - Maximum number of source events to read
 * @param {number} [options.proximityMinutes=15] - Maximum gap between related events
 * @returns {Promise<Array>} Aggregated incident records
 */
upsEventSchema.statics.buildIncidentTimeline = async function(options = {}) {
  try {
    const {
      upsName,
      start,
      end,
      startDate,
      endDate,
      limit = DEFAULT_TIMELINE_LIMIT,
      proximityMinutes = DEFAULT_PROXIMITY_MINUTES
    } = options;

    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      throw new TypeError('Incident timeline limit must be a positive number');
    }

    const boundedLimit = Math.min(Math.floor(parsedLimit), MAX_TIMELINE_LIMIT);
    const proximity = Number(proximityMinutes);
    if (!Number.isFinite(proximity) || proximity <= 0) {
      throw new TypeError('Incident timeline proximity must be a positive number');
    }

    const endValue = end ?? endDate;
    const startValue = start ?? startDate;
    const endAt = endValue ? new Date(endValue) : new Date();
    const startAt = startValue
      ? new Date(startValue)
      : new Date(endAt.getTime() - MAX_TIMELINE_RANGE_MS);

    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new TypeError('Incident timeline dates must be valid dates');
    }

    if (startAt > endAt) {
      throw new RangeError('Incident timeline start date must precede its end date');
    }

    if (endAt.getTime() - startAt.getTime() > MAX_TIMELINE_RANGE_MS) {
      throw new RangeError('Incident timeline date range cannot exceed 31 days');
    }

    const query = {
      createdAt: {
        $gte: startAt,
        $lte: endAt
      }
    };

    if (upsName) {
      query.upsName = upsName;
    }

    const events = await retryOperation(
      () => this.find(query)
        .sort({ createdAt: 1 })
        .limit(boundedLimit)
        .lean(),
      { retries: 3 }
    );

    const eventsByUps = new Map();
    for (const event of events) {
      if (!event.createdAt) continue;
      if (!eventsByUps.has(event.upsName)) {
        eventsByUps.set(event.upsName, []);
      }
      eventsByUps.get(event.upsName).push(event);
    }

    const windowReachesNow = endAt.getTime() >= Date.now() - 60 * 1000;
    const incidents = [];
    const proximityMs = Math.min(proximity, 24 * 60) * 60 * 1000;
    const ts = (value) => new Date(value).getTime();

    for (const [eventUpsName, upsEvents] of eventsByUps) {
      let current = null;
      const upsIncidents = [];

      // An incident ends one of two ways: a recorded recovery event cleared every
      // open failure, or the next event came after the proximity gap. In the second
      // case no recovery was recorded (upsService skips recording during a
      // notification cooldown), so the end time is unknown: report the span we
      // actually observed and say so, rather than claiming the failure is still on.
      const close = (incident, recovered) => {
        const last = incident.events[incident.events.length - 1];
        incident.recoveryRecorded = recovered;
        incident.endTime = recovered ? last.createdAt : null;
        incident.lastEventAt = last.createdAt;
        incident.duration = Math.max(0, Math.floor((ts(last.createdAt) - ts(incident.startTime)) / 1000));
        incident.openFailures = [...incident.pendingFailures];
        incident.relatedEvents = incident.events.slice(1);
        delete incident.events;
        delete incident.pendingFailures;
        upsIncidents.push(incident);
      };

      for (const event of upsEvents) {
        const isFailure = FAILURE_EVENT_TYPES.has(event.eventType);

        if (current && ts(event.createdAt) - ts(current.events[current.events.length - 1].createdAt) > proximityMs) {
          close(current, false);
          current = null;
        }

        // Only a failure opens an incident. A lone recovery, self-test or status
        // change outside an incident is not one.
        if (!current) {
          if (!isFailure) continue;
          current = {
            upsName: eventUpsName,
            startTime: event.createdAt,
            endTime: null,
            duration: 0,
            triggeringEvent: event,
            relatedEvents: [],
            events: [event],
            maximumSeverity: event.severity || 'info',
            actionsTaken: [],
            pendingFailures: new Set()
          };
        } else {
          current.events.push(event);
          if ((SEVERITY_RANK[event.severity] ?? 0) > (SEVERITY_RANK[current.maximumSeverity] ?? 0)) {
            current.maximumSeverity = event.severity;
          }
        }

        for (const action of event.actionsTaken || []) {
          if (!current.actionsTaken.includes(action)) current.actionsTaken.push(action);
        }

        if (isFailure) current.pendingFailures.add(event.eventType);

        const clears = RECOVERY_EVENT_TYPES.get(event.eventType);
        if (clears) {
          for (const failureType of clears) current.pendingFailures.delete(failureType);
          if (current.pendingFailures.size === 0) {
            close(current, true);
            current = null;
          }
        }
      }

      if (current) close(current, false);

      // Only the newest incident for a UPS can still be in progress: anything
      // older was followed by later events. It is flagged, and its duration runs
      // to now, only when it was not closed by a recovery and the window reaches
      // the present (a historical window cannot see what happened after it).
      const newest = upsIncidents[upsIncidents.length - 1];
      for (const incident of upsIncidents) {
        incident.unresolved = windowReachesNow && incident === newest && !incident.recoveryRecorded;
        if (incident.unresolved) {
          incident.duration = Math.max(0, Math.floor((Date.now() - ts(incident.startTime)) / 1000));
        }
      }
      incidents.push(...upsIncidents);
    }

    incidents.sort((a, b) => ts(a.startTime) - ts(b.startTime));

    return incidents;
  } catch (error) {
    logger.error('Error building UPS incident timeline', {
      error: error.message,
      options
    });
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
