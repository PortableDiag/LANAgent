import { BasePlugin } from '../core/basePlugin.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export default class SystemPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'system';
    this.version = '1.0.0';
    this.description = 'System management and deployment operations';
    this.commands = [
      {
        command: 'restart',
        description: 'Restart the agent process',
        usage: 'restart [delay]',
        masterOnly: true
      },
      {
        command: 'redeploy',
        description: 'Pull latest changes from git and restart',
        usage: 'redeploy',
        masterOnly: true
      },
      {
        command: 'update',
        description: 'Update dependencies and restart',
        usage: 'update',
        masterOnly: true
      },
      {
        command: 'status',
        description: 'Get detailed system status',
        usage: 'status'
      },
      {
        command: 'info',
        description: 'Get system information (disk, cpu, memory, etc)',
        usage: 'info [type]'
      },
      {
        command: 'run',
        description: 'Run a system command',
        usage: 'run [command]'
      },
      {
        command: 'remind',
        description: 'Set a reminder',
        usage: 'remind [message] in [minutes]'
      }
    ];
    
    this.masterUserId = process.env.TELEGRAM_USER_ID;
    this.deployPath = process.cwd();
  }

  async execute(params) {
    // Validate base parameters
    this.validateParams(params, {
      action: { 
        required: true, 
        type: 'string', 
        enum: ['restart', 'redeploy', 'update', 'status', 'info', 'run', 'remind']
      }
    });
    
    // Sanitize parameters
    params = this.sanitizeParams(params);
    
    const { action, delay, userId } = params;
    
    // Check master-only commands
    const masterOnlyActions = ['restart', 'redeploy', 'update'];
    if (masterOnlyActions.includes(action) && userId !== this.masterUserId) {
      return {
        success: false,
        error: 'This command is restricted to the master user only.'
      };
    }
    
    try {
      switch(action) {
        case 'restart':
          return await this.restartAgent(delay);
          
        case 'redeploy':
          // Check if this is a manual deployment (from web UI or user command)
          const isManual = params.manual !== false; // Default to manual
          return await this.redeployFromGit(isManual);
          
        case 'update':
          return await this.updateAndRestart();
          
        case 'status':
          return await this.getSystemStatus();
          
        case 'info':
          return await this.getSystemInfo(params);
          
        case 'run':
          return await this.runCommand(params);
          
        case 'remind':
          return await this.setReminder(params);
          
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: restart, redeploy, update, status, info, run, or remind' 
          };
      }
    } catch (error) {
      logger.error('System plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async restartAgent(delay = 5) {
    logger.info(`Restart requested, will restart in ${delay} seconds`);
    
    // Notify before restart
    await this.notify(`🔄 Restarting agent in ${delay} seconds...`);
    
    // Schedule restart
    setTimeout(async () => {
      try {
        // Check if running under PM2
        const pm2Check = await execAsync('pm2 list').catch(() => null);
        
        if (pm2Check && pm2Check.stdout.includes('lanagent')) {
          logger.info('Restarting via PM2...');
          await execAsync('pm2 restart lanagent');
        } else {
          // Fallback to process exit (systemd or other process manager will restart)
          logger.info('Exiting process for external restart...');
          process.exit(0);
        }
      } catch (error) {
        logger.error('Restart error:', error);
        // Force exit as fallback
        process.exit(1);
      }
    }, delay * 1000);
    
    return {
      success: true,
      result: `Agent will restart in ${delay} seconds. I'll be back online shortly!`
    };
  }

  async redeployFromGit(isManual = true) {
    logger.info(`Starting ${isManual ? 'manual' : 'automatic'} redeployment from git...`);
    
    let lockAcquired = false;
    let deploymentTimeout = null;
    
    try {
      // Check locks for both manual and automatic deployments
      const lockCheck = await this.checkDeploymentLocks();
      if (!lockCheck.safe) {
        const message = `⚠️ Deployment blocked: ${lockCheck.reason}`;
        logger.warn(message);
        await this.notify(message);
        return {
          success: false,
          error: lockCheck.reason,
          blocked: true,
          lockInfo: lockCheck.lockInfo
        };
      }
      
      // Try to acquire the lock for deployment
      const { selfModLock } = await import('../../services/selfModLock.js');
      lockAcquired = await selfModLock.acquire('deployment');
      
      if (!lockAcquired) {
        const lockInfo = selfModLock.getLockInfo();
        const message = `Cannot start deployment: Another process (${lockInfo?.service}) is using git`;
        logger.warn(message);
        await this.notify(`⚠️ ${message}`);
        return {
          success: false,
          error: message,
          blocked: true,
          lockInfo
        };
      }
      
      try {
        // Set a safety timeout for the entire deployment process
        deploymentTimeout = setTimeout(async () => {
          logger.error('Deployment timeout reached (15 minutes), releasing lock');
          await selfModLock.release('deployment');
        }, 15 * 60 * 1000); // 15 minutes timeout
        
        // Notify start
        await this.notify('🚀 Starting redeployment from git...');
      
      // Determine git repository path
      const gitRepoPath = await this.findGitRepository();
      
      if (!gitRepoPath) {
        throw new Error('Git repository not found. Unable to perform self-deployment.');
      }
      
      logger.info(`Using git repository at: ${gitRepoPath}`);
      
      // Save current version for rollback
      const currentVersion = await this.getCurrentVersion();
      const currentCommit = await execAsync('git rev-parse HEAD', { cwd: gitRepoPath });
      const backupInfo = {
        version: currentVersion,
        commit: currentCommit.stdout.trim(),
        timestamp: new Date()
      };
      
      // Store current branch and ensure we're on main
      const currentBranch = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: gitRepoPath });
      const wasOnDifferentBranch = currentBranch.stdout.trim() !== 'main';
      
      if (wasOnDifferentBranch) {
        logger.info(`Switching from branch '${currentBranch.stdout.trim()}' to 'main' for deployment`);
        await execAsync('git stash', { cwd: gitRepoPath });
        await execAsync('git checkout main', { cwd: gitRepoPath });
      }
      
      // For automatic deployments, analyze changes to determine if deployment is needed
      if (!isManual) {
        // Fetch latest changes without merging yet
        await execAsync('git fetch origin main', { cwd: gitRepoPath });
        
        // Check what would change
        const diffResult = await execAsync('git diff HEAD origin/main --name-only', { cwd: gitRepoPath });
        const changedFiles = diffResult.stdout.trim().split('\n').filter(f => f);
        
        logger.info(`Changed files: ${changedFiles.length}`);
        
        // Analyze changes
        const deploymentNeeded = await this.analyzeChangesForDeployment(gitRepoPath, changedFiles);
        
        if (!deploymentNeeded.needed) {
          logger.info(`Deployment not needed: ${deploymentNeeded.reason}`);
          
          // Restore original branch if needed
          if (wasOnDifferentBranch) {
            await execAsync(`git checkout ${currentBranch.stdout.trim()}`, { cwd: gitRepoPath });
            await execAsync('git stash pop', { cwd: gitRepoPath }).catch(() => {});
          }
          
          return {
            success: true,
            result: `No deployment needed: ${deploymentNeeded.reason}`,
            changes: deploymentNeeded.summary
          };
        }
      }
      
      // For manual deployments, we still fetch to see what will change (for logging)
      let changedFiles = [];
      let deploymentNeeded = { summary: 'Manual deployment requested', newVersion: null };
      
      if (isManual) {
        try {
          await execAsync('git fetch origin main', { cwd: gitRepoPath });
          const diffResult = await execAsync('git diff HEAD origin/main --name-only', { cwd: gitRepoPath });
          changedFiles = diffResult.stdout.trim().split('\n').filter(f => f);
          
          // Get version info for manual deployments too (just for the summary)
          const versionInfo = await this.getVersionComparison(gitRepoPath);
          if (versionInfo.changed) {
            deploymentNeeded.summary = `Manual deployment: v${versionInfo.current} → v${versionInfo.new}`;
            deploymentNeeded.newVersion = versionInfo.new;
          }
        } catch (e) {
          logger.warn('Could not analyze changes for manual deployment:', e);
        }
      }
      
      // Pull latest changes
      const pullResult = await execAsync('git pull origin main', { cwd: gitRepoPath });
      logger.info('Git pull result:', pullResult.stdout);
      
      // Check if actually up to date (for manual deployments)
      if (isManual && pullResult.stdout.includes('Already up to date')) {
        logger.info('Already up to date, but proceeding with manual deployment as requested');
      }
      
      // Create deployment backup before syncing
      await this.createDeploymentBackup(backupInfo);
      
      try {
        // Now we need to sync the updated code from git repo to deployment directory
        await this.notify('📂 Syncing code to deployment directory...');
        await this.syncGitToDeployment(gitRepoPath);
        
        // Check if dependencies changed
        const depsChanged = changedFiles.some(f => 
          f === 'package.json' || f === 'package-lock.json'
        );
        
        if (depsChanged) {
          // Install/update dependencies in deployment directory
          await this.notify('📦 Installing dependencies...');
          const npmResult = await execAsync('npm install --no-bin-links --legacy-peer-deps', { 
            cwd: this.deployPath 
          });
        } else {
          logger.info('No dependency changes, skipping npm install');
        }
        
        // Restart the agent
        await this.notify(`✅ Deployment complete! Restarting... (${deploymentNeeded.summary})`);
        await this.restartAgent(3);
        
        // Restore original branch if needed
        if (wasOnDifferentBranch) {
          // Do this after restart is initiated
          setTimeout(async () => {
            await execAsync(`git checkout ${currentBranch.stdout.trim()}`, { cwd: gitRepoPath });
            await execAsync('git stash pop', { cwd: gitRepoPath }).catch(() => {});
          }, 5000);
        }
        
        // Clear the timeout and release the lock before returning
        clearTimeout(deploymentTimeout);
        await selfModLock.release('deployment');
        
        return {
          success: true,
          result: `Successfully deployed: ${deploymentNeeded.summary}`,
          version: deploymentNeeded.newVersion,
          changes: changedFiles.length
        };
        
      } catch (deployError) {
        logger.error('Deployment failed, attempting rollback:', deployError);
        
        // Attempt rollback
        const rollbackResult = await this.rollbackDeployment(backupInfo, gitRepoPath);
        
        // Clear the timeout and release the lock before throwing
        clearTimeout(deploymentTimeout);
        await selfModLock.release('deployment');
        
        throw new Error(`Deployment failed and ${rollbackResult.success ? 'was rolled back' : 'rollback also failed'}: ${deployError.message}`);
      }
      
      } finally {
        // Always release the lock if we acquired it
        if (lockAcquired) {
          if (deploymentTimeout) {
            clearTimeout(deploymentTimeout);
          }
          const { selfModLock } = await import('../../services/selfModLock.js');
          await selfModLock.release('deployment');
        }
      }
    } catch (error) {
      logger.error('Redeploy error:', error);
      
      // Try to restore stashed changes
      await execAsync('git stash pop').catch(() => {});
      
      return {
        success: false,
        error: `Redeployment failed: ${error.message}`
      };
    }
  }

  async updateAndRestart() {
    logger.info('Updating dependencies and restarting...');
    
    try {
      await this.notify('📦 Updating dependencies...');
      
      // Update npm packages
      const updateResult = await execAsync('npm update', { cwd: this.deployPath });
      logger.info('NPM update result:', updateResult.stdout);
      
      // Run install to ensure everything is properly linked
      await execAsync('npm install --no-bin-links --legacy-peer-deps', { 
        cwd: this.deployPath 
      });
      
      // Restart
      await this.notify('✅ Dependencies updated! Restarting...');
      await this.restartAgent(3);
      
      return {
        success: true,
        result: 'Dependencies updated successfully! Will restart in 3 seconds.'
      };
      
    } catch (error) {
      logger.error('Update error:', error);
      return {
        success: false,
        error: `Update failed: ${error.message}`
      };
    }
  }

  async getSystemStatus() {
    try {
      const status = {
        agent: {
          name: this.agent.config.name,
          version: this.agent.config.version,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          pid: process.pid
        },
        git: {},
        pm2: null
      };
      
      // Get git status
      try {
        const branch = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: this.deployPath });
        const commit = await execAsync('git rev-parse --short HEAD', { cwd: this.deployPath });
        const behind = await execAsync('git rev-list --count HEAD..origin/main', { cwd: this.deployPath });
        
        status.git = {
          branch: branch.stdout.trim(),
          commit: commit.stdout.trim(),
          behindOrigin: parseInt(behind.stdout.trim()) || 0
        };
      } catch (error) {
        status.git.error = 'Unable to get git status';
      }
      
      // Check PM2 status
      try {
        const pm2Result = await execAsync('pm2 show lanagent --json');
        const pm2Data = JSON.parse(pm2Result.stdout);
        if (pm2Data && pm2Data.length > 0) {
          status.pm2 = {
            status: pm2Data[0].pm2_env.status,
            restarts: pm2Data[0].pm2_env.restart_time,
            cpu: pm2Data[0].monit.cpu,
            memory: Math.round(pm2Data[0].monit.memory / 1024 / 1024) + ' MB'
          };
        }
      } catch (error) {
        // PM2 not available or not managing this process
        status.pm2 = null;
      }
      
      return {
        success: true,
        result: status
      };
      
    } catch (error) {
      logger.error('System status error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getSystemInfo(params) {
    const { type } = params;
    
    try {
      let info = {};
      
      // Get specific info type or all if not specified
      if (!type || type === 'all' || type === 'disk') {
        // Disk usage
        const dfResult = await execAsync('df -h /');
        const dfLines = dfResult.stdout.trim().split('\n');
        const dfData = dfLines[1].split(/\s+/);
        info.disk = {
          total: dfData[1],
          used: dfData[2],
          available: dfData[3],
          usePercent: dfData[4],
          mountPoint: dfData[5]
        };
        
        // Get all disk partitions
        const dfAllResult = await execAsync('df -h -t ext4 -t xfs -t ntfs -t vfat');
        info.allDisks = dfAllResult.stdout;
      }
      
      if (!type || type === 'all' || type === 'memory' || type === 'ram') {
        // Memory usage
        const memResult = await execAsync('free -h');
        const memLines = memResult.stdout.trim().split('\n');
        const memData = memLines[1].split(/\s+/);
        info.memory = {
          total: memData[1],
          used: memData[2],
          free: memData[3],
          available: memData[6] || memData[3]
        };
      }
      
      if (!type || type === 'all' || type === 'cpu') {
        // CPU info
        const cpuInfoResult = await execAsync('lscpu | grep -E "^Model name:|^CPU\\(s\\):|^CPU MHz:"');
        const loadResult = await execAsync('uptime');
        const loadMatch = loadResult.stdout.match(/load average: ([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
        
        info.cpu = {
          info: cpuInfoResult.stdout.trim(),
          loadAverage: {
            '1min': loadMatch ? loadMatch[1] : 'N/A',
            '5min': loadMatch ? loadMatch[2] : 'N/A',
            '15min': loadMatch ? loadMatch[3] : 'N/A'
          }
        };
        
        // Get CPU usage percentage
        try {
          const topResult = await execAsync('top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk \'{print 100 - $1}\'');
          info.cpu.usage = parseFloat(topResult.stdout.trim()).toFixed(1) + '%';
        } catch (e) {
          info.cpu.usage = 'N/A';
        }
      }
      
      if (!type || type === 'all' || type === 'network') {
        // Network info
        const netResult = await execAsync('ip -4 addr show | grep -E "inet " | grep -v 127.0.0.1');
        info.network = {
          interfaces: netResult.stdout.trim()
        };
        
        // Get network usage if vnstat is available
        try {
          const vnstatResult = await execAsync('vnstat --oneline');
          info.network.bandwidth = vnstatResult.stdout.trim();
        } catch (e) {
          // vnstat not available
        }
      }
      
      if (!type || type === 'all' || type === 'uptime') {
        // System uptime
        const uptimeResult = await execAsync('uptime -p');
        info.uptime = uptimeResult.stdout.trim();
      }
      
      if (!type || type === 'all' || type === 'os') {
        // OS info
        const osResult = await execAsync('cat /etc/os-release | grep -E "^NAME=|^VERSION=" | sed \'s/[^=]*=//;s/"//g\'');
        const kernelResult = await execAsync('uname -r');
        info.os = {
          distribution: osResult.stdout.trim().replace('\n', ' '),
          kernel: kernelResult.stdout.trim()
        };
      }
      
      // Format the response
      let result = '';
      if (info.disk) {
        result += `💾 **Disk Usage:**\n`;
        result += `Total: ${info.disk.total} | Used: ${info.disk.used} (${info.disk.usePercent}) | Free: ${info.disk.available}\n\n`;
      }
      
      if (info.memory) {
        result += `🧠 **Memory:**\n`;
        result += `Total: ${info.memory.total} | Used: ${info.memory.used} | Free: ${info.memory.free} | Available: ${info.memory.available}\n\n`;
      }
      
      if (info.cpu) {
        result += `💻 **CPU:**\n`;
        result += `${info.cpu.info}\n`;
        result += `Usage: ${info.cpu.usage} | Load: ${info.cpu.loadAverage['1min']} / ${info.cpu.loadAverage['5min']} / ${info.cpu.loadAverage['15min']}\n\n`;
      }
      
      if (info.network) {
        result += `🌐 **Network:**\n${info.network.interfaces}\n`;
        if (info.network.bandwidth) {
          result += `Bandwidth: ${info.network.bandwidth}\n`;
        }
        result += '\n';
      }
      
      if (info.uptime) {
        result += `⏱️ **Uptime:** ${info.uptime}\n\n`;
      }
      
      if (info.os) {
        result += `🐧 **OS:** ${info.os.distribution} (Kernel ${info.os.kernel})\n`;
      }
      
      return {
        success: true,
        result: result.trim(),
        data: info
      };
      
    } catch (error) {
      logger.error('System info error:', error);
      return {
        success: false,
        error: `Failed to get system info: ${error.message}`
      };
    }
  }

  async runCommand(params) {
    // Validate command parameter
    this.validateParams(params, {
      command: { 
        required: true, 
        type: 'string',
        maxLength: 1000
      }
    });
    
    const { command } = params;
    
    // Additional validation using common schema
    const schemas = this.getCommonSchemas();
    const commandValidation = schemas.command.validate(command);
    if (commandValidation) {
      return {
        success: false,
        error: commandValidation
      };
    }
    
    // Safety checks - allow only safe read commands
    const safeCommands = [
      'ls', 'pwd', 'date', 'whoami', 'hostname', 'uname',
      'df', 'free', 'uptime', 'ps', 'top', 'htop',
      'netstat', 'ss', 'ip', 'ifconfig', 'route',
      'cat /proc/cpuinfo', 'cat /proc/meminfo',
      'lsblk', 'lscpu', 'lsmem', 'lspci', 'lsusb',
      'systemctl status', 'journalctl', 'dmesg',
      'sensors', 'nvidia-smi', 'vnstat', 'iftop',
      'du', 'ncdu', 'iostat', 'vmstat', 'mpstat',
      'w', 'who', 'last', 'lastlog'
    ];
    
    // Check if command starts with any safe command
    const isSafe = safeCommands.some(safe => 
      command.toLowerCase().startsWith(safe.toLowerCase())
    );
    
    // Also allow piped commands if the base is safe
    const baseCmdMatch = command.match(/^(\S+)/);
    const baseCmd = baseCmdMatch ? baseCmdMatch[1].toLowerCase() : '';
    const isBaseSafe = safeCommands.some(safe => 
      safe.toLowerCase().startsWith(baseCmd)
    );
    
    if (!isSafe && !isBaseSafe) {
      return {
        success: false,
        error: 'Command not allowed. Only safe read-only system information commands are permitted.'
      };
    }
    
    try {
      logger.info(`Running system command: ${command}`);
      const result = await execAsync(command, {
        timeout: 30000, // 30 second timeout
        maxBuffer: 5 * 1024 * 1024 // 5MB buffer
      });
      
      return {
        success: true,
        result: result.stdout || 'Command executed successfully with no output',
        stderr: result.stderr
      };
      
    } catch (error) {
      logger.error('Command execution error:', error);
      return {
        success: false,
        error: `Command failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async setReminder(params) {
    const { message, minutes, notificationMethod = 'telegram' } = params;
    
    if (!message) {
      return {
        success: false,
        error: 'Reminder message is required'
      };
    }
    
    if (!minutes || minutes <= 0) {
      return {
        success: false,
        error: 'Valid time duration is required'
      };
    }
    
    // Validate notification method
    const validMethods = ['telegram', 'email', 'both'];
    if (!validMethods.includes(notificationMethod)) {
      return {
        success: false,
        error: 'Notification method must be: telegram, email, or both'
      };
    }
    
    try {
      // Use Agenda scheduler if available
      if (this.agent.scheduler) {
        const result = await this.agent.scheduler.scheduleReminder(
          message, 
          minutes, 
          params.userId, 
          { notificationMethod }
        );
        return {
          success: true,
          result: `✅ Reminder set! I'll remind you "${message}" in ${minutes} minutes via ${notificationMethod} (at ${result.scheduledFor.toLocaleString()})`
        };
      } else {
        // Fallback to simple setTimeout with multi-channel notification
        const remindAt = new Date();
        remindAt.setMinutes(remindAt.getMinutes() + minutes);
        
        setTimeout(async () => {
          await this.sendMultiChannelNotification(`🔔 Reminder: ${message}`, notificationMethod);
        }, minutes * 60 * 1000);
        
        return {
          success: true,
          result: `✅ Reminder set! I'll remind you "${message}" in ${minutes} minutes via ${notificationMethod} (at ${remindAt.toLocaleString()})`
        };
      }
    } catch (error) {
      logger.error('Set reminder error:', error);
      return {
        success: false,
        error: `Failed to set reminder: ${error.message}`
      };
    }
  }

  // Multi-channel notification support for reminders
  async sendMultiChannelNotification(message, method = 'telegram') {
    const notifications = [];
    
    try {
      if (method === 'telegram' || method === 'both') {
        await this.notify(message);
        notifications.push('Telegram');
      }
      
      if (method === 'email' || method === 'both') {
        await this.sendEmailNotification(message);
        notifications.push('Email');
      }
      
      logger.info(`Reminder sent via: ${notifications.join(', ')}`);
    } catch (error) {
      logger.error('Multi-channel notification error:', error);
    }
  }

  // Send email notification
  async sendEmailNotification(message) {
    try {
      const emailPlugin = this.agent.apiManager?.getPlugin('email');
      if (emailPlugin && emailPlugin.enabled && process.env.EMAIL_OF_MASTER) {
        await emailPlugin.execute({
          action: 'send',
          to: process.env.EMAIL_OF_MASTER,
          subject: 'LANAgent Reminder',
          text: message
        });
      } else {
        logger.warn('Email notification requested but email plugin not available or master email not configured');
      }
    } catch (error) {
      logger.error('Email notification error:', error);
    }
  }
  
  /**
   * Check if it's safe to deploy (no critical processes running)
   */
  async checkDeploymentLocks() {
    try {
      // Check for self-modification lock
      const { selfModLock } = await import('../../services/selfModLock.js');
      if (selfModLock.isLocked()) {
        const info = selfModLock.getLockInfo();
        return {
          safe: false,
          reason: `Self-modification in progress${info?.branch ? ` on branch ${info.branch}` : ''}`,
          lockInfo: info
        };
      }
      
      // Check for active git operations in development
      try {
        const gitStatus = await execAsync('ps aux | grep -E "git (merge|rebase|cherry-pick)" | grep -v grep');
        if (gitStatus.stdout.trim()) {
          return {
            safe: false,
            reason: 'Git operation in progress'
          };
        }
      } catch (e) {
        // No git operations found (grep returns error when no matches)
      }
      
      // Check for git index lock file
      try {
        const gitRepoPath = await this.findGitRepository();
        if (gitRepoPath) {
          const gitLockPath = path.join(gitRepoPath, '.git', 'index.lock');
          await fs.access(gitLockPath);
          // If we can access the lock file, it exists
          return {
            safe: false,
            reason: 'Git index is locked - another git operation may be in progress'
          };
        }
      } catch (e) {
        // Lock file doesn't exist, which is good
      }
      
      return { safe: true };
    } catch (error) {
      logger.warn('Error checking deployment locks:', error);
      return { safe: true }; // Proceed if we can't check
    }
  }
  
  /**
   * Get current version from package.json
   */
  async getCurrentVersion() {
    try {
      const packagePath = path.join(this.deployPath, 'package.json');
      const packageData = await fs.readFile(packagePath, 'utf8');
      const packageJson = JSON.parse(packageData);
      return packageJson.version;
    } catch (error) {
      logger.warn('Could not read current version:', error);
      return 'unknown';
    }
  }
  
  /**
   * Compare current version with origin/main version
   */
  async getVersionComparison(gitRepoPath) {
    try {
      const currentPackage = await fs.readFile(path.join(this.deployPath, 'package.json'), 'utf8');
      const newPackageResult = await execAsync(`git show origin/main:package.json`, { cwd: gitRepoPath });
      
      const currentVersion = JSON.parse(currentPackage).version;
      const newVersion = JSON.parse(newPackageResult.stdout).version;
      
      return {
        changed: currentVersion !== newVersion,
        current: currentVersion,
        new: newVersion
      };
    } catch (error) {
      logger.warn('Could not compare versions:', error);
      return { changed: false, current: 'unknown', new: 'unknown' };
    }
  }
  
  /**
   * Analyze changes to determine if deployment is needed
   */
  async analyzeChangesForDeployment(gitRepoPath, changedFiles) {
    // Check if no files changed
    if (changedFiles.length === 0 || (changedFiles.length === 1 && changedFiles[0] === '')) {
      return {
        needed: false,
        reason: 'No files changed',
        summary: 'Already up to date'
      };
    }
    
    // Files that don't require deployment
    const nonDeploymentFiles = [
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
      '.gitignore',
      'docs/',
      '*.md',
      '.github/',
      'scripts/fix-' // Fix scripts that are run manually
    ];
    
    // Check if all changes are non-deployment files
    const deploymentFilesChanged = changedFiles.filter(file => {
      return !nonDeploymentFiles.some(pattern => {
        if (pattern.endsWith('/')) {
          return file.startsWith(pattern);
        }
        if (pattern.includes('*')) {
          const regex = new RegExp(pattern.replace('*', '.*'));
          return regex.test(file);
        }
        return file === pattern || file.startsWith(pattern);
      });
    });
    
    if (deploymentFilesChanged.length === 0) {
      return {
        needed: false,
        reason: 'Only documentation/non-code files changed',
        summary: `${changedFiles.length} doc file(s) updated`
      };
    }
    
    // Check version change
    let versionInfo = { changed: false };
    try {
      const currentPackage = await fs.readFile(path.join(this.deployPath, 'package.json'), 'utf8');
      const newPackageResult = await execAsync(`git show origin/main:package.json`, { cwd: gitRepoPath });
      
      const currentVersion = JSON.parse(currentPackage).version;
      const newVersion = JSON.parse(newPackageResult.stdout).version;
      
      versionInfo = {
        changed: currentVersion !== newVersion,
        current: currentVersion,
        new: newVersion
      };
    } catch (error) {
      logger.warn('Could not compare versions:', error);
    }
    
    // Build summary
    const codeFiles = deploymentFilesChanged.filter(f => f.endsWith('.js') || f.endsWith('.ts'));
    const configFiles = deploymentFilesChanged.filter(f => f.endsWith('.json') || f.endsWith('.env'));
    
    let summary = [];
    if (versionInfo.changed) {
      summary.push(`v${versionInfo.current} → v${versionInfo.new}`);
    }
    if (codeFiles.length > 0) {
      summary.push(`${codeFiles.length} code files`);
    }
    if (configFiles.length > 0) {
      summary.push(`${configFiles.length} config files`);
    }
    
    return {
      needed: true,
      reason: 'Code or configuration changes detected',
      summary: summary.join(', ') || `${deploymentFilesChanged.length} files changed`,
      newVersion: versionInfo.new
    };
  }
  
  /**
   * Create a backup of current deployment
   */
  async createDeploymentBackup(backupInfo) {
    try {
      const backupDir = process.env.BACKUP_PATH || path.join(process.env.DEPLOY_PATH || process.cwd(), 'backups');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `backup-${timestamp}`);
      
      // Create backup directory
      await execAsync(`mkdir -p ${backupDir}`);
      
      // Save backup info
      await fs.writeFile(
        path.join(backupDir, 'last-backup.json'),
        JSON.stringify(backupInfo, null, 2)
      );
      
      // Create backup (excluding runtime directories)
      // Use rsync if available, otherwise use find+cp
      try {
        await execAsync('which rsync');
        // Use rsync with exclude options
        await execAsync(`rsync -a --exclude=node_modules --exclude=logs --exclude=data ${this.deployPath}/ ${backupPath}/`);
      } catch (rsyncError) {
        // Fallback to tar method if rsync not available
        await execAsync(`cd ${path.dirname(this.deployPath)} && tar cf - --exclude='node_modules' --exclude='logs' --exclude='data' ${path.basename(this.deployPath)} | (cd ${backupDir} && tar xf -)`);
        await execAsync(`mv ${backupDir}/${path.basename(this.deployPath)} ${backupPath}`);
      }
      
      // Keep only last 3 backups
      await execAsync(`cd ${backupDir} && ls -t backup-* | tail -n +4 | xargs -r rm -rf`);
      
      logger.info(`Created deployment backup at ${backupPath}`);
      return backupPath;
    } catch (error) {
      logger.warn('Backup creation failed (non-fatal):', error);
      return null;
    }
  }
  
  /**
   * Rollback to previous deployment
   */
  async rollbackDeployment(backupInfo, gitRepoPath) {
    try {
      logger.error('Attempting deployment rollback...');
      await this.notify('❌ Deployment failed! Attempting rollback...');
      
      // Rollback git repo to previous commit
      if (backupInfo.commit) {
        await execAsync(`git reset --hard ${backupInfo.commit}`, { cwd: gitRepoPath });
      }
      
      // Try to restore from backup
      const backupInfoPath = path.join(process.env.BACKUP_PATH || path.join(process.env.DEPLOY_PATH || process.cwd(), 'backups'), 'last-backup.json');
      if (await fs.access(backupInfoPath).then(() => true).catch(() => false)) {
        const lastBackup = JSON.parse(await fs.readFile(backupInfoPath, 'utf8'));
        logger.info(`Rollback to version ${lastBackup.version} (commit: ${lastBackup.commit})`);
      }
      
      // Restart with previous code
      await this.restartAgent(3);
      
      await this.notify('✅ Rollback completed successfully');
      return { success: true };
    } catch (error) {
      logger.error('Rollback failed:', error);
      await this.notify('❌ Rollback failed! Manual intervention required');
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Find the git repository location
   * Checks common locations where the LANAgent git repository might be
   */
  async findGitRepository() {
    const possiblePaths = [
      process.env.AGENT_REPO_PATH, // Configured repo path
      process.cwd(), // Current directory (might be git repo in dev)
      path.join(process.env.HOME || '/root', 'lanagent-repo'),
      path.join(process.env.HOME || '/root', 'LANAgent')
    ];
    
    for (const repoPath of possiblePaths) {
      try {
        // Check if this is a git repository
        await execAsync('git rev-parse --git-dir', { cwd: repoPath });
        logger.info(`Found git repository at: ${repoPath}`);
        return repoPath;
      } catch (error) {
        // Not a git repository, continue checking
      }
    }
    
    // If no git repo found, try to find any directory with .git
    try {
      const findResult = await execAsync('find /root -name ".git" -type d 2>/dev/null | grep -E "(lanagent|LANAgent)" | head -1');
      if (findResult.stdout) {
        const gitDir = findResult.stdout.trim();
        const repoPath = path.dirname(gitDir);
        logger.info(`Found git repository via search at: ${repoPath}`);
        return repoPath;
      }
    } catch (error) {
      logger.debug('Git repository search failed:', error);
    }
    
    return null;
  }
  
  /**
   * Sync code from git repository to deployment directory
   * Excludes .git, node_modules, logs, and other runtime files
   */
  async syncGitToDeployment(gitRepoPath) {
    try {
      const deployPath = this.deployPath;
      
      // Check if rsync is available, otherwise use cp
      let syncMethod = 'rsync';
      try {
        await execAsync('which rsync');
      } catch (error) {
        logger.info('rsync not found, falling back to cp method');
        syncMethod = 'cp';
      }
      
      if (syncMethod === 'rsync') {
        // Use rsync to sync files, excluding unnecessary directories
        const rsyncCommand = `rsync -av --delete \
          --exclude='.git' \
          --exclude='node_modules' \
          --exclude='logs' \
          --exclude='data' \
          --exclude='uploads' \
          --exclude='quarantine' \
          --exclude='workspace' \
          --exclude='.env' \
          --exclude='*.log' \
          --exclude='tmp' \
          --exclude='temp' \
          ${gitRepoPath}/ ${deployPath}/`;
        
        logger.info('Syncing files from git to deployment using rsync...');
        const result = await execAsync(rsyncCommand);
        logger.info('Sync completed successfully');
      } else {
        // Fallback to cp method
        logger.info('Syncing files from git to deployment using cp...');
        
        // Create a temporary list of files to exclude
        const excludePatterns = [
          '.git', 'node_modules', 'logs', 'data', 'uploads', 
          'quarantine', 'workspace', '.env', '*.log', 'tmp', 'temp'
        ];
        
        // Copy all directories and files except excluded ones
        const copyCommand = `cd ${gitRepoPath} && find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/logs/*' -not -path '*/data/*' -not -path '*/uploads/*' -not -path '*/quarantine/*' -not -path '*/workspace/*' -not -path '*/tmp/*' -not -path '*/temp/*' -not -name '.env' -not -name '*.log' | while read file; do
          dir=$(dirname "$file")
          mkdir -p "${deployPath}/$dir"
          cp "$file" "${deployPath}/$file"
        done`;
        
        await execAsync(copyCommand, { shell: '/bin/bash' });
        
        // Also copy directories (for empty dirs)
        const dirCommand = `cd ${gitRepoPath} && find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/logs/*' -not -path '*/data/*' -not -path '*/uploads/*' -not -path '*/quarantine/*' -not -path '*/workspace/*' -not -path '*/tmp/*' -not -path '*/temp/*' | while read dir; do
          mkdir -p "${deployPath}/$dir"
        done`;
        
        await execAsync(dirCommand, { shell: '/bin/bash' });
        
        logger.info('File copy completed successfully');
      }
      
      // Ensure proper permissions
      await execAsync(`chmod -R 755 ${deployPath}`);
      
      // Ensure required directories exist
      const requiredDirs = ['logs', 'data', 'uploads', 'quarantine', 'workspace', 'temp'];
      for (const dir of requiredDirs) {
        await execAsync(`mkdir -p ${path.join(deployPath, dir)}`);
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to sync git to deployment:', error);
      throw new Error(`Sync failed: ${error.message}`);
    }
  }
}