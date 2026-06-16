import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

/**
 * HealingEvent Model
 * Tracks all self-healing/auto-remediation actions taken by the system
 */
const healingEventSchema = new mongoose.Schema({
  // Event identification
  eventType: {
    type: String,
    required: true,
    enum: [
      'service_restart',
      'memory_cleanup',
      'disk_cleanup',
      'connection_reset',
      'cache_clear',
      'log_rotation',
      'process_kill',
      'db_reconnect',
      'certificate_renewal',
      'job_retry',
      'custom'
    ]
  },

  // What triggered the healing action
  trigger: {
    type: {
      type: String,
      enum: ['threshold', 'error', 'scheduled', 'manual', 'pattern'],
      required: true
    },
    source: String, // e.g., 'memory_monitor', 'error_scanner', 'api'
    condition: String, // e.g., 'memory > 90%', 'connection_lost'
    value: mongoose.Schema.Types.Mixed // The actual value that triggered
  },

  // Action details
  action: {
    name: { type: String, required: true },
    command: String, // The actual command or method executed
    parameters: mongoose.Schema.Types.Mixed,
    targetService: String // e.g., 'mongodb', 'telegram', 'pm2'
  },

  // Result
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'success', 'failed', 'skipped'],
    default: 'pending'
  },

  result: {
    success: Boolean,
    message: String,
    output: String,
    error: String,
    metrics: {
      before: mongoose.Schema.Types.Mixed,
      after: mongoose.Schema.Types.Mixed,
      improvement: mongoose.Schema.Types.Mixed
    }
  },

  // Timing
  startedAt: Date,
  completedAt: Date,
  duration: Number, // milliseconds

  // Safety tracking
  cooldownExpires: Date, // When this type of action can be taken again
  attemptNumber: { type: Number, default: 1 }, // Which attempt this is

  // Context
  systemState: {
    memoryUsage: Number,
    cpuUsage: Number,
    diskUsage: Number,
    uptime: Number,
    loadAverage: [Number]
  },

  // Metadata
  notes: String,
  acknowledged: { type: Boolean, default: false },
  acknowledgedBy: String,
  acknowledgedAt: Date

}, {
  timestamps: true
});

// Indexes
healingEventSchema.index({ eventType: 1, createdAt: -1 });
healingEventSchema.index({ status: 1 });
healingEventSchema.index({ 'trigger.source': 1 });
healingEventSchema.index({ createdAt: -1 });

// Caching setup
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Instance methods
healingEventSchema.methods.start = async function() {
  this.status = 'in_progress';
  this.startedAt = new Date();
  await this.save();
  logger.info(`HealingEvent started: ${this._id}`, { event: this });
};

healingEventSchema.methods.complete = async function(success, message, output = null) {
  this.status = success ? 'success' : 'failed';
  this.completedAt = new Date();
  this.duration = this.completedAt - this.startedAt;
  this.result = {
    success,
    message,
    output: output ? String(output).substring(0, 5000) : null
  };
  await this.save();
  logger.info(`HealingEvent completed: ${this._id}`, { event: this });
};

healingEventSchema.methods.fail = async function(error) {
  const retryStrategy = {
    retries: 3,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 5000,
    randomize: true
  };

  try {
    await retryOperation(async () => {
      this.status = 'failed';
      this.completedAt = new Date();
      this.duration = this.startedAt ? this.completedAt - this.startedAt : 0;
      this.result = {
        success: false,
        error: error.message || String(error)
      };
      await this.save();
      logger.error(`HealingEvent failed: ${this._id}`, { event: this });
    }, retryStrategy);
  } catch (retryError) {
    logger.error(`Failed to save HealingEvent after retries: ${retryError.message}`);
  }
};

healingEventSchema.methods.skip = async function(reason) {
  this.status = 'skipped';
  this.result = {
    success: false,
    message: reason
  };
  await this.save();
  logger.info(`HealingEvent skipped: ${this._id}`, { event: this });
};

// Static methods
healingEventSchema.statics.getRecentByType = function(eventType, hours = 1) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.find({
    eventType,
    createdAt: { $gte: since }
  }).sort({ createdAt: -1 });
};

healingEventSchema.statics.countRecentByType = function(eventType, hours = 1) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.countDocuments({
    eventType,
    createdAt: { $gte: since }
  });
};

healingEventSchema.statics.getStats = async function(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const stats = await this.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { eventType: '$eventType', status: '$status' },
        count: { $sum: 1 }
      }
    }
  ]);

  const summary = {
    total: 0,
    byType: {},
    byStatus: { success: 0, failed: 0, skipped: 0, pending: 0, in_progress: 0 }
  };

  for (const stat of stats) {
    const type = stat._id.eventType;
    const status = stat._id.status;

    if (!summary.byType[type]) {
      summary.byType[type] = { total: 0, success: 0, failed: 0 };
    }

    summary.byType[type].total += stat.count;
    summary.byType[type][status] = (summary.byType[type][status] || 0) + stat.count;
    summary.byStatus[status] += stat.count;
    summary.total += stat.count;
  }

  return summary;
};

healingEventSchema.statics.isInCooldown = async function(eventType, cooldownMinutes = 5) {
  const cacheKey = `cooldown_${eventType}`;
  const cachedCooldown = cache.get(cacheKey);

  if (cachedCooldown) {
    return true;
  }

  const since = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  const recentEvent = await this.findOne({
    eventType,
    createdAt: { $gte: since },
    status: { $in: ['success', 'in_progress'] }
  });

  if (recentEvent) {
    cache.set(cacheKey, true, cooldownMinutes * 60);
    return true;
  }

  return false;
};

/**
 * Scoped cooldown check across (eventType, action.targetService, trigger.condition).
 * Cache-first to avoid repeated DB scans during burst attempts; on positive DB hit,
 * caches the cooldown for the remaining window.
 */
healingEventSchema.statics.isInCooldownScoped = async function(eventType, targetService = null, condition = null, cooldownMinutes = 5) {
  const cacheKey = `cooldown:${eventType || 'any'}:${targetService || 'any'}:${condition || 'any'}`;

  try {
    if (cache.get(cacheKey)) {
      logger.debug(`Cooldown cache hit for key=${cacheKey}`);
      return true;
    }
  } catch (err) {
    logger.warn(`Cooldown cache get error for key=${cacheKey}: ${err.message}`);
  }

  const since = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  const query = {
    eventType,
    createdAt: { $gte: since },
    status: { $in: ['success', 'in_progress'] }
  };
  if (targetService) query['action.targetService'] = targetService;
  if (condition)     query['trigger.condition']    = condition;

  try {
    const recent = await retryOperation(
      async () => this.findOne(query).sort({ createdAt: -1 }),
      { retries: 3 }
    );
    if (recent) {
      try { cache.set(cacheKey, true, cooldownMinutes * 60); }
      catch (setErr) { logger.warn(`Cooldown cache set error for key=${cacheKey}: ${setErr.message}`); }
      logger.info(`Scoped cooldown active for ${cacheKey}`, { eventType, targetService: targetService || null, condition: condition || null, cooldownMinutes });
      return true;
    }
  } catch (dbErr) {
    logger.error(`Error checking scoped cooldown for ${cacheKey}: ${dbErr.message}`, { error: dbErr });
  }

  return false;
};

/**
 * Manually arm a scoped cooldown in cache without a DB write. Useful when a
 * caller wants to suppress further attempts after a one-off operation.
 */
healingEventSchema.statics.setCooldownScoped = function(eventType, targetService = null, condition = null, minutes = 5) {
  const cacheKey = `cooldown:${eventType || 'any'}:${targetService || 'any'}:${condition || 'any'}`;
  const ttl = Math.max(1, Number(minutes) || 5) * 60;
  try {
    cache.set(cacheKey, true, ttl);
    logger.info(`Scoped cooldown set for ${cacheKey} (ttl=${ttl}s)`);
    return true;
  } catch (err) {
    logger.error(`Failed to set scoped cooldown for ${cacheKey}: ${err.message}`, { error: err });
    return false;
  }
};

// Virtual for display
healingEventSchema.virtual('displayStatus').get(function() {
  const icons = {
    pending: '⏳',
    in_progress: '🔄',
    success: '✅',
    failed: '❌',
    skipped: '⏭️'
  };
  return `${icons[this.status] || '❓'} ${this.status}`;
});

// Transform for JSON output
healingEventSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

const HealingEvent = mongoose.model('HealingEvent', healingEventSchema);

export default HealingEvent;
