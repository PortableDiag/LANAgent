import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

const improvementMetricsSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
    unique: true,
    index: true
  },
  daily: {
    total: { type: Number, default: 0 },
    merged: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    inProgress: { type: Number, default: 0 },
    byType: {
      type: Map,
      of: Number,
      default: new Map()
    },
    byPriority: {
      high: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      low: { type: Number, default: 0 }
    },
    byImpact: {
      major: { type: Number, default: 0 },
      moderate: { type: Number, default: 0 },
      minor: { type: Number, default: 0 }
    }
  },
  cumulative: {
    total: { type: Number, default: 0 },
    merged: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    byType: {
      type: Map,
      of: Number,
      default: new Map()
    },
    successRate: { type: Number, default: 0 },
    averageTimeToMerge: { type: Number, default: 0 },
    topFiles: [{
      file: String,
      count: Number
    }],
    topTypes: [{
      _id: false,
      typeName: String,
      count: Number
    }]
  },
  performance: {
    avgResponseTime: { type: Number, default: 0 },
    totalExecutionTime: { type: Number, default: 0 },
    improvementsPerHour: { type: Number, default: 0 }
  },
  capabilities: {
    newCapabilitiesAdded: [String],
    totalCapabilities: { type: Number, default: 0 }
  },
  trends: {
    byType: [{
      date: Date,
      type: String,
      count: Number
    }],
    byPriority: [{
      date: Date,
      priority: String,
      count: Number
    }]
  }
}, {
  timestamps: true
});

// Index for efficient date-based queries
improvementMetricsSchema.index({ date: -1 });

/**
 * Update metrics for a given date with retry and error handling.
 * @param {Date} date - The date for which to update metrics.
 * @returns {Promise<Object>} - The updated metrics document.
 */
improvementMetricsSchema.statics.updateMetrics = async function(date = new Date()) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const Improvement = mongoose.model('Improvement');

  try {
    const [dailyImprovements, allImprovements] = await Promise.all([
      retryOperation(() => Improvement.find({
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      }).lean(), { retries: 3 }),
      retryOperation(() => Improvement.find({
        createdAt: { $lte: endOfDay }
      }).lean(), { retries: 3 })
    ]);

    const dailyMetrics = {
      total: dailyImprovements.length,
      merged: dailyImprovements.filter(i => i.status === 'merged').length,
      rejected: dailyImprovements.filter(i => i.status === 'rejected').length,
      failed: dailyImprovements.filter(i => i.status === 'failed').length,
      inProgress: dailyImprovements.filter(i => ['in_progress', 'pr_created'].includes(i.status)).length,
      byType: {},
      byPriority: {
        high: dailyImprovements.filter(i => i.priority === 'high').length,
        medium: dailyImprovements.filter(i => i.priority === 'medium').length,
        low: dailyImprovements.filter(i => i.priority === 'low').length
      },
      byImpact: {
        major: dailyImprovements.filter(i => i.impact === 'major').length,
        moderate: dailyImprovements.filter(i => i.impact === 'moderate').length,
        minor: dailyImprovements.filter(i => i.impact === 'minor').length
      }
    };

    dailyImprovements.forEach(imp => {
      dailyMetrics.byType[imp.type] = (dailyMetrics.byType[imp.type] || 0) + 1;
    });

    const cumulativeMetrics = {
      total: allImprovements.length,
      merged: allImprovements.filter(i => i.status === 'merged').length,
      rejected: allImprovements.filter(i => i.status === 'rejected').length,
      failed: allImprovements.filter(i => i.status === 'failed').length,
      byType: {},
      successRate: 0,
      averageTimeToMerge: 0,
      topFiles: [],
      topTypes: []
    };

    const typeCount = {};
    const fileCount = {};
    let totalMergeTime = 0;
    let mergeCount = 0;

    allImprovements.forEach(imp => {
      typeCount[imp.type] = (typeCount[imp.type] || 0) + 1;
      
      if (imp.targetFile) {
        fileCount[imp.targetFile] = (fileCount[imp.targetFile] || 0) + 1;
      }
      
      if (imp.status === 'merged' && imp.completedAt) {
        const mergeTime = imp.completedAt - imp.createdAt;
        totalMergeTime += mergeTime;
        mergeCount++;
      }
    });

    cumulativeMetrics.byType = typeCount;
    
    const completed = cumulativeMetrics.merged + cumulativeMetrics.rejected + cumulativeMetrics.failed;
    if (completed > 0) {
      cumulativeMetrics.successRate = (cumulativeMetrics.merged / completed) * 100;
    }

    if (mergeCount > 0) {
      cumulativeMetrics.averageTimeToMerge = (totalMergeTime / mergeCount) / (1000 * 60 * 60);
    }

    cumulativeMetrics.topFiles = Object.entries(fileCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([file, count]) => ({ file, count }));

    cumulativeMetrics.topTypes = Object.entries(typeCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([typeName, count]) => ({ typeName, count }));

    const newCapabilities = [];
    dailyImprovements.forEach(imp => {
      if (imp.newCapabilities && imp.newCapabilities.length > 0) {
        newCapabilities.push(...imp.newCapabilities);
      }
    });

    const hoursInDay = (endOfDay - startOfDay) / (1000 * 60 * 60);
    const performanceMetrics = {
      improvementsPerHour: dailyMetrics.total / hoursInDay
    };

    const trends = {
      byType: Object.entries(dailyMetrics.byType).map(([type, count]) => ({
        date: startOfDay,
        type,
        count
      })),
      byPriority: Object.entries(dailyMetrics.byPriority).map(([priority, count]) => ({
        date: startOfDay,
        priority,
        count
      }))
    };

    const metrics = await this.findOneAndUpdate(
      { date: startOfDay },
      {
        date: startOfDay,
        daily: dailyMetrics,
        cumulative: cumulativeMetrics,
        performance: performanceMetrics,
        capabilities: {
          newCapabilitiesAdded: [...new Set(newCapabilities)],
          totalCapabilities: newCapabilities.length
        },
        trends
      },
      { upsert: true, new: true }
    );

    // Convert to plain object before caching to avoid NodeCache clone issues with Mongoose docs
    cache.set(startOfDay.toISOString(), metrics.toObject());
    return metrics;
  } catch (error) {
    logger.error('Error updating metrics:', error);
    throw error;
  }
};

/**
 * Get metrics for a specific date range.
 * @param {Date} startDate - The start date of the range.
 * @param {Date} endDate - The end date of the range.
 * @returns {Promise<Array>} - An array of metrics documents.
 */
improvementMetricsSchema.statics.getMetricsForRange = async function(startDate, endDate) {
  try {
    const cacheKey = `range-${startDate.toISOString()}-${endDate.toISOString()}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    // Use lean() to return plain objects instead of Mongoose documents
    const metrics = await this.find({
      date: { $gte: startDate, $lte: endDate }
    }).sort({ date: -1 }).lean();

    cache.set(cacheKey, metrics);
    return metrics;
  } catch (error) {
    logger.error('Error fetching metrics for range:', error);
    throw error;
  }
};

/**
 * Get the latest metrics document.
 * @returns {Promise<Object>} - The latest metrics document.
 */
improvementMetricsSchema.statics.getLatestMetrics = async function() {
  try {
    const cachedData = cache.get('latest');
    if (cachedData) {
      return cachedData;
    }

    const latestMetrics = await this.findOne().sort({ date: -1 }).lean();
    if (latestMetrics) {
      cache.set('latest', latestMetrics);
    }
    return latestMetrics;
  } catch (error) {
    logger.error('Error fetching latest metrics:', error);
    throw error;
  }
};

/**
 * Get trend data for improvement types and priorities over time.
 * @returns {Promise<Object>} - An object containing trend data.
 */
improvementMetricsSchema.statics.getTrends = async function() {
  try {
    const trends = await this.aggregate([
      { $unwind: '$trends.byType' },
      { $unwind: '$trends.byPriority' },
      {
        $group: {
          _id: null,
          byType: { $push: '$trends.byType' },
          byPriority: { $push: '$trends.byPriority' }
        }
      },
      {
        $project: {
          _id: 0,
          byType: 1,
          byPriority: 1
        }
      }
    ]);

    return trends[0] || { byType: [], byPriority: [] };
  } catch (error) {
    logger.error('Error fetching trends:', error);
    throw error;
  }
};

const ImprovementMetrics = mongoose.model('ImprovementMetrics', improvementMetricsSchema);

export default ImprovementMetrics;
