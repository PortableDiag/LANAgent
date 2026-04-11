import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

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

/**
 * Advanced search using aggregation pipeline.
 * Supports filtering by severity, status, date range, and environment.
 */
BugReportSchema.statics.advancedSearch = async function(criteria) {
  const matchStage = {};
  if (criteria.severity) matchStage.severity = criteria.severity;
  if (criteria.status) matchStage.status = criteria.status;
  if (criteria.environment) matchStage.environment = criteria.environment;
  if (criteria.startDate || criteria.endDate) {
    matchStage.foundDate = {};
    if (criteria.startDate) matchStage.foundDate.$gte = new Date(criteria.startDate);
    if (criteria.endDate) matchStage.foundDate.$lte = new Date(criteria.endDate);
  }

  try {
    return await this.aggregate([
      { $match: matchStage },
      { $sort: { foundDate: -1 } }
    ]).exec();
  } catch (error) {
    logger.error('Error executing advanced search:', error);
    throw error;
  }
};

export const BugReport = mongoose.model('BugReport', BugReportSchema);