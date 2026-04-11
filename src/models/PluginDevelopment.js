import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { safeJsonStringify } from '../utils/jsonUtils.js';

const pluginDevelopmentSchema = new mongoose.Schema({
  api: {
    type: String,
    required: true,
    index: true
  },
  branchName: {
    type: String,
    sparse: true
  },
  prUrl: {
    type: String,
    sparse: true
  },
  status: {
    type: String,
    enum: ['in_progress', 'completed', 'failed', 'postponed', 'rejected'],
    default: 'in_progress',
    required: true
  },
  error: {
    type: String
  },
  apiDetails: {
    name: String,
    description: String,
    category: String,
    documentation: String,
    features: [String],
    evaluation: {
      score: Number,
      pros: [String],
      cons: [String]
    }
  },
  pluginCode: {
    type: String
  },
  testCode: {
    type: String
  },
  rejectionFeedback: {
    prNumber: Number,
    closedAt: Date,
    rejectionReasons: [String],
    suggestions: [String],
    comments: [{
      author: String,
      body: String,
      createdAt: Date
    }]
  },
  previousAttempts: [{
    prNumber: Number,
    branchName: String,
    attemptedAt: Date,
    status: String,
    rejectionReason: String
  }],
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  completedAt: {
    type: Date
  },
  version: {
    type: String,
    required: true,
    default: '1.0.0'
  },
  versionHistory: [{
    version: String,
    changes: String,
    updatedAt: Date
  }]
});

// Index for efficient queries
pluginDevelopmentSchema.index({ createdAt: -1 });
pluginDevelopmentSchema.index({ status: 1, createdAt: -1 });
pluginDevelopmentSchema.index({ status: 1, completedAt: -1 });

/**
 * Generate a summary report of plugin development status and history.
 * Aggregates data from 'status', 'previousAttempts', and 'rejectionFeedback'.
 * @returns {Object} Summary report object.
 */
pluginDevelopmentSchema.methods.generateSummaryReport = function() {
  try {
    const summary = {
      currentStatus: this.status,
      previousAttempts: this.previousAttempts.map(attempt => ({
        prNumber: attempt.prNumber,
        branchName: attempt.branchName,
        attemptedAt: attempt.attemptedAt,
        status: attempt.status,
        rejectionReason: attempt.rejectionReason
      })),
      rejectionFeedback: this.rejectionFeedback ? {
        prNumber: this.rejectionFeedback.prNumber,
        closedAt: this.rejectionFeedback.closedAt,
        rejectionReasons: this.rejectionFeedback.rejectionReasons,
        suggestions: this.rejectionFeedback.suggestions,
        comments: this.rejectionFeedback.comments.map(comment => ({
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt
        }))
      } : null
    };
    return summary;
  } catch (error) {
    logger.error('Error generating summary report:', error);
    throw new Error('Failed to generate summary report');
  }
};

/**
 * Calculate average time to completion for completed plugins.
 * @returns {Number} Average time in milliseconds.
 */
pluginDevelopmentSchema.methods.calculateAverageCompletionTime = function() {
  try {
    const completedAttempts = this.previousAttempts.filter(attempt => attempt.status === 'completed');
    if (completedAttempts.length === 0) return 0;

    const totalTime = completedAttempts.reduce((total, attempt) => {
      const timeTaken = new Date(attempt.completedAt) - new Date(attempt.attemptedAt);
      return total + timeTaken;
    }, 0);

    return totalTime / completedAttempts.length;
  } catch (error) {
    logger.error('Error calculating average completion time:', error);
    throw new Error('Failed to calculate average completion time');
  }
};

/**
 * Generate analytics report for plugin development.
 * Includes metrics like average time to completion, success rates, and common rejection reasons.
 * @returns {Object} Analytics report object.
 */
pluginDevelopmentSchema.methods.generateAnalyticsReport = function() {
  try {
    const totalAttempts = this.previousAttempts.length;
    const completedAttempts = this.previousAttempts.filter(attempt => attempt.status === 'completed').length;
    const failedAttempts = this.previousAttempts.filter(attempt => attempt.status === 'failed').length;
    const rejectionReasons = this.previousAttempts.reduce((acc, attempt) => {
      if (attempt.rejectionReason) {
        acc[attempt.rejectionReason] = (acc[attempt.rejectionReason] || 0) + 1;
      }
      return acc;
    }, {});

    const analytics = {
      averageCompletionTime: this.calculateAverageCompletionTime(),
      successRate: totalAttempts ? (completedAttempts / totalAttempts) * 100 : 0,
      failureRate: totalAttempts ? (failedAttempts / totalAttempts) * 100 : 0,
      commonRejectionReasons: rejectionReasons
    };

    return analytics;
  } catch (error) {
    logger.error('Error generating analytics report:', error);
    throw new Error('Failed to generate analytics report');
  }
};

/**
 * Add a new version entry to the version history.
 * @param {String} version - The new version number.
 * @param {String} changes - Description of changes in this version.
 */
pluginDevelopmentSchema.methods.addVersion = function(version, changes) {
  try {
    this.version = version;
    this.versionHistory.push({
      version,
      changes,
      updatedAt: new Date()
    });
  } catch (error) {
    logger.error('Error adding version:', error);
    throw new Error('Failed to add version');
  }
};

/**
 * Retrieve the version history.
 * @returns {Array} List of version history entries.
 */
pluginDevelopmentSchema.methods.getVersionHistory = function() {
  try {
    return this.versionHistory;
  } catch (error) {
    logger.error('Error retrieving version history:', error);
    throw new Error('Failed to retrieve version history');
  }
};

/**
 * Compare two versions and return the differences.
 * @param {String} version1 - The first version number.
 * @param {String} version2 - The second version number.
 * @returns {Object} Differences between the two versions.
 */
pluginDevelopmentSchema.methods.compareVersions = function(version1, version2) {
  try {
    const v1 = this.versionHistory.find(v => v.version === version1);
    const v2 = this.versionHistory.find(v => v.version === version2);

    if (!v1 || !v2) {
      throw new Error('One or both versions not found');
    }

    return {
      version1: v1,
      version2: v2,
      differences: {
        changes: v1.changes !== v2.changes ? { v1: v1.changes, v2: v2.changes } : null
      }
    };
  } catch (error) {
    logger.error('Error comparing versions:', error);
    throw new Error('Failed to compare versions');
  }
};

/**
 * Generate detailed plugin documentation based on the schema and code.
 * @returns {String} Generated documentation in markdown format.
 */
pluginDevelopmentSchema.methods.generatePluginDocumentation = function() {
  try {
    const obj = this.toObject();
    const schemaJson = safeJsonStringify(obj, 2);
    const documentation = `# Plugin Documentation

## API: ${obj.api || 'Unknown'}

## Status: ${obj.status || 'Unknown'}

## Details
${obj.apiDetails ? `
- **Name**: ${obj.apiDetails.name || 'N/A'}
- **Description**: ${obj.apiDetails.description || 'N/A'}
- **Category**: ${obj.apiDetails.category || 'N/A'}
` : 'No details available'}

## Schema
\`\`\`json
${schemaJson}
\`\`\`
`;
    return documentation;
  } catch (error) {
    logger.error('Error generating plugin documentation:', error);
    throw new Error('Failed to generate plugin documentation');
  }
};

/**
 * Generate a changelog in markdown format based on version history.
 * @returns {String} Changelog in markdown format.
 */
pluginDevelopmentSchema.methods.generateChangelog = function() {
  try {
    if (!this.versionHistory || this.versionHistory.length === 0) {
      return 'No version history available.';
    }

    const changelog = this.versionHistory.map(entry => {
      return `## Version ${entry.version} - ${entry.updatedAt.toISOString().split('T')[0]}\n\n${entry.changes}\n`;
    }).join('\n');

    return `# Changelog\n\n${changelog}`;
  } catch (error) {
    logger.error('Error generating changelog:', error);
    throw new Error('Failed to generate changelog');
  }
};

export const PluginDevelopment = mongoose.model('PluginDevelopment', pluginDevelopmentSchema);