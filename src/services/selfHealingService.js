import { EventEmitter } from 'events';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import mongoose from 'mongoose';
import si from 'systeminformation';
import HealingEvent from '../models/HealingEvent.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

/**
 * Self-Healing Service
 * Automatically detects and remediates runtime/operational issues
 *
 * Key safety features:
 * - Config-driven with global enable/disable
 * - Per-action cooldowns to prevent loops
 * - Max actions per hour limits
 * - All actions logged to database
 * - Dry-run mode for testing
 */
class SelfHealingService extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.isRunning = false;
    this.jobName = 'self-healing-check';
    this.lastCheck = null;

    // Default configuration - everything is configurable and can be disabled
    this.config = {
      // Global switch - if false, no healing actions are taken
      enabled: false, // DISABLED BY DEFAULT for safety

      // Dry-run mode - log actions but don't execute them
      dryRun: true, // TRUE BY DEFAULT for safety

      // How often to check for issues (milliseconds)
      checkInterval: 60 * 1000, // 1 minute

      // Global safety limits
      maxActionsPerHour: 10, // Max total healing actions per hour
      globalCooldownMinutes: 2, // Minimum time between any actions

      // Individual remediation rules
      rules: {
        // Memory cleanup when usage is high
        memoryCleanup: {
          enabled: true,
          threshold: 90, // percentage
          cooldownMinutes: 15,
          maxAttemptsPerHour: 3,
          action: 'gc_and_cache_clear'
        },

        // Disk cleanup when space is low
        diskCleanup: {
          enabled: true,
          threshold: 90, // percentage
          cooldownMinutes: 60,
          maxAttemptsPerHour: 2,
          action: 'log_rotation',
          targetPaths: [process.env.LOGS_PATH || 'logs', '/tmp']
        },

        // MongoDB reconnection on connection loss
        dbReconnect: {
          enabled: true,
          cooldownMinutes: 5,
          maxAttemptsPerHour: 5,
          retryDelayMs: 5000
        },

        // Clear expired cache entries
        cacheCleanup: {
          enabled: true,
          intervalMinutes: 30, // Run periodically, not on threshold
          cooldownMinutes: 30,
          maxAttemptsPerHour: 2
        },

        // Rotate logs when they get too large
        logRotation: {
          enabled: true,
          maxLogSizeMB: 100,
          cooldownMinutes: 60,
          maxAttemptsPerHour: 2,
          keepRotations: 5
        },

        // Retry failed scheduled jobs
        jobRetry: {
          enabled: true,
          cooldownMinutes: 10,
          maxAttemptsPerHour: 5,
          maxRetries: 3
        },

        // Process watchdog - restart if memory grows too much
        processWatchdog: {
          enabled: false, // DISABLED - dangerous, could cause boot loop
          memoryThresholdMB: 1500,
          cooldownMinutes: 30,
          maxAttemptsPerHour: 1
        }
      },

      // Notification settings
      notifications: {
        telegram: true,
        logLevel: 'info' // 'debug', 'info', 'warn', 'error'
      }
    };

    // Track recent actions for rate limiting
    this.recentActions = [];

    logger.info('[SelfHealing] Service initialized (disabled by default)');
  }

  /**
   * Initialize the service
   */
  async initialize() {
    try {
      // Load saved configuration from database
      await this.loadConfig();

      // Define the Agenda job for health checks
      await this.defineAgendaJob();

      if (this.config.enabled) {
        await this.startMonitoring();
        logger.info('[SelfHealing] Service started with monitoring enabled');
      } else {
        logger.info('[SelfHealing] Service initialized but monitoring is disabled');
      }

      return true;
    } catch (error) {
      logger.error('[SelfHealing] Failed to initialize:', error);
      return false;
    }
  }

  /**
   * Define the Agenda job for health checks
   */
  async defineAgendaJob() {
    const scheduler = this.agent?.scheduler;
    if (!scheduler?.agenda) {
      logger.warn('[SelfHealing] Scheduler not available, cannot define Agenda job');
      return;
    }

    // Define the health check job
    scheduler.agenda.define(this.jobName, async (job) => {
      try {
        // Only run if enabled
        if (!this.config.enabled) {
          logger.debug('[SelfHealing] Job triggered but service is disabled');
          return;
        }
        await this.runHealthCheck();
      } catch (error) {
        logger.error('[SelfHealing] Agenda job failed:', error);
      }
    });

    logger.info('[SelfHealing] Agenda job defined');
  }

  /**
   * Load configuration from database
   */
  async loadConfig() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });

      if (agent?.serviceConfigs?.selfHealing) {
        // Deep merge with defaults
        this.config = this.deepMerge(this.config, agent.serviceConfigs.selfHealing);
        logger.info('[SelfHealing] Configuration loaded from database');
      }
    } catch (error) {
      logger.warn('[SelfHealing] Failed to load config from database, using defaults:', error.message);
    }
  }

  /**
   * Save configuration to database
   */
  async saveConfig() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });

      if (agent) {
        if (!agent.serviceConfigs) {
          agent.serviceConfigs = {};
        }
        agent.serviceConfigs.selfHealing = this.config;
        agent.markModified('serviceConfigs');
        await agent.save();
        logger.info('[SelfHealing] Configuration saved to database');
      }
    } catch (error) {
      logger.error('[SelfHealing] Failed to save config:', error);
    }
  }

  /**
   * Deep merge helper
   */
  deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  /**
   * Start the monitoring loop using Agenda
   */
  async startMonitoring() {
    const scheduler = this.agent?.scheduler;
    if (!scheduler?.agenda) {
      logger.warn('[SelfHealing] Scheduler not available, cannot start monitoring');
      return false;
    }

    try {
      // Cancel any existing jobs first
      await this.stopMonitoring();

      // Schedule the recurring health check (every 1 minute by default)
      const intervalMinutes = Math.max(1, Math.floor(this.config.checkInterval / 60000));
      await scheduler.agenda.every(`${intervalMinutes} minutes`, this.jobName, {}, {
        skipImmediate: false // Run immediately on start
      });

      logger.info(`[SelfHealing] Monitoring started via Agenda (every ${intervalMinutes} minute(s))`);
      return true;
    } catch (error) {
      logger.error('[SelfHealing] Failed to start monitoring:', error);
      return false;
    }
  }

  /**
   * Stop the monitoring loop
   */
  async stopMonitoring() {
    const scheduler = this.agent?.scheduler;
    if (!scheduler?.agenda) {
      return;
    }

    try {
      // Cancel all self-healing jobs
      await scheduler.agenda.cancel({ name: this.jobName });
      logger.info('[SelfHealing] Monitoring stopped');
    } catch (error) {
      logger.error('[SelfHealing] Failed to stop monitoring:', error);
    }
  }

  /**
   * Check if monitoring is active
   */
  async isMonitoringActive() {
    const scheduler = this.agent?.scheduler;
    if (!scheduler?.agenda) {
      return false;
    }

    try {
      const jobs = await scheduler.agenda.jobs({ name: this.jobName });
      return jobs.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Run a health check and trigger remediation if needed
   */
  async runHealthCheck() {
    if (this.isRunning) {
      logger.debug('[SelfHealing] Check already running, skipping');
      return;
    }

    this.isRunning = true;
    this.lastCheck = new Date();

    try {
      // Collect current system state
      const systemState = await this.collectSystemState();

      // Check each enabled rule
      const issues = [];

      // Check memory
      if (this.config.rules.memoryCleanup.enabled) {
        if (systemState.memory.percentage > this.config.rules.memoryCleanup.threshold) {
          issues.push({
            type: 'memory_cleanup',
            condition: `memory ${systemState.memory.percentage.toFixed(1)}% > ${this.config.rules.memoryCleanup.threshold}%`,
            value: systemState.memory.percentage
          });
        }
      }

      // Check disk space
      if (this.config.rules.diskCleanup.enabled) {
        for (const disk of systemState.disks) {
          if (disk.percentage > this.config.rules.diskCleanup.threshold) {
            issues.push({
              type: 'disk_cleanup',
              condition: `disk ${disk.mount} ${disk.percentage.toFixed(1)}% > ${this.config.rules.diskCleanup.threshold}%`,
              value: disk.percentage,
              target: disk.mount
            });
          }
        }
      }

      // Check MongoDB connection
      if (this.config.rules.dbReconnect.enabled) {
        if (mongoose.connection.readyState !== 1) {
          issues.push({
            type: 'db_reconnect',
            condition: `MongoDB state: ${mongoose.connection.readyState} (not connected)`,
            value: mongoose.connection.readyState
          });
        }
      }

      // Process issues
      for (const issue of issues) {
        await this.handleIssue(issue, systemState);
      }

      // Run periodic tasks
      await this.runPeriodicTasks(systemState);

    } catch (error) {
      logger.error('[SelfHealing] Health check failed:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Collect current system state
   */
  async collectSystemState() {
    try {
      const [mem, disks, load] = await Promise.all([
        si.mem(),
        si.fsSize(),
        si.currentLoad()
      ]);

      return {
        memory: {
          total: mem.total,
          used: mem.used,
          free: mem.free,
          percentage: (mem.used / mem.total) * 100
        },
        disks: disks.map(d => ({
          mount: d.mount,
          size: d.size,
          used: d.used,
          available: d.available,
          percentage: d.use
        })),
        cpu: {
          load: load.currentLoad,
          loadAverage: os.loadavg()
        },
        uptime: os.uptime(),
        processMemory: process.memoryUsage()
      };
    } catch (error) {
      logger.error('[SelfHealing] Failed to collect system state:', error);
      return {
        memory: { percentage: 0 },
        disks: [],
        cpu: { load: 0, loadAverage: [0, 0, 0] },
        uptime: 0
      };
    }
  }

  /**
   * Handle a detected issue
   */
  async handleIssue(issue, systemState) {
    const eventType = issue.type;
    const rule = this.config.rules[this.eventTypeToRuleKey(eventType)];

    if (!rule || !rule.enabled) {
      return;
    }

    // Check cooldown
    const inCooldown = await HealingEvent.isInCooldown(eventType, rule.cooldownMinutes);
    if (inCooldown) {
      logger.debug(`[SelfHealing] ${eventType} in cooldown, skipping`);
      return;
    }

    // Check rate limit
    const recentCount = await HealingEvent.countRecentByType(eventType, 1);
    if (recentCount >= rule.maxAttemptsPerHour) {
      logger.warn(`[SelfHealing] ${eventType} rate limit reached (${recentCount}/${rule.maxAttemptsPerHour} per hour)`);
      return;
    }

    // Check global rate limit
    const globalRecentCount = await this.getGlobalActionCount(1);
    if (globalRecentCount >= this.config.maxActionsPerHour) {
      logger.warn(`[SelfHealing] Global rate limit reached (${globalRecentCount}/${this.config.maxActionsPerHour} per hour)`);
      return;
    }

    // Create healing event record
    const event = new HealingEvent({
      eventType,
      trigger: {
        type: 'threshold',
        source: 'health_check',
        condition: issue.condition,
        value: issue.value
      },
      action: {
        name: rule.action || eventType,
        targetService: issue.target
      },
      systemState: {
        memoryUsage: systemState.memory.percentage,
        cpuUsage: systemState.cpu.load,
        diskUsage: systemState.disks[0]?.percentage || 0,
        uptime: systemState.uptime,
        loadAverage: systemState.cpu.loadAverage
      }
    });

    await event.save();

    // Execute or simulate
    if (this.config.dryRun) {
      logger.info(`[SelfHealing] DRY RUN: Would execute ${eventType} for: ${issue.condition}`);
      await event.skip('Dry run mode enabled');
      return;
    }

    if (!this.config.enabled) {
      logger.info(`[SelfHealing] DISABLED: Would execute ${eventType} for: ${issue.condition}`);
      await event.skip('Service disabled');
      return;
    }

    // Execute the remediation action
    await this.executeRemediation(event, issue, rule);
  }

  /**
   * Execute a remediation action
   */
  async executeRemediation(event, issue, rule) {
    await event.start();

    try {
      let result;

      switch (event.eventType) {
        case 'memory_cleanup':
          result = await this.doMemoryCleanup();
          break;

        case 'disk_cleanup':
          result = await this.doDiskCleanup(rule.targetPaths);
          break;

        case 'db_reconnect':
          result = await this.doDbReconnect();
          break;

        case 'cache_clear':
          result = await this.doCacheCleanup();
          break;

        case 'log_rotation':
          result = await this.doLogRotation(rule);
          break;

        default:
          result = { success: false, message: `Unknown action type: ${event.eventType}` };
      }

      if (result.success) {
        await event.complete(true, result.message, result.output);
        this.notify(`Self-healed: ${event.eventType}`, result.message);
      } else {
        await event.fail(new Error(result.message));
        this.notify(`Self-healing failed: ${event.eventType}`, result.message, 'error');
      }

      this.emit('action', { event, result });

    } catch (error) {
      await event.fail(error);
      logger.error(`[SelfHealing] Remediation failed for ${event.eventType}:`, error);
      this.notify(`Self-healing error: ${event.eventType}`, error.message, 'error');
    }
  }

  /**
   * Memory cleanup action
   */
  async doMemoryCleanup() {
    try {
      const before = process.memoryUsage();

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      // Clear any agent caches
      if (this.agent?.providerManager?.clearCache) {
        this.agent.providerManager.clearCache();
      }

      const after = process.memoryUsage();
      const freedMB = ((before.heapUsed - after.heapUsed) / 1024 / 1024).toFixed(2);

      return {
        success: true,
        message: `Freed ${freedMB}MB of heap memory`,
        output: JSON.stringify({ before, after })
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Disk cleanup action
   */
  async doDiskCleanup(targetPaths = []) {
    try {
      const results = [];

      for (const targetPath of targetPaths) {
        try {
          // Only clean known safe paths
          if (!targetPath.includes('logs') && targetPath !== '/tmp') {
            continue;
          }

          // For log directories, remove old files
          if (targetPath.includes('logs')) {
            const { stdout } = await execAsync(
              `find "${targetPath}" -name "*.log.*" -mtime +7 -delete 2>/dev/null; ` +
              `find "${targetPath}" -name "*.gz" -mtime +30 -delete 2>/dev/null; ` +
              `echo "Cleaned ${targetPath}"`
            );
            results.push(stdout.trim());
          }

          // For /tmp, remove old temp files
          if (targetPath === '/tmp') {
            const { stdout } = await execAsync(
              `find /tmp -name "voice_*" -mtime +1 -delete 2>/dev/null; ` +
              `find /tmp -name "*.wav" -mtime +1 -delete 2>/dev/null; ` +
              `echo "Cleaned temp files"`
            );
            results.push(stdout.trim());
          }
        } catch (err) {
          results.push(`Failed to clean ${targetPath}: ${err.message}`);
        }
      }

      return {
        success: true,
        message: `Disk cleanup completed`,
        output: results.join('\n')
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Database reconnection action
   */
  async doDbReconnect() {
    try {
      if (mongoose.connection.readyState === 1) {
        return { success: true, message: 'Database already connected' };
      }

      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';

      // Close existing connection if any
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
      }

      // Reconnect
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000
      });

      return {
        success: true,
        message: 'Database reconnected successfully'
      };
    } catch (error) {
      return { success: false, message: `Database reconnection failed: ${error.message}` };
    }
  }

  /**
   * Cache cleanup action
   */
  async doCacheCleanup() {
    try {
      let cleared = 0;

      // Clear plugin caches if available
      if (this.agent?.apiManager?.plugins) {
        for (const [name, plugin] of this.agent.apiManager.plugins) {
          if (plugin.clearCache) {
            plugin.clearCache();
            cleared++;
          }
        }
      }

      // Clear contract service cache if available
      try {
        const contractService = (await import('./crypto/contractServiceWrapper.js')).default;
        if (contractService?.clearCache) {
          contractService.clearCache();
          cleared++;
        }
      } catch (err) {
        // Contract service may not be loaded
      }

      return {
        success: true,
        message: `Cleared ${cleared} caches`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Log rotation action
   */
  async doLogRotation(rule) {
    try {
      const logDir = process.env.LOGS_PATH || path.join(process.cwd(), 'logs');
      const maxSizeMB = rule.maxLogSizeMB || 100;
      const keepRotations = rule.keepRotations || 5;

      // Find large log files and rotate them
      const { stdout } = await execAsync(
        `find "${logDir}" -name "*.log" -size +${maxSizeMB}M 2>/dev/null || echo ""`
      );

      const largeFiles = stdout.trim().split('\n').filter(f => f);

      if (largeFiles.length === 0) {
        return { success: true, message: 'No logs need rotation' };
      }

      const rotated = [];
      for (const logFile of largeFiles) {
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const rotatedName = `${logFile}.${timestamp}`;

          // Rotate: rename current, create new empty
          await execAsync(`mv "${logFile}" "${rotatedName}" && touch "${logFile}"`);

          // Compress rotated file
          await execAsync(`gzip "${rotatedName}" 2>/dev/null || true`);

          // Remove old rotations beyond keep limit
          await execAsync(
            `ls -t "${logFile}".* 2>/dev/null | tail -n +${keepRotations + 1} | xargs rm -f 2>/dev/null || true`
          );

          rotated.push(path.basename(logFile));
        } catch (err) {
          logger.warn(`[SelfHealing] Failed to rotate ${logFile}:`, err.message);
        }
      }

      return {
        success: true,
        message: `Rotated ${rotated.length} log files`,
        output: rotated.join(', ')
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Run periodic tasks (not threshold-based)
   */
  async runPeriodicTasks(systemState) {
    const now = Date.now();

    // Cache cleanup
    if (this.config.rules.cacheCleanup.enabled) {
      const rule = this.config.rules.cacheCleanup;
      const intervalMs = rule.intervalMinutes * 60 * 1000;

      if (!this.lastCacheCleanup || (now - this.lastCacheCleanup) > intervalMs) {
        const inCooldown = await HealingEvent.isInCooldown('cache_clear', rule.cooldownMinutes);
        if (!inCooldown) {
          this.lastCacheCleanup = now;
          await this.handleIssue({
            type: 'cache_clear',
            condition: 'Periodic cache cleanup',
            value: null
          }, systemState);
        }
      }
    }
  }

  /**
   * Get global action count in the last N hours
   */
  async getGlobalActionCount(hours = 1) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return await HealingEvent.countDocuments({
      createdAt: { $gte: since },
      status: { $in: ['success', 'in_progress'] }
    });
  }

  /**
   * Convert event type to rule key
   */
  eventTypeToRuleKey(eventType) {
    const mapping = {
      'memory_cleanup': 'memoryCleanup',
      'disk_cleanup': 'diskCleanup',
      'db_reconnect': 'dbReconnect',
      'cache_clear': 'cacheCleanup',
      'log_rotation': 'logRotation',
      'job_retry': 'jobRetry',
      'process_watchdog': 'processWatchdog'
    };
    return mapping[eventType] || eventType;
  }

  /**
   * Send notification
   */
  notify(title, message, level = 'info') {
    const logFn = level === 'error' ? logger.error : logger.info;
    logFn(`[SelfHealing] ${title}: ${message}`);

    if (this.config.notifications.telegram && this.agent?.telegram) {
      const icon = level === 'error' ? '❌' : '🔧';
      this.agent.telegram.sendMessage(`${icon} *Self-Healing*\n\n*${title}*\n${message}`)
        .catch(err => logger.warn('[SelfHealing] Failed to send Telegram notification:', err.message));
    }
  }

  /**
   * Manually trigger a specific healing action (for testing)
   */
  async triggerAction(actionType, options = {}) {
    const systemState = await this.collectSystemState();

    const event = new HealingEvent({
      eventType: actionType,
      trigger: {
        type: 'manual',
        source: 'api',
        condition: options.reason || 'Manual trigger'
      },
      action: {
        name: actionType,
        parameters: options
      },
      systemState: {
        memoryUsage: systemState.memory.percentage,
        cpuUsage: systemState.cpu.load,
        diskUsage: systemState.disks[0]?.percentage || 0,
        uptime: systemState.uptime,
        loadAverage: systemState.cpu.loadAverage
      }
    });

    await event.save();

    // Check if we should actually execute
    if (this.config.dryRun && !options.force) {
      await event.skip('Dry run mode (use force=true to override)');
      return { success: false, event, message: 'Dry run mode - action not executed' };
    }

    // Execute the action
    await event.start();

    try {
      let result;

      switch (actionType) {
        case 'memory_cleanup':
          result = await this.doMemoryCleanup();
          break;
        case 'disk_cleanup':
          result = await this.doDiskCleanup(options.targetPaths || this.config.rules.diskCleanup.targetPaths);
          break;
        case 'db_reconnect':
          result = await this.doDbReconnect();
          break;
        case 'cache_clear':
          result = await this.doCacheCleanup();
          break;
        case 'log_rotation':
          result = await this.doLogRotation(this.config.rules.logRotation);
          break;
        default:
          result = { success: false, message: `Unknown action: ${actionType}` };
      }

      if (result.success) {
        await event.complete(true, result.message, result.output);
      } else {
        await event.fail(new Error(result.message));
      }

      return { success: result.success, event, result };

    } catch (error) {
      await event.fail(error);
      return { success: false, event, error: error.message };
    }
  }

  /**
   * Get service status
   */
  async getStatus() {
    const stats = await HealingEvent.getStats(24);
    const systemState = await this.collectSystemState();
    const isMonitoring = await this.isMonitoringActive();

    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      monitoring: isMonitoring,
      lastCheck: this.lastCheck,
      checkInterval: this.config.checkInterval,
      systemState: {
        memory: `${systemState.memory.percentage.toFixed(1)}%`,
        disk: systemState.disks[0] ? `${systemState.disks[0].percentage.toFixed(1)}%` : 'N/A',
        cpu: `${systemState.cpu.load.toFixed(1)}%`,
        uptime: `${Math.floor(systemState.uptime / 3600)}h ${Math.floor((systemState.uptime % 3600) / 60)}m`,
        dbConnected: mongoose.connection.readyState === 1
      },
      stats24h: stats,
      rules: Object.fromEntries(
        Object.entries(this.config.rules).map(([key, rule]) => [key, { enabled: rule.enabled }])
      )
    };
  }

  /**
   * Update configuration
   */
  async updateConfig(updates) {
    this.config = this.deepMerge(this.config, updates);
    await this.saveConfig();

    // Restart monitoring if needed
    const isMonitoring = await this.isMonitoringActive();
    if (this.config.enabled && !isMonitoring) {
      await this.startMonitoring();
    } else if (!this.config.enabled && isMonitoring) {
      await this.stopMonitoring();
    }

    return this.config;
  }

  /**
   * Enable the service
   */
  async enable() {
    this.config.enabled = true;
    await this.saveConfig();
    await this.startMonitoring();
    logger.info('[SelfHealing] Service enabled');
    return { success: true, message: 'Self-healing service enabled' };
  }

  /**
   * Disable the service
   */
  async disable() {
    this.config.enabled = false;
    await this.saveConfig();
    await this.stopMonitoring();
    logger.info('[SelfHealing] Service disabled');
    return { success: true, message: 'Self-healing service disabled' };
  }

  /**
   * Set dry-run mode
   */
  async setDryRun(enabled) {
    this.config.dryRun = enabled;
    await this.saveConfig();
    logger.info(`[SelfHealing] Dry-run mode ${enabled ? 'enabled' : 'disabled'}`);
    return { success: true, dryRun: enabled };
  }

  /**
   * Get recent healing events
   */
  async getEvents(options = {}) {
    const { limit = 50, eventType, status } = options;

    const query = {};
    if (eventType) query.eventType = eventType;
    if (status) query.status = status;

    const events = await HealingEvent.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return events;
  }

  /**
   * Cleanup old healing events
   */
  async cleanupOldEvents(daysToKeep = 30) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const result = await HealingEvent.deleteMany({ createdAt: { $lt: cutoff } });
    logger.info(`[SelfHealing] Cleaned up ${result.deletedCount} old events`);
    return { deletedCount: result.deletedCount };
  }
}

export default SelfHealingService;
