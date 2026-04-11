import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';

/**
 * Self-Healing Plugin
 * API interface for the self-healing/auto-remediation service
 *
 * Provides endpoints to:
 * - View service status and configuration
 * - Enable/disable the service
 * - Manually trigger healing actions
 * - View healing event history
 * - Update configuration
 */
export default class SelfHealingPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'selfHealing';
    this.version = '1.0.0';
    this.description = 'Self-healing and auto-remediation service for runtime issues';

    this.commands = [
      {
        command: 'status',
        description: 'Get self-healing service status',
        usage: 'status',
        examples: [
          'show self-healing status',
          'is self-healing enabled',
          'check healing service'
        ]
      },
      {
        command: 'enable',
        description: 'Enable the self-healing service',
        usage: 'enable',
        examples: [
          'enable self-healing',
          'turn on auto-remediation',
          'start self-healing'
        ]
      },
      {
        command: 'disable',
        description: 'Disable the self-healing service',
        usage: 'disable',
        examples: [
          'disable self-healing',
          'turn off auto-remediation',
          'stop self-healing'
        ]
      },
      {
        command: 'trigger',
        description: 'Manually trigger a healing action',
        usage: 'trigger({ action: "memory_cleanup" })',
        examples: [
          'trigger memory cleanup',
          'run disk cleanup',
          'clear caches',
          'rotate logs'
        ]
      },
      {
        command: 'events',
        description: 'Get recent healing events',
        usage: 'events({ limit: 20 })',
        examples: [
          'show healing events',
          'list recent remediations',
          'healing history'
        ]
      },
      {
        command: 'config',
        description: 'View or update configuration',
        usage: 'config or config({ rules: { memoryCleanup: { threshold: 85 } } })',
        examples: [
          'show healing config',
          'update memory threshold',
          'configure self-healing'
        ]
      }
    ];
  }

  async execute(params) {
    const { action, ...data } = params;

    // Get the self-healing service from agent
    const service = this.agent?.selfHealingService;

    if (!service) {
      return {
        success: false,
        error: 'Self-healing service not initialized. Please restart the agent.'
      };
    }

    try {
      switch (action) {
        case 'status':
          return await this.getStatus(service);

        case 'enable':
          return await this.enableService(service);

        case 'disable':
          return await this.disableService(service);

        case 'setDryRun':
          return await this.setDryRun(service, data);

        case 'trigger':
          return await this.triggerAction(service, data);

        case 'events':
          return await this.getEvents(service, data);

        case 'stats':
          return await this.getStats(service, data);

        case 'config':
          return await this.handleConfig(service, data);

        case 'updateConfig':
          return await this.updateConfig(service, data);

        case 'runCheck':
          return await this.runHealthCheck(service);

        case 'cleanup':
          return await this.cleanupEvents(service, data);

        case 'systemState':
          return await this.getSystemState(service);

        default:
          return {
            success: false,
            error: `Unknown action: ${action}. Available: status, enable, disable, setDryRun, trigger, events, stats, config, updateConfig, runCheck, cleanup, systemState`
          };
      }
    } catch (error) {
      logger.error(`[SelfHealingPlugin] Action ${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get service status
   */
  async getStatus(service) {
    const status = await service.getStatus();

    return {
      success: true,
      data: status,
      message: status.enabled
        ? (status.dryRun ? 'Self-healing enabled (dry-run mode)' : 'Self-healing active')
        : 'Self-healing disabled'
    };
  }

  /**
   * Enable the service
   */
  async enableService(service) {
    const result = await service.enable();
    return {
      success: true,
      data: { enabled: true },
      message: result.message
    };
  }

  /**
   * Disable the service
   */
  async disableService(service) {
    const result = await service.disable();
    return {
      success: true,
      data: { enabled: false },
      message: result.message
    };
  }

  /**
   * Set dry-run mode
   */
  async setDryRun(service, data) {
    this.validateParams(data, {
      enabled: { required: true, type: 'boolean' }
    });

    const result = await service.setDryRun(data.enabled);
    return {
      success: true,
      data: result,
      message: `Dry-run mode ${data.enabled ? 'enabled' : 'disabled'}`
    };
  }

  /**
   * Manually trigger a healing action
   */
  async triggerAction(service, data) {
    const validActions = [
      'memory_cleanup',
      'disk_cleanup',
      'db_reconnect',
      'cache_clear',
      'log_rotation'
    ];

    this.validateParams(data, {
      actionType: { required: true, type: 'string', enum: validActions }
    });

    const result = await service.triggerAction(data.actionType, {
      force: data.force || false,
      reason: data.reason || 'API trigger',
      targetPaths: data.targetPaths
    });

    return {
      success: result.success,
      data: {
        eventId: result.event?._id,
        status: result.event?.status,
        result: result.result
      },
      message: result.message || (result.success ? 'Action executed successfully' : 'Action failed')
    };
  }

  /**
   * Get recent healing events
   */
  async getEvents(service, data) {
    const events = await service.getEvents({
      limit: data.limit || 50,
      eventType: data.eventType,
      status: data.status
    });

    return {
      success: true,
      data: {
        events,
        count: events.length
      },
      message: `Retrieved ${events.length} healing events`
    };
  }

  /**
   * Get healing statistics
   */
  async getStats(service, data) {
    const HealingEvent = (await import('../../models/HealingEvent.js')).default;
    const hours = data.hours || 24;
    const stats = await HealingEvent.getStats(hours);

    return {
      success: true,
      data: {
        period: `${hours} hours`,
        stats
      },
      message: `${stats.total} healing events in the last ${hours} hours`
    };
  }

  /**
   * Handle config action (get or update)
   */
  async handleConfig(service, data) {
    // If data has updates, apply them
    if (data.rules || data.enabled !== undefined || data.dryRun !== undefined) {
      return await this.updateConfig(service, data);
    }

    // Otherwise return current config
    return {
      success: true,
      data: {
        config: service.config
      },
      message: 'Current self-healing configuration'
    };
  }

  /**
   * Update configuration
   */
  async updateConfig(service, data) {
    const newConfig = await service.updateConfig(data);

    return {
      success: true,
      data: {
        config: newConfig
      },
      message: 'Configuration updated successfully'
    };
  }

  /**
   * Run a health check now
   */
  async runHealthCheck(service) {
    await service.runHealthCheck();

    return {
      success: true,
      data: {
        lastCheck: service.lastCheck
      },
      message: 'Health check completed'
    };
  }

  /**
   * Cleanup old healing events
   */
  async cleanupEvents(service, data) {
    const daysToKeep = data.daysToKeep || 30;
    const result = await service.cleanupOldEvents(daysToKeep);

    return {
      success: true,
      data: result,
      message: `Cleaned up ${result.deletedCount} old events`
    };
  }

  /**
   * Get current system state
   */
  async getSystemState(service) {
    const state = await service.collectSystemState();

    return {
      success: true,
      data: {
        memory: {
          usedGB: (state.memory.used / 1024 / 1024 / 1024).toFixed(2),
          totalGB: (state.memory.total / 1024 / 1024 / 1024).toFixed(2),
          percentage: state.memory.percentage.toFixed(1)
        },
        disks: state.disks.map(d => ({
          mount: d.mount,
          usedGB: (d.used / 1024 / 1024 / 1024).toFixed(2),
          totalGB: (d.size / 1024 / 1024 / 1024).toFixed(2),
          percentage: d.percentage.toFixed(1)
        })),
        cpu: {
          load: state.cpu.load.toFixed(1),
          loadAverage: state.cpu.loadAverage.map(l => l.toFixed(2))
        },
        uptime: {
          seconds: state.uptime,
          human: `${Math.floor(state.uptime / 86400)}d ${Math.floor((state.uptime % 86400) / 3600)}h ${Math.floor((state.uptime % 3600) / 60)}m`
        },
        processMemory: {
          heapUsedMB: (state.processMemory.heapUsed / 1024 / 1024).toFixed(2),
          heapTotalMB: (state.processMemory.heapTotal / 1024 / 1024).toFixed(2),
          rssMB: (state.processMemory.rss / 1024 / 1024).toFixed(2)
        }
      },
      message: 'Current system state'
    };
  }

  /**
   * Get AI capabilities for natural language
   */
  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }

  /**
   * Get available commands
   */
  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}
