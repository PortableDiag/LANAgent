import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

const execAsync = promisify(exec);

export class SystemExecutor {
  constructor(agent) {
    this.agent = agent;
    this.executionHistory = [];
    this.maxHistorySize = 100;
    this.commandWhitelist = this.initializeWhitelist();
    this.dangerousCommands = this.initializeDangerousCommands();
    this.executionTimeout = 30000; // 30 seconds default timeout
  }

  initializeWhitelist() {
    return {
      // System info commands (safe)
      info: [
        'uname', 'hostname', 'uptime', 'date', 'whoami', 'id',
        'df', 'du', 'free', 'top', 'htop', 'ps', 'lsof',
        'netstat', 'ss', 'ip', 'ifconfig', 'iwconfig'
      ],
      // File operations (limited)
      file: [
        'ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'find',
        'wc', 'sort', 'uniq', 'diff', 'file', 'which'
      ],
      // Network tools
      network: [
        'ping', 'traceroute', 'nslookup', 'dig', 'curl', 'wget',
        'nc', 'nmap', 'arp', 'route'
      ],
      // Package management (requires sudo)
      package: [
        'apt', 'apt-get', 'dpkg', 'snap', 'pip', 'pip3',
        'npm', 'yarn', 'gem', 'cargo'
      ],
      // Service management (requires sudo)
      service: [
        'systemctl', 'service', 'journalctl'
      ],
      // Development tools
      dev: [
        'git', 'gh', 'docker', 'docker-compose', 'node', 'python',
        'python3', 'gcc', 'make', 'cmake'
      ]
    };
  }

  initializeDangerousCommands() {
    return [
      'rm -rf /', 'rm -rf /*', 'dd if=/dev/zero',
      'mkfs', 'format', ':(){ :|:& };:', 
      'shutdown', 'reboot', 'halt', 'poweroff',
      'kill -9 -1', 'killall',
      'chmod -R 777 /', 'chown -R',
      'iptables -F', 'ufw disable'
    ];
  }

  async execute(command, options = {}) {
    try {
      // Validate command
      const validation = await this.validateCommand(command);
      if (!validation.safe) {
        throw new Error(`Command rejected: ${validation.reason}`);
      }

      // Log execution attempt
      logger.info(`Executing command: ${command}`);
      
      // Check if command requires approval
      if (validation.requiresApproval && !options.approved) {
        return {
          success: false,
          requiresApproval: true,
          command: command,
          reason: validation.approvalReason,
          message: 'This command requires approval before execution'
        };
      }

      // Execute command
      const result = await this.executeCommand(command, options);
      
      // Add to history
      this.addToHistory(command, result, options);
      
      return result;
    } catch (error) {
      // Only log as error if not a routine health check
      if (!options.suppressErrorLog) {
        logger.error('Command execution failed:', error);
      } else {
        logger.debug(`Command failed (routine check): ${command} - ${error.message}`);
      }
      
      const result = {
        success: false,
        command: command,
        error: error.message,
        timestamp: new Date()
      };
      this.addToHistory(command, result, options);
      return result;
    }
  }

  async validateCommand(command) {
    const validation = {
      safe: true,
      requiresApproval: false,
      reason: null,
      approvalReason: null
    };

    // Check for dangerous patterns
    for (const dangerous of this.dangerousCommands) {
      if (command.includes(dangerous)) {
        validation.safe = false;
        validation.reason = 'Command contains dangerous pattern';
        return validation;
      }
    }

    // Check for shell injection attempts
    const injectionPatterns = [
      /[;&|]/,  // Command chaining
      /\$\(/,   // Command substitution
      /`/,      // Backtick substitution
      />/,      // Redirection that might overwrite files
      /<</,     // Here documents
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(command) && !this.isSafeChaining(command)) {
        validation.requiresApproval = true;
        validation.approvalReason = 'Command contains shell operators';
      }
    }

    // Check if command needs sudo
    if (command.startsWith('sudo')) {
      validation.requiresApproval = true;
      validation.approvalReason = 'Command requires sudo privileges';
    }

    // Check if it's a whitelisted command
    const baseCommand = command.split(' ')[0].replace('sudo', '').trim();
    const isWhitelisted = Object.values(this.commandWhitelist)
      .flat()
      .includes(baseCommand);

    if (!isWhitelisted) {
      validation.requiresApproval = true;
      validation.approvalReason = 'Command is not in whitelist';
    }

    return validation;
  }

  isSafeChaining(command) {
    // Allow safe command chaining patterns
    const safePatterns = [
      /ls.*\|.*grep/,
      /ps.*\|.*grep/,
      /cat.*\|.*grep/,
      /find.*\|.*grep/,
      /docker.*\|.*grep/
    ];

    return safePatterns.some(pattern => pattern.test(command));
  }

  async executeCommand(command, options = {}) {
    const timeout = options.timeout || this.executionTimeout;
    const cwd = options.cwd || process.cwd();
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      const result = {
        command: command,
        stdout: '',
        stderr: '',
        exitCode: null,
        duration: null,
        timestamp: new Date(),
        success: false
      };

      // Use exec for simple commands, spawn for complex ones
      if (this.shouldUseSpawn(command)) {
        this.executeWithSpawn(command, cwd, timeout, result, startTime, resolve, options);
      } else {
        this.executeWithExec(command, cwd, timeout, result, startTime, resolve, options);
      }
    });
  }

  shouldUseSpawn(command) {
    // Use spawn for commands with pipes or complex shell features
    return command.includes('|') || command.includes('>') || command.includes('&');
  }

  async executeWithExec(command, cwd, timeout, result, startTime, resolve, options = {}) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      });

      result.stdout = stdout;
      result.stderr = stderr;
      result.exitCode = 0;
      result.success = true;
      result.duration = Date.now() - startTime;
      
      resolve(result);
    } catch (error) {
      result.stderr = error.stderr || error.message;
      result.stdout = error.stdout || '';
      result.exitCode = error.code || 1;
      result.success = false;
      result.duration = Date.now() - startTime;
      
      // Don't treat non-zero exit codes as failures for some commands
      if (error.code && !error.killed) {
        result.success = true;
      }
      
      resolve(result);
    }
  }

  executeWithSpawn(command, cwd, timeout, result, startTime, resolve, options = {}) {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    
    const proc = spawn(shell, shellArgs, {
      cwd,
      shell: false
    });

    let timeoutId;
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        result.stderr += '\nProcess killed due to timeout';
        result.timedOut = true;
      }, timeout);
    }

    proc.stdout.on('data', (data) => {
      result.stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      result.stderr += data.toString();
    });

    proc.on('error', (error) => {
      result.stderr += `\nProcess error: ${error.message}`;
      result.success = false;
    });

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      
      result.exitCode = code;
      result.duration = Date.now() - startTime;
      result.success = code === 0 && !result.timedOut;
      
      resolve(result);
    });
  }

  async executeScript(scriptPath, args = [], options = {}) {
    try {
      // Verify script exists
      await fs.access(scriptPath);
      
      // Make script executable if needed
      if (process.platform !== 'win32') {
        await execAsync(`chmod +x "${scriptPath}"`);
      }

      // Build command
      const command = `"${scriptPath}" ${args.map(arg => `"${arg}"`).join(' ')}`;
      
      return await this.execute(command, options);
    } catch (error) {
      return {
        success: false,
        error: `Script execution failed: ${error.message}`,
        scriptPath,
        args
      };
    }
  }

  async executeInBackground(command, options = {}) {
    const jobId = this.generateJobId();
    
    // Execute without waiting
    setImmediate(async () => {
      const result = await this.execute(command, options);
      
      // Store result for later retrieval
      await this.agent.memoryManager?.store({
        type: 'background_job',
        jobId,
        command,
        result,
        timestamp: new Date()
      });
      
      // Notify if callback provided
      if (options.onComplete) {
        options.onComplete(result);
      }
    });

    return {
      jobId,
      status: 'started',
      command,
      message: 'Command execution started in background'
    };
  }

  async getSystemInfo() {
    const info = {};

    try {
      // OS Info
      info.platform = os.platform();
      info.arch = os.arch();
      info.hostname = os.hostname();
      info.release = os.release();
      
      // Memory Info
      info.memory = {
        total: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100,
        free: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100,
        used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024 * 100) / 100
      };

      // CPU Info
      info.cpus = os.cpus().length;
      info.loadAverage = os.loadavg();

      // Uptime
      info.uptime = this.formatUptime(os.uptime());

      // Additional info via commands
      if (info.platform === 'linux') {
        try {
          // Use a special option to suppress error logging for routine health checks
          const diskSpace = await this.execute('df -h /', { suppressErrorLog: true });
          if (diskSpace.success && diskSpace.stdout) {
            info.diskSpace = this.parseDiskSpace(diskSpace.stdout);
          }
        } catch (error) {
          logger.debug('Failed to get disk space information:', error);
        }

        // Try to read temperature directly with file system
        try {
          const fs = await import('fs/promises');
          const tempData = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8').catch(() => null);
          if (tempData) {
            const tempValue = parseInt(tempData.trim());
            info.temperature = Math.round(tempValue / 1000);
            logger.debug(`Temperature reading: ${tempValue} raw, ${info.temperature}°C`);
          }
        } catch (err) {
          logger.debug('Direct temperature read failed, trying command approach');
        }
        
        // If direct read failed, try with command
        if (info.temperature === undefined) {
          try {
            const temperature = await this.execute('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null', { suppressErrorLog: true });
            if (temperature.success && temperature.stdout && temperature.stdout.trim()) {
              const tempValue = parseInt(temperature.stdout.trim());
              info.temperature = Math.round(tempValue / 1000);
              logger.debug(`Temperature reading via command: ${tempValue} raw, ${info.temperature}°C`);
            } else {
              // Try alternative methods if the standard path doesn't exist
              const alternatives = [
                'cat /sys/devices/virtual/thermal/thermal_zone0/temp 2>/dev/null',
                'cat /sys/devices/platform/coretemp.0/hwmon/hwmon*/temp1_input 2>/dev/null',
                'cat /sys/class/hwmon/hwmon*/temp1_input 2>/dev/null | head -1'
              ];
              
              for (const cmd of alternatives) {
                try {
                  const altTemp = await this.execute(cmd, { suppressErrorLog: true });
                  if (altTemp.success && altTemp.stdout && altTemp.stdout.trim()) {
                    const tempValue = parseInt(altTemp.stdout.trim());
                    if (!isNaN(tempValue)) {
                      info.temperature = Math.round(tempValue / 1000);
                      break;
                    }
                  }
                } catch (error) {
                  logger.debug(`Temperature alternative command failed: ${cmd}`, error);
                }
              }
            }
          } catch (error) {
            logger.debug('Failed to get temperature via commands:', error);
          }
          
          // If still no temperature, check if lm-sensors is available
          if (!info.temperature || info.temperature === 0) {
            try {
              const sensors = await this.execute('sensors -u 2>/dev/null | grep -E "temp[0-9]+_input:" | head -1', { suppressErrorLog: true });
              if (sensors.success && sensors.stdout) {
                const match = sensors.stdout.match(/:\s*(\d+\.\d+)/);
                if (match) {
                  info.temperature = Math.round(parseFloat(match[1]));
                }
              }
            } catch (error) {
              logger.debug('Failed to get temperature via sensors command:', error);
            }
          }
        }
      }

    } catch (error) {
      logger.error('Error getting system info:', error);
    }

    logger.debug('System info final temperature:', info.temperature);
    return info;
  }

  parseDiskSpace(dfOutput) {
    const lines = dfOutput.trim().split('\n');
    if (lines.length < 2) return null;

    const values = lines[1].split(/\s+/);
    return {
      total: values[1],
      used: values[2],
      available: values[3],
      usePercent: values[4]
    };
  }

  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    
    return parts.join(' ') || '0m';
  }

  generateJobId() {
    return `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  addToHistory(command, result, options = {}) {
    // Skip adding failed routine health checks to history
    if (options.suppressErrorLog && !result.success) {
      return;
    }
    
    const historyEntry = {
      command,
      result,
      timestamp: new Date()
    };
    
    this.executionHistory.push(historyEntry);

    // Keep history size limited
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory.shift();
    }

    // Also log to operation logger if available
    // Skip operation logging for routine health checks that fail
    if (this.agent && this.agent.operationLogger && 
        !(options.suppressErrorLog && !result.success)) {
      this.agent.operationLogger.logOperation({
        type: 'command',
        action: 'execute',
        plugin: 'system',
        params: { command },
        result: {
          success: result.success,
          stdout: result.stdout ? result.stdout.substring(0, 200) : '',
          stderr: result.stderr ? result.stderr.substring(0, 200) : '',
          exitCode: result.exitCode,
          duration: result.duration
        },
        status: result.success ? 'success' : 'error',
        userId: 'system',
        interface: 'system',
        duration: result.duration
      });
    }
  }

  getHistory(limit = 10) {
    return this.executionHistory.slice(-limit);
  }

  clearHistory() {
    this.executionHistory = [];
  }
}