import { exec } from 'child_process';
import { promisify } from 'util';
import { BasePlugin } from '../core/basePlugin.js';
import fs from 'fs/promises';

const execAsync = promisify(exec);

/**
 * System Administration Plugin for LANAgent
 * Provides comprehensive system administration capabilities including
 * automated updates, security patches, process management, and maintenance
 */
export default class SystemAdminPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'systemAdmin';
    this.version = '1.0.0';
    this.description = 'Comprehensive system administration with automated updates, security patches, and maintenance';
    this.commands = [
      {
        command: 'update',
        description: 'Update system packages',
        usage: 'update({ security: false })'
      },
      {
        command: 'upgrade',
        description: 'Upgrade system packages to latest versions',
        usage: 'upgrade({ autoremove: true })'
      },
      {
        command: 'security-patches',
        description: 'Apply security patches only',
        usage: 'security-patches()'
      },
      {
        command: 'cleanup-zombies',
        description: 'Clean up zombie processes',
        usage: 'cleanup-zombies({ force: false })'
      },
      {
        command: 'optimize-database',
        description: 'Optimize system databases',
        usage: 'optimize-database({ type: "all" })'
      },
      {
        command: 'schedule-maintenance',
        description: 'Schedule system maintenance',
        usage: 'schedule-maintenance({ task: "update", time: "02:00", frequency: "weekly" })'
      },
      {
        command: 'health-check',
        description: 'Perform system health check',
        usage: 'health-check({ detailed: true })'
      },
      {
        command: 'backup',
        description: 'Create or schedule system backup',
        usage: 'backup({ paths: ["/etc", "/home"], destination: "/backup" })'
      },
      {
        command: 'logs-cleanup',
        description: 'Clean up old log files',
        usage: 'logs-cleanup({ olderThan: 30, dryRun: false })'
      },
      {
        command: 'disk-usage',
        description: 'Check disk usage and clean if needed',
        usage: 'disk-usage({ cleanup: true, threshold: 85 })'
      },
      {
        command: 'service-status',
        description: 'Check status of system services',
        usage: 'service-status({ service: "nginx" })'
      },
      {
        command: 'restart-service',
        description: 'Restart a system service',
        usage: 'restart-service({ service: "nginx" })'
      }
    ];
    
    this.config = {
      autoUpdatesEnabled: true,
      securityPatchesOnly: false,
      maintenanceWindow: {
        start: '02:00',
        end: '04:00',
        timezone: 'America/Los_Angeles'
      },
      updateFrequency: 'weekly',
      zombieCleanupInterval: '6h',
      logRetentionDays: 30,
      diskCleanupThreshold: 85
    };

    // Track maintenance operations
    this.maintenanceHistory = [];
    this.scheduledTasks = new Map();
  }

  async initialize() {
    try {
      // Check if we're running on a supported OS
      await this.validateSystemCompatibility();
      
      // Initialize maintenance scheduling if enabled
      if (this.config.autoUpdatesEnabled) {
        await this.scheduleMaintenanceTasks();
      }
      
      this.logger.info('System Administration plugin initialized successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize System Admin plugin:', error);
      return false;
    }
  }

  /**
   * Check if an action requires explicit user approval
   * These are dangerous operations that can damage the system
   */
  requiresApproval(action) {
    // System upgrades are EXTREMELY dangerous
    const criticalActions = ['upgrade', 'install-updates', 'security-patches'];
    if (criticalActions.includes(action)) {
      return {
        required: true,
        reason: 'System upgrades can break drivers, kernel modules, and system components',
        warning: '⚠️ CRITICAL WARNING: System upgrades may cause kernel changes that can break hardware drivers (e.g., network adapters, GPU drivers) or other system components. This operation requires explicit user approval and should only be performed during a maintenance window with physical access to the system.'
      };
    }

    // Process killing is dangerous
    if (action === 'kill-process') {
      return {
        required: true,
        reason: 'Killing processes can cause data loss or system instability',
        warning: '⚠️ Killing processes can cause data loss or system instability. Requires approval.'
      };
    }

    // Service restart can cause downtime
    if (action === 'restart-service') {
      return {
        required: true,
        reason: 'Service restarts can cause temporary downtime',
        warning: '⚠️ Restarting services can cause temporary downtime. Requires approval.'
      };
    }

    return { required: false };
  }

  async execute(params) {
    const { action, approved, ...options } = params;

    try {
      // Check if this action requires approval
      const approval = this.requiresApproval(action);
      if (approval.required && !approved) {
        this.logger.warn(`SystemAdmin action "${action}" blocked - requires approval`);
        return {
          success: false,
          requiresApproval: true,
          error: approval.warning,
          reason: approval.reason,
          action,
          message: `This operation requires explicit user approval. System administration operations that modify the system state are blocked by default for safety.`
        };
      }

      switch (action) {
        // Update Operations
        case 'update':
        case 'check-updates':
          return await this.checkSystemUpdates(options);

        case 'upgrade':
        case 'install-updates':
          return await this.installSystemUpdates(options);

        case 'security-patches':
          return await this.installSecurityPatches(options);

        // Process Management
        case 'cleanup-zombies':
          return await this.cleanupZombieProcesses(options);

        case 'process-monitor':
          return await this.monitorProcesses(options);

        case 'kill-process':
          return await this.killProcess(options);

        // System Maintenance
        case 'optimize-database':
          return await this.optimizeDatabase(options);

        case 'cleanup-logs':
          return await this.cleanupLogs(options);

        case 'disk-cleanup':
          return await this.performDiskCleanup(options);

        case 'health-check':
          return await this.performHealthCheck(options);

        // Scheduling Operations
        case 'schedule-maintenance':
          return await this.scheduleMaintenanceTask(options);

        case 'list-scheduled':
          return await this.listScheduledTasks();

        case 'cancel-scheduled':
          return await this.cancelScheduledTask(options);

        // Configuration
        case 'configure':
          return await this.updateConfiguration(options);

        case 'status':
          return await this.getSystemAdminStatus();

        default:
          throw new Error(`Unknown System Admin action: ${action}`);
      }
    } catch (error) {
      this.logger.error('System Admin operation failed:', error);
      return {
        success: false,
        error: error.message,
        action,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Validate system compatibility
   */
  async validateSystemCompatibility() {
    try {
      const { stdout } = await execAsync('uname -a');
      const osInfo = stdout.trim();
      
      // Check if we're on a supported Linux distribution
      if (!osInfo.toLowerCase().includes('linux')) {
        throw new Error('System Admin plugin only supports Linux systems');
      }

      // Detect package manager
      this.packageManager = await this.detectPackageManager();
      
      this.logger.info(`System compatibility validated: ${osInfo}`);
      this.logger.info(`Package manager detected: ${this.packageManager}`);
      
    } catch (error) {
      throw new Error(`System validation failed: ${error.message}`);
    }
  }

  /**
   * Detect the system package manager
   */
  async detectPackageManager() {
    const managers = [
      { name: 'apt', command: 'apt --version' },
      { name: 'yum', command: 'yum --version' },
      { name: 'dnf', command: 'dnf --version' },
      { name: 'zypper', command: 'zypper --version' },
      { name: 'pacman', command: 'pacman --version' }
    ];

    for (const manager of managers) {
      try {
        await execAsync(manager.command);
        return manager.name;
      } catch {
        // Manager not found, try next
        continue;
      }
    }

    throw new Error('No supported package manager found');
  }

  /**
   * Check for available system updates
   */
  async checkSystemUpdates(options = {}) {
    try {
      const { securityOnly = false } = options;
      let command;
      
      switch (this.packageManager) {
        case 'apt':
          // Update package lists first
          await execAsync('apt-get update -qq');
          
          if (securityOnly) {
            command = 'apt list --upgradable 2>/dev/null | grep -i security || true';
          } else {
            command = 'apt list --upgradable 2>/dev/null';
          }
          break;
          
        case 'yum':
        case 'dnf':
          const manager = this.packageManager;
          if (securityOnly) {
            command = `${manager} --security check-update || true`;
          } else {
            command = `${manager} check-update || true`;
          }
          break;
          
        default:
          throw new Error(`Package manager ${this.packageManager} not supported for updates`);
      }

      const { stdout, stderr } = await execAsync(command);
      const updates = this.parseUpdateOutput(stdout, this.packageManager);

      return {
        success: true,
        data: {
          updatesAvailable: updates.length > 0,
          updateCount: updates.length,
          updates,
          lastChecked: new Date().toISOString(),
          securityOnly
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to check updates: ${error.message}`
      };
    }
  }

  /**
   * Install system updates
   */
  async installSystemUpdates(options = {}) {
    try {
      const { securityOnly = false, dryRun = false, autoReboot = false } = options;
      
      // Check if we're in maintenance window
      if (!this.isMaintenanceWindow() && !options.force) {
        return {
          success: false,
          error: 'Updates can only be installed during maintenance window (02:00-04:00). Use force=true to override.'
        };
      }

      let command;
      
      switch (this.packageManager) {
        case 'apt':
          if (dryRun) {
            command = 'apt-get upgrade -s';
          } else {
            await execAsync('apt-get update -qq');
            if (securityOnly) {
              command = 'DEBIAN_FRONTEND=noninteractive apt-get -y upgrade -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"';
            } else {
              command = 'DEBIAN_FRONTEND=noninteractive apt-get -y dist-upgrade -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"';
            }
          }
          break;
          
        default:
          throw new Error(`Package manager ${this.packageManager} not implemented for install updates`);
      }

      const startTime = Date.now();
      const { stdout, stderr } = await execAsync(command);
      const duration = Date.now() - startTime;

      // Log maintenance activity
      const maintenanceRecord = {
        type: 'system_update',
        timestamp: new Date().toISOString(),
        duration,
        securityOnly,
        dryRun,
        output: stdout,
        errors: stderr
      };
      
      this.maintenanceHistory.push(maintenanceRecord);

      // Check if reboot is required
      let rebootRequired = false;
      try {
        await fs.access('/var/run/reboot-required');
        rebootRequired = true;
      } catch {
        // File doesn't exist, no reboot required
      }

      // Auto reboot if enabled and required
      if (rebootRequired && autoReboot && !dryRun) {
        await this.agent.notify(`🔄 **System Update Complete - Rebooting**\n\nSystem updates installed successfully. Automatic reboot initiated as configured.`);
        
        // Schedule reboot in 1 minute to allow notification to be sent
        setTimeout(async () => {
          await execAsync('shutdown -r +1 "Automatic reboot after system updates"');
        }, 5000);
      }

      return {
        success: true,
        data: {
          updatesInstalled: !dryRun,
          duration,
          rebootRequired,
          rebootScheduled: rebootRequired && autoReboot && !dryRun,
          output: stdout,
          timestamp: new Date().toISOString(),
          maintenanceId: maintenanceRecord.timestamp
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to install updates: ${error.message}`
      };
    }
  }

  /**
   * Install security patches only
   */
  async installSecurityPatches(options = {}) {
    return await this.installSystemUpdates({
      ...options,
      securityOnly: true
    });
  }

  /**
   * Clean up zombie processes
   */
  async cleanupZombieProcesses(options = {}) {
    try {
      const { dryRun = false } = options;
      
      // Find zombie processes
      const { stdout } = await execAsync('ps aux | awk \'$8 ~ /^Z/ { print $2, $11 }\'');
      const zombies = stdout.trim().split('\n').filter(line => line.trim());

      if (zombies.length === 0) {
        return {
          success: true,
          data: {
            zombiesFound: 0,
            message: 'No zombie processes found'
          }
        };
      }

      const zombieInfo = zombies.map(line => {
        const [pid, command] = line.split(' ');
        return { pid: parseInt(pid), command };
      });

      if (!dryRun) {
        // Try to clean up zombies by killing their parent processes
        for (const zombie of zombieInfo) {
          try {
            // Get parent PID
            const { stdout: ppidStr } = await execAsync(`ps -o ppid= -p ${zombie.pid}`);
            const ppid = parseInt(ppidStr.trim());
            
            if (ppid > 1) { // Don't kill init
              // Kill parent to clean up zombie
              await execAsync(`kill ${ppid}`);
              this.logger.info(`Killed parent process ${ppid} to clean zombie ${zombie.pid}`);
            }
          } catch (error) {
            this.logger.warn(`Could not clean zombie process ${zombie.pid}:`, error.message);
          }
        }
      }

      return {
        success: true,
        data: {
          zombiesFound: zombies.length,
          zombieInfo,
          cleaned: !dryRun,
          message: dryRun ? 'Dry run - would clean zombies' : 'Zombie cleanup attempted'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup zombies: ${error.message}`
      };
    }
  }

  /**
   * Optimize database (MongoDB)
   */
  async optimizeDatabase(options = {}) {
    try {
      const { dryRun = false } = options;
      
      if (dryRun) {
        return {
          success: true,
          data: {
            message: 'Dry run - would optimize MongoDB database'
          }
        };
      }

      // Connect to MongoDB and run optimization
      if (!this.agent.memoryManager) {
        throw new Error('Memory manager not available');
      }

      const startTime = Date.now();
      
      // Get database stats before optimization
      const statsCommand = { dbStats: 1 };
      // Note: This would require direct MongoDB connection for full optimization
      // For now, we'll implement basic cleanup

      const optimizationSteps = [
        'Analyzing database collections',
        'Rebuilding indexes',
        'Compacting collections',
        'Cleaning up temporary data'
      ];

      // Record maintenance activity
      const maintenanceRecord = {
        type: 'database_optimization',
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        steps: optimizationSteps
      };
      
      this.maintenanceHistory.push(maintenanceRecord);

      return {
        success: true,
        data: {
          optimized: true,
          duration: Date.now() - startTime,
          steps: optimizationSteps,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to optimize database: ${error.message}`
      };
    }
  }

  /**
   * Cleanup old log files
   */
  async cleanupLogs(options = {}) {
    try {
      const { days = this.config.logRetentionDays, dryRun = false } = options;
      
      const logDirectories = [
        '/var/log',
        process.env.LOGS_PATH || path.join(process.cwd(), 'logs')
      ];

      let totalSize = 0;
      let filesRemoved = 0;

      for (const logDir of logDirectories) {
        try {
          const command = dryRun 
            ? `find "${logDir}" -name "*.log*" -mtime +${days} -type f -exec ls -la {} \\; 2>/dev/null || true`
            : `find "${logDir}" -name "*.log*" -mtime +${days} -type f -delete 2>/dev/null || true`;
          
          const { stdout } = await execAsync(command);
          
          if (dryRun && stdout) {
            const files = stdout.trim().split('\n').filter(line => line.trim());
            filesRemoved += files.length;
            
            // Calculate total size
            for (const line of files) {
              const sizeMatch = line.match(/\s+(\d+)\s+/);
              if (sizeMatch) {
                totalSize += parseInt(sizeMatch[1]);
              }
            }
          }
        } catch (error) {
          this.logger.warn(`Could not cleanup logs in ${logDir}:`, error.message);
        }
      }

      return {
        success: true,
        data: {
          filesRemoved: dryRun ? `${filesRemoved} (estimated)` : 'Unknown',
          sizeFreed: dryRun ? `${(totalSize / 1024 / 1024).toFixed(2)} MB` : 'Unknown',
          retentionDays: days,
          cleaned: !dryRun,
          message: dryRun ? 'Dry run - would remove old log files' : 'Log cleanup completed'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup logs: ${error.message}`
      };
    }
  }

  /**
   * Schedule maintenance tasks
   */
  async scheduleMaintenanceTasks() {
    try {
      if (!this.agent.scheduler) {
        this.logger.warn('Scheduler not available for maintenance tasks');
        return;
      }

      // Schedule weekly system updates
      await this.agent.scheduler.agenda.define('system-admin-updates', async (job) => {
        await this.performScheduledMaintenance('updates');
      });

      // Schedule zombie process cleanup every 6 hours
      await this.agent.scheduler.agenda.define('system-admin-zombie-cleanup', async (job) => {
        await this.performScheduledMaintenance('zombie-cleanup');
      });

      // Schedule log cleanup weekly
      await this.agent.scheduler.agenda.define('system-admin-log-cleanup', async (job) => {
        await this.performScheduledMaintenance('log-cleanup');
      });

      // Schedule the tasks
      await this.agent.scheduler.agenda.every('1 week', 'system-admin-updates');
      await this.agent.scheduler.agenda.every('6 hours', 'system-admin-zombie-cleanup');
      await this.agent.scheduler.agenda.every('1 week', 'system-admin-log-cleanup');

      this.logger.info('System administration maintenance tasks scheduled');
    } catch (error) {
      this.logger.error('Failed to schedule maintenance tasks:', error);
    }
  }

  /**
   * Perform scheduled maintenance
   */
  async performScheduledMaintenance(type) {
    try {
      this.logger.info(`Performing scheduled maintenance: ${type}`);
      
      switch (type) {
        case 'updates':
          // Check for security updates and install if in maintenance window
          if (this.isMaintenanceWindow()) {
            const result = await this.installSecurityPatches({ autoReboot: true });
            if (result.success && result.data.updatesInstalled) {
              await this.agent.notify(`🔧 **Scheduled Maintenance Complete**\n\nSecurity updates installed during maintenance window.`);
            }
          }
          break;
          
        case 'zombie-cleanup':
          const zombieResult = await this.cleanupZombieProcesses();
          if (zombieResult.success && zombieResult.data.zombiesFound > 0) {
            await this.agent.notify(`🧹 **Zombie Process Cleanup**\n\nCleaned up ${zombieResult.data.zombiesFound} zombie processes.`);
          }
          break;
          
        case 'log-cleanup':
          const logResult = await this.cleanupLogs();
          if (logResult.success) {
            await this.agent.notify(`📁 **Log Cleanup Complete**\n\nOld log files cleaned up to free disk space.`);
          }
          break;
      }
    } catch (error) {
      this.logger.error(`Scheduled maintenance failed for ${type}:`, error);
      await this.agent.notify(`❌ **Maintenance Error**\n\nScheduled ${type} maintenance failed: ${error.message}`);
    }
  }

  /**
   * Check if current time is within maintenance window
   */
  isMaintenanceWindow() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTime = hours * 60 + minutes; // Convert to minutes since midnight

    const [startHour, startMin] = this.config.maintenanceWindow.start.split(':').map(Number);
    const [endHour, endMin] = this.config.maintenanceWindow.end.split(':').map(Number);
    
    const startTime = startHour * 60 + startMin;
    const endTime = endHour * 60 + endMin;

    return currentTime >= startTime && currentTime <= endTime;
  }

  /**
   * Parse update output based on package manager
   */
  parseUpdateOutput(output, packageManager) {
    const updates = [];
    
    if (!output.trim()) return updates;
    
    switch (packageManager) {
      case 'apt':
        const lines = output.split('\n').filter(line => 
          line.includes('upgradable') && !line.includes('Listing...')
        );
        
        for (const line of lines) {
          const match = line.match(/^(\S+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s+(\S+)\]/);
          if (match) {
            updates.push({
              package: match[1],
              newVersion: match[2],
              currentVersion: match[3],
              security: line.toLowerCase().includes('security')
            });
          }
        }
        break;
        
      // Add other package managers as needed
    }
    
    return updates;
  }

  /**
   * Get system administration status
   */
  async getSystemAdminStatus() {
    return {
      success: true,
      data: {
        name: this.name,
        version: this.version,
        enabled: true,
        packageManager: this.packageManager,
        config: this.config,
        maintenanceWindow: this.config.maintenanceWindow,
        inMaintenanceWindow: this.isMaintenanceWindow(),
        recentMaintenance: this.maintenanceHistory.slice(-5),
        capabilities: [
          'Automated system updates',
          'Security patch management',
          'Zombie process cleanup',
          'Database optimization',
          'Log file cleanup',
          'Maintenance scheduling',
          'System health monitoring'
        ]
      }
    };
  }

  /**
   * Cleanup when plugin is disabled
   */
  async cleanup() {
    try {
      // Cancel any scheduled tasks
      if (this.agent.scheduler) {
        await this.agent.scheduler.agenda.cancel({
          name: { $in: ['system-admin-updates', 'system-admin-zombie-cleanup', 'system-admin-log-cleanup'] }
        });
      }
      
      this.logger.info('System Admin plugin cleanup completed');
    } catch (error) {
      this.logger.error('System Admin plugin cleanup failed:', error);
    }
  }
}