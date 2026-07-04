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

/**
 * Compare system performance between two time periods
 * @param {Date} period1Start - Start date of first period
 * @param {Date} period1End - End date of first period
 * @param {Date} period2Start - Start date of second period
 * @param {Date} period2End - End date of second period
 * @param {Array} metrics - Array of metric names to compare
 * @returns {Object} Comparison results with percentage changes and trends
 */
systemReportSchema.statics.getPerformanceComparison = async function(
  period1Start, 
  period1End, 
  period2Start, 
  period2End, 
  metrics = []
) {
  // Validate date ranges
  if (period1Start >= period1End || period2Start >= period2End) {
    throw new Error('Invalid date ranges: start date must be before end date');
  }

  // Validate metrics if provided
  const validMetrics = [
    'avgResponseTime',
    'peakMemoryUsage',
    'jobSuccessRate',
    'errorsLogged',
    'criticalIssues',
    'conversations',
    'totalRequests',
    'totalTokens',
    'received',
    'sent',
    'tradesExecuted',
    'totalPnL'
  ];

  if (metrics.length > 0) {
    const invalidMetrics = metrics.filter(metric => !validMetrics.includes(metric));
    if (invalidMetrics.length > 0) {
      throw new Error(`Invalid metrics: ${invalidMetrics.join(', ')}`);
    }
  }

  // Get reports for both periods
  const reportsPeriod1 = await retryOperation(() => 
    this.find({
      'dateRange.start': { $gte: period1Start },
      'dateRange.end': { $lte: period1End }
    }).sort({ createdAt: 1 })
  );

  const reportsPeriod2 = await retryOperation(() => 
    this.find({
      'dateRange.start': { $gte: period2Start },
      'dateRange.end': { $lte: period2End }
    }).sort({ createdAt: 1 })
  );

  if (reportsPeriod1.length === 0 || reportsPeriod2.length === 0) {
    throw new Error('No reports found for one or both periods');
  }

  // Calculate averages for each period
  const calculateAverages = (reports) => {
    const totals = {};
    const counts = {};

    reports.forEach(report => {
      const content = report.content;
      
      // Performance metrics
      if (content.performance) {
        if (content.performance.avgResponseTime !== undefined) {
          totals.avgResponseTime = (totals.avgResponseTime || 0) + content.performance.avgResponseTime;
          counts.avgResponseTime = (counts.avgResponseTime || 0) + 1;
        }
        if (content.performance.peakMemoryUsage !== undefined) {
          totals.peakMemoryUsage = (totals.peakMemoryUsage || 0) + content.performance.peakMemoryUsage;
          counts.peakMemoryUsage = (counts.peakMemoryUsage || 0) + 1;
        }
        if (content.performance.jobSuccessRate !== undefined) {
          totals.jobSuccessRate = (totals.jobSuccessRate || 0) + content.performance.jobSuccessRate;
          counts.jobSuccessRate = (counts.jobSuccessRate || 0) + 1;
        }
      }
      
      // Issues metrics
      if (content.issues) {
        if (content.issues.errorsLogged !== undefined) {
          totals.errorsLogged = (totals.errorsLogged || 0) + content.issues.errorsLogged;
          counts.errorsLogged = (counts.errorsLogged || 0) + 1;
        }
        if (content.issues.criticalIssues !== undefined) {
          totals.criticalIssues = (totals.criticalIssues || 0) + content.issues.criticalIssues;
          counts.criticalIssues = (counts.criticalIssues || 0) + 1;
        }
      }
      
      // AI activity metrics
      if (content.aiActivity) {
        if (content.aiActivity.conversations !== undefined) {
          totals.conversations = (totals.conversations || 0) + content.aiActivity.conversations;
          counts.conversations = (counts.conversations || 0) + 1;
        }
        if (content.aiActivity.totalRequests !== undefined) {
          totals.totalRequests = (totals.totalRequests || 0) + content.aiActivity.totalRequests;
          counts.totalRequests = (counts.totalRequests || 0) + 1;
        }
        if (content.aiActivity.totalTokens !== undefined) {
          totals.totalTokens = (totals.totalTokens || 0) + content.aiActivity.totalTokens;
          counts.totalTokens = (counts.totalTokens || 0) + 1;
        }
      }
      
      // Email activity metrics
      if (content.emailActivity) {
        if (content.emailActivity.received !== undefined) {
          totals.received = (totals.received || 0) + content.emailActivity.received;
          counts.received = (counts.received || 0) + 1;
        }
        if (content.emailActivity.sent !== undefined) {
          totals.sent = (totals.sent || 0) + content.emailActivity.sent;
          counts.sent = (counts.sent || 0) + 1;
        }
      }
      
      // Crypto activity metrics
      if (content.cryptoActivity) {
        if (content.cryptoActivity.tradesExecuted !== undefined) {
          totals.tradesExecuted = (totals.tradesExecuted || 0) + content.cryptoActivity.tradesExecuted;
          counts.tradesExecuted = (counts.tradesExecuted || 0) + 1;
        }
        if (content.cryptoActivity.totalPnL !== undefined) {
          totals.totalPnL = (totals.totalPnL || 0) + content.cryptoActivity.totalPnL;
          counts.totalPnL = (counts.totalPnL || 0) + 1;
        }
      }
    });

    // Calculate averages
    const averages = {};
    Object.keys(totals).forEach(key => {
      averages[key] = totals[key] / counts[key];
    });

    return averages;
  };

  const period1Averages = calculateAverages(reportsPeriod1);
  const period2Averages = calculateAverages(reportsPeriod2);

  // Determine which metrics to compare
  const metricsToCompare = metrics.length > 0 ? metrics : validMetrics;
  
  // Calculate comparison results
  const comparisonResults = {};
  
  metricsToCompare.forEach(metric => {
    const period1Value = period1Averages[metric];
    const period2Value = period2Averages[metric];
    
    if (period1Value !== undefined && period2Value !== undefined) {
      const absoluteChange = period2Value - period1Value;
      const percentageChange = period1Value !== 0 ? (absoluteChange / Math.abs(period1Value)) * 100 : (period2Value !== 0 ? Infinity : 0);
      
      comparisonResults[metric] = {
        period1: period1Value,
        period2: period2Value,
        absoluteChange: absoluteChange,
        percentageChange: percentageChange,
        trend: percentageChange > 0 ? 'increased' : percentageChange < 0 ? 'decreased' : 'unchanged'
      };
    } else if (period1Value !== undefined || period2Value !== undefined) {
      // One period has data, the other doesn't
      comparisonResults[metric] = {
        period1: period1Value,
        period2: period2Value,
        absoluteChange: period2Value !== undefined ? period2Value : -period1Value,
        // New metric (no period1 baseline) or removed (no period2): percentage
        // change is undefined rather than a misleading flat 100.
        percentageChange: period1Value === undefined || period2Value === undefined ? null : 0,
        trend: period1Value === undefined ? 'new' : 'removed'
      };
    }
    // If both are undefined, we don't include the metric in results
  });

  return {
    period1: {
      startDate: period1Start,
      endDate: period1End,
      reportCount: reportsPeriod1.length
    },
    period2: {
      startDate: period2Start,
      endDate: period2End,
      reportCount: reportsPeriod2.length
    },
    metrics: comparisonResults
  };
};

export const SystemReport = mongoose.model('SystemReport', systemReportSchema);
