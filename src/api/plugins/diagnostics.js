import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';

/**
 * Diagnostics Plugin
 * Provides access to system health checks and self-diagnostics
 */
export default class DiagnosticsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'diagnostics';
    this.version = '1.0.0';
    this.description = 'Comprehensive system health monitoring and API endpoint testing';
    this.commands = [
      {
        command: 'run',
        description: 'Run full system diagnostics',
        usage: 'diagnostics run'
      },
      {
        command: 'status',
        description: 'Get current system health status',
        usage: 'diagnostics status'
      },
      {
        command: 'history',
        description: 'View diagnostic history',
        usage: 'diagnostics history [limit]'
      },
      {
        command: 'report',
        description: 'Get detailed diagnostic report',
        usage: 'diagnostics report [reportId]'
      },
      {
        command: 'test',
        description: 'Test specific component',
        usage: 'diagnostics test <component>'
      },
      {
        command: 'schedule',
        description: 'Schedule automatic diagnostics at specified interval',
        usage: 'diagnostics schedule <interval>'
      },
      {
        command: 'view-schedule',
        description: 'View scheduled diagnostics',
        usage: 'diagnostics view-schedule'
      },
      {
        command: 'cancel-schedule',
        description: 'Cancel all scheduled diagnostics',
        usage: 'diagnostics cancel-schedule'
      },
      {
        command: 'compare',
        description: 'Compare two diagnostic reports',
        usage: 'diagnostics compare [reportId1] [reportId2]'
      }
    ];
  }

  async execute(params = {}) {
    const { action, ...data } = params;

    try {
      switch(action) {
        case 'run':
          return await this.runDiagnostics(data);
        case 'status':
          return await this.getStatus();
        case 'history':
          return await this.getHistory(data);
        case 'report':
          return await this.getReport(data);
        case 'test':
          return await this.testComponent(data);
        case 'schedule':
          return await this.scheduleDiagnostics(data);
        case 'view-schedule':
          return await this.viewScheduledDiagnostics();
        case 'cancel-schedule':
          return await this.cancelScheduledDiagnostics();
        case 'compare':
          return await this.compareReports(data);
        default:
          return {
            success: false,
            error: 'Invalid action. Available actions: run, status, history, report, test, schedule, view-schedule, cancel-schedule, compare'
          };
      }
    } catch (error) {
      logger.error('Diagnostics plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async runDiagnostics(data) {
    try {
      const diagnosticsService = this.agent.selfDiagnosticsService;
      if (!diagnosticsService) {
        return { 
          success: false, 
          error: 'Diagnostics service not available' 
        };
      }

      const result = await diagnosticsService.runDiagnostics(
        data.trigger || 'manual',
        data.requestedBy || 'user'
      );

      if (result.success) {
        // Format for display
        const formattedReport = diagnosticsService.formatReport(
          await diagnosticsService.getReport(result.reportId)
        );

        return {
          success: true,
          reportId: result.reportId,
          overallHealth: result.overallHealth,
          summary: result.summary,
          duration: result.duration,
          testResults: result.testResults,
          formattedReport
        };
      } else {
        return result;
      }
    } catch (error) {
      logger.error('Failed to run diagnostics:', error);
      return { success: false, error: error.message };
    }
  }

  async getStatus() {
    try {
      const diagnosticsService = this.agent.selfDiagnosticsService;
      if (!diagnosticsService) {
        return { 
          success: false, 
          error: 'Diagnostics service not available' 
        };
      }

      const latestReport = await diagnosticsService.getReport();
      
      if (!latestReport) {
        return {
          success: true,
          status: 'No diagnostic reports available',
          message: 'Run diagnostics to generate a report'
        };
      }

      return {
        success: true,
        lastRun: latestReport.timestamp,
        overallHealth: latestReport.overallHealth,
        summary: latestReport.summary,
        duration: latestReport.duration,
        testsRun: latestReport.tests?.length || 0,
        passed: latestReport.tests?.filter(t => t.status === 'passed').length || 0,
        failed: latestReport.tests?.filter(t => t.status === 'failed').length || 0,
        warnings: latestReport.tests?.filter(t => t.status === 'warning').length || 0
      };
    } catch (error) {
      logger.error('Failed to get diagnostics status:', error);
      return { success: false, error: error.message };
    }
  }

  async getHistory(data) {
    try {
      const diagnosticsService = this.agent.selfDiagnosticsService;
      if (!diagnosticsService) {
        return { 
          success: false, 
          error: 'Diagnostics service not available' 
        };
      }

      const limit = data.limit || 10;
      const history = await diagnosticsService.getHistory(limit);

      return {
        success: true,
        count: history.length,
        reports: history.map(report => ({
          id: report._id,
          timestamp: report.timestamp,
          overallHealth: report.overallHealth,
          summary: report.summary,
          duration: report.duration,
          triggeredBy: report.triggeredBy,
          testCount: report.tests?.length || 0
        }))
      };
    } catch (error) {
      logger.error('Failed to get diagnostics history:', error);
      return { success: false, error: error.message };
    }
  }

  async getReport(data) {
    try {
      const diagnosticsService = this.agent.selfDiagnosticsService;
      if (!diagnosticsService) {
        return { 
          success: false, 
          error: 'Diagnostics service not available' 
        };
      }

      const report = await diagnosticsService.getReport(data.reportId);
      
      if (!report) {
        return {
          success: false,
          error: 'Report not found'
        };
      }

      const formattedReport = diagnosticsService.formatReport(report);

      return {
        success: true,
        report: {
          id: report._id,
          timestamp: report.timestamp,
          overallHealth: report.overallHealth,
          summary: report.summary,
          duration: report.duration,
          triggeredBy: report.triggeredBy,
          requestedBy: report.requestedBy,
          tests: report.tests,
          systemInfo: report.systemInfo,
          formatted: formattedReport
        }
      };
    } catch (error) {
      logger.error('Failed to get diagnostic report:', error);
      return { success: false, error: error.message };
    }
  }

  async testComponent(data) {
    try {
      const { component } = data;
      
      if (!component) {
        return {
          success: false,
          error: 'Component name required. Available: api, database, telegram, web, plugins'
        };
      }

      const diagnosticsService = this.agent.selfDiagnosticsService;
      if (!diagnosticsService) {
        return { 
          success: false, 
          error: 'Diagnostics service not available' 
        };
      }

      let result;
      
      switch(component.toLowerCase()) {
        case 'api':
          result = await diagnosticsService.testApiEndpoints();
          break;
        case 'database':
          result = await diagnosticsService.testDatabaseConnection();
          break;
        case 'telegram':
          result = await diagnosticsService.testTelegramConnection();
          break;
        case 'web':
          result = await diagnosticsService.testWebInterface();
          break;
        case 'plugins':
          result = await diagnosticsService.testPluginSystem();
          break;
        case 'resources':
          result = await diagnosticsService.testSystemResources();
          break;
        case 'process':
          result = await diagnosticsService.testProcessStatus();
          break;
        case 'services':
          result = await diagnosticsService.testBackgroundServices();
          break;
        default:
          return {
            success: false,
            error: `Unknown component: ${component}. Available: api, database, telegram, web, plugins, resources, process, services`
          };
      }

      // Handle array results (like API endpoints)
      if (Array.isArray(result)) {
        return {
          success: true,
          component,
          tests: result,
          summary: {
            total: result.length,
            passed: result.filter(t => t.status === 'passed').length,
            failed: result.filter(t => t.status === 'failed').length,
            warnings: result.filter(t => t.status === 'warning').length
          }
        };
      } else {
        return {
          success: true,
          component,
          test: result
        };
      }
    } catch (error) {
      logger.error('Failed to test component:', error);
      return { success: false, error: error.message };
    }
  }

  async scheduleDiagnostics(data) {
    try {
      const { interval } = data;
      if (!interval) {
        return { success: false, error: 'Interval is required (e.g., "1 hour", "30 minutes", "6 hours")' };
      }

      const scheduler = this.agent?.scheduler;
      if (!scheduler?.agenda) {
        return { success: false, error: 'Scheduler service not available' };
      }

      const agenda = scheduler.agenda;

      agenda.define('scheduled-diagnostics', async () => {
        try {
          await this.runDiagnostics({ trigger: 'scheduled', requestedBy: 'system' });
          logger.info('Scheduled diagnostics completed');
        } catch (err) {
          logger.error('Scheduled diagnostics failed:', err);
        }
      });

      await agenda.every(interval, 'scheduled-diagnostics');
      logger.info(`Diagnostics scheduled every ${interval}`);

      return { success: true, message: `Diagnostics scheduled every ${interval}` };
    } catch (error) {
      logger.error('Failed to schedule diagnostics:', error);
      return { success: false, error: error.message };
    }
  }

  async viewScheduledDiagnostics() {
    try {
      const scheduler = this.agent?.scheduler;
      if (!scheduler?.agenda) {
        return { success: false, error: 'Scheduler service not available' };
      }

      const jobs = await scheduler.agenda.jobs({ name: 'scheduled-diagnostics' });

      if (!jobs || jobs.length === 0) {
        return { success: true, message: 'No diagnostics currently scheduled', scheduledJobs: [] };
      }

      return {
        success: true,
        scheduledJobs: jobs.map(job => ({
          id: job.attrs._id?.toString(),
          nextRunAt: job.attrs.nextRunAt,
          lastRunAt: job.attrs.lastRunAt,
          interval: job.attrs.repeatInterval
        }))
      };
    } catch (error) {
      logger.error('Failed to view scheduled diagnostics:', error);
      return { success: false, error: error.message };
    }
  }

  async cancelScheduledDiagnostics() {
    try {
      const scheduler = this.agent?.scheduler;
      if (!scheduler?.agenda) {
        return { success: false, error: 'Scheduler service not available' };
      }

      const numRemoved = await scheduler.agenda.cancel({ name: 'scheduled-diagnostics' });
      logger.info(`Cancelled ${numRemoved} scheduled diagnostic jobs`);

      return { success: true, message: `Cancelled ${numRemoved} scheduled diagnostic job(s)` };
    } catch (error) {
      logger.error('Failed to cancel scheduled diagnostics:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Compare two diagnostic reports and return a structured diff
   * @param {Object} data - Contains optional reportId1 and reportId2
   * @returns {Object} Diff result with test changes, health comparison, and summary
   */
  async compareReports(data) {
    try {
      const diagnosticsService = this.agent.selfDiagnosticsService;
      if (!diagnosticsService) {
        return { success: false, error: 'Diagnostics service not available' };
      }

      let report1, report2;

      // Determine which reports to compare
      if (data.reportId1 && data.reportId2) {
        // Both IDs provided
        report1 = await diagnosticsService.getReport(data.reportId1);
        report2 = await diagnosticsService.getReport(data.reportId2);
      } else if (!data.reportId1 && !data.reportId2) {
        // No IDs provided: fetch two most recent reports
        const recent = await diagnosticsService.getHistory(2);
        if (!recent || recent.length < 2) {
          return {
            success: false,
            error: 'Need at least two diagnostic reports to compare. Run diagnostics first.'
          };
        }
        // getHistory returns newest first, so index 0 is most recent, index 1 is previous
        report1 = recent[1]; // older
        report2 = recent[0]; // newer
      } else {
        // Only one ID provided
        return {
          success: false,
          error: 'Please provide both report IDs or none to compare the two most recent reports.'
        };
      }

      if (!report1 || !report2) {
        return { success: false, error: 'One or both reports not found.' };
      }

      // Build test maps by name for comparison
      const tests1 = report1.tests || [];
      const tests2 = report2.tests || [];
      const map1 = new Map(tests1.map(t => [t.name, t]));
      const map2 = new Map(tests2.map(t => [t.name, t]));

      const added = [];
      const removed = [];
      const changed = [];
      const unchanged = [];

      // Check for added and changed tests in report2
      for (const [name, test2] of map2) {
        const test1 = map1.get(name);
        if (!test1) {
          added.push({ name, status: test2.status });
        } else if (test1.status !== test2.status) {
          changed.push({
            name,
            from: test1.status,
            to: test2.status
          });
        } else {
          unchanged.push({ name, status: test2.status });
        }
      }

      // Check for removed tests (present in report1 but not report2)
      for (const [name, test1] of map1) {
        if (!map2.has(name)) {
          removed.push({ name, status: test1.status });
        }
      }

      // Compare overall health, duration, summary
      const healthChanged = report1.overallHealth !== report2.overallHealth;
      const durationDiff = (report2.duration || 0) - (report1.duration || 0);
      const summaryChanged = report1.summary !== report2.summary;

      // Build human-readable summary
      const summaryParts = [];
      if (added.length) summaryParts.push(`${added.length} test(s) added`);
      if (removed.length) summaryParts.push(`${removed.length} test(s) removed`);
      if (changed.length) summaryParts.push(`${changed.length} test(s) changed status`);
      if (healthChanged) summaryParts.push(`overall health changed from "${report1.overallHealth}" to "${report2.overallHealth}"`);
      if (summaryChanged) summaryParts.push('summary text changed');
      if (durationDiff !== 0) {
        const sign = durationDiff > 0 ? '+' : '';
        summaryParts.push(`duration ${sign}${durationDiff}ms`);
      }
      const humanSummary = summaryParts.length
        ? summaryParts.join(', ')
        : 'No significant changes detected';

      return {
        success: true,
        report1: {
          id: report1._id,
          timestamp: report1.timestamp
        },
        report2: {
          id: report2._id,
          timestamp: report2.timestamp
        },
        diff: {
          tests: {
            added,
            removed,
            changed,
            unchanged: unchanged.length
          },
          overallHealth: {
            from: report1.overallHealth,
            to: report2.overallHealth,
            changed: healthChanged
          },
          duration: {
            from: report1.duration,
            to: report2.duration,
            diff: durationDiff
          },
          summary: {
            from: report1.summary,
            to: report2.summary,
            changed: summaryChanged
          }
        },
        summary: humanSummary
      };
    } catch (error) {
      logger.error('Failed to compare reports:', error);
      return { success: false, error: error.message };
    }
  }

  // Intent handler
  async handleIntent(intent, params, context) {
    const commandMap = {
      'run_diagnostics': 'run',
      'check_health': 'status',
      'diagnostic_history': 'history',
      'get_diagnostic_report': 'report',
      'test_component': 'test',
      'schedule_diagnostics': 'schedule',
      'view_scheduled_diagnostics': 'view-schedule',
      'cancel_scheduled_diagnostics': 'cancel-schedule',
      'compare_diagnostics': 'compare'
    };

    const action = commandMap[intent] || 'status';
    return this.execute({ action, ...params });
  }

  // Register intents
  getIntentPatterns() {
    return [
      {
        pattern: /run.*diagnos|health.*check|system.*test/i,
        intent: 'run_diagnostics',
        description: 'Run system diagnostics'
      },
      {
        pattern: /diagnos.*status|health.*status|system.*health/i,
        intent: 'check_health',
        description: 'Check system health status'
      },
      {
        pattern: /diagnos.*history|health.*history/i,
        intent: 'diagnostic_history',
        description: 'View diagnostic history'
      },
      {
        // Before the report pattern: "compare the last two diagnostic reports" matches both.
        pattern: /compar\w*.*(diagnos|health)|(diagnos|health).*compar/i,
        intent: 'compare_diagnostics',
        description: 'Compare two diagnostic reports'
      },
      {
        pattern: /diagnos.*report|health.*report/i,
        intent: 'get_diagnostic_report',
        description: 'Get diagnostic report'
      },
      {
        pattern: /test.*(api|database|telegram|web|plugin)/i,
        intent: 'test_component',
        description: 'Test specific component'
      },
      {
        pattern: /schedule.*diagnos/i,
        intent: 'schedule_diagnostics',
        description: 'Schedule automatic diagnostics'
      },
      {
        pattern: /view.*scheduled.*diagnos/i,
        intent: 'view_scheduled_diagnostics',
        description: 'View scheduled diagnostics'
      },
      {
        pattern: /cancel.*scheduled.*diagnos/i,
        intent: 'cancel_scheduled_diagnostics',
        description: 'Cancel scheduled diagnostics'
      }
    ];
  }
}
