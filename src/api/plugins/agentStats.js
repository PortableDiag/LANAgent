import NodeCache from 'node-cache';
import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import ImprovementMetrics from '../../models/ImprovementMetrics.js';

export default class AgentStatsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'agentstats';
    this.version = '1.0.0';
    this.description = 'View agent statistics, improvements, and runtime errors';
    this.commands = [
      {
        command: 'stats',
        description: 'Get overall agent statistics',
        usage: 'stats [improvements|errors|all]'
      },
      {
        command: 'improvements',
        description: 'Get detailed improvement statistics',
        usage: 'improvements [days]'
      },
      {
        command: 'errors',
        description: 'Get runtime error statistics',
        usage: 'errors [recent|summary]'
      },
      {
        command: 'compare',
        description: 'Compare current period stats with previous period',
        usage: 'compare [days]',
        examples: [
          'compare stats for last 7 days',
          'compare improvement stats',
          'how are we doing compared to last month'
        ]
      }
    ];
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
  }

  async execute(action, params = {}) {
    switch (action) {
      case 'stats':
        return this.getAgentStats(params);
      case 'improvements':
        return this.getImprovementStats(params);
      case 'errors':
        return this.getErrorStats(params);
      case 'compare':
        return this.compareStats(params);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
  }

  async getAgentStats(params) {
    try {
      const type = params.type || 'all';
      
      if (type === 'improvements') {
        return this.getImprovementStats(params);
      } else if (type === 'errors') {
        return this.getErrorStats(params);
      }

      const fetchStats = async () => {
        return await Promise.all([
          this.agent.metricsUpdater.getImprovementStats(30),
          this.agent.errorLogScanner.getStats(),
          this.agent.selfModification ? this.agent.selfModification.getStats() : null
        ]);
      };

      const [improvementStats, errorStats, selfModStats] = await this.getCachedData('agentStats', fetchStats);

      const uptime = Date.now() - this.agent.startTime;
      const uptimeDays = Math.floor(uptime / (1000 * 60 * 60 * 24));
      const uptimeHours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

      let response = `📊 **Agent Statistics**\n\n`;
      response += `**Version:** ${this.agent.version || '2.8.52'}\n`;
      response += `**Uptime:** ${uptimeDays} days, ${uptimeHours} hours\n\n`;

      if (improvementStats && improvementStats.current) {
        response += `**🚀 Improvements:**\n`;
        response += `• Total: ${improvementStats.current.total}\n`;
        response += `• Merged: ${improvementStats.current.merged}\n`;
        response += `• Success Rate: ${improvementStats.current.successRate?.toFixed(1)}%\n`;
        response += `• Today: ${improvementStats.current.todayCount}\n`;
        response += `• Avg Time to Merge: ${improvementStats.current.averageTimeToMerge?.toFixed(1)} hours\n\n`;
      }

      if (errorStats) {
        response += `**🔍 Runtime Errors:**\n`;
        response += `• Since Startup: ${errorStats.errorsSinceStartup}\n`;
        response += `• Last Hour: ${errorStats.errorsLastHour}\n`;
        response += `• Last 24 Hours: ${errorStats.errorsLastDay}\n`;
        response += `• Scanner Status: ${errorStats.scannerStatus}\n\n`;
        
        if (errorStats.errorsBySeverity) {
          response += `**Error Severity:**\n`;
          for (const [severity, count] of Object.entries(errorStats.errorsBySeverity)) {
            response += `• ${severity}: ${count}\n`;
          }
        }
      }

      if (selfModStats) {
        response += `\n**🔧 Self-Modification:**\n`;
        response += `• Today's Improvements: ${selfModStats.todayImprovements}\n`;
        response += `• Pending PRs: ${selfModStats.pendingImprovements}\n`;
      }

      return {
        success: true,
        data: response
      };
    } catch (error) {
      logger.error('Agent stats error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getImprovementStats(params) {
    try {
      const days = params.days || 30;
      const fetchStats = async () => {
        return await this.agent.metricsUpdater.getImprovementStats(days);
      };
      const stats = await this.getCachedData(`improvementStats_${days}`, fetchStats);

      if (!stats || !stats.current) {
        return {
          success: true,
          data: 'No improvement statistics available yet.'
        };
      }

      let response = `🚀 **Improvement Statistics (Last ${days} days)**\n\n`;
      
      response += `**Overall Statistics:**\n`;
      response += `• Total Improvements: ${stats.current.total}\n`;
      response += `• Successfully Merged: ${stats.current.merged}\n`;
      response += `• Rejected: ${stats.current.rejected}\n`;
      response += `• Failed: ${stats.current.failed}\n`;
      response += `• Success Rate: ${stats.current.successRate?.toFixed(1)}%\n`;
      response += `• Average Time to Merge: ${stats.current.averageTimeToMerge?.toFixed(1)} hours\n\n`;

      response += `**Today's Progress:**\n`;
      response += `• Improvements: ${stats.current.todayCount}\n`;
      if (stats.current.newCapabilities && stats.current.newCapabilities.length > 0) {
        response += `• New Capabilities: ${stats.current.newCapabilities.join(', ')}\n`;
      }
      response += `\n`;

      if (stats.periodSummary) {
        response += `**Period Summary:**\n`;
        response += `• Total in Period: ${stats.periodSummary.totalInPeriod}\n`;
        response += `• Average per Day: ${stats.periodSummary.averagePerDay.toFixed(1)}\n`;
        
        if (stats.periodSummary.mostProductiveDay) {
          const date = new Date(stats.periodSummary.mostProductiveDay.date).toLocaleDateString();
          response += `• Most Productive Day: ${date} (${stats.periodSummary.mostProductiveDay.count} improvements)\n`;
        }
      }

      if (stats.trends) {
        response += `\n**Trend:** `;
        if (stats.trends.direction === 'up') {
          response += `📈 Up ${stats.trends.changePercent.toFixed(1)}%`;
        } else if (stats.trends.direction === 'down') {
          response += `📉 Down ${stats.trends.changePercent.toFixed(1)}%`;
        } else {
          response += `→ Stable`;
        }
        response += ` (${stats.trends.recentAverage.toFixed(1)} vs ${stats.trends.previousAverage.toFixed(1)} per day)\n`;
      }

      if (stats.current.topFiles && stats.current.topFiles.length > 0) {
        response += `\n**Top Improved Files:**\n`;
        stats.current.topFiles.slice(0, 5).forEach(file => {
          response += `• ${file.file}: ${file.count} improvements\n`;
        });
      }

      if (stats.current.byType) {
        response += `\n**By Type:**\n`;
        for (const [type, count] of Object.entries(stats.current.byType)) {
          response += `• ${type}: ${count}\n`;
        }
      }

      return {
        success: true,
        data: response
      };
    } catch (error) {
      logger.error('Improvement stats error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getErrorStats(params) {
    try {
      const fetchStats = async () => {
        return await this.agent.errorLogScanner.getStats();
      };
      const stats = await this.getCachedData('errorStats', fetchStats);

      if (!stats) {
        return {
          success: true,
          data: 'Error scanner is not available.'
        };
      }

      let response = `🔍 **Runtime Error Statistics**\n\n`;
      
      response += `**Scanner Status:** ${stats.scannerStatus === 'active' ? '✅ Active' : '⚠️ Stopped'}\n`;
      response += `**Monitoring Since:** ${new Date(stats.startupTime).toLocaleString()}\n`;
      response += `**Log Files Tracked:** ${stats.lastScanPosition}\n\n`;

      response += `**Error Counts:**\n`;
      response += `• Total Errors: ${stats.totalErrors}\n`;
      response += `• Since Startup: ${stats.errorsSinceStartup}\n`;
      response += `• Last Hour: ${stats.errorsLastHour}\n`;
      response += `• Last 24 Hours: ${stats.errorsLastDay}\n\n`;

      if (stats.errorsBySeverity && Object.keys(stats.errorsBySeverity).length > 0) {
        response += `**By Severity:**\n`;
        const severityOrder = ['critical', 'high', 'medium', 'low'];
        severityOrder.forEach(severity => {
          if (stats.errorsBySeverity[severity]) {
            const emoji = severity === 'critical' ? '🔴' :
                         severity === 'high' ? '🟠' :
                         severity === 'medium' ? '🟡' : '🟢';
            response += `${emoji} ${severity}: ${stats.errorsBySeverity[severity]}\n`;
          }
        });
        response += `\n`;
      }

      if (stats.topErrorFiles && stats.topErrorFiles.length > 0) {
        response += `**Top Error Sources:**\n`;
        stats.topErrorFiles.slice(0, 5).forEach(file => {
          const fileName = file._id.split('/').pop();
          response += `• ${fileName}: ${file.count} errors\n`;
        });
        response += `\n`;
      }

      if (params.type === 'recent' && stats.recentErrors && stats.recentErrors.length > 0) {
        response += `**Recent Errors:**\n`;
        stats.recentErrors.slice(0, 5).forEach(error => {
          const time = new Date(error.timestamp).toLocaleTimeString();
          const severity = error.severity === 'critical' ? '🔴' :
                          error.severity === 'high' ? '🟠' :
                          error.severity === 'medium' ? '🟡' : '🟢';
          response += `${severity} [${time}] ${error.message.substring(0, 80)}...\n`;
        });
      }

      return {
        success: true,
        data: response
      };
    } catch (error) {
      logger.error('Error stats error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async compareStats(params) {
    try {
      const days = params.days || 14;

      // Current period: last N days
      const now = new Date();
      const currentStart = new Date(now);
      currentStart.setDate(currentStart.getDate() - days);

      // Previous period: N days before the current period
      const previousStart = new Date(currentStart);
      previousStart.setDate(previousStart.getDate() - days);

      const [currentMetrics, previousMetrics, errorStats] = await Promise.all([
        ImprovementMetrics.getMetricsForRange(currentStart, now),
        ImprovementMetrics.getMetricsForRange(previousStart, currentStart),
        this.agent.errorLogScanner.getStats()
      ]);

      const currentTotal = currentMetrics.reduce((sum, m) => sum + m.daily.total, 0);
      const previousTotal = previousMetrics.reduce((sum, m) => sum + m.daily.total, 0);
      const currentMerged = currentMetrics.reduce((sum, m) => sum + (m.daily.merged || 0), 0);
      const previousMerged = previousMetrics.reduce((sum, m) => sum + (m.daily.merged || 0), 0);

      const currentAvgPerDay = currentMetrics.length > 0 ? currentTotal / currentMetrics.length : 0;
      const previousAvgPerDay = previousMetrics.length > 0 ? previousTotal / previousMetrics.length : 0;
      const changePct = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal * 100) : 0;

      let response = `📊 **Stats Comparison: Last ${days} days vs Previous ${days} days**\n\n`;

      response += `**🚀 Improvements:**\n`;
      response += `• Total: ${currentTotal} vs ${previousTotal}`;
      response += changePct !== 0 ? ` (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)\n` : ` (no change)\n`;
      response += `• Merged: ${currentMerged} vs ${previousMerged}\n`;
      response += `• Avg/day: ${currentAvgPerDay.toFixed(1)} vs ${previousAvgPerDay.toFixed(1)}\n`;

      if (changePct > 10) {
        response += `• Trend: 📈 Improving\n`;
      } else if (changePct < -10) {
        response += `• Trend: 📉 Declining\n`;
      } else {
        response += `• Trend: → Stable\n`;
      }

      if (errorStats) {
        response += `\n**🔍 Current Errors:**\n`;
        response += `• Since Startup: ${errorStats.errorsSinceStartup}\n`;
        response += `• Last 24h: ${errorStats.errorsLastDay}\n`;
        response += `• Last Hour: ${errorStats.errorsLastHour}\n`;
      }

      return { success: true, data: response };
    } catch (error) {
      logger.error('Comparison stats error:', error);
      return { success: false, error: error.message };
    }
  }

  async getRawStats() {
    try {
      const fetchStats = async () => {
        return await Promise.all([
          this.agent.metricsUpdater.getImprovementStats(30),
          this.agent.errorLogScanner.getStats(),
          this.agent.selfModification ? this.agent.selfModification.getStats() : null
        ]);
      };

      const [improvementStats, errorStats, selfModStats] = await this.getCachedData('rawStats', fetchStats);

      return {
        improvements: improvementStats,
        errors: errorStats,
        selfModification: selfModStats,
        uptime: Date.now() - this.agent.startTime,
        version: this.agent.version
      };
    } catch (error) {
      logger.error('Failed to get raw stats:', error);
      return null;
    }
  }
}