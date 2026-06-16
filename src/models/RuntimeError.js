import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import { safeJsonParse } from '../utils/jsonUtils.js';

const runtimeErrorSchema = new mongoose.Schema({
  fingerprint: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    enum: ['runtime', 'scan_position'],
    default: 'runtime'
  },
  severity: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium'
  },
  message: {
    type: String,
    required: true
  },
  file: {
    type: String,
    required: true
  },
  line: {
    type: Number
  },
  timestamp: {
    type: Date,
    required: true,
    index: true
  },
  context: {
    type: String
  },
  pattern: {
    type: String
  },
  occurrences: {
    type: Number,
    default: 1
  },
  firstSeen: {
    type: Date,
    required: true
  },
  lastSeen: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['new', 'acknowledged', 'investigating', 'resolved', 'ignored', 'github-issue-created'],
    default: 'new',
    index: true
  },
  resolution: {
    type: String
  },
  relatedBugReport: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BugReport'
  },
  githubIssueNumber: {
    type: Number,
    sparse: true
  },
  githubIssueUrl: {
    type: String
  },
  source: {
    type: String,
    enum: ['log_scanner', 'manual', 'api'],
    default: 'log_scanner'
  },
  data: {
    type: mongoose.Schema.Types.Mixed
  },
  category: {
    type: String
  },
  correlationId: {
    type: String,
    index: true
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
runtimeErrorSchema.index({ timestamp: -1 });
runtimeErrorSchema.index({ severity: 1, status: 1 });
runtimeErrorSchema.index({ file: 1, line: 1 });

// Virtual for age of error
runtimeErrorSchema.virtual('age').get(function() {
  return Date.now() - this.timestamp;
});

// Method to check if error is recent
runtimeErrorSchema.methods.isRecent = function(hours = 24) {
  const hoursAgo = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.timestamp >= hoursAgo;
};

// Add cache property to class (in constructor)
runtimeErrorSchema.statics.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

// Static method to get error trends with caching and retry logic
runtimeErrorSchema.statics.getErrorTrends = async function(days = 7) {
  const cacheKey = `errorTrends-${days}`;
  const cachedTrends = this.cache.get(cacheKey);
  if (cachedTrends !== undefined) {
    return cachedTrends;
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const fetchTrends = async () => {
    return await this.aggregate([
      {
        $match: {
          type: 'runtime',
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            severity: '$severity'
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.date': 1 }
      }
    ]);
  };

  const trends = await retryOperation(fetchTrends, { retries: 3, factor: 2, minTimeout: 1000 });
  this.cache.set(cacheKey, trends);
  return trends;
};

/**
 * Categorize the error based on historical data and patterns.
 * @returns {Promise<void>}
 */
runtimeErrorSchema.methods.categorizeError = async function() {
  try {
    const historicalErrors = await this.constructor.find({ pattern: this.pattern });
    const categoryCounts = {};

    historicalErrors.forEach(error => {
      if (error.category) {
        categoryCounts[error.category] = (categoryCounts[error.category] || 0) + 1;
      }
    });

    const mostCommonCategory = Object.keys(categoryCounts).reduce((a, b) => categoryCounts[a] > categoryCounts[b] ? a : b, null);

    this.category = mostCommonCategory || 'uncategorized';
    await this.save();
  } catch (error) {
    logger.error('Error categorizing runtime error:', error);
  }
};

/**
 * Retrieve all errors related to a specific correlation ID.
 * @param {String} correlationId - The correlation ID to search for.
 * @returns {Promise<Array>} - An array of related errors.
 */
runtimeErrorSchema.statics.getErrorsByCorrelationId = async function(correlationId) {
  try {
    return await this.find({ correlationId });
  } catch (error) {
    logger.error('Error retrieving errors by correlation ID:', error);
    throw error;
  }
};

const RuntimeError = mongoose.model('RuntimeError', runtimeErrorSchema);

export default RuntimeError;
