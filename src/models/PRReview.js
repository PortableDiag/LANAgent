import mongoose from 'mongoose';

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
  }
}, {
  timestamps: true
});

// Index for efficient queries
prReviewHistorySchema.index({ agentId: 1, createdAt: -1 });
prReviewHistorySchema.index({ prNumber: 1 });

export const PRReviewSettings = mongoose.model('PRReviewSettings', prReviewSettingsSchema);
export const PRReviewHistory = mongoose.model('PRReviewHistory', prReviewHistorySchema);