import { logger } from '../utils/logger.js';
import ImprovementMetrics from '../models/ImprovementMetrics.js';
import cron from 'node-cron';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * Service for updating pre-computed metrics
 */
export class MetricsUpdaterService {
  constructor() {
    this.updateInterval = '0 */15 * * * *'; // Every 15 minutes
    this.dailyUpdateInterval = '5 0 * * *'; // 12:05 AM daily
    this.isRunning = false;
  }

  /**
   * Initialize the metrics updater service
   */
  async initialize() {
    try {
      logger.info('[MetricsUpdater] Initializing metrics updater service', {
        service: 'metrics-updater'
      });

      // Update metrics immediately on startup
      await this.updateCurrentMetrics();

      // Schedule periodic updates
      this.scheduleUpdates();

      logger.info('[MetricsUpdater] Metrics updater service initialized successfully', {
        service: 'metrics-updater'
      });
    } catch (error) {
      logger.error('[MetricsUpdater] Failed to initialize:', error, {
        service: 'metrics-updater'
      });
      throw error;
    }
  }

  /**
   * Schedule periodic metric updates
   */
  scheduleUpdates() {
    // Update current day metrics every 15 minutes
    cron.schedule(this.updateInterval, async () => {
      try {
        await this.updateCurrentMetrics();
      } catch (error) {
        logger.error('[MetricsUpdater] Failed to update current metrics:', error);
      }
    });

    // Update previous day metrics at midnight
    cron.schedule(this.dailyUpdateInterval, async () => {
      try {
        await this.updatePreviousDayMetrics();
      } catch (error) {
        logger.error('[MetricsUpdater] Failed to update previous day metrics:', error);
      }
    });

    logger.info('[MetricsUpdater] Scheduled metric updates', {
      service: 'metrics-updater',
      currentInterval: this.updateInterval,
      dailyInterval: this.dailyUpdateInterval
    });
  }

  /**
   * Update metrics for current day
   */
  async updateCurrentMetrics() {
    try {
      const today = new Date();
      const metrics = await retryOperation(
        () => ImprovementMetrics.updateMetrics(today),
        { retries: 3, context: 'updateCurrentMetrics' }
      );

      logger.debug('[MetricsUpdater] Updated current day metrics', {
        service: 'metrics-updater',
        date: today.toISOString().split('T')[0],
        totalImprovements: metrics.cumulative.total,
        todayImprovements: metrics.daily.total
      });

      return metrics;
    } catch (error) {
      logger.error('[MetricsUpdater] Error updating current metrics:', error);
      throw error;
    }
  }

  /**
   * Update metrics for previous days (backfill)
   */
  async updatePreviousDayMetrics() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const metrics = await retryOperation(
        () => ImprovementMetrics.updateMetrics(yesterday),
        { retries: 3, context: 'updatePreviousDayMetrics' }
      );

      logger.info('[MetricsUpdater] Updated previous day metrics', {
        service: 'metrics-updater',
        date: yesterday.toISOString().split('T')[0],
        improvements: metrics.daily.total
      });

      return metrics;
    } catch (error) {
      logger.error('[MetricsUpdater] Error updating previous day metrics:', error);
      throw error;
    }
  }

  /**
   * Backfill metrics for a date range
   */
  async backfillMetrics(startDate, endDate) {
    try {
      logger.info('[MetricsUpdater] Starting metrics backfill', {
        service: 'metrics-updater',
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0]
      });

      const current = new Date(startDate);
      const end = new Date(endDate);
      let count = 0;

      while (current <= end) {
        await retryOperation(
          () => ImprovementMetrics.updateMetrics(new Date(current)),
          { retries: 3, context: 'backfillMetrics' }
        );
        count++;
        current.setDate(current.getDate() + 1);
      }

      logger.info('[MetricsUpdater] Metrics backfill completed', {
        service: 'metrics-updater',
        daysProcessed: count
      });

      return count;
    } catch (error) {
      logger.error('[MetricsUpdater] Error during backfill:', error);
      throw error;
    }
  }

  /**
   * Get improvement statistics for API
   */
  async getImprovementStats(days = 30) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Get latest metrics
      const latestMetrics = await ImprovementMetrics.getLatestMetrics();
      
      // Get metrics for date range
      const rangeMetrics = await ImprovementMetrics.getMetricsForRange(startDate, endDate);

      // Calculate trends
      const trends = this.calculateTrends(rangeMetrics);

      return {
        current: latestMetrics ? {
          total: latestMetrics.cumulative.total,
          merged: latestMetrics.cumulative.merged,
          rejected: latestMetrics.cumulative.rejected,
          failed: latestMetrics.cumulative.failed,
          successRate: latestMetrics.cumulative.successRate,
          todayCount: latestMetrics.daily.total,
          byType: Object.fromEntries(latestMetrics.cumulative.byType || new Map()),
          topFiles: latestMetrics.cumulative.topFiles,
          topTypes: latestMetrics.cumulative.topTypes,
          averageTimeToMerge: latestMetrics.cumulative.averageTimeToMerge,
          newCapabilities: latestMetrics.capabilities.newCapabilitiesAdded
        } : null,
        trends: trends,
        periodSummary: {
          totalInPeriod: rangeMetrics.reduce((sum, m) => sum + m.daily.total, 0),
          averagePerDay: rangeMetrics.length > 0 ? 
            rangeMetrics.reduce((sum, m) => sum + m.daily.total, 0) / rangeMetrics.length : 0,
          mostProductiveDay: this.findMostProductiveDay(rangeMetrics),
          byPriority: this.aggregateByPriority(rangeMetrics),
          byImpact: this.aggregateByImpact(rangeMetrics)
        }
      };
    } catch (error) {
      logger.error('[MetricsUpdater] Error getting improvement stats:', error);
      return null;
    }
  }

  /**
   * Calculate trends from metrics
   */
  calculateTrends(metrics) {
    if (metrics.length < 2) return null;

    const recent = metrics.slice(0, 7);
    const previous = metrics.slice(7, 14);

    const recentAvg = recent.reduce((sum, m) => sum + m.daily.total, 0) / recent.length;
    const previousAvg = previous.length > 0 ? 
      previous.reduce((sum, m) => sum + m.daily.total, 0) / previous.length : 0;

    const change = previousAvg > 0 ? ((recentAvg - previousAvg) / previousAvg) * 100 : 0;

    return {
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable',
      changePercent: Math.abs(change),
      recentAverage: recentAvg,
      previousAverage: previousAvg
    };
  }

  /**
   * Find most productive day
   */
  findMostProductiveDay(metrics) {
    if (metrics.length === 0) return null;

    let maxDay = metrics[0];
    for (const metric of metrics) {
      if (metric.daily.total > maxDay.daily.total) {
        maxDay = metric;
      }
    }

    return {
      date: maxDay.date,
      count: maxDay.daily.total
    };
  }

  /**
   * Aggregate by priority
   */
  aggregateByPriority(metrics) {
    return metrics.reduce((acc, m) => {
      acc.high += m.daily.byPriority.high || 0;
      acc.medium += m.daily.byPriority.medium || 0;
      acc.low += m.daily.byPriority.low || 0;
      return acc;
    }, { high: 0, medium: 0, low: 0 });
  }

  /**
   * Aggregate by impact
   */
  aggregateByImpact(metrics) {
    return metrics.reduce((acc, m) => {
      acc.major += m.daily.byImpact.major || 0;
      acc.moderate += m.daily.byImpact.moderate || 0;
      acc.minor += m.daily.byImpact.minor || 0;
      return acc;
    }, { major: 0, moderate: 0, minor: 0 });
  }
}

// Create singleton instance
export const metricsUpdater = new MetricsUpdaterService();