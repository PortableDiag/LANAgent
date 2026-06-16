import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

/**
 * Process Management Service for LANAgent
 * Monitors and manages system processes, cleans up zombies,
 * and provides process health monitoring
 */
export class ProcessManager extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.config = {
      monitoringEnabled: true,
      zombieCheckInterval: 300000, // 5 minutes
      processHealthInterval: 600000, // 10 minutes
      alertThresholds: {
        cpuPercent: 80,
        memoryPercent: 80,
        zombieCount: 5
      },
      criticalProcesses: [
        'lan-agent',
        'mongod',
        'sshd',
        'systemd'
      ]
    };

    this.processCache = new Map();
    this.zombieHistory = [];
    this.alerts = new Map();
    this.monitoringIntervals = new Map();
  }

  async initialize() {
    try {
      if (this.config.monitoringEnabled) {
        await this.startProcessMonitoring();
      }
      
      logger.info('Process Manager initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Process Manager:', error);
      return false;
    }
  }

  /**
   * Start process monitoring
   */
  async startProcessMonitoring() {
    try {
      // Start zombie process monitoring
      const zombieInterval = setInterval(async () => {
        await this.checkZombieProcesses();
      }, this.config.zombieCheckInterval);
      
      this.monitoringIntervals.set('zombies', zombieInterval);

      // Start general process health monitoring
      const healthInterval = setInterval(async () => {
        await this.checkProcessHealth();
      }, this.config.processHealthInterval);
      
      this.monitoringIntervals.set('health', healthInterval);

      // Start critical process monitoring
      const criticalInterval = setInterval(async () => {
        await this.checkCriticalProcesses();
      }, 60000); // Check every minute
      
      this.monitoringIntervals.set('critical', criticalInterval);

      logger.info('Process monitoring started');
    } catch (error) {
      logger.error('Failed to start process monitoring:', error);
      throw error;
    }
  }

  /**
   * Check for zombie processes
   */
  async checkZombieProcesses() {
    try {
      const { stdout } = await execAsync('ps aux | awk \'$8 ~ /^Z/ { print $2, $11, $3, $4 }\'');
      const zombieLines = stdout.trim().split('\n').filter(line => line.trim());

      if (zombieLines.length === 0) {
        return { zombieCount: 0, zombies: [] };
      }

      const zombies = zombieLines.map(line => {
        const [pid, command, cpu, memory] = line.split(/\s+/);
        return {
          pid: parseInt(pid),
          command: command || 'unknown',
          cpu: parseFloat(cpu) || 0,
          memory: parseFloat(memory) || 0,
          detected: new Date().toISOString()
        };
      });

      // Update zombie history
      this.zombieHistory.push({
        timestamp: new Date().toISOString(),
        count: zombies.length,
        zombies
      });

      // Keep only last 100 zombie checks
      if (this.zombieHistory.length > 100) {
        this.zombieHistory = this.zombieHistory.slice(-100);
      }

      // Alert if zombie count exceeds threshold
      if (zombies.length >= this.config.alertThresholds.zombieCount) {
        await this.sendZombieAlert(zombies);
      }

      this.emit('zombiesDetected', { count: zombies.length, zombies });

      return { zombieCount: zombies.length, zombies };
    } catch (error) {
      logger.error('Failed to check zombie processes:', error);
      return { zombieCount: 0, zombies: [], error: error.message };
    }
  }

  /**
   * Check overall process health
   */
  async checkProcessHealth() {
    try {
      // Get process information with CPU and memory usage
      const { stdout } = await execAsync('ps aux --sort=-%cpu | head -20');
      const processLines = stdout.trim().split('\n').slice(1); // Skip header

      const processes = processLines.map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 11) {
          return {
            user: parts[0],
            pid: parseInt(parts[1]),
            cpu: parseFloat(parts[2]),
            memory: parseFloat(parts[3]),
            vsz: parseInt(parts[4]),
            rss: parseInt(parts[5]),
            tty: parts[6],
            stat: parts[7],
            start: parts[8],
            time: parts[9],
            command: parts.slice(10).join(' ')
          };
        }
        return null;
      }).filter(p => p !== null);

      // Find high resource usage processes
      // Filter out the ps command itself and other short-lived monitoring commands
      const highCpuProcesses = processes.filter(p => 
        p.cpu >= this.config.alertThresholds.cpuPercent &&
        !p.command.includes('ps aux') &&
        !p.command.includes('ps -') &&
        !p.command.includes('top -') &&
        !p.command.includes('htop')
      );
      
      const highMemoryProcesses = processes.filter(p => 
        p.memory >= this.config.alertThresholds.memoryPercent &&
        !p.command.includes('ps aux') &&
        !p.command.includes('ps -')
      );

      // Alert for high resource usage
      if (highCpuProcesses.length > 0 || highMemoryProcesses.length > 0) {
        await this.sendResourceAlert(highCpuProcesses, highMemoryProcesses);
      }

      this.emit('processHealth', { processes, highCpuProcesses, highMemoryProcesses });

      return {
        totalProcesses: processes.length,
        highCpuProcesses,
        highMemoryProcesses,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to check process health:', error);
      return { error: error.message };
    }
  }

  /**
   * Check critical processes are running
   */
  async checkCriticalProcesses() {
    try {
      const missingProcesses = [];
      
      for (const processName of this.config.criticalProcesses) {
        try {
          const { stdout } = await execAsync(`pgrep -f "${processName}"`);
          if (!stdout.trim()) {
            missingProcesses.push(processName);
          }
        } catch (error) {
          // pgrep returns non-zero when no processes found
          missingProcesses.push(processName);
        }
      }

      if (missingProcesses.length > 0) {
        await this.sendCriticalProcessAlert(missingProcesses);
      }

      this.emit('criticalProcessCheck', { 
        checked: this.config.criticalProcesses,
        missing: missingProcesses 
      });

      return {
        criticalProcesses: this.config.criticalProcesses,
        missingProcesses,
        allRunning: missingProcesses.length === 0
      };
    } catch (error) {
      logger.error('Failed to check critical processes:', error);
      return { error: error.message };
    }
  }

  /**
   * Clean up zombie processes
   */
  async cleanupZombies(options = {}) {
    try {
      const { force = false, dryRun = false } = options;
      
      const zombieCheck = await this.checkZombieProcesses();
      if (zombieCheck.zombieCount === 0) {
        return {
          success: true,
          message: 'No zombie processes found',
          cleaned: 0
        };
      }

      let cleaned = 0;
      const cleanupResults = [];

      for (const zombie of zombieCheck.zombies) {
        try {
          if (dryRun) {
            cleanupResults.push({
              pid: zombie.pid,
              command: zombie.command,
              action: 'would_cleanup',
              success: true
            });
            cleaned++;
            continue;
          }

          // Try to get parent PID
          const { stdout: ppidStr } = await execAsync(`ps -o ppid= -p ${zombie.pid} 2>/dev/null || echo ""`);
          const ppid = parseInt(ppidStr.trim());
          
          if (ppid > 1) { // Don't kill init process
            // Kill parent to clean up zombie
            await execAsync(`kill ${ppid}`);
            cleanupResults.push({
              pid: zombie.pid,
              ppid,
              command: zombie.command,
              action: 'parent_killed',
              success: true
            });
            cleaned++;
          } else if (force) {
            // Try direct kill if force is enabled
            await execAsync(`kill -9 ${zombie.pid}`);
            cleanupResults.push({
              pid: zombie.pid,
              command: zombie.command,
              action: 'force_killed',
              success: true
            });
            cleaned++;
          } else {
            cleanupResults.push({
              pid: zombie.pid,
              command: zombie.command,
              action: 'skipped_no_parent',
              success: false,
              reason: 'No valid parent PID found and force not enabled'
            });
          }
        } catch (error) {
          cleanupResults.push({
            pid: zombie.pid,
            command: zombie.command,
            action: 'failed',
            success: false,
            error: error.message
          });
          logger.warn(`Failed to cleanup zombie process ${zombie.pid}:`, error.message);
        }
      }

      return {
        success: true,
        message: `${dryRun ? 'Would clean' : 'Cleaned'} ${cleaned} out of ${zombieCheck.zombieCount} zombie processes`,
        totalZombies: zombieCheck.zombieCount,
        cleaned,
        dryRun,
        results: cleanupResults
      };
    } catch (error) {
      logger.error('Failed to cleanup zombie processes:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Kill a specific process
   */
  async killProcess(pid, options = {}) {
    try {
      const { signal = 'TERM', force = false } = options;
      
      // Verify process exists and get info
      const { stdout } = await execAsync(`ps -p ${pid} -o pid,ppid,user,command --no-headers`);
      if (!stdout.trim()) {
        throw new Error(`Process ${pid} not found`);
      }

      const processInfo = stdout.trim();
      const [, , user, ...commandParts] = processInfo.split(/\s+/);
      const command = commandParts.join(' ');

      // Kill the process
      const killSignal = force ? '9' : signal;
      await execAsync(`kill -${killSignal} ${pid}`);

      logger.info(`Killed process ${pid} (${command}) with signal ${killSignal}`);

      return {
        success: true,
        pid,
        signal: killSignal,
        command,
        user,
        message: `Process ${pid} killed successfully`
      };
    } catch (error) {
      logger.error(`Failed to kill process ${pid}:`, error);
      return {
        success: false,
        error: error.message,
        pid
      };
    }
  }

  /**
   * Get process information
   */
  async getProcessInfo(pid) {
    try {
      const { stdout } = await execAsync(`ps -p ${pid} -o pid,ppid,user,pcpu,pmem,vsz,rss,tty,stat,start,time,command`);
      const lines = stdout.trim().split('\n');
      
      if (lines.length < 2) {
        throw new Error(`Process ${pid} not found`);
      }

      const processLine = lines[1].trim();
      const parts = processLine.split(/\s+/);
      
      return {
        success: true,
        process: {
          pid: parseInt(parts[0]),
          ppid: parseInt(parts[1]),
          user: parts[2],
          cpu: parseFloat(parts[3]),
          memory: parseFloat(parts[4]),
          vsz: parseInt(parts[5]),
          rss: parseInt(parts[6]),
          tty: parts[7],
          stat: parts[8],
          start: parts[9],
          time: parts[10],
          command: parts.slice(11).join(' ')
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        pid
      };
    }
  }

  /**
   * Send zombie process alert
   */
  async sendZombieAlert(zombies) {
    const alertKey = 'zombie_processes';
    const lastAlert = this.alerts.get(alertKey);
    const now = Date.now();

    // Throttle alerts to once per hour
    if (lastAlert && (now - lastAlert) < 3600000) {
      return;
    }

    this.alerts.set(alertKey, now);

    try {
      const message = `⚠️ **Zombie Process Alert**\n\n` +
        `Found ${zombies.length} zombie processes:\n` +
        zombies.map(z => `• PID ${z.pid}: ${z.command}`).join('\n') + '\n\n' +
        `Consider running system cleanup to remove zombie processes.`;

      await this.agent.notify(message);
      logger.warn(`Zombie process alert sent: ${zombies.length} zombies detected`);
    } catch (error) {
      logger.error('Failed to send zombie alert:', error);
    }
  }

  /**
   * Send resource usage alert
   */
  async sendResourceAlert(highCpuProcesses, highMemoryProcesses) {
    const alertKey = 'resource_usage';
    const lastAlert = this.alerts.get(alertKey);
    const now = Date.now();

    // Throttle alerts to once per 30 minutes
    if (lastAlert && (now - lastAlert) < 1800000) {
      return;
    }

    this.alerts.set(alertKey, now);

    try {
      let message = `📊 **High Resource Usage Alert**\n\n`;

      if (highCpuProcesses.length > 0) {
        message += `**High CPU Usage (>${this.config.alertThresholds.cpuPercent}%):**\n`;
        message += highCpuProcesses.map(p => 
          `• PID ${p.pid}: ${p.command.substring(0, 40)} (${p.cpu}%)`
        ).join('\n') + '\n\n';
      }

      if (highMemoryProcesses.length > 0) {
        message += `**High Memory Usage (>${this.config.alertThresholds.memoryPercent}%):**\n`;
        message += highMemoryProcesses.map(p => 
          `• PID ${p.pid}: ${p.command.substring(0, 40)} (${p.memory}%)`
        ).join('\n') + '\n\n';
      }

      // Add context about recent operations if scheduler is available
      if (this.agent.scheduler && this.agent.scheduler.analyzeRecentOperations) {
        try {
          const operations = await this.agent.scheduler.analyzeRecentOperations();
          message += '\n' + operations.summary;
        } catch (error) {
          logger.warn('Failed to get operation context:', error);
        }
      } else {
        message += `Monitor system resources and consider process management if needed.`;
      }

      await this.agent.notify(message);
      logger.warn(`Resource usage alert sent: ${highCpuProcesses.length} high CPU, ${highMemoryProcesses.length} high memory`);
    } catch (error) {
      logger.error('Failed to send resource alert:', error);
    }
  }

  /**
   * Send critical process alert
   */
  async sendCriticalProcessAlert(missingProcesses) {
    const alertKey = 'critical_processes';
    const lastAlert = this.alerts.get(alertKey);
    const now = Date.now();

    // Throttle alerts to once per 15 minutes
    if (lastAlert && (now - lastAlert) < 900000) {
      return;
    }

    this.alerts.set(alertKey, now);

    try {
      const message = `🚨 **Critical Process Alert**\n\n` +
        `The following critical processes are not running:\n` +
        missingProcesses.map(p => `• ${p}`).join('\n') + '\n\n' +
        `System stability may be affected. Check service status immediately.`;

      await this.agent.notify(message);
      logger.error(`Critical process alert sent: ${missingProcesses.join(', ')} not running`);
    } catch (error) {
      logger.error('Failed to send critical process alert:', error);
    }
  }

  /**
   * Get process manager status
   */
  getStatus() {
    return {
      enabled: this.config.monitoringEnabled,
      config: this.config,
      activeIntervals: Array.from(this.monitoringIntervals.keys()),
      recentZombieChecks: this.zombieHistory.slice(-10),
      alertsThrottled: Object.fromEntries(this.alerts),
      capabilities: [
        'Zombie process detection and cleanup',
        'High resource usage monitoring',
        'Critical process monitoring',
        'Automated alerts and notifications',
        'Process information retrieval',
        'Process termination management'
      ]
    };
  }

  /**
   * Stop process monitoring
   */
  stopMonitoring() {
    for (const [name, interval] of this.monitoringIntervals) {
      clearInterval(interval);
      logger.info(`Stopped ${name} monitoring interval`);
    }
    this.monitoringIntervals.clear();
  }

  /**
   * Cleanup when service is stopped
   */
  async cleanup() {
    try {
      this.stopMonitoring();
      this.removeAllListeners();
      logger.info('Process Manager cleanup completed');
    } catch (error) {
      logger.error('Process Manager cleanup failed:', error);
    }
  }
}

export default ProcessManager;