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
        default:
          return {
            success: false,
            error: 'Invalid action. Available actions: run, status, history, report, test, schedule, view-schedule, cancel-schedule'
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
      'cancel_scheduled_diagnostics': 'cancel-schedule'
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