import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

const systemReportSchema = new mongoose.Schema({
  reportType: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'custom'],
    required: true
  },
  
  title: {
    type: String,
    required: true
  },
  
  frequency: {
    type: Number, // Days between reports
    required: true
  },
  
  dateRange: {
    start: {
      type: Date,
      required: true
    },
    end: {
      type: Date,
      required: true
    }
  },
  
  content: {
    raw: {
      type: String, // Full markdown report
      required: true
    },
    
    // Structured data for querying/analysis
    systemStatus: {
      agentUptime: String,
      systemUptime: String,
      memoryFree: Number,
      memoryTotal: Number,
      loadAverage: [Number]
    },
    
    emailActivity: {
      received: Number,
      sent: Number,
      autoReplies: Number,
      processingRate: Number
    },
    
    aiActivity: {
      conversations: Number,
      newMemories: Number,
      mostActiveInterface: String,
      totalRequests: Number,
      totalTokens: Number,
      totalCost: Number
    },

    cryptoActivity: {
      strategy: String,
      totalPnL: Number,
      dailyPnL: Number,
      tradesExecuted: Number,
      tradesProposed: Number
    },

    mediaActivity: {
      sonarr: {
        downloaded: Number,
        monitored: Number,
        upcoming: Number
      },
      radarr: {
        downloaded: Number,
        monitored: Number,
        upcoming: Number
      }
    },

    selfImprovement: {
      total: Number,
      merged: Number,
      rejected: Number,
      successRate: Number
    },

    issues: {
      errorsLogged: Number,
      criticalIssues: Number,
      systemRestarts: Number,
      lastMaintenance: String
    },

    performance: {
      peakMemoryUsage: Number,
      avgResponseTime: Number,
      jobSuccessRate: Number
    },

    scheduledJobs: {
      summary: String,
      details: [{
        name: String,
        count: Number
      }]
    }
  },
  
  sentTo: [{
    channel: {
      type: String,
      enum: ['telegram', 'email', 'web'],
      required: true
    },
    sentAt: {
      type: Date,
      default: Date.now
    },
    success: {
      type: Boolean,
      default: true
    },
    error: String
  }],
  
  metadata: {
    generatedBy: {
      type: String,
      enum: ['scheduled', 'manual'],
      default: 'scheduled'
    },
    generationTime: Number, // ms taken to generate
    triggeredBy: String // User ID if manual
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
systemReportSchema.index({ createdAt: -1 });
systemReportSchema.index({ reportType: 1, createdAt: -1 });
systemReportSchema.index({ 'dateRange.start': -1 });
systemReportSchema.index({ 'dateRange.end': -1 });

// Caching setup
const reportCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Instance methods
systemReportSchema.methods.toSummary = function() {
  return {
    id: this._id,
    type: this.reportType,
    title: this.title,
    dateRange: this.dateRange,
    created: this.createdAt,
    performance: {
      avgResponseTime: this.content.performance.avgResponseTime,
      jobSuccessRate: this.content.performance.jobSuccessRate
    },
    issues: {
      total: (this.content.issues.errorsLogged || 0) + (this.content.issues.criticalIssues || 0),
      critical: this.content.issues.criticalIssues
    }
  };
};

// Static methods
systemReportSchema.statics.getLatestReport = function(reportType = null) {
  const query = reportType ? { reportType } : {};
  const cacheKey = `latestReport-${reportType || 'all'}`;
  const cachedReport = reportCache.get(cacheKey);
  if (cachedReport) return Promise.resolve(cachedReport);
  return retryOperation(() => this.findOne(query).sort({ createdAt: -1 }))
    .then(report => { if (report) reportCache.set(cacheKey, report); return report; });
};

systemReportSchema.statics.getReportsInRange = function(startDate, endDate, reportType = null) {
  const query = {
    'dateRange.start': { $gte: startDate },
    'dateRange.end': { $lte: endDate }
  };

  if (reportType) {
    query.reportType = reportType;
  }

  return retryOperation(() => this.find(query).sort({ createdAt: -1 }));
};

systemReportSchema.statics.getPerformanceTrends = async function(days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const reports = await retryOperation(() => this.find({
    createdAt: { $gte: startDate }
  }).sort({ createdAt: 1 }));
  
  return reports.map(report => ({
    date: report.createdAt,
    avgResponseTime: report.content.performance.avgResponseTime,
    memoryUsage: report.content.performance.peakMemoryUsage,
    errorCount: report.content.issues.errorsLogged,
    jobSuccessRate: report.content.performance.jobSuccessRate
  }));
};

systemReportSchema.statics.getAggregatedPerformanceMetrics = async function(period = 'monthly') {
  const now = new Date();
  let startDate;
  
  switch (period) {
    case 'weekly':
      startDate = new Date(now.setDate(now.getDate() - 7));
      break;
    case 'monthly':
      startDate = new Date(now.setMonth(now.getMonth() - 1));
      break;
    default:
      throw new Error('Unsupported period. Use "weekly" or "monthly".');
  }

  const aggregationPipeline = [
    { $match: { createdAt: { $gte: startDate } } },
    { $group: {
      _id: null,
      avgResponseTime: { $avg: '$content.performance.avgResponseTime' },
      peakMemoryUsage: { $avg: '$content.performance.peakMemoryUsage' },
      jobSuccessRate: { $avg: '$content.performance.jobSuccessRate' }
    }}
  ];

  const result = await retryOperation(() => this.aggregate(aggregationPipeline));
  return result.length > 0 ? result[0] : null;
};

export const SystemReport = mongoose.model('SystemReport', systemReportSchema);