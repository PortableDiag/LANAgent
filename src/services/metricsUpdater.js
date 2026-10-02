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
    this.scheduledTasks = new Map();
    this._initialized = false;
    this._initializePromise = null;
    // Per-job overrun flags. Cron ticks that arrive while a previous run is
    // still in progress are skipped instead of stacking. Sufficient for
    // single-process deployments; multi-process cluster locking would need
    // a database-backed mutex (the existing file-based selfModLock is shared
    // with self-mod / bug-fix runs and isn't a good fit for metrics).
    this._runningCurrent = false;
    this._runningPrev = false;
  }

  /**
   * Initialize the metrics updater service
   */
  async initialize() {
    if (this._initialized) {
      this.start();
      return;
    }

    if (this._initializePromise) {
      return this._initializePromise;
    }

    this._initializePromise = (async () => {
      try {
        logger.info('[MetricsUpdater] Initializing metrics updater service', {
          service: 'metrics-updater'
        });

        // Update metrics immediately on startup
        await this.updateCurrentMetrics();

        // Schedule periodic updates
        this.start();

        this._initialized = true;

        logger.info('[MetricsUpdater] Metrics updater service initialized successfully', {
          service: 'metrics-updater'
        });
      } catch (error) {
        this.isRunning = false;
        this._initialized = false;
        logger.error('[MetricsUpdater] Failed to initialize:', error, {
          service: 'metrics-updater'
        });
        throw error;
      } finally {
        this._initializePromise = null;
      }
    })();

    return this._initializePromise;
  }

  /**
   * Start scheduled metric updates.
   *
   * Cron tasks are created on the first start only; later starts resume the
   * existing handles, so no duplicate cron jobs are ever registered.
   */
  start() {
    if (this.isRunning) {
      return;
    }

    try {
      if (this.scheduledTasks.size === 0) {
        this.scheduleUpdates();
      } else {
        for (const task of this.scheduledTasks.values()) {
          if (task && typeof task.start === 'function') {
            task.start();
          }
        }
      }

      this.isRunning = true;
      logger.info('[MetricsUpdater] Metric update scheduling started', {
        service: 'metrics-updater',
        scheduledTasks: this.scheduledTasks.size
      });
    } catch (error) {
      this.isRunning = false;
      logger.error('[MetricsUpdater] Failed to start metric update scheduling:', error, {
        service: 'metrics-updater'
      });
      throw error;
    }
  }

  /**
   * Stop scheduled metric updates.
   *
   * Task handles are kept and resumed by start(). node-cron 3 has no
   * destroy() and keeps every task it ever scheduled in its global storage,
   * so re-creating tasks on each stop/start cycle would leak stopped tasks.
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    for (const [name, task] of this.scheduledTasks.entries()) {
      try {
        if (task && typeof task.stop === 'function') {
          task.stop();
        }
      } catch (error) {
        logger.error(`[MetricsUpdater] Failed to stop ${name} metric task:`, error, {
          service: 'metrics-updater',
          task: name
        });
      }
    }

    logger.info('[MetricsUpdater] Metric update scheduling stopped', {
      service: 'metrics-updater'
    });
  }

  /**
   * Restart scheduled metric updates.
   */
  restart() {
    this.stop();
    this.start();
  }

  /**
   * Schedule periodic metric updates
   */
  scheduleUpdates() {
    if (this.scheduledTasks.size > 0) {
      logger.debug('[MetricsUpdater] Metric updates are already scheduled', {
        service: 'metrics-updater',
        scheduledTasks: this.scheduledTasks.size
      });
      return;
    }

    try {
      // Update current day metrics every 15 minutes
      const currentTask = cron.schedule(this.updateInterval, async () => {
        if (!this.isRunning) {
          return;
        }
        if (this._runningCurrent) {
          logger.debug('[MetricsUpdater] Skipping tick — current run still in progress');
          return;
        }
        try {
          await this.updateCurrentMetrics();
        } catch (error) {
          logger.error('[MetricsUpdater] Failed to update current metrics:', error);
        }
      });

      this.scheduledTasks.set('current', currentTask);

      // Update previous day metrics at midnight
      const previousTask = cron.schedule(this.dailyUpdateInterval, async () => {
        if (!this.isRunning) {
          return;
        }
        if (this._runningPrev) {
          logger.debug('[MetricsUpdater] Skipping tick — previous-day run still in progress');
          return;
        }
        try {
          await this.updatePreviousDayMetrics();
        } catch (error) {
          logger.error('[MetricsUpdater] Failed to update previous day metrics:', error);
        }
      });

      this.scheduledTasks.set('previous', previousTask);

      logger.info('[MetricsUpdater] Scheduled metric updates', {
        service: 'metrics-updater',
        currentInterval: this.updateInterval,
        dailyInterval: this.dailyUpdateInterval
      });
    } catch (error) {
      for (const task of this.scheduledTasks.values()) {
        try {
          if (task && typeof task.stop === 'function') {
            task.stop();
          }
          if (task && typeof task.destroy === 'function') {
            task.destroy();
          }
        } catch (cleanupError) {
          logger.error('[MetricsUpdater] Failed to clean up partially scheduled task:', cleanupError, {
            service: 'metrics-updater'
          });
        }
      }
      this.scheduledTasks.clear();
      throw error;
    }
  }

  /**
   * Update metrics for current day
   */
  async updateCurrentMetrics() {
    if (this._runningCurrent) {
      logger.debug('[MetricsUpdater] updateCurrentMetrics called while previous run still active; skipping');
      return null;
    }
    this._runningCurrent = true;
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
    } finally {
      this._runningCurrent = false;
    }
  }

  /**
   * Update metrics for previous days (backfill)
   */
  async updatePreviousDayMetrics() {
    if (this._runningPrev) {
      logger.debug('[MetricsUpdater] updatePreviousDayMetrics called while previous run still active; skipping');
      return null;
    }
    this._runningPrev = true;
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
    } finally {
      this._runningPrev = false;
    }
  }

  /**
   * Backfill metrics for a date range
   */
  async backfillMetrics(startDate, endDate) {
    const wasRunning = this.isRunning;

    if (wasRunning) {
      this.stop();
    }

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
    } finally {
      if (wasRunning) {
        this.start();
      }
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
