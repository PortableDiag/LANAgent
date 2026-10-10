import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const MAX_SEARCH_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_COUNT_SCAN = 10000;
const SEARCHABLE_FIELDS = ['bugId', 'title', 'description', 'file', 'pattern', 'code'];

const BugReportSchema = new mongoose.Schema({
  bugId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  severity: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium'
  },
  priority: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium'
  },
  file: {
    type: String,
    required: true
  },
  line: {
    type: Number
  },
  code: {
    type: String
  },
  pattern: {
    type: String,
    required: true
  },
  fingerprint: {
    type: String,
    index: true,
    unique: true,
    sparse: true // Allow null but ensure uniqueness when present
  },
  foundBy: {
    type: String,
    default: 'agent'
  },
  foundDate: {
    type: Date,
    default: Date.now
  },
  environment: {
    type: String,
    default: 'production'
  },
  status: {
    type: String,
    enum: ['new', 'analyzing', 'in-progress', 'fixed', 'ignored', 'duplicate'],
    default: 'new'
  },
  githubIssueNumber: {
    type: Number
  },
  githubIssueUrl: {
    type: String
  },
  fixCommit: {
    type: String
  },
  fixPrUrl: {
    type: String
  },
  // Written by selfModification when it fixes a bug; without these paths Mongoose dropped them.
  fixedDate: {
    type: Date
  },
  fixedBy: {
    type: String
  },
  processedAt: {
    type: Date
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  history: {
    type: [{
      status: String,
      changedAt: Date
    }],
    default: []
  }
}, {
  timestamps: true,
  collection: 'bugreports'
});

// Indexes for performance
BugReportSchema.index({ severity: 1, status: 1 });
BugReportSchema.index({ foundDate: -1 });
BugReportSchema.index({ file: 1, line: 1 });
BugReportSchema.index({ pattern: 1 });

// Pre-save middleware to track status changes and new critical bugs
BugReportSchema.pre('save', async function(next) {
  if (this.isModified('status') && !this.isNew) {
    // Store the status change info for post-save hook
    this._statusChanged = true;
    this._previousStatus = this._original?.status || 'unknown';
    // Track status history
    this.history.push({ status: this.status, changedAt: new Date() });
  }
  // Flag new critical bugs for notification
  if (this.isNew && this.severity === 'critical') {
    this._newCritical = true;
  }
  next();
});

// Post-save hook to notify about status changes
BugReportSchema.post('save', async function(doc) {
  if (doc._statusChanged) {
    try {
      // Get the agent instance if available
      const agent = global.agent;
      if (agent && agent.notify) {
        const message = `🐛 **Bug Report Status Update**\n\n` +
                       `**Bug ID:** ${doc.bugId}\n` +
                       `**Title:** ${doc.title}\n` +
                       `**File:** ${doc.file}:${doc.line || 'unknown'}\n` +
                       `**Severity:** ${doc.severity}\n` +
                       `**Status:** ${doc._previousStatus} → ${doc.status}\n` +
                       (doc.githubIssueUrl ? `**GitHub Issue:** ${doc.githubIssueUrl}\n` : '') +
                       (doc.fixPrUrl ? `**Fix PR:** ${doc.fixPrUrl}\n` : '');

        await retryOperation(() => agent.notify(message), { retries: 3, context: 'BugReport notification' });
        logger.info(`Notified about bug report status change: ${doc.bugId} (${doc._previousStatus} → ${doc.status})`);
      } else {
        logger.info(`Bug report status changed: ${doc.bugId} (${doc._previousStatus} → ${doc.status}) - No agent available for notification`);
      }
    } catch (error) {
      logger.error('Failed to notify about bug report status change:', error);
    }

    // Clean up temporary properties
    delete doc._statusChanged;
    delete doc._previousStatus;
  }

  // Notify on new critical bug reports
  if (doc._newCritical) {
    try {
      const agent = global.agent;
      if (agent && agent.notify) {
        const message = `🚨 **Critical Bug Detected**\n\n` +
                       `**Bug ID:** ${doc.bugId}\n` +
                       `**Title:** ${doc.title}\n` +
                       `**File:** ${doc.file}:${doc.line || 'unknown'}\n` +
                       `**Pattern:** ${doc.pattern || 'unknown'}\n` +
                       (doc.description ? `**Details:** ${doc.description.substring(0, 200)}\n` : '');

        await retryOperation(() => agent.notify(message), { retries: 3, context: 'Critical BugReport notification' });
        logger.info(`Notified about new critical bug: ${doc.bugId} — ${doc.title}`);
      }
    } catch (error) {
      logger.error('Failed to notify about critical bug:', error);
    }
    delete doc._newCritical;
  }
});

// Store original values on init
BugReportSchema.pre('init', function(data) {
  this._original = data;
});

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeSearchCursor(foundDate, id) {
  return Buffer.from(JSON.stringify({
    foundDate: new Date(foundDate).toISOString(),
    id: String(id)
  }), 'utf8').toString('base64url');
}

function decodeSearchCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new TypeError('cursor must be a non-empty string');
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw new TypeError('Invalid search cursor');
  }

  const foundDate = new Date(decoded.foundDate);
  if (!decoded.id || Number.isNaN(foundDate.getTime()) || !mongoose.Types.ObjectId.isValid(decoded.id)) {
    throw new TypeError('Invalid search cursor');
  }

  return { foundDate, id: new mongoose.Types.ObjectId(decoded.id) };
}

function buildSearchMatch(criteria) {
  const matchStage = {};

  if (criteria.severity) matchStage.severity = criteria.severity;
  if (criteria.status) matchStage.status = criteria.status;
  if (criteria.environment) matchStage.environment = criteria.environment;

  if (criteria.startDate || criteria.endDate) {
    matchStage.foundDate = {};
    if (criteria.startDate) {
      const startDate = new Date(criteria.startDate);
      if (Number.isNaN(startDate.getTime())) throw new TypeError('Invalid startDate');
      matchStage.foundDate.$gte = startDate;
    }
    if (criteria.endDate) {
      const endDate = new Date(criteria.endDate);
      if (Number.isNaN(endDate.getTime())) throw new TypeError('Invalid endDate');
      matchStage.foundDate.$lte = endDate;
    }
  }

  if (criteria.metadata) {
    if (typeof criteria.metadata !== 'object' || Array.isArray(criteria.metadata)) {
      throw new TypeError('metadata must be an object');
    }
    for (const [key, value] of Object.entries(criteria.metadata)) {
      if (!key || key.startsWith('$') || key.includes('$')) {
        throw new TypeError('Invalid metadata field');
      }
      matchStage[`metadata.${key}`] = value;
    }
  }

  if (criteria.search !== undefined && criteria.search !== null && String(criteria.search).length > 0) {
    const searchExpression = new RegExp(escapeRegularExpression(criteria.search), 'i');
    const searchableFields = SEARCHABLE_FIELDS.filter((field) =>
      field !== 'code' || criteria.includeCode === true || (
        Array.isArray(criteria.fields) && criteria.fields.includes('code')
      ) || (typeof criteria.fields === 'string' && criteria.fields.split(',').map((field) => field.trim()).includes('code'))
    );

    matchStage.$or = searchableFields.map((field) => ({ [field]: searchExpression }));
  }

  return matchStage;
}

function buildCursorMatch(cursor) {
  if (!cursor) return null;

  return {
    $or: [
      { foundDate: { $lt: cursor.foundDate } },
      { foundDate: cursor.foundDate, _id: { $lt: cursor.id } }
    ]
  };
}

function getRequestedFields(fields) {
  if (fields === undefined || fields === null) return null;

  const requested = Array.isArray(fields)
    ? fields
    : String(fields).split(',').map((field) => field.trim()).filter(Boolean);

  const allowed = new Set([
    ...Object.keys(BugReportSchema.paths),
    '_id'
  ]);
  const uniqueFields = [...new Set(requested)];

  for (const field of uniqueFields) {
    if (!allowed.has(field)) {
      throw new TypeError(`Unsupported projection field: ${field}`);
    }
  }

  return uniqueFields;
}

function buildProjection(fields) {
  if (!fields) return null;

  const projection = { _id: 1, foundDate: 1 };
  for (const field of fields) projection[field] = 1;
  return projection;
}

function removeCursorFields(item, fields) {
  if (!fields) return item;

  const selected = new Set(fields);
  if (!selected.has('_id')) delete item._id;
  if (!selected.has('foundDate')) delete item.foundDate;
  return item;
}

/**
 * Advanced search using aggregation pipeline.
 * Supports filtering by severity, status, date range, environment, and metadata fields.
 */
BugReportSchema.statics.advancedSearch = async function(criteria = {}) {
  const extendedSearch = [
    'cursor',
    'limit',
    'search',
    'fields',
    'includeCounts',
    'includeCode'
  ].some((key) => Object.prototype.hasOwnProperty.call(criteria, key));

  const matchStage = buildSearchMatch(criteria);

  if (!extendedSearch) {
    try {
      return await this.aggregate([
        { $match: matchStage },
        { $sort: { foundDate: -1, _id: -1 } }
      ]).exec();
    } catch (error) {
      logger.error('Error executing advanced search:', error);
      throw error;
    }
  }

  const requestedFields = getRequestedFields(criteria.fields);
  const limitValue = criteria.limit === undefined ? DEFAULT_SEARCH_LIMIT : Number(criteria.limit);

  if (!Number.isInteger(limitValue) || limitValue < 1) {
    throw new TypeError('limit must be a positive integer');
  }

  const limit = Math.min(limitValue, MAX_SEARCH_LIMIT);
  const cursor = criteria.cursor ? decodeSearchCursor(criteria.cursor) : null;
  const cursorMatch = buildCursorMatch(cursor);
  const pagedMatch = cursorMatch
    ? { $and: [matchStage, cursorMatch] }
    : matchStage;

  const pipeline = [
    { $match: pagedMatch },
    { $sort: { foundDate: -1, _id: -1 } },
    { $limit: limit + 1 }
  ];

  const projection = buildProjection(requestedFields);
  if (projection) pipeline.push({ $project: projection });

  try {
    const results = await this.aggregate(pipeline).exec();
    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    const lastItem = page[page.length - 1];

    const items = page.map((item) => removeCursorFields(item, requestedFields));
    const nextCursor = hasMore && lastItem
      ? encodeSearchCursor(lastItem.foundDate, lastItem._id)
      : null;

    let counts = null;
    if (criteria.includeCounts === true) {
      const countResult = await this.aggregate([
        { $match: matchStage },
        { $limit: MAX_COUNT_SCAN },
        {
          $facet: {
            status: [
              { $group: { _id: '$status', count: { $sum: 1 } } },
              { $sort: { _id: 1 } }
            ],
            severity: [
              { $group: { _id: '$severity', count: { $sum: 1 } } },
              { $sort: { _id: 1 } }
            ]
          }
        }
      ]).exec();

      const facet = countResult[0] || { status: [], severity: [] };
      counts = {
        status: Object.fromEntries(facet.status.map((entry) => [entry._id, entry.count])),
        severity: Object.fromEntries(facet.severity.map((entry) => [entry._id, entry.count]))
      };
    }

    return {
      items,
      nextCursor,
      hasMore,
      counts
    };
  } catch (error) {
    logger.error('Error executing advanced search:', error);
    throw error;
  }
};

/**
 * Allowed status transitions for bug lifecycle.
 * Any open status may go straight to 'fixed' — self-modification marks bugs
 * fixed without passing through analyzing/in-progress. Closed statuses can be
 * reopened to 'new' (a regression, or an ignore/duplicate call that was wrong).
 * @type {Object<string, string[]>}
 */
BugReportSchema.statics.transitionMap = {
  'new': ['analyzing', 'in-progress', 'fixed', 'ignored', 'duplicate'],
  'analyzing': ['new', 'in-progress', 'fixed', 'ignored', 'duplicate'],
  'in-progress': ['new', 'analyzing', 'fixed', 'ignored', 'duplicate'],
  'fixed': ['new'],
  'ignored': ['new'],
  'duplicate': ['new']
};

/**
 * Atomically transition a bug report to a new status if the transition is allowed.
 * Uses findOneAndUpdate with a condition that the current status is in the allowed list.
 * Logs and notifies on successful transition.
 *
 * @param {string} bugId - The bug report ID.
 * @param {string} newStatus - The target status.
 * @returns {Promise<Object|null>} The updated bug report document, or null if transition not allowed or bug not found.
 */
BugReportSchema.statics.transitionStatus = async function(bugId, newStatus) {
  const allowed = this.transitionMap;
  // Build list of statuses that can transition to newStatus
  const allowedFromStatuses = Object.entries(allowed)
    .filter(([_, targets]) => targets.includes(newStatus))
    .map(([status]) => status);

  if (allowedFromStatuses.length === 0) {
    // No status can transition to newStatus, so it's invalid.
    logger.warn(`Transition to '${newStatus}' is not allowed from any status for bug ${bugId}`);
    return null;
  }

  const updatedDoc = await this.findOneAndUpdate(
    {
      bugId,
      status: { $in: allowedFromStatuses }
    },
    {
      $set: { status: newStatus },
      $push: { history: { status: newStatus, changedAt: new Date() } }
    },
    { new: true, runValidators: true }
  );

  if (!updatedDoc) {
    logger.warn(`Failed to transition bug ${bugId} to '${newStatus}': either bug not found or current status not allowed`);
    return null;
  }

  logger.info(`Bug ${bugId} transitioned to '${newStatus}'`);

  // Notify about the status change
  try {
    const agent = global.agent;
    if (agent && agent.notify) {
      const message = `🐛 **Bug Report Status Update**\n\n` +
                     `**Bug ID:** ${updatedDoc.bugId}\n` +
                     `**Title:** ${updatedDoc.title}\n` +
                     `**File:** ${updatedDoc.file}:${updatedDoc.line || 'unknown'}\n` +
                     `**Severity:** ${updatedDoc.severity}\n` +
                     `**Status:** → ${newStatus}\n` +
                     (updatedDoc.githubIssueUrl ? `**GitHub Issue:** ${updatedDoc.githubIssueUrl}\n` : '') +
                     (updatedDoc.fixPrUrl ? `**Fix PR:** ${updatedDoc.fixPrUrl}\n` : '');

      await retryOperation(() => agent.notify(message), { retries: 3, context: 'BugReport transition notification' });
      logger.info(`Notified about bug report status transition: ${updatedDoc.bugId} → ${newStatus}`);
    }
  } catch (error) {
    logger.error('Failed to notify about bug report status transition:', error);
  }

  return updatedDoc;
};

export const BugReport = mongoose.model('BugReport', BugReportSchema);
