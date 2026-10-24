import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

// Per-agent settings cache (process-local, MongoDB remains source of truth).
const settingsCache = new NodeCache({ stdTTL: 30, checkperiod: 60, useClones: false });

const prReviewSettingsSchema = new mongoose.Schema({
  agentId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  enabled: {
    type: Boolean,
    default: false
  },
  schedule: {
    type: String,
    default: '0 9,21 * * *' // 9 AM and 9 PM
  },
  timeZone: {
    type: String,
    default: 'UTC'
  },
  excludeWeekends: {
    type: Boolean,
    default: false
  },
  excludeHolidays: {
    type: [String], // List of holiday dates in 'YYYY-MM-DD' format
    default: []
  },
  aiProvider: {
    type: String,
    default: 'anthropic'
  },
  aiModel: {
    type: String,
    default: 'claude-opus-4-5-20251101'
  },
  autoMerge: {
    type: Boolean,
    default: true
  },
  autoImplement: {
    type: Boolean,
    default: true
  },
  createPRsForImplementations: {
    type: Boolean,
    default: true
  },
  deployAfterMerge: {
    type: Boolean,
    default: true
  },
  rollbackOnFailure: {
    type: Boolean,
    default: true
  },
  reviewOnlyBotPRs: {
    type: Boolean,
    default: false
  },
  maxPRsPerRun: {
    type: Number,
    default: 10
  },
  requireTests: {
    type: Boolean,
    default: false
  },
  commentOnPRs: {
    type: Boolean,
    default: true
  },
  verboseComments: {
    type: Boolean,
    default: true
  },
  lastReview: Date,
  stats: {
    totalReviewed: {
      type: Number,
      default: 0
    },
    merged: {
      type: Number,
      default: 0
    },
    rejected: {
      type: Number,
      default: 0
    },
    implemented: {
      type: Number,
      default: 0
    },
    deployments: {
      type: Number,
      default: 0
    },
    rollbacks: {
      type: Number,
      default: 0
    },
    errors: {
      type: Number,
      default: 0
    },
    lastError: String,
    reviewHistoryMax: { type: Number, default: 200 },
    reviewHistory: [{
      prNumber: Number,
      title: String,
      action: String,
      reason: String,
      timestamp: Date
    }]
  }
}, {
  timestamps: true
});

const prReviewHistorySchema = new mongoose.Schema({
  agentId: {
    type: String,
    required: true,
    index: true
  },
  prNumber: {
    type: Number,
    required: true
  },
  title: String,
  author: String,
  action: {
    type: String,
    enum: ['merge', 'reject', 'implement', 'error'],
    required: true
  },
  reason: String,
  details: String,
  issues: [String],
  suggestions: [String],
  aiProvider: String,
  aiModel: String,
  deploymentStatus: {
    type: String,
    enum: ['none', 'success', 'failed', 'rolled_back']
  },
  error: String,
  reviewTime: {
    type: Number, // milliseconds
    required: true
  },
  // Unique run identifier — when provided, dedupe upserts by this key
  runId: { type: String, unique: true, sparse: true, index: true },
  attemptCount: { type: Number, default: 0 },
  lastAttemptAt: Date
}, {
  timestamps: true
});

// Index for efficient queries
prReviewHistorySchema.index({ agentId: 1, createdAt: -1 });
prReviewHistorySchema.index({ prNumber: 1 });
prReviewHistorySchema.index({ agentId: 1, prNumber: 1, createdAt: -1 });

/**
 * Atomically increment stats counters and append a bounded history entry on PRReviewSettings.
 * Uses $inc for counters and $push with $slice for bounded array growth.
 */
prReviewSettingsSchema.statics.updateStatsAtomic = async function updateStatsAtomic(agentId, deltas = {}, historyEntry = null) {
  const op = async () => {
    let settings = settingsCache.get(agentId);
    if (!settings) {
      settings = await this.findOne({ agentId }).lean();
      if (settings) settingsCache.set(agentId, settings);
    }
    const max = (settings?.stats?.reviewHistoryMax) || 200;

    const update = {};
    const $inc = {};
    for (const [k, v] of Object.entries(deltas)) {
      if (typeof v === 'number' && !Number.isNaN(v)) $inc[`stats.${k}`] = v;
    }
    if (Object.keys($inc).length > 0) update.$inc = $inc;
    if (historyEntry) {
      update.$push = { 'stats.reviewHistory': { $each: [historyEntry], $slice: -max } };
    }
    if (Object.keys(update).length === 0) return settings || null;

    const updated = await this.findOneAndUpdate({ agentId }, update, { new: true, upsert: true }).lean();
    if (updated) settingsCache.set(agentId, updated);
    return updated;
  };
  try {
    return await retryOperation(op, { retries: 3 });
  } catch (err) {
    logger.error('PRReviewSettings.updateStatsAtomic failed', { agentId, deltas, err: err?.message });
    throw err;
  }
};

/**
 * Record an outcome row with optional runId-based dedup, then atomically update settings counters.
 */
prReviewHistorySchema.statics.recordOutcome = async function recordOutcome(params) {
  const {
    agentId, prNumber, title, author, action, reason, details, issues, suggestions,
    aiProvider, aiModel, deploymentStatus, error, reviewTime, runId
  } = params || {};

  if (!agentId || typeof prNumber !== 'number' || !action || typeof reviewTime !== 'number') {
    const err = new Error('Missing required fields: agentId, prNumber (Number), action, reviewTime (Number)');
    logger.error('PRReviewHistory.recordOutcome validation error', { params, error: err.message });
    throw err;
  }

  const payload = { agentId, prNumber, title, author, action, reason, details, issues, suggestions, aiProvider, aiModel, deploymentStatus, error, reviewTime };
  const attemptFields = { $inc: { attemptCount: 1 }, $set: { lastAttemptAt: new Date() } };

  const upsertOp = async () => {
    if (runId) {
      return await this.findOneAndUpdate(
        { runId },
        { $setOnInsert: { ...payload, runId }, ...attemptFields },
        { new: true, upsert: true }
      ).lean();
    }
    const created = await this.create({ ...payload, attemptCount: 1, lastAttemptAt: new Date() });
    return created.toObject ? created.toObject() : created;
  };

  let historyDoc;
  try {
    historyDoc = await retryOperation(upsertOp, { retries: 3 });
  } catch (err) {
    logger.error('PRReviewHistory.recordOutcome persistence failed', { agentId, prNumber, runId, error: err?.message });
    try {
      await PRReviewSettings.updateStatsAtomic(agentId,
        { errors: 1, totalReviewed: action === 'error' ? 1 : 0 },
        { prNumber, title: title || '', action: 'error', reason: (reason || error || 'persistence_failed').toString(), timestamp: new Date() }
      );
    } catch (inner) {
      logger.error('PRReviewHistory.recordOutcome failed to update settings after persistence error', { agentId, prNumber, error: inner?.message });
    }
    throw err;
  }

  const deltas = { totalReviewed: 1 };
  switch (action) {
    case 'merge':     deltas.merged = 1; break;
    case 'reject':    deltas.rejected = 1; break;
    case 'implement': deltas.implemented = 1; break;
    case 'error':     deltas.errors = 1; break;
  }
  if (deploymentStatus === 'success') deltas.deployments = 1;
  else if (deploymentStatus === 'rolled_back') deltas.rollbacks = 1;

  const historyEntry = { prNumber, title: title || '', action, reason: reason || '', timestamp: new Date() };

  try {
    await PRReviewSettings.updateStatsAtomic(agentId, deltas, historyEntry);
  } catch (err) {
    logger.error('PRReviewHistory.recordOutcome failed to update settings counters', { agentId, prNumber, action, error: err?.message });
    // Don't throw — history row already persisted; counters can be repaired later
  }

  return historyDoc;
};

/**
 * Retrieve paginated PR review history with optional filters.
 *
 * @param {Object} options
 * @param {string} [options.agentId] - Filter by agent identifier.
 * @param {string} [options.action] - Filter by action (merge, reject, implement, error).
 * @param {Date|string} [options.startDate] - Inclusive lower bound on createdAt.
 * @param {Date|string} [options.endDate] - Inclusive upper bound on createdAt.
 * @param {number} [options.page=1] - Page number (1-based).
 * @param {number} [options.limit=20] - Number of documents per page.
 * @param {string} [options.sort='-createdAt'] - Sort field(s) in Mongoose format.
 * @returns {Promise<{ data: Array, total: number, page: number, totalPages: number }>}
 */
prReviewHistorySchema.statics.getHistory = async function getHistory(options = {}) {
  const {
    agentId,
    action,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sort = '-createdAt'
  } = options;

  const filter = {};
  if (agentId) filter.agentId = String(agentId);
  if (action) filter.action = String(action);
  // An unparseable date would reach Mongo as Invalid Date and fail the query (or match nothing)
  // without saying why; reject it here with the value that was wrong.
  const toDate = (v, name) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${name}: ${v}`);
    return d;
  };
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = toDate(startDate, 'startDate');
    if (endDate) filter.createdAt.$lte = toDate(endDate, 'endDate');
  }
  // Sort is caller-supplied: only fields the schema indexes or carries, ascending or descending.
  const SORTABLE = new Set(['createdAt', 'updatedAt', 'prNumber', 'action', 'reviewTime']);
  const sortKey = String(sort || '').replace(/^-/, '');
  const safeSort = SORTABLE.has(sortKey) ? String(sort) : '-createdAt';

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const queryOp = async () => {
    const [data, total] = await Promise.all([
      this.find(filter).sort(safeSort).skip(skip).limit(limitNum).lean(),
      this.countDocuments(filter)
    ]);
    return { data, total };
  };

  try {
    const { data, total } = await retryOperation(queryOp, { retries: 3, context: 'PRReviewHistory.getHistory' });
    const totalPages = Math.ceil(total / limitNum) || 1;
    return { data, total, page: pageNum, totalPages };
  } catch (err) {
    logger.error('PRReviewHistory.getHistory failed', { options, error: err?.message });
    throw err;
  }
};

export const PRReviewSettings = mongoose.model('PRReviewSettings', prReviewSettingsSchema);
export const PRReviewHistory = mongoose.model('PRReviewHistory', prReviewHistorySchema);
