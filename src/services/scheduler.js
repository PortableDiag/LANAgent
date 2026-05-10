import Agenda from 'agenda';
import { logger } from '../utils/logger.js';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { safeInterval } from '../utils/errorHandlers.js';
import { selfModLock } from './selfModLock.js';

const execAsync = promisify(exec);

class TaskScheduler {
  constructor() {
    this.agenda = null;
    this.agent = null;
    this.apiManager = null;
    
    // Track last activity times
    this.lastEmailCheck = null;
    this.lastTaskReminder = null;
    this.lastSystemStats = null;
    this.lastModelUpdate = null;
    this.lastGitCheck = null;
    this.lastMaintenance = null;
    this.lastSystemHealth = null;
    this.lastCodeAnalysis = null;
    this.lastProcessTasks = null;
    this.lastSelfModScan = null;
    this.lastWeeklyReport = null;
    this.lastDailyBugScan = null;
    this.lastBugFixing = null;
    this.lastCleanupJobs = null;
    this.lastSystemDiagnostics = null;
    // Note: Crypto strategy moved to SubAgent orchestrator
    
    // Health alert throttling (prevent spam)
    this.healthAlerts = {
      cpu: { lastAlert: null, alertCooldown: 300000 }, // 5 minutes
      memory: { lastAlert: null, alertCooldown: 300000 },
      disk: { lastAlert: null, alertCooldown: 600000 } // 10 minutes for disk
    };
    
    // Resource usage tracking for extended monitoring
    this.resourceHistory = {
      cpu: [],
      memory: [],
      maxHistorySize: 10 // Keep last 10 minutes of data (1 check per minute)
    };
    
    // Track recent operations for correlation
    this.recentOperations = [];
    
    // Auto-reply tracking (prevent email loops)
    this.autoReplyTracker = {};
    
    // Track recently processed emails to prevent duplicates
    this.processedEmailsCache = new Map();
    
    // Track last auto-reply time per email address for cooldown
    this.lastAutoReplyTime = new Map();
    
    // Track email threads to prevent multiple replies to same conversation
    this.emailThreads = new Map();
    
    // Clean up old auto-reply tracking data daily with error handling
    this.cleanupInterval = safeInterval(() => {
      const today = new Date().toISOString().split('T')[0];
      Object.keys(this.autoReplyTracker).forEach(key => {
        if (!key.includes(today)) {
          delete this.autoReplyTracker[key];
        }
      });
      
      // Clean up processed emails cache (keep for 1 hour)
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      for (const [key, timestamp] of this.processedEmailsCache) {
        if (timestamp < oneHourAgo) {
          this.processedEmailsCache.delete(key);
        }
      }
      
      // Clean up last reply time cache (keep for 24 hours)
      const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
      for (const [email, timestamp] of this.lastAutoReplyTime) {
        if (timestamp < twentyFourHoursAgo) {
          this.lastAutoReplyTime.delete(email);
        }
      }
      
      // Clean up email thread tracking (keep for 7 days)
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      for (const [threadKey, threadData] of this.emailThreads) {
        if (threadData.lastReplyTime < sevenDaysAgo) {
          this.emailThreads.delete(threadKey);
        }
      }
      
      logger.debug(`Cleaned up old auto-reply tracking data`);
    }, 24 * 60 * 60 * 1000, 'scheduler-auto-reply-cleanup'); // Daily cleanup
  }

  async initialize(agent) {
    this.agent = agent;
    this.apiManager = agent.apiManager;
    
    // Initialize Agenda with MongoDB
    this.agenda = new Agenda({
      db: {
        address: process.env.MONGODB_URI,
        collection: 'scheduled_jobs'
      },
      processEvery: '30 seconds',
      maxConcurrency: 10
    });
    
    // Define job types
    this.defineJobs();
    
    // Start the agenda
    await this.agenda.start();
    logger.info('Task scheduler initialized with Agenda');

    // Load persisted activity timestamps from database
    await this.loadActivityTimestamps();

    // Schedule recurring jobs
    await this.scheduleRecurringJobs();

    // Load and apply saved report settings
    await this.restoreReportSettings();
  }

  /**
   * Load persisted activity timestamps from database
   */
  async loadActivityTimestamps() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
      const timestamps = agentData?.schedulerData?.activityTimestamps;

      if (timestamps) {
        this.lastEmailCheck = timestamps.emailCheck ? new Date(timestamps.emailCheck) : null;
        this.lastTaskReminder = timestamps.taskReminder ? new Date(timestamps.taskReminder) : null;
        this.lastSystemStats = timestamps.systemStats ? new Date(timestamps.systemStats) : null;
        this.lastModelUpdate = timestamps.modelUpdate ? new Date(timestamps.modelUpdate) : null;
        this.lastGitCheck = timestamps.gitCheck ? new Date(timestamps.gitCheck) : null;
        this.lastMaintenance = timestamps.maintenance ? new Date(timestamps.maintenance) : null;
        this.lastSystemHealth = timestamps.systemHealth ? new Date(timestamps.systemHealth) : null;
        this.lastCodeAnalysis = timestamps.codeAnalysis ? new Date(timestamps.codeAnalysis) : null;
        this.lastProcessTasks = timestamps.processTasks ? new Date(timestamps.processTasks) : null;
        this.lastSelfModScan = timestamps.selfModScan ? new Date(timestamps.selfModScan) : null;
        this.lastWeeklyReport = timestamps.weeklyReport ? new Date(timestamps.weeklyReport) : null;
        this.lastDailyBugScan = timestamps.dailyBugScan ? new Date(timestamps.dailyBugScan) : null;
        this.lastBugFixing = timestamps.bugFixing ? new Date(timestamps.bugFixing) : null;
        this.lastGitHubDiscovery = timestamps.githubDiscovery ? new Date(timestamps.githubDiscovery) : null;
        this.lastCleanupJobs = timestamps.cleanupJobs ? new Date(timestamps.cleanupJobs) : null;
        this.lastSystemDiagnostics = timestamps.systemDiagnostics ? new Date(timestamps.systemDiagnostics) : null;
        logger.debug('Loaded persisted activity timestamps from database');
      }
    } catch (error) {
      logger.debug('Could not load activity timestamps:', error.message);
    }
  }

  /**
   * Save activity timestamps to database for persistence
   */
  async saveActivityTimestamps() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const timestamps = {
        emailCheck: this.lastEmailCheck,
        taskReminder: this.lastTaskReminder,
        systemStats: this.lastSystemStats,
        modelUpdate: this.lastModelUpdate,
        gitCheck: this.lastGitCheck,
        maintenance: this.lastMaintenance,
        systemHealth: this.lastSystemHealth,
        codeAnalysis: this.lastCodeAnalysis,
        processTasks: this.lastProcessTasks,
        selfModScan: this.lastSelfModScan,
        weeklyReport: this.lastWeeklyReport,
        dailyBugScan: this.lastDailyBugScan,
        bugFixing: this.lastBugFixing,
        githubDiscovery: this.lastGitHubDiscovery,
        cleanupJobs: this.lastCleanupJobs,
        systemDiagnostics: this.lastSystemDiagnostics
      };

      await Agent.findOneAndUpdate(
        { name: process.env.AGENT_NAME || 'LANAgent' },
        { $set: { 'schedulerData.activityTimestamps': timestamps } },
        { upsert: true }
      );
    } catch (error) {
      logger.debug('Could not save activity timestamps:', error.message);
    }
  }

  /**
   * Update a specific activity timestamp and persist it
   */
  async updateActivityTimestamp(activity) {
    const now = new Date();
    const propertyMap = {
      'emailCheck': 'lastEmailCheck',
      'taskReminder': 'lastTaskReminder',
      'systemStats': 'lastSystemStats',
      'modelUpdate': 'lastModelUpdate',
      'gitCheck': 'lastGitCheck',
      'maintenance': 'lastMaintenance',
      'systemHealth': 'lastSystemHealth',
      'codeAnalysis': 'lastCodeAnalysis',
      'processTasks': 'lastProcessTasks',
      'selfModScan': 'lastSelfModScan',
      'weeklyReport': 'lastWeeklyReport',
      'dailyBugScan': 'lastDailyBugScan',
      'bugFixing': 'lastBugFixing',
      'githubDiscovery': 'lastGitHubDiscovery',
      'cleanupJobs': 'lastCleanupJobs',
      'systemDiagnostics': 'lastSystemDiagnostics'
    };

    const property = propertyMap[activity];
    if (property) {
      this[property] = now;
      await this.saveActivityTimestamps();
    }
  }

  /**
   * Sync local repo from the upstream (genesis) repository.
   * For forked instances, origin points to their fork. UPSTREAM_REPO points
   * to the genesis repo. This fetches upstream/main and merges new commits
   * so forked instances receive updates pushed to the genesis repo.
   */
  async _syncFromUpstream(gitPlugin) {
    const upstreamRepo = process.env.UPSTREAM_REPO;
    if (!upstreamRepo) return; // Not a fork, or upstream not configured

    // Skip if origin IS the upstream repo (single-repo genesis — no separate upstream to pull from).
    // In dual-repo mode (genesis=private, upstream=public), these URLs differ so sync proceeds
    // normally — genesis pulls community improvements from the public repo.
    // UPSTREAM_CONTRIBUTIONS (checked in selfModification.js) controls PRing back, not pulling.
    try {
      const originResult = await gitPlugin.executeGitCommand('remote get-url origin');
      if (originResult.success) {
        const originUrl = originResult.stdout.trim().replace(/\.git$/, '').toLowerCase();
        const upstreamUrl = upstreamRepo.replace(/\.git$/, '').toLowerCase();
        if (originUrl === upstreamUrl) {
          logger.debug('[UpstreamSync] Origin is the upstream repo — skipping (single-repo genesis)');
          return;
        }
      }
    } catch { /* continue */ }

    const lockAcquired = await selfModLock.acquire('git-monitor');
    if (!lockAcquired) {
      logger.debug('[UpstreamSync] Lock busy, skipping upstream sync');
      return;
    }

    try {
      // Ensure the 'upstream' remote exists
      const remoteCheck = await gitPlugin.executeGitCommand('remote get-url upstream');
      if (!remoteCheck.success) {
        logger.info(`[UpstreamSync] Adding upstream remote: ${upstreamRepo}`);
        await gitPlugin.executeGitCommand(`remote add upstream ${upstreamRepo}`);
      }

      // Fetch latest from upstream
      logger.info('[UpstreamSync] Fetching upstream/main...');
      const fetchResult = await gitPlugin.executeGitCommand('fetch upstream main');
      if (!fetchResult.success) {
        logger.warn('[UpstreamSync] Fetch failed:', fetchResult.stderr || fetchResult.error);
        return;
      }

      // Check how many commits we're behind upstream/main
      const behindResult = await gitPlugin.executeGitCommand('rev-list --count HEAD..upstream/main');
      if (!behindResult.success) return;
      const behindCount = parseInt(behindResult.stdout.trim(), 10);

      if (!behindCount || behindCount === 0) {
        logger.debug('[UpstreamSync] Already up to date with upstream');
        return;
      }

      logger.info(`[UpstreamSync] ${behindCount} new commit(s) from upstream`);

      // Check for local uncommitted changes
      const statusResult = await gitPlugin.executeGitCommand('status --porcelain');
      if (statusResult.success && statusResult.stdout.trim()) {
        logger.warn('[UpstreamSync] Local changes present, skipping upstream merge');
        await this.agent.notify(`📡 ${behindCount} upstream update(s) available but local changes prevent auto-merge. Commit or stash local changes to receive updates.`);
        return;
      }

      // Checkout main
      const checkoutResult = await gitPlugin.executeGitCommand('checkout main');
      if (!checkoutResult.success) {
        logger.warn('[UpstreamSync] Failed to checkout main:', checkoutResult.stderr);
        return;
      }

      // Merge upstream/main with --no-edit (auto commit message)
      const mergeResult = await gitPlugin.executeGitCommand('merge upstream/main --no-edit');
      if (!mergeResult.success) {
        const errMsg = (mergeResult.stderr || mergeResult.error || '').toLowerCase();
        if (errMsg.includes('conflict')) {
          logger.error('[UpstreamSync] Merge conflicts — aborting merge');
          await gitPlugin.executeGitCommand('merge --abort');
          await this.agent.notify(`🚨 Upstream sync failed: merge conflicts with ${behindCount} new commit(s). Manual resolution required.`);
        } else {
          logger.error('[UpstreamSync] Merge failed:', mergeResult.stderr || mergeResult.error);
        }
        return;
      }

      logger.info(`[UpstreamSync] Merged ${behindCount} commit(s) from upstream`);

      // Push merged result to origin (keep the fork in sync)
      const pushResult = await gitPlugin.executeGitCommand('push origin main');
      if (pushResult.success) {
        logger.info('[UpstreamSync] Pushed upstream changes to origin/main');
      } else {
        logger.warn('[UpstreamSync] Push to origin failed (non-critical):', pushResult.stderr);
      }

      await this.agent.notify(`📦 Synced ${behindCount} update(s) from upstream repository`);
    } catch (error) {
      logger.error('[UpstreamSync] Error:', error.message);
    } finally {
      await selfModLock.release('git-monitor');
    }
  }

  defineJobs() {
    // Reminder job
    this.agenda.define('reminder', async (job) => {
      const { message, userId, notificationMethod = 'telegram' } = job.attrs.data;
      logger.info(`Sending reminder: ${message} via ${notificationMethod}`);
      
      try {
        // Rephrase the reminder from the agent's perspective using AI
        const rephrasePrompt = `Rephrase this reminder message from your perspective as an AI assistant. Keep it friendly but brief.
        
Original: "${message}"

Examples:
"brush my teeth" -> "Time to brush your teeth!"
"check logs" -> "Don't forget to check those logs!"  
"call mom" -> "Remember to call your mom!"
"deploy the app" -> "Time to deploy the app!"

Respond with ONLY the rephrased message, no explanation:`;

        let finalMessage;
        try {
          const response = await this.agent.providerManager.generateResponse(rephrasePrompt, { maxTokens: 50 });
          finalMessage = `🔔 ${response.content.trim()}`;
        } catch (error) {
          // Fallback if AI fails
          finalMessage = `🔔 Reminder: Time to ${message}!`;
        }
        
        // Send via appropriate channels
        if (notificationMethod === 'telegram' || notificationMethod === 'both') {
          await this.agent.notify(finalMessage, userId);
        }
        
        if (notificationMethod === 'email' || notificationMethod === 'both') {
          try {
            const emailPlugin = this.agent.apiManager?.getPlugin('email');
            if (emailPlugin && process.env.EMAIL_OF_MASTER) {
              await emailPlugin.instance.execute({
                action: 'send',
                to: process.env.EMAIL_OF_MASTER,
                subject: `Reminder from ${this.agent.config.name}`,
                message: finalMessage.replace('🔔 ', '')
              });
            }
          } catch (emailError) {
            logger.warn('Failed to send email reminder:', emailError);
          }
        }
        
        logger.info('Reminder sent successfully');
      } catch (error) {
        logger.error('Failed to send reminder:', error);
        throw error;
      }
    });
    
    // Email check job with comprehensive auto-reply logic
    this.agenda.define('check-emails', async (job) => {
      try {
        this.lastEmailCheck = new Date();
        this.saveActivityTimestamps(); // Persist to database

        const emailPlugin = this.apiManager.getPlugin('email');
        if (!emailPlugin) {
          logger.warn('Email plugin not found');
          return;
        }

        // Check if plugin is enabled
        const pluginStatus = this.apiManager.getPluginStatus('email');
        if (!pluginStatus || !pluginStatus.enabled) {
          logger.warn('Email plugin disabled');
          return;
        }

        // Skip silently when no IMAP credentials are configured. Without this
        // guard we'd log "Failed to initialize IMAP" + "Email check job failed"
        // every 3 minutes for the lifetime of the process.
        if (!emailPlugin.gmailUser || !emailPlugin.gmailPassword) {
          if (!this._emailNotConfiguredLogged) {
            logger.info('Email check job: IMAP credentials not configured — disabling scheduled checks');
            this._emailNotConfiguredLogged = true;
          }
          return;
        }

        logger.info('Running scheduled email check...');
        
        logger.info('Getting unread emails...');
        const result = await emailPlugin.execute({
          action: 'getEmails',
          params: {
            limit: 5,
            unreadOnly: true
          }
        });
        
        logger.info(`Email check result: success=${result.success}, email_count=${result.emails?.length || 0}`);
        
        // Check for unprocessed emails in database
        let unprocessedEmails = [];
        try {
          const { Email } = await import('../models/Email.js');
          unprocessedEmails = await Email.find({ 
            processed: false, 
            type: 'received' 
          }).sort({ sentDate: -1 }).limit(10);
          logger.info(`Found ${unprocessedEmails.length} unprocessed emails in database`);
        } catch (error) {
          logger.error('Error checking unprocessed emails:', error);
        }
        
        // Combine and process emails
        let emailsToProcess = [];
        
        if (result.success && result.emails && result.emails.length > 0) {
          const { Email } = await import('../models/Email.js');
          
          for (const imapEmail of result.emails) {
            const existingEmail = await Email.findOne({ 
              messageId: imapEmail.messageId,
              processed: true 
            });
            
            if (!existingEmail) {
              emailsToProcess.push(imapEmail);
            }
          }
        }
        
        // Deduplicate emails by messageId before concatenating
        const processedIds = new Set(emailsToProcess.map(e => e.messageId || `${e.from}-${e.subject}`));
        for (const dbEmail of unprocessedEmails) {
          const emailKey = dbEmail.messageId || `${dbEmail.from}-${dbEmail.subject}`;
          if (!processedIds.has(emailKey)) {
            emailsToProcess.push(dbEmail);
            processedIds.add(emailKey);
          }
        }

        if (emailsToProcess.length > 0) {
          // Process emails for auto-reply
          for (const email of emailsToProcess) {
            try {
              await this.processEmailForAutoReply(email);
            } catch (error) {
              logger.error(`Failed to process email: ${error.message}`);
            }
          }
          
          // Notify master user
          if (this.agent.config.notifications?.emailAlerts) {
            await this.agent.notify(`📧 Processed ${emailsToProcess.length} emails`);
          }
        }
      } catch (error) {
        logger.error('Email check job failed:', error);
      }
    });
    
    // System health check with enhanced monitoring
    this.agenda.define('system-health', async (job) => {
      logger.debug('Running enhanced system health check...');
      this.lastSystemHealth = new Date();
      this.saveActivityTimestamps(); // Persist to database
      
      try {
        const systemPlugin = this.agent.apiManager.getPlugin('system');
        if (systemPlugin && systemPlugin.enabled) {
          const result = await systemPlugin.execute({
            action: 'info',
            params: { type: 'all' }
          });
          
          if (result.success && result.data) {
            const diskUsage = parseInt(result.data.disk?.usePercent) || 0;
            const memUsage = this.calculateMemoryUsage(result.data.memory);
            const cpuUsage = parseFloat(result.data.cpu?.usage) || 0;
            
            // Track resource usage history
            this.trackResourceUsage('cpu', cpuUsage);
            this.trackResourceUsage('memory', memUsage);
            
            // Check for extended high CPU usage (80% threshold over 5 minutes)
            const extendedCpuIssue = await this.checkExtendedHighUsage('cpu', 80, 5);
            if (extendedCpuIssue.isHigh && this.shouldSendAlert('cpu')) {
              const operations = await this.analyzeRecentOperations();
              await this.agent.notify(`🔥 **Extended High CPU Usage Alert**\n\n` +
                `CPU: **${cpuUsage.toFixed(1)}%** (average: ${extendedCpuIssue.average.toFixed(1)}%)\n` +
                `Duration: **${extendedCpuIssue.duration} minutes** above 80%\n\n` +
                `${operations.summary}`);
              this.markAlertSent('cpu');
            }
            
            // Check for extended high memory usage (80% threshold over 5 minutes)
            const extendedMemIssue = await this.checkExtendedHighUsage('memory', 80, 5);
            if (extendedMemIssue.isHigh && this.shouldSendAlert('memory')) {
              const operations = await this.analyzeRecentOperations();
              await this.agent.notify(`💾 **Extended High Memory Usage Alert**\n\n` +
                `Memory: **${memUsage}%** (average: ${extendedMemIssue.average.toFixed(1)}%)\n` +
                `Duration: **${extendedMemIssue.duration} minutes** above 80%\n\n` +
                `${operations.summary}`);
              this.markAlertSent('memory');
            }
            
            // Check disk usage (90% threshold - more critical)
            if (diskUsage > 90 && this.shouldSendAlert('disk')) {
              await this.agent.notify(`💽 **Critical Disk Usage Alert**\n\n` +
                `Disk: **${diskUsage}%** (Threshold: 90%)\n` +
                `⚠️ **Immediate action required** - System may become unstable!`);
              this.markAlertSent('disk');
            }
            
            // Log current stats for debugging
            logger.debug(`Health check: CPU ${cpuUsage}%, Memory ${memUsage}%, Disk ${diskUsage}%`);
          }
        }
      } catch (error) {
        logger.error('System health check failed:', error);
      }
    });
    
    // Code analysis job for self-modification
    this.agenda.define('code-analysis', async (job) => {
      this.lastCodeAnalysis = new Date();
      if (!this.agent.selfModification?.enabled) {
        logger.debug('Self-modification service is not enabled, skipping analysis');
        return;
      }
      
      logger.info('Running code analysis for self-modification...');
      
      try {
        const selfModService = this.agent.selfModification;
        if (selfModService) {
          await selfModService.analyzeCodebase();
        }
      } catch (error) {
        logger.error('Code analysis job failed:', error);
      }
    });
    
    // Task reminders
    this.agenda.define('task-reminder', async (job) => {
      const { taskId, title } = job.attrs.data;
      logger.info(`Sending task reminder for: ${title}`);
      
      try {
        this.lastTaskReminder = new Date();
        await this.agent.notify(`📋 Task Reminder: ${title}\n\nTask ID: ${taskId}`);
      } catch (error) {
        logger.error('Task reminder failed:', error);
      }
    });
    
    // Git repository monitor
    this.agenda.define('git-monitor', async (job) => {
      logger.info('Running git repository monitor...');
      this.lastGitCheck = new Date();
      this.saveActivityTimestamps(); // Persist to database

      try {
        const gitPlugin = this.apiManager.getPlugin('git');
        if (!gitPlugin) return;

        // Phase 1: Sync from upstream repo if this is a fork
        await this._syncFromUpstream(gitPlugin);

        // Phase 2: Check origin for updates (existing logic)
        const status = await gitPlugin.execute({
          action: 'status',
          params: { verbose: true }
        });

        if (status.success && status.data) {
          // Check if behind origin
          if (status.data.behind && status.data.behind > 0) {
            logger.info(`Repository is ${status.data.behind} commits behind origin`);

            // Auto-pull if no local changes
            if (!status.data.files || status.data.files.length === 0) {
              // Try to acquire lock before git operations
              const lockAcquired = await selfModLock.acquire('git-monitor');
              if (!lockAcquired) {
                logger.info('Another self-modification process is running. Git monitor will skip this check.');
                return;
              }

              try {
                // First checkout main branch
                logger.info('Switching to main branch for auto-pull...');
                const checkoutResult = await gitPlugin.execute({
                  action: 'checkout',
                  params: { branch: 'main' }
                });

                if (!checkoutResult.success) {
                  logger.warn('Failed to checkout main branch for auto-pull:', checkoutResult.error);
                  await selfModLock.release('git-monitor');
                  return;
                }

                const pullResult = await gitPlugin.execute({
                  action: 'pull',
                  params: { remote: 'origin', branch: 'main' }
                });

                if (pullResult.success) {
                  logger.info('Successfully pulled latest changes');
                  await this.agent.notify('📦 Auto-updated: Pulled latest changes from repository');
                } else {
                  // Handle pull failures (conflicts, network issues, etc.)
                  const errorMsg = pullResult.error || pullResult.stderr || 'Unknown error';
                  logger.error('Auto-pull failed:', errorMsg);

                  if (errorMsg.toLowerCase().includes('conflict') || errorMsg.toLowerCase().includes('merge')) {
                    await this.agent.notify('🚨 Auto-pull failed: Git conflicts detected! Manual intervention required.\n\nRepository needs manual conflict resolution before auto-updates can continue.');
                  } else if (errorMsg.toLowerCase().includes('network') || errorMsg.toLowerCase().includes('timeout')) {
                    await this.agent.notify('📡 Auto-pull failed: Network error. Will retry on next check (30 minutes).');
                  } else {
                    await this.agent.notify(`⚠️ Auto-pull failed: ${errorMsg.substring(0, 200)}...\n\nCheck repository status manually.`);
                  }
                }
              } finally {
                // Always release the lock
                await selfModLock.release('git-monitor');
                logger.debug('Git monitor released lock');
              }
            } else {
              const fileList = status.data.files.slice(0, 5).join(', ');
              const moreFiles = status.data.files.length > 5 ? ` (+${status.data.files.length - 5} more)` : '';
              await this.agent.notify(`📝 Repository update available but local changes prevent auto-pull.\n\nModified files: ${fileList}${moreFiles}\n\nOptions:\n• Commit changes: git add . && git commit -m "message"\n• Discard changes: git reset --hard HEAD\n• Stash changes: git stash`);
            }
          }
        }
      } catch (error) {
        logger.error('Git monitor error:', error);
      }
    });
    
    // Task processor - executes pending tasks
    this.agenda.define('process-tasks', async (job) => {
      logger.info('Running task processor...');
      this.lastProcessTasks = new Date();
      this.saveActivityTimestamps(); // Persist to database
      
      try {
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          logger.warn('Tasks plugin not available');
          return;
        }
        
        const result = await tasksPlugin.execute({ action: 'process' });
        
        if (result.success && result.task) {
          logger.info('Task processed:', result.task.title);
        } else if (result.message) {
          logger.info('Task processor:', result.message);
        }
      } catch (error) {
        logger.error('Task processor error:', error);
      }
    });
    
    // Self-modification scanner
    this.agenda.define('self-mod-scan', async (job) => {
      logger.info('Running self-modification scanner...');
      this.lastSelfModScan = new Date();
      this.saveActivityTimestamps(); // Persist to database

      try {
        // Check if self-modification service exists and is enabled
        if (!this.agent.selfModification?.enabled) {
          logger.debug('Self-modification service is not enabled, skipping scan');
          return;
        }

        const selfModService = this.agent.selfModification;
        if (!selfModService) {
          logger.warn('Self-modification service not available');
          return;
        }

        // Run the full improvement check which analyzes, implements, and creates PRs
        logger.info('Running self-modification check for improvements...');
        await selfModService.checkForImprovements();

        logger.info('Self-modification check completed');
      } catch (error) {
        logger.error('Self-mod scan error:', error);
      }
    });

    // Crypto Strategy Agent (dynamic interval, triggered by SubAgent)
    this.agenda.define('crypto-strategy-agent', async (job) => {
      const { agentId } = job.attrs.data || {};
      logger.info(`Running scheduled crypto strategy agent (id: ${agentId})...`);

      try {
        const orchestrator = this.agent?.subAgentOrchestrator;
        if (!orchestrator) {
          logger.warn('SubAgent orchestrator not available for crypto strategy agent');
          return;
        }

        // Run the agent directly
        const result = await orchestrator.runAgent(agentId);
        logger.info(`Crypto strategy agent run result: ${result?.success ? 'success' : result?.reason || 'unknown'}`);
      } catch (error) {
        logger.error('Crypto strategy agent job failed:', error);
      }
    });

    // Crypto price monitor - lightweight Chainlink poll for event-driven strategy execution
    this.agenda.define('crypto-price-monitor', async (job) => {
      try {
        const orchestrator = this.agent?.subAgentOrchestrator;
        if (!orchestrator) {
          logger.debug('Crypto price monitor: orchestrator not ready, skipping');
          return;
        }

        const { ethers } = await import('ethers');
        const { default: contractServiceWrapper } = await import('./crypto/contractServiceWrapper.js');

        const FEEDS = {
          ethereum: { symbol: 'ETH', pair: 'ETH/USD', feedAddress: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' },
          bsc: { symbol: 'BNB', pair: 'BNB/USD', feedAddress: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE' }
        };

        const FEED_ABI = [
          { inputs: [], name: 'latestRoundData', outputs: [
            { internalType: 'uint80', name: 'roundId', type: 'uint80' },
            { internalType: 'int256', name: 'answer', type: 'int256' },
            { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
            { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
            { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' }
          ], stateMutability: 'view', type: 'function' },
          { inputs: [], name: 'decimals', outputs: [
            { internalType: 'uint8', name: '', type: 'uint8' }
          ], stateMutability: 'view', type: 'function' }
        ];

        if (!this.cryptoPriceState) {
          this.cryptoPriceState = new Map();
        }

        const MOVE_THRESHOLD = 0.01; // 1%
        const currentPrices = {};
        let significantMoveDetected = false;
        const moves = [];

        for (const [network, feed] of Object.entries(FEEDS)) {
          try {
            const provider = await contractServiceWrapper.getProvider(network);
            const contract = new ethers.Contract(feed.feedAddress, FEED_ABI, provider);
            const [, answer, , updatedAt] = await contract.latestRoundData();
            const decimals = await contract.decimals();
            const price = Number(answer) / Math.pow(10, Number(decimals));

            currentPrices[network] = {
              price,
              symbol: feed.symbol,
              source: 'chainlink',
              updatedAt: new Date(Number(updatedAt) * 1000),
              network
            };

            const last = this.cryptoPriceState.get(network);
            if (last) {
              const changePct = (price - last.price) / last.price;
              if (Math.abs(changePct) >= MOVE_THRESHOLD) {
                significantMoveDetected = true;
                moves.push({
                  network,
                  symbol: feed.symbol,
                  previousPrice: last.price,
                  currentPrice: price,
                  changePercent: (changePct * 100).toFixed(2)
                });
              }
            }

            this.cryptoPriceState.set(network, { price, symbol: feed.symbol, timestamp: Date.now() });
          } catch (error) {
            logger.warn(`Price monitor: failed to read ${feed.symbol} from Chainlink: ${error.message}`);
          }
        }

        // Price check for tracked tokens (token_trader) using Chainlink oracles
        // Falls back to DEX stablecoin quote if no oracle available
        if (this.cryptoWatchedTokens?.length > 0) {
          // Known Chainlink price feeds for tokens
          const TOKEN_FEEDS = {
            bsc: {
              '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD': '0xca236E327F629f9Fc2c30A4E95775EbF0B89fAC8', // LINK/USD
              '0x2170Ed0880ac9A755fd29B2688956BD959F933F8': '0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e', // ETH/USD
              '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c': '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf', // BTC/USD
            },
            ethereum: {
              '0x514910771AF9Ca656af840dff83E8264EcF986CA': '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c', // LINK/USD
            }
          };

          for (const token of this.cryptoWatchedTokens) {
            try {
              let tokenPrice = 0;
              let source = 'none';

              // Primary: Chainlink oracle (free, authoritative)
              const checksumAddr = ethers.getAddress(token.address.toLowerCase());
              const feedAddr = TOKEN_FEEDS[token.network]?.[checksumAddr];
              if (feedAddr) {
                try {
                  const provider = await contractServiceWrapper.getProvider(token.network);
                  const contract = new ethers.Contract(feedAddr, FEED_ABI, provider);
                  const [, answer, , updatedAt] = await contract.latestRoundData();
                  const decimals = await contract.decimals();
                  const price = Number(answer) / Math.pow(10, Number(decimals));
                  const staleness = Date.now() - Number(updatedAt) * 1000;
                  if (price > 0 && staleness < 3600000) {
                    tokenPrice = price;
                    source = 'chainlink';
                  }
                } catch (oracleErr) {
                  logger.debug(`Price monitor: Chainlink oracle failed for ${token.symbol}: ${oracleErr.message}`);
                }
              }

              // Fallback: DEX stablecoin quote (actual trading price)
              if (tokenPrice <= 0) {
                try {
                  const { default: swapSvc } = await import('./crypto/swapService.js');
                  const stablecoins = swapSvc.getStablecoins(token.network);
                  const stablecoinAddr = stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
                  if (stablecoinAddr) {
                    const quote = await swapSvc.getQuote(token.address, stablecoinAddr, '1', token.network, 'uniswapV2', {
                      decimalsIn: token.decimals || 18, decimalsOut: 18
                    });
                    if (quote && parseFloat(quote.amountOut) > 0) {
                      tokenPrice = parseFloat(quote.amountOut);
                      source = 'dex';
                    }
                  }
                } catch (dexErr) {
                  logger.debug(`Price monitor: DEX quote failed for ${token.symbol}: ${dexErr.message}`);
                }
              }

              if (tokenPrice > 0) {
                const key = `${token.network}-${token.symbol.toLowerCase()}`;
                currentPrices[key] = { price: tokenPrice, symbol: token.symbol, source, network: token.network };

                const last = this.cryptoPriceState.get(key);
                if (last) {
                  const changePct = (tokenPrice - last.price) / last.price;
                  if (Math.abs(changePct) >= MOVE_THRESHOLD) {
                    significantMoveDetected = true;
                    moves.push({ network: token.network, symbol: token.symbol, previousPrice: last.price, currentPrice: tokenPrice, changePercent: (changePct * 100).toFixed(2) });
                  }
                }
                this.cryptoPriceState.set(key, { price: tokenPrice, symbol: token.symbol, timestamp: Date.now() });
              }
            } catch (err) {
              logger.debug(`Price monitor: failed to get ${token.symbol} price: ${err.message}`);
            }
          }
        }

        // Log every poll with current prices
        const pricesSummary = Object.entries(currentPrices).map(([n, p]) => `${p.symbol}=$${typeof p.price === 'number' && p.price > 0.001 ? p.price.toFixed(2) : p.price.toExponential(4)}`).join(', ');
        if (pricesSummary) {
          logger.info(`Crypto price monitor: ${pricesSummary}${significantMoveDetected ? ' [MOVE DETECTED]' : ''}`);
        }

        if (significantMoveDetected && Object.keys(currentPrices).length > 0) {
          logger.info(`Crypto price monitor: significant move - ${moves.map(m => `${m.symbol} ${m.changePercent}%`).join(', ')}`);
          await orchestrator.dispatchEvent('crypto:significant_move', {
            prices: currentPrices,
            moves,
            timestamp: new Date(),
            source: 'price_monitor'
          });

          // If any move > 3%, dispatch high_volatility for faster arb scanning
          const highVolMoves = moves.filter(m => Math.abs(parseFloat(m.changePercent)) >= 3);
          if (highVolMoves.length > 0) {
            logger.info(`Crypto price monitor: HIGH VOLATILITY - ${highVolMoves.map(m => `${m.symbol} ${m.changePercent}%`).join(', ')}`);
            await orchestrator.dispatchEvent('crypto:high_volatility', {
              prices: currentPrices,
              moves: highVolMoves,
              timestamp: new Date(),
              source: 'price_monitor'
            });
          }
        }
      } catch (error) {
        logger.error('Crypto price monitor error:', error);
      }
    });

    // Crypto heartbeat - periodic trigger for time-based strategies (DCA) in flat markets
    this.agenda.define('crypto-heartbeat', async (job) => {
      try {
        const orchestrator = this.agent?.subAgentOrchestrator;
        if (!orchestrator) {
          logger.debug('Crypto heartbeat: orchestrator not ready, skipping');
          return;
        }

        const prices = {};
        if (this.cryptoPriceState) {
          for (const [network, data] of this.cryptoPriceState) {
            prices[network] = {
              price: data.price,
              symbol: data.symbol || network,
              source: 'chainlink',
              network,
              updatedAt: new Date(data.timestamp)
            };
          }
        }

        const pricesSummary = Object.entries(prices).map(([n, p]) => `${n}=$${p.price?.toFixed?.(2) || '?'}`).join(', ');
        logger.info(`Crypto heartbeat: dispatching periodic trigger${pricesSummary ? ` (${pricesSummary})` : ''}`);
        await orchestrator.dispatchEvent('crypto:heartbeat', {
          prices,
          timestamp: new Date(),
          source: 'heartbeat'
        });
      } catch (error) {
        logger.error('Crypto heartbeat error:', error);
      }
    });

    // MindSwarm engagement cycle — process notifications, auto-reply, daily post
    this.agenda.define('mindswarm-engagement', async (job) => {
      try {
        const apiManager = this.agent?.apiManager;
        if (!apiManager) return;
        const mindswarm = apiManager.apis?.get('mindswarm')?.instance;
        if (!mindswarm?.accessToken) return;
        if (!mindswarm._engagementConfig?.enabled) return;
        await mindswarm._engagementCycle();
      } catch (error) {
        logger.error('MindSwarm engagement cycle error:', error.message);
      }
    });

    // Twitter/X auto-posting — daily tweets from real agent activity
    this.agenda.define('twitter-engagement', async (job) => {
      try {
        const apiManager = this.agent?.apiManager;
        if (!apiManager) return;
        const twitter = apiManager.apis?.get('twitter')?.instance;
        if (!twitter?.hasWriteCredentials()) return;
        if (twitter._autoPostConfig?.enabled) await twitter._dailyAutoPost();
        if (twitter._engagementConfig?.enabled) await twitter._engagementCycle();
      } catch (error) {
        logger.error('Twitter engagement error:', error.message);
      }
    });

    // Server maintenance heartbeat - hourly check of goliath server
    this.agenda.define('maintenance-heartbeat', async (job) => {
      try {
        const orchestrator = this.agent?.subAgentOrchestrator;
        if (!orchestrator) {
          logger.debug('Maintenance heartbeat: orchestrator not ready, skipping');
          return;
        }

        logger.info('Maintenance heartbeat: dispatching maintenance:heartbeat');
        await orchestrator.dispatchEvent('maintenance:heartbeat', {
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Maintenance heartbeat error:', error);
      }
    });

    // Daily crypto P&L report
    this.agenda.define('crypto-daily-report', async (job) => {
      try {
        const orchestrator = this.mainAgent?.subAgentOrchestrator;
        if (!orchestrator) return;

        const { SubAgent } = await import('../models/SubAgent.js');
        const agents = await SubAgent.find({ domain: 'crypto' });
        if (!agents.length) return;

        const handler = orchestrator.agentHandlers.get(agents[0]._id.toString());
        if (!handler?.sendDailyPnLReport) return;

        await handler.sendDailyPnLReport();
      } catch (error) {
        logger.error('Crypto daily report error:', error);
      }
    });

    // Skynet staking yield — check on-chain reward epoch and fund new epochs from ledger
    this.agenda.define('skynet-staking-yield', async (job) => {
      logger.info('Running Skynet staking epoch check...');
      try {
        const stakingService = (await import('../services/crypto/skynetStakingService.js')).default;
        if (!stakingService.isAvailable()) {
          await stakingService.initialize();
        }
        if (!stakingService.isAvailable()) {
          logger.info('Staking contract not configured, skipping epoch check');
          return;
        }

        const stats = await stakingService.getContractStats();
        if (!stats.available) return;

        const ONE_DAY = 86400;

        // If reward period ending within 1 day, fund a new epoch from the ledger
        if (stats.timeUntilEnd < ONE_DAY) {
          const SkynetTokenLedger = (await import('../models/SkynetTokenLedger.js')).default;
          const stakingEntry = await SkynetTokenLedger.findOne({ category: 'staking' });

          if (!stakingEntry || stakingEntry.amount <= 0) {
            logger.info('Staking ledger pool empty, cannot fund new epoch');
            return;
          }

          // Fund 0.1% of remaining pool for next epoch
          const weeklyYieldRate = 0.001;
          const fundAmount = Math.max(1, stakingEntry.amount * weeklyYieldRate);

          try {
            const result = await stakingService.fundRewards(fundAmount);
            stakingEntry.amount -= fundAmount;
            await stakingEntry.save();

            logger.info(`Funded new staking epoch: ${fundAmount.toFixed(2)} SKYNET on-chain (pool remaining: ${stakingEntry.amount.toFixed(0)}), tx=${result.txHash}`);

            if (this.agent?.emit) {
              this.agent.emit('skynet:staking_yield', {
                type: 'epoch_funded',
                amount: parseFloat(fundAmount.toFixed(2)),
                txHash: result.txHash,
                poolRemaining: stakingEntry.amount
              });
            }
          } catch (fundError) {
            logger.error('Failed to fund staking epoch on-chain:', fundError);
          }
        } else {
          logger.info(`Staking epoch active: ${Math.floor(stats.timeUntilEnd / 3600)}h remaining, ${stats.totalStaked.toFixed(0)} SKYNET staked, APY ${stats.apy}%`);
        }

        // Peer scoring for off-chain trust/priority (separate from on-chain rewards)
        try {
          const { P2PPeer } = await import('../models/P2PPeer.js');
          const trustedPeers = await P2PPeer.find({ trustLevel: 'trusted', skynetBalance: { $gt: 0 } });

          for (const peer of trustedPeers) {
            if (peer.walletAddress) {
              const peerStake = await stakingService.verifyPeerStake(peer.walletAddress);
              if (peerStake.verified) {
                peer.onChainStake = peerStake.amount;
                peer.onChainStakeVerifiedAt = new Date();
                await peer.save();
              }
            }
          }
        } catch (peerErr) {
          logger.debug('Peer stake verification during epoch check:', peerErr.message);
        }
      } catch (error) {
        logger.error('Skynet staking yield error:', error);
      }
    });

    // Skynet staking auto-claim — daily check for pending rewards
    this.agenda.define('skynet-staking-autoclaim', async (job) => {
      try {
        const stakingService = (await import('../services/crypto/skynetStakingService.js')).default;
        if (!stakingService.isAvailable()) await stakingService.initialize();
        if (!stakingService.isAvailable()) return;

        const info = await stakingService.getFullStakeInfo();
        if (!info.available || info.pendingRewards <= 0) return;

        // Auto-claim if pending rewards exceed threshold (100 SKYNET)
        const CLAIM_THRESHOLD = 100;
        if (info.pendingRewards >= CLAIM_THRESHOLD) {
          const result = await stakingService.claimRewards();
          logger.info(`Auto-claimed ${info.pendingRewards.toFixed(2)} SKYNET staking rewards: tx=${result.txHash}`);

          if (this.agent?.emit) {
            this.agent.emit('skynet:staking_autoclaim', {
              amount: info.pendingRewards,
              txHash: result.txHash
            });
          }
        } else {
          logger.debug(`Staking rewards below threshold: ${info.pendingRewards.toFixed(2)} < ${CLAIM_THRESHOLD}`);
        }
      } catch (error) {
        logger.error('Skynet staking auto-claim error:', error);
      }
    });

    // Skynet LP staking auto-claim, auto re-stake, and reward compounding
    this.agenda.define('skynet-lp-staking-autoclaim', async (job) => {
      try {
        const stakingService = (await import('../services/crypto/skynetStakingService.js')).default;
        if (!stakingService.isAvailable()) await stakingService.initialize();
        if (!stakingService.isAvailable()) return;

        const info = await stakingService.getLPStakeInfo();
        if (!info) return;

        // Configurable per instance via SystemSettings (defaults for any LANAgent instance)
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const lpClaimThreshold = parseFloat(await SystemSettings.getSetting('lp_staking_claim_threshold')) || 100;
        const lpRestakeTier = parseInt(await SystemSettings.getSetting('lp_staking_restake_tier')) || 3;
        const skynetStakeThreshold = parseFloat(await SystemSettings.getSetting('skynet_compound_threshold')) || 500;
        const skynetReserve = parseFloat(await SystemSettings.getSetting('skynet_wallet_reserve')) || 100000;

        const LP_CLAIM_THRESHOLD = lpClaimThreshold;
        const LP_RESTAKE_TIER = lpRestakeTier;
        const SKYNET_STAKE_THRESHOLD = skynetStakeThreshold;

        // 1. Auto re-stake LP if lock expired and LP tokens are unstaked
        if (info.stakedAmount > 0 && !info.locked && info.lockExpiry && Date.now() / 1000 > info.lockExpiry) {
          // Lock expired — claim rewards first, then unstake and re-stake to reset the lock tier
          logger.info(`LP lock expired — re-staking ${info.stakedAmount.toFixed(4)} LP at Tier ${LP_RESTAKE_TIER}`);
          try {
            // Claim any pending rewards before re-staking
            if (info.pendingRewards >= LP_CLAIM_THRESHOLD) {
              const claimResult = await stakingService.claimLPRewards();
              logger.info(`Auto-claimed ${info.pendingRewards.toFixed(2)} SKYNET before LP re-stake: tx=${claimResult.txHash}`);
            }
            // Unstake all LP
            const unstakeResult = await stakingService.unstakeLP(info.stakedAmount.toString());
            logger.info(`Unstaked ${info.stakedAmount.toFixed(4)} LP: tx=${unstakeResult.txHash}`);
            // Re-stake at highest tier
            const restakeResult = await stakingService.stakeLP(info.stakedAmount.toString(), LP_RESTAKE_TIER);
            logger.info(`Re-staked ${info.stakedAmount.toFixed(4)} LP at Tier ${LP_RESTAKE_TIER}: tx=${restakeResult.txHash}`);

            try {
              const mongoose = (await import('mongoose')).default;
              const HistoricalTransaction = mongoose.model('HistoricalTransaction');
              await new HistoricalTransaction({
                transactionType: 'lpStakingRestake',
                category: 'staking',
                amount: info.stakedAmount,
                txHash: restakeResult.txHash,
                network: 'bsc',
                description: `Auto re-staked ${info.stakedAmount.toFixed(4)} LP at Tier ${LP_RESTAKE_TIER} (180 days, 3x)`
              }).save();
            } catch { /* non-critical */ }

            if (this.agent?.emit) {
              this.agent.emit('skynet:lp_restake', { amount: info.stakedAmount, tier: LP_RESTAKE_TIER, txHash: restakeResult.txHash });
            }
            return; // Done for this cycle — rewards already claimed
          } catch (restakeErr) {
            logger.error('LP re-stake failed:', restakeErr.message || restakeErr);
          }
        }

        // 2. Auto-claim LP staking rewards
        if (info.stakedAmount > 0 && info.pendingRewards >= LP_CLAIM_THRESHOLD) {
          const result = await stakingService.claimLPRewards();
          logger.info(`Auto-claimed ${info.pendingRewards.toFixed(2)} SKYNET LP staking rewards: tx=${result.txHash}`);

          try {
            const mongoose = (await import('mongoose')).default;
            const HistoricalTransaction = mongoose.model('HistoricalTransaction');
            await new HistoricalTransaction({
              transactionType: 'lpStakingClaim',
              category: 'staking',
              amount: info.pendingRewards,
              txHash: result.txHash,
              network: 'bsc',
              description: `Auto-claimed ${info.pendingRewards.toFixed(2)} SKYNET LP staking rewards`
            }).save();
          } catch { /* non-critical */ }

          if (this.agent?.emit) {
            this.agent.emit('skynet:lp_staking_autoclaim', { amount: info.pendingRewards, txHash: result.txHash });
          }
        }

        // 3. Compound: stake claimed SKYNET rewards in regular staking pool
        try {
          const { ethers } = await import('ethers');
          const contractServiceWrapper = (await import('../services/crypto/contractServiceWrapper.js')).default;
          const provider = await contractServiceWrapper.getProvider('bsc');
          const walletService = (await import('../services/crypto/walletService.js')).default;
          const walletInfo = await walletService.getWalletInfo();
          const walletAddr = walletInfo?.addresses?.find(a => a.chain === 'bsc')?.address;
          if (!walletAddr) return;

          const skynetAddress = await SystemSettings.getSetting('skynet_token_address') || '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
          const skynetToken = new ethers.Contract(
            skynetAddress,
            ['function balanceOf(address) view returns (uint256)'],
            provider
          );
          const balance = Number(ethers.formatEther(await skynetToken.balanceOf(walletAddr)));

          // Keep a reserve liquid for operations (configurable per instance)
          const SKYNET_RESERVE = skynetReserve;
          const stakeableAmount = balance - SKYNET_RESERVE;

          if (stakeableAmount >= SKYNET_STAKE_THRESHOLD) {
            const stakeInfo = await stakingService.getFullStakeInfo();
            // Only stake if not already locked (to avoid tier conflicts)
            if (stakeInfo.available && (!stakeInfo.locked || stakeInfo.lockExpiry < Date.now() / 1000)) {
              const stakeResult = await stakingService.stake(Math.floor(stakeableAmount).toString(), 0); // Tier 0 (no lock) for flexibility
              logger.info(`Compounded ${Math.floor(stakeableAmount).toLocaleString()} SKYNET into regular staking: tx=${stakeResult.txHash}`);

              try {
                const mongoose = (await import('mongoose')).default;
                const HistoricalTransaction = mongoose.model('HistoricalTransaction');
                await new HistoricalTransaction({
                  transactionType: 'stakingCompound',
                  category: 'staking',
                  amount: stakeableAmount,
                  txHash: stakeResult.txHash,
                  network: 'bsc',
                  description: `Compounded ${Math.floor(stakeableAmount).toLocaleString()} SKYNET from LP rewards into regular staking`
                }).save();
              } catch { /* non-critical */ }
            }
          }
        } catch (compoundErr) {
          logger.debug('SKYNET reward compounding (non-fatal):', compoundErr.message || compoundErr);
        }

        // 4. Check for unstaked LP tokens in wallet and auto-stake them
        try {
          if (info.walletBalance > 0) {
            logger.info(`Found ${info.walletBalance.toFixed(4)} unstaked LP tokens in wallet — auto-staking at Tier ${LP_RESTAKE_TIER}`);
            const stakeResult = await stakingService.stakeLP(info.walletBalance.toString(), LP_RESTAKE_TIER);
            logger.info(`Auto-staked ${info.walletBalance.toFixed(4)} new LP tokens: tx=${stakeResult.txHash}`);

            if (this.agent?.emit) {
              this.agent.emit('skynet:lp_autostake', { amount: info.walletBalance, tier: LP_RESTAKE_TIER, txHash: stakeResult.txHash });
            }
          }
        } catch (autoStakeErr) {
          logger.debug('LP auto-stake (non-fatal):', autoStakeErr.message || autoStakeErr);
        }
      } catch (error) {
        logger.error('Skynet LP staking auto-claim error:', error.message || error);
      }
    });

    // SkynetVault compound — triggers auto-compound for all vault users (earns bounty)
    this.agenda.define('skynet-vault-compound', async (job) => {
      try {
        const stakingService = (await import('../services/crypto/skynetStakingService.js')).default;
        if (!stakingService.isAvailable()) await stakingService.initialize();
        if (!stakingService.isAvailable()) return;

        const vaultAddr = await stakingService.getVaultAddress();
        if (!vaultAddr) return; // Vault not configured

        const stats = await stakingService.getVaultStats();
        if (!stats || stats.paused) return;

        // Compound regular staking if there are pending rewards
        if (stats.pendingRewards > 10) {
          try {
            const result = await stakingService.vaultCompound();
            logger.info(`Vault compound: claimed+restaked for ${stats.stakerCount} users, tx=${result.txHash}`);
          } catch (e) {
            logger.debug('Vault compound (non-fatal):', e.message || e);
          }
        }

        // Compound LP staking if there are pending LP rewards
        if (stats.pendingLPRewards > 10) {
          try {
            const result = await stakingService.vaultCompoundLP();
            logger.info(`Vault LP compound: claimed+restaked for ${stats.lpStakerCount} users, tx=${result.txHash}`);
          } catch (e) {
            logger.debug('Vault LP compound (non-fatal):', e.message || e);
          }
        }
      } catch (error) {
        logger.error('Skynet vault compound error:', error.message || error);
      }
    });

    // Scammer registry fee auto-pricer — anchors the on-chain flag fee to a USD
    // target via the shared SKYNET/USD oracle. Silently no-ops on non-genesis
    // instances and skips when drift is within tolerance. See
    // docs/proposals/scammer-fee-auto-pricing.md for the design.
    this.agenda.define('skynet-auto-price-fee', async (job) => {
      try {
        const scammerRegistryService = (await import('../services/crypto/scammerRegistryService.js')).default;
        if (!scammerRegistryService.isAvailable()) await scammerRegistryService.initialize();
        if (!scammerRegistryService.isAvailable()) return;

        const result = await scammerRegistryService.autoUpdateScammerFee();
        if (result.ran) {
          logger.info(`Auto-priced scammer fee: ${result.target.toLocaleString()} SKYNET (≈$${result.targetUsd}), tx=${result.txHash}`);
          if (this.agent?.emit) {
            this.agent.emit('skynet:fee_repriced', { type: 'reportFee', ...result });
          }
        } else {
          logger.debug(`Scammer fee auto-price skipped: ${result.reason}`);
        }
      } catch (error) {
        logger.error('Skynet scammer fee auto-price error:', error.message || error);
      }
    });

    // Immunity threshold auto-pricer — same shape as the fee auto-pricer above,
    // updates the SKYNET amount required to qualify for immunity (Factor 2 of
    // the 2-of-3 immunity check) so it tracks a USD target as SKYNET drifts.
    this.agenda.define('skynet-auto-price-immunity', async (job) => {
      try {
        const scammerRegistryService = (await import('../services/crypto/scammerRegistryService.js')).default;
        if (!scammerRegistryService.isAvailable()) await scammerRegistryService.initialize();
        if (!scammerRegistryService.isAvailable()) return;

        const result = await scammerRegistryService.autoUpdateImmunityThreshold();
        if (result.ran) {
          logger.info(`Auto-priced immunity threshold: ${result.target.toLocaleString()} SKYNET (≈$${result.targetUsd}), tx=${result.txHash}`);
          if (this.agent?.emit) {
            this.agent.emit('skynet:fee_repriced', { type: 'immunityThreshold', ...result });
          }
        } else {
          logger.debug(`Immunity threshold auto-price skipped: ${result.reason}`);
        }
      } catch (error) {
        logger.error('Skynet immunity threshold auto-price error:', error.message || error);
      }
    });

    // WireGuard tunnel watchdog — checks handshake age and peer reachability
    // every 2 minutes. Auto-bounces (wg-quick down/up) if the tunnel is stale
    // or unreachable. The PostUp hooks in wg0.conf re-add the static route and
    // iptables exception for ExpressVPN coexistence automatically.
    this.agenda.define('vpn-wireguard-watchdog', async (job) => {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Skip entirely if WireGuard isn't installed or no wg0 config exists.
        // Avoids spamming "bounce failed" every 2 minutes on hosts (e.g. Docker
        // beta) where WG was never set up.
        if (this._wgWatchdogDisabled) return;
        try {
          await execAsync('command -v wg-quick >/dev/null && test -f /etc/wireguard/wg0.conf');
        } catch {
          if (!this._wgWatchdogLogged) {
            logger.info('WireGuard watchdog: wg-quick or /etc/wireguard/wg0.conf not present — disabling');
            this._wgWatchdogLogged = true;
          }
          this._wgWatchdogDisabled = true;
          return;
        }

        // Quick check: is wg0 up and has a recent handshake?
        let handshakeAge = null;
        try {
          const { stdout } = await execAsync('wg show wg0 latest-handshakes');
          const epoch = parseInt(stdout.split('\t')[1]);
          if (epoch > 0) handshakeAge = Math.floor(Date.now() / 1000) - epoch;
        } catch {
          // wg0 interface not up
          handshakeAge = Infinity;
        }

        // Also ping the peer
        let peerReachable = false;
        try {
          await execAsync('ping -c1 -W3 10.8.0.1 2>&1');
          peerReachable = true;
        } catch { /* unreachable */ }

        const MAX_AGE = 180; // 3 minutes (keepalive is 25s, so >3min = dead)
        const healthy = peerReachable && handshakeAge !== null && handshakeAge < MAX_AGE;

        if (healthy) return; // silent no-op when healthy

        const reason = handshakeAge === Infinity
          ? 'interface_down'
          : !peerReachable
            ? 'peer_unreachable'
            : `handshake_stale_${handshakeAge}s`;

        logger.warn(`WireGuard watchdog: tunnel unhealthy (${reason}) — bouncing wg0`);

        try {
          await execAsync('wg-quick down wg0 2>&1').catch(() => {});
          await new Promise(r => setTimeout(r, 2000));
          await execAsync('wg-quick up wg0 2>&1');
          await new Promise(r => setTimeout(r, 6000));

          // Verify recovery
          let recovered = false;
          try {
            await execAsync('ping -c1 -W3 10.8.0.1 2>&1');
            recovered = true;
          } catch { /* still down */ }

          if (recovered) {
            logger.info('WireGuard watchdog: tunnel recovered after bounce');
          } else {
            logger.error('WireGuard watchdog: tunnel still down after bounce');
          }
        } catch (bounceErr) {
          logger.error('WireGuard watchdog: bounce failed:', bounceErr.message);
        }
      } catch (error) {
        logger.error('WireGuard watchdog error:', error.message || error);
      }
    });

    // ENS auto-renewal — check expiry and renew if within 30 days
    this.agenda.define('ens-renewal-check', async (job) => {
      try {
        const ensService = (await import('../services/crypto/ensService.js')).default;
        if (!ensService.isAvailable()) await ensService.initialize();
        if (!ensService.isAvailable()) return;

        const result = await ensService.checkAndRenew();
        if (result.renewed && result.renewed.length > 0) {
          logger.info(`ENS auto-renewal: renewed ${result.renewed.length} name(s)`);
          if (this.agent?.emit) {
            this.agent.emit('ens:renewed', { renewed: result.renewed });
          }
        } else {
          logger.debug(`ENS renewal check: ${result.baseName?.daysUntilExpiry ?? '?'} days until expiry`);
        }

        // Also retry any pending subname requests (e.g., after receiving funds)
        await ensService.retryPendingSubnameRequest();
      } catch (error) {
        logger.error('ENS renewal check error:', error);
      }
    });

    // Trust registry scammer sync - syncs scammer registry entries to on-chain trust registry
    this.agenda.define('trust-scammer-sync', async (job) => {
      try {
        const trustRegistryService = (await import('./crypto/trustRegistryService.js')).default;
        if (!trustRegistryService) {
          logger.debug('Trust registry service not available, skipping scammer sync');
          return;
        }
        const result = await trustRegistryService.runScammerSyncIfNeeded();
        if (result?.synced) {
          logger.info(`Trust registry scammer sync completed: ${result.count} scammers synced`, { service: 'trust-registry' });
        } else {
          logger.debug('Trust registry scammer sync skipped (not needed yet)', { service: 'trust-registry' });
        }
      } catch (error) {
        logger.error('Trust registry scammer sync error:', error, { service: 'trust-registry' });
      }
    });

    // System maintenance
    this.agenda.define('system-maintenance', async (job) => {
      logger.info('Running system maintenance...');
      this.lastMaintenance = new Date();
      this.saveActivityTimestamps(); // Persist to database

      try {
        // Clean up old logs
        const logsDir = './logs';
        const { readdir, stat, unlink } = await import('fs/promises');
        const files = await readdir(logsDir);
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        
        for (const file of files) {
          const filePath = `${logsDir}/${file}`;
          const stats = await stat(filePath);
          
          if (now - stats.mtime.getTime() > maxAge && file.includes('.log.')) {
            await unlink(filePath);
            logger.info(`Deleted old log file: ${file}`);
          }
        }
        
        // Save system stats
        await this.saveSystemStats();

        // Clean up expired device aliases
        try {
          const { DeviceAlias } = await import('../models/DeviceAlias.js');
          await DeviceAlias.cleanupExpiredAliases();
        } catch (aliasErr) {
          logger.error('Expired alias cleanup error:', aliasErr);
        }

      } catch (error) {
        logger.error('System maintenance error:', error);
      }
    });
    
    // Auto-archive AutoAccount entries that have been inactive past their
    // archiveAfterDays threshold. Persists across restarts via Agenda
    // (in-process timers in the model would not).
    this.agenda.define('auto-account-archive', async (job) => {
      try {
        const { default: AutoAccount } = await import('../models/AutoAccount.js');
        const inactivityMs = 30 * 24 * 60 * 60 * 1000; // 30 days
        await AutoAccount.archiveInactiveAccounts(inactivityMs);
      } catch (error) {
        logger.error('Auto-account archive error:', error);
      }
    });

    // System status report (frequency configurable)
    this.agenda.define('system-status-report', async (job) => {
      logger.info('🔄 System status report job started...');
      this.lastWeeklyReport = new Date();
      
      try {
        logger.info('📊 Generating system status report data...');
        const { report, reportData } = await this.generateWeeklyReport();
        logger.info('💾 Saving report to database...');
        await this.saveReportToDatabase(reportData, 'scheduled');
        logger.info('📤 Sending system status report notification...');
        await this.agent.notify(report);
        logger.info('✅ System status report completed successfully');
      } catch (error) {
        logger.error('❌ Weekly report error:', error);
        // Try to notify about the error
        try {
          await this.agent.notify(`❌ Weekly report failed: ${error.message}`);
        } catch (notifyError) {
          logger.error('Failed to notify about weekly report error:', notifyError);
        }
      }
    });
    
    // Model updates
    this.agenda.define('model-update', async (job) => {
      logger.info('Checking for model updates...');
      this.lastModelUpdate = new Date();

      try {
        const { ModelUpdaterService } = await import('./modelUpdater.js');
        const updater = new ModelUpdaterService(this.agent);
        const results = await updater.updateAllProviders();

        const updated = results.success || [];
        if (updated.length > 0) {
          logger.info(`Model update: refreshed ${updated.join(', ')}`);
          for (const prov of updated) {
            try { await updater.updateProviderConfiguration(prov); } catch {}
          }
          if (this.agent.providerManager) {
            await this.agent.providerManager.syncModelsWithDatabase();
          }
        }
        if (results.failed?.length > 0) {
          logger.warn(`Model update: failed for ${results.failed.map(f => f.provider || f).join(', ')}`);
        }

        // Validate saved model configs — reset to defaults if retired (404)
        try {
          const { Agent } = await import('../models/Agent.js');
          const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
          const configs = agentData?.aiProviders?.configurations || {};
          const pm = this.agent.providerManager;
          if (!pm) return;

          const defaultModels = {
            anthropic: 'claude-opus-4-5-20251101',
            openai: 'gpt-4o'
          };

          for (const [provName, defaults] of Object.entries(defaultModels)) {
            const savedModel = configs[provName]?.model || configs[provName]?.chatModel;
            if (!savedModel) continue;
            const provider = pm.providers.get(provName);
            if (!provider) continue;

            // Check if saved model is still valid by checking available models
            const available = provider.getAvailableModels ? provider.getAvailableModels() : [];
            if (available.length > 0 && !available.includes(savedModel)) {
              logger.warn(`Model ${savedModel} for ${provName} is no longer available — resetting to ${defaults}`);
              await Agent.updateOne(
                { name: process.env.AGENT_NAME || 'LANAgent' },
                { $set: { [`aiProviders.configurations.${provName}.model`]: defaults } }
              );
              // Also update the live provider
              if (provider.models) provider.models.chat = defaults;
            }
          }
        } catch (valErr) {
          logger.debug('Model validation (non-fatal):', valErr.message);
        }
      } catch (error) {
        logger.error('Model update check error:', error);
      }
    });

    // Daily bug scan
    this.agenda.define('daily-bug-scan', async (job) => {
      try {
        logger.info('Running daily automated bug scan...');
        this.lastDailyBugScan = new Date();
        this.saveActivityTimestamps(); // Persist to database
        
        const bugDetectorPlugin = this.apiManager.getPlugin('bugDetector');
        if (!bugDetectorPlugin || !bugDetectorPlugin.enabled) {
          logger.debug('Bug detector plugin not available or disabled');
          return;
        }
        
        // Get plugin settings
        const settingsResult = await bugDetectorPlugin.execute({ action: 'getSettings' });
        const settings = settingsResult.success ? settingsResult.settings : {};
        
        if (!settings.dailyScanEnabled) {
          logger.info('Daily bug scan is disabled in settings');
          return;
        }
        
        // Perform daily scan
        const scanResult = await bugDetectorPlugin.execute({ action: 'scanDaily' });
        
        if (scanResult.success) {
          const { bugsFound, summary, scanDuration } = scanResult;
          const bugCount = bugsFound?.length || 0;
          
          logger.info(`Daily bug scan completed: ${bugCount} issues found in ${scanDuration}ms`);
          
          // Notify if critical bugs found
          if (summary?.critical > 0) {
            await this.agent.notify(`🚨 Daily bug scan found ${summary.critical} critical issues! Check the bug tracker for details.`);
          } else if (bugCount > 0) {
            await this.agent.notify(`🐛 Daily bug scan found ${bugCount} potential issues (${summary?.high || 0} high, ${summary?.medium || 0} medium, ${summary?.low || 0} low priority)`);
          }
          
          // Update last scan time
          await bugDetectorPlugin.execute({
            action: 'updateSettings',
            lastScan: new Date().toISOString()
          });
        } else {
          logger.error('Daily bug scan failed:', scanResult.error);
          await this.agent.notify(`❌ Daily bug scan failed: ${scanResult.error}`);
        }
        
      } catch (error) {
        logger.error('Daily bug scan error:', error);
        await this.agent.notify(`❌ Daily bug scan error: ${error.message}`);
      }
    });

    // GitHub feature discovery job - runs twice daily to discover features from similar projects
    this.agenda.define('github-discovery', async (job) => {
      try {
        logger.info('🔍 Running GitHub feature discovery...');
        this.lastGitHubDiscovery = new Date();
        this.saveActivityTimestamps(); // Persist to database
        
        // Import the discovery service
        const { GitHubFeatureDiscovery } = await import('./githubFeatureDiscovery.js');
        const { DiscoveredFeature } = await import('../models/DiscoveredFeature.js');
        
        // Initialize discovery
        const discovery = new GitHubFeatureDiscovery(this.agent, process.env.GIT_PERSONAL_ACCESS_TOKEN);
        
        // Run discovery
        const features = await discovery.discoverFeaturesFromGitHub();
        logger.info(`Discovered ${features.length} features from GitHub`);
        
        // Store features in database
        let newFeaturesCount = 0;
        for (const feature of features) {
          try {
            // Create feature data
            const featureData = {
              title: feature.description,
              description: `Auto-discovered from GitHub project ${feature.source}.\n\nImplementation suggestion: ${feature.implementation}\n\nSource: ${feature.sourceUrl}`,
              type: feature.type || 'readme_feature',
              source: {
                repository: feature.source,
                url: feature.sourceUrl,
                filePath: feature.githubReference?.filePath,
                language: feature.githubReference?.language
              },
              implementation: {
                suggestion: feature.implementation,
                confidence: feature.confidence || 'medium',
                targetFile: null, // Will be determined later
                estimatedEffort: 'medium'
              },
              status: 'discovered',
              discoveredBy: 'github_discovery_scheduler',
              tags: ['github', 'discovered', feature.type]
            };
            
            // Add code snippets if available
            if (feature.githubReference && feature.githubReference.codeSnippet) {
              featureData.codeSnippets = [{
                code: feature.githubReference.codeSnippet.substring(0, 10000), // Ensure within limit
                language: feature.githubReference.language,
                filePath: feature.githubReference.filePath,
                contextNotes: feature.githubReference.contextNotes
              }];
            }
            
            try {
              await DiscoveredFeature.create(featureData);
              newFeaturesCount++;
            } catch (err) {
              if (err.code === 11000) {
                logger.debug(`Feature already exists: ${feature.description}`);
              } else {
                throw err;
              }
            }
          } catch (error) {
            logger.error(`Failed to store feature: ${error.message}`);
          }
        }
        
        if (newFeaturesCount > 0) {
          await this.agent.notify(`🌟 GitHub Discovery: Found ${newFeaturesCount} new features from analyzing similar AI agent projects!`);
        }
        
        logger.info(`GitHub discovery completed: ${newFeaturesCount} new features stored`);
      } catch (error) {
        logger.error('GitHub discovery job failed:', error);
      }
    });

    // Bug fixing job - runs twice daily to automatically fix GitHub issues
    this.agenda.define('bug-fixing', async (job) => {
      try {
        logger.info('Running bug fixing session...');
        this.lastBugFixing = new Date();
        this.saveActivityTimestamps(); // Persist to database
        
        // Check if bug fixing is enabled
        if (!this.agent.bugFixing?.enabled) {
          logger.debug('Bug fixing service is disabled');
          return;
        }
        
        // Run the bug fixing session
        await this.agent.bugFixing.runBugFixingSession();
        
        logger.info('Bug fixing session completed successfully');
      } catch (error) {
        logger.error('Bug fixing job failed:', error);
        await this.agent.notify(`❌ Bug fixing session failed: ${error.message}`);
      }
    });

    // Cleanup old completed reminder jobs
    this.agenda.define('cleanup-old-reminders', async (job) => {
      try {
        const cutoffDate = new Date();
        cutoffDate.setMinutes(cutoffDate.getMinutes() - 10); // Remove reminders completed more than 10 minutes ago
        
        // Find ALL reminder jobs that have finished (successful or failed)
        const completedJobs = await this.agenda.jobs({
          name: 'reminder',
          $or: [
            { 'lastFinishedAt': { $exists: true } }, // Successfully completed
            { 'failedAt': { $exists: true } }        // Failed jobs
          ]
        });

        logger.info(`Found ${completedJobs.length} reminder jobs to evaluate for cleanup`);
        
        let cleanedCount = 0;
        for (const reminderJob of completedJobs) {
          const attrs = reminderJob.attrs;
          const lastFinished = attrs.lastFinishedAt;
          const failed = attrs.failedAt;
          
          // If job has finished or failed and it was more than 10 minutes ago
          const hasCompleted = lastFinished && lastFinished < cutoffDate;
          const hasFailed = failed && failed < cutoffDate;
          
          if (hasCompleted || hasFailed) {
            try {
              await reminderJob.remove();
              cleanedCount++;
              logger.debug(`Removed old reminder job: ${attrs._id}`);
            } catch (removeError) {
              logger.error(`Failed to remove reminder job ${attrs._id}:`, removeError);
            }
          }
        }
        
        // Clean up old instances of the cleanup job itself
        const oldCleanupJobs = await this.agenda.jobs({
          name: 'cleanup-old-reminders',
          $or: [
            { 'lastFinishedAt': { $exists: true } }, // Successfully completed
            { 'failedAt': { $exists: true } }        // Failed jobs
          ]
        });
        
        logger.debug(`Found ${oldCleanupJobs.length} cleanup jobs to evaluate for self-cleanup`);
        
        let selfCleanedCount = 0;
        for (const cleanupJob of oldCleanupJobs) {
          const attrs = cleanupJob.attrs;
          const lastFinished = attrs.lastFinishedAt;
          const failed = attrs.failedAt;
          
          // Skip the current job
          if (attrs._id.toString() === job.attrs._id.toString()) {
            continue;
          }
          
          // If job has finished or failed and it was more than 10 minutes ago
          const hasCompleted = lastFinished && lastFinished < cutoffDate;
          const hasFailed = failed && failed < cutoffDate;
          
          if (hasCompleted || hasFailed) {
            try {
              await cleanupJob.remove();
              selfCleanedCount++;
              logger.debug(`Removed old cleanup job: ${attrs._id}`);
            } catch (removeError) {
              logger.error(`Failed to remove cleanup job ${attrs._id}:`, removeError);
            }
          }
        }
        
        const totalCleaned = cleanedCount + selfCleanedCount;
        if (totalCleaned > 0) {
          logger.info(`Successfully cleaned up ${cleanedCount} old reminder jobs and ${selfCleanedCount} old cleanup jobs`);
        } else {
          logger.info('No old jobs found to clean up');
        }
      } catch (error) {
        logger.error('Reminder cleanup job failed:', error);
      }
    });

    // General cleanup for ALL completed jobs (not just reminders)
    this.agenda.define('cleanup-completed-jobs', async (job) => {
      try {
        this.lastCleanupJobs = new Date();
        const cutoffDate = new Date();
        cutoffDate.setMinutes(cutoffDate.getMinutes() - 30); // Remove jobs completed more than 30 minutes ago
        
        // Find ALL jobs that have finished (successful or failed)
        // For cleanup-completed-jobs, use a shorter cutoff time to prevent accumulation
        const cleanupCutoff = new Date();
        cleanupCutoff.setMinutes(cleanupCutoff.getMinutes() - 5); // 5 minutes for cleanup jobs
        
        const completedJobs = await this.agenda.jobs({
          $or: [
            { 
              'lastFinishedAt': { $exists: true },
              'lastFinishedAt': { $lt: cutoffDate },
              'name': { $ne: 'cleanup-completed-jobs' }
            },
            { 
              'failedAt': { $exists: true },
              'failedAt': { $lt: cutoffDate },
              'name': { $ne: 'cleanup-completed-jobs' }
            },
            // Special handling for cleanup-completed-jobs to prevent accumulation
            {
              'name': 'cleanup-completed-jobs',
              'lastFinishedAt': { $exists: true },
              'lastFinishedAt': { $lt: cleanupCutoff },
              'type': { $ne: 'single' } // Don't remove the recurring one
            }
          ]
        });

        logger.info(`Found ${completedJobs.length} completed jobs to evaluate for cleanup`);
        
        const jobTypeCounts = {};
        let totalRemoved = 0;
        
        for (const completedJob of completedJobs) {
          const attrs = completedJob.attrs;
          const jobName = attrs.name;
          
          // Skip the current job and any recurring jobs
          if (attrs._id.toString() === job.attrs._id.toString() || 
              attrs.repeatInterval || 
              attrs.repeatAt) {
            continue;
          }
          
          try {
            await completedJob.remove();
            totalRemoved++;
            jobTypeCounts[jobName] = (jobTypeCounts[jobName] || 0) + 1;
          } catch (removeError) {
            logger.error(`Failed to remove ${jobName} job ${attrs._id}:`, removeError);
          }
        }
        
        if (totalRemoved > 0) {
          const summary = Object.entries(jobTypeCounts)
            .map(([name, count]) => `${name}: ${count}`)
            .join(', ');
          logger.info(`Successfully cleaned up ${totalRemoved} completed jobs (${summary})`);
        } else {
          logger.info('No completed jobs found to clean up');
        }
      } catch (error) {
        logger.error('Completed jobs cleanup failed:', error);
      }
    });

    // Scheduled email sender
    this.agenda.define('send-scheduled-email', async (job) => {
      const { to, subject, text, body, html, plugin } = job.attrs.data;
      
      logger.info(`Processing scheduled email to ${to}`);
      
      try {
        const emailPlugin = this.agent.apiManager.getPlugin('email');
        if (!emailPlugin) {
          throw new Error('Email plugin not available');
        }
        
        const result = await emailPlugin.execute({
          action: 'send',
          to: to,
          subject: subject,
          text: text || body || '', // Support both 'text' and 'body' for backward compatibility
          html: html
        });
        
        if (result.success) {
          logger.info(`Scheduled email sent successfully to ${to}`);
        } else {
          logger.error(`Failed to send scheduled email: ${result.error}`);
          throw new Error(result.error || 'Unknown error');
        }
        
      } catch (error) {
        logger.error('Error processing scheduled email:', error);
        throw error;
      }
    });

    // Monthly AI provider stats archive - runs at midnight on 1st of each month
    this.agenda.define('monthly-stats-archive', async (job) => {
      try {
        logger.info('📊 Running monthly AI provider stats archive...');

        const { ProviderStatsArchive } = await import('../models/ProviderStatsArchive.js');
        const { TokenUsage } = await import('../models/TokenUsage.js');

        // Create archive for the previous month
        const archive = await ProviderStatsArchive.createArchive('auto', 'Monthly automatic archive');

        // Clear the TokenUsage collection after successful archive
        const deleteResult = await TokenUsage.deleteMany({});

        // Reset in-memory metrics for all providers
        const providers = this.agent.providerManager?.providers;
        if (providers) {
          for (const [key, provider] of providers) {
            if (provider.resetMetrics) {
              provider.resetMetrics();
            }
          }
        }

        const period = `${archive.year}-${String(archive.month).padStart(2, '0')}`;
        logger.info(`Monthly stats archived for ${period}: ${archive.totals.requests} requests, ${archive.totals.tokens} tokens, $${archive.totals.cost.toFixed(4)} cost`);

        // Notify about the archive
        await this.agent.notify(
          `📊 **Monthly AI Usage Report** (${period})\n\n` +
          `📈 **Totals:**\n` +
          `• Requests: ${archive.totals.requests.toLocaleString()}\n` +
          `• Tokens: ${archive.totals.tokens.toLocaleString()}\n` +
          `• Cost: $${archive.totals.cost.toFixed(4)}\n\n` +
          `📁 Stats archived and reset for new month.`
        );

      } catch (error) {
        // Check if it's a duplicate archive error (already archived this month)
        if (error.message && error.message.includes('Archive already exists')) {
          logger.info('Monthly archive already exists, skipping');
          return;
        }

        logger.error('Monthly stats archive failed:', error);
        await this.agent.notify(`❌ Monthly stats archive failed: ${error.message}`);
      }
    });

    // System diagnostics job - comprehensive health checks and API testing
    this.agenda.define('system-diagnostics', async (job) => {
      try {
        logger.info('🏥 Running scheduled system diagnostics...', { service: 'diagnostics' });
        this.lastSystemDiagnostics = new Date();
        this.saveActivityTimestamps(); // Persist to database

        const diagnosticsService = this.agent.selfDiagnosticsService;
        if (!diagnosticsService) {
          logger.error('Diagnostics service not available', { service: 'diagnostics' });
          return;
        }

        const result = await diagnosticsService.runDiagnostics('scheduled', 'system');

        if (result.skipped) {
          logger.info(`⏳ Diagnostics skipped: ${result.reason}`, { service: 'diagnostics' });
          return;
        }

        logger.info(`✅ Diagnostics completed - Health: ${result.overallHealth}, Summary: ${result.summary}`, { service: 'diagnostics' });

        // Update job stats
        job.attrs.data.lastResult = {
          health: result.overallHealth,
          summary: result.summary,
          reportId: result.reportId,
          timestamp: new Date()
        };

      } catch (error) {
        logger.error('Failed to run system diagnostics:', error, { service: 'diagnostics' });
        throw error;
      }
    });

    // Automated backup
    this.agenda.define('backup-full', async (job) => {
      try {
        logger.info('Running scheduled full backup...', { service: 'backup' });
        const backupPlugin = this.agent?.apiManager?.plugins?.get('backupStrategy');
        if (!backupPlugin) {
          logger.warn('Backup strategy plugin not available', { service: 'backup' });
          return;
        }
        const result = await backupPlugin.execute({ action: 'createFullBackup' });
        if (result.success) {
          logger.info(`Scheduled backup completed: ${result.backup?.backupName} (${result.backup?.size ? (result.backup.size / 1024 / 1024).toFixed(1) + 'MB' : '?'})`, { service: 'backup' });
        } else {
          logger.error(`Scheduled backup failed: ${result.error}`, { service: 'backup' });
          try { await this.agent.notify(`⚠️ Scheduled backup failed: ${result.error}`); } catch {}
        }
      } catch (error) {
        logger.error('Scheduled backup job error:', error, { service: 'backup' });
      }
    });

    // *arr service update checker — daily check for Prowlarr, Radarr, Sonarr, Lidarr, Readarr updates
    this.agenda.define('arr-update-check', async (job) => {
      try {
        logger.info('Checking *arr services for available updates...');
        const { ArrBasePlugin } = await import('../api/plugins/arr-base-helper.js');
        const { updates, summary } = await ArrBasePlugin.checkAllArrUpdates(this.agent);

        if (updates.length > 0) {
          logger.info(`Found ${updates.length} *arr update(s): ${updates.map(u => `${u.result}`).join(', ')}`);
          await this.agent.notify(summary);
        } else {
          logger.info('All *arr services are up to date');
        }
      } catch (error) {
        logger.error('*arr update check failed:', error);
      }
    });

    // Archive completed development items older than 30 days
    this.agenda.define('archive-old-dev-items', async (job) => {
      try {
        const { default: DevelopmentPlan } = await import('../models/DevelopmentPlan.js');
        await DevelopmentPlan.archiveOldCompletedItems(30);
      } catch (error) {
        logger.error('archive-old-dev-items job failed:', error);
      }
    });

    // Send email lease expiration warnings (7 days ahead)
    this.agenda.define('email-lease-expiration-warnings', async (job) => {
      try {
        const { default: EmailLease } = await import('../models/EmailLease.js');
        await EmailLease.sendExpirationNotifications(7);
      } catch (error) {
        logger.error('email-lease-expiration-warnings job failed:', error);
      }
    });

    // One-shot job for user-scheduled Zap runs (data: { zapId })
    this.agenda.define('zapier-run-zap', async (job) => {
      const { zapId } = job.attrs.data || {};
      try {
        const zapierPlugin = this.agent?.apiManager?.getPlugin?.('zapier');
        if (!zapierPlugin?.instance) {
          logger.warn(`zapier-run-zap: zapier plugin unavailable, skipping zap ${zapId}`);
          return;
        }
        await zapierPlugin.instance.runZap({ zapId });
        logger.info(`zapier-run-zap: ran scheduled zap ${zapId}`);
      } catch (error) {
        logger.error(`zapier-run-zap failed for ${zapId}:`, error);
      }
    });

    // Note: Crypto strategy job removed - now handled by SubAgent orchestrator
  }

  // Schedule a one-time reminder
  async scheduleReminder(message, minutes, userId, options = {}) {
    const runAt = new Date();
    runAt.setMinutes(runAt.getMinutes() + minutes);
    
    const job = await this.agenda.schedule(runAt, 'reminder', {
      message,
      userId,
      notificationMethod: options.notificationMethod || 'telegram'
    });
    
    return {
      jobId: job.attrs._id,
      scheduledFor: runAt
    };
  }

  // Schedule recurring jobs
  async scheduleRecurringJobs() {
    // Email check every 3 minutes
    await this.agenda.every('3 minutes', 'check-emails');
    
    // System health check every minute
    await this.agenda.every('1 minute', 'system-health');
    
    // Task processor every 5 minutes
    await this.agenda.every('5 minutes', 'process-tasks');
    
    // Git repository monitor every 30 minutes
    await this.agenda.every('30 minutes', 'git-monitor');
    
    // Self-modification scanner every hour
    // Schedule first run 5 min from now to avoid lock collision with git-monitor
    await this.agenda.every('1 hour', 'self-mod-scan');
    const selfModJob = await this.agenda.jobs({ name: 'self-mod-scan' });
    if (selfModJob.length > 0) {
      selfModJob[0].attrs.nextRunAt = new Date(Date.now() + 5 * 60 * 1000);
      await selfModJob[0].save();
    }
    
    // System maintenance every hour
    await this.agenda.every('1 hour', 'system-maintenance');
    
    // System status reports - default to Mondays at 9 AM (configurable via settings)
    await this.agenda.every('0 9 * * 1', 'system-status-report');
    
    // Model updates daily at 3 AM
    await this.agenda.every('0 3 * * *', 'model-update');
    
    // Daily bug scan at 2 AM
    await this.agenda.every('0 2 * * *', 'daily-bug-scan');
    
    // Bug fixing sessions at 10 AM and 10 PM (twice daily)
    await this.agenda.every('0 10,22 * * *', 'bug-fixing');
    
    // GitHub feature discovery at 9 AM and 9 PM (twice daily)
    await this.agenda.every('0 9,21 * * *', 'github-discovery');
    
    // Cleanup old reminders daily at 4 AM (production schedule)
    await this.agenda.every('0 4 * * *', 'cleanup-old-reminders');

    // Auto-archive inactive AutoAccount entries — daily at midnight
    await this.agenda.every('0 0 * * *', 'auto-account-archive');
    
    // Cleanup all completed jobs every hour
    await this.agenda.every('0 * * * *', 'cleanup-completed-jobs');

    // Monthly AI provider stats archive - midnight on 1st of each month
    await this.agenda.every('0 0 1 * *', 'monthly-stats-archive');

    // Crypto price monitor - Chainlink reads every 5 minutes, dispatches events on significant moves
    await this.agenda.every('5 minutes', 'crypto-price-monitor');

    // Crypto heartbeat - periodic trigger for time-based strategies (DCA)
    await this.agenda.every('10 minutes', 'crypto-heartbeat');

    // Crypto daily P&L report - runs daily (time configured in agent config)
    await this.agenda.every('24 hours', 'crypto-daily-report');

    // MindSwarm engagement - process notifications, auto-reply, daily post
    await this.agenda.every('5 minutes', 'mindswarm-engagement');

    // Twitter/X auto-posting — daily tweets from real agent activity
    await this.agenda.every('10 minutes', 'twitter-engagement');

    // Server maintenance heartbeat - hourly goliath server check
    await this.agenda.every('60 minutes', 'maintenance-heartbeat');

    // Skynet staking yield - daily at midnight (was weekly, but 7-day epoch could expire mid-week)
    await this.agenda.every('0 0 * * *', 'skynet-staking-yield');

    // Skynet staking auto-claim - daily at 6 AM
    await this.agenda.every('0 6 * * *', 'skynet-staking-autoclaim');

    // Skynet LP staking auto-claim - daily at 6:30 AM
    await this.agenda.every('30 6 * * *', 'skynet-lp-staking-autoclaim');

    // SkynetVault compound - every 12 hours (earns bounty for this agent)
    await this.agenda.every('12 hours', 'skynet-vault-compound');

    // Scammer registry fee auto-pricer - hourly. Job is opt-in via
    // skynet.scammerFee.autoPrice and rate-limited internally to once per N
    // hours (default 24), so the hourly cron just gives the drift gate a
    // chance to fire as soon as it's eligible.
    await this.agenda.every('1 hour', 'skynet-auto-price-fee');

    // Immunity threshold auto-pricer - hourly, same opt-in/rate-limit pattern
    await this.agenda.every('1 hour', 'skynet-auto-price-immunity');

    // WireGuard tunnel watchdog - every 2 minutes. Checks handshake age and
    // peer reachability; auto-bounces if stale. Silent no-op when healthy.
    await this.agenda.every('2 minutes', 'vpn-wireguard-watchdog');

    // Automated full backup - daily at 1 AM
    await this.agenda.every('0 1 * * *', 'backup-full');

    // ENS renewal check - daily at 7 AM
    await this.agenda.every('0 7 * * *', 'ens-renewal-check');

    // Trust registry scammer sync - every 6 hours
    await this.agenda.every('6 hours', 'trust-scammer-sync');

    // *arr service update check - daily at 8 AM
    await this.agenda.every('0 8 * * *', 'arr-update-check');

    // Archive completed development items - daily at 2:30 AM
    await this.agenda.every('30 2 * * *', 'archive-old-dev-items');

    // Email lease expiration warnings - daily at 9 AM
    await this.agenda.every('0 9 * * *', 'email-lease-expiration-warnings');

    // Don't create immediate cleanup job - let the hourly schedule handle it
    // This prevents accumulation of cleanup job instances
    logger.info('Cleanup jobs will run on their regular schedule');
    
    // One-time cleanup of accumulated cleanup-completed-jobs
    try {
      const db = this.agenda._mdb;
      const result = await db.collection('scheduled_jobs').deleteMany({
        name: 'cleanup-completed-jobs',
        type: { $ne: 'single' }, // Keep the recurring one
        lastFinishedAt: { $exists: true }
      });
      if (result.deletedCount > 0) {
        logger.info(`Cleaned up ${result.deletedCount} accumulated cleanup-completed-jobs instances`);
      }
    } catch (error) {
      logger.warn('Failed to clean accumulated cleanup jobs:', error);
    }
    
    logger.info('All recurring jobs scheduled');
  }

  // Schedule a task reminder
  async scheduleTaskReminder(taskId, title, dueDate) {
    const reminderTime = new Date(dueDate);
    reminderTime.setMinutes(reminderTime.getMinutes() - 30); // 30 minutes before
    
    if (reminderTime > new Date()) {
      await this.agenda.schedule(reminderTime, 'task-reminder', {
        taskId,
        title
      });
    }
  }

  // Cancel a scheduled job
  async cancelJob(jobId) {
    await this.agenda.cancel({ _id: jobId });
  }

  // Manually trigger cleanup of old reminders
  async cleanupOldReminders() {
    try {
      await this.agenda.now('cleanup-old-reminders');
      logger.info('Manual reminder cleanup triggered');
    } catch (error) {
      logger.error('Failed to trigger manual reminder cleanup:', error);
      throw error;
    }
  }
  
  // Manually trigger GitHub discovery
  async triggerGitHubDiscovery() {
    try {
      await this.agenda.now('github-discovery');
      logger.info('Manual GitHub discovery triggered');
      return { success: true, message: 'GitHub discovery job started' };
    } catch (error) {
      logger.error('Failed to trigger GitHub discovery:', error);
      throw error;
    }
  }
  
  // Clean up all old cleanup jobs immediately (one-time cleanup)
  async cleanupAllOldCleanupJobs() {
    try {
      const oldCleanupJobs = await this.agenda.jobs({
        name: 'cleanup-old-reminders',
        $or: [
          { 'lastFinishedAt': { $exists: true } },
          { 'failedAt': { $exists: true } }
        ]
      });
      
      logger.info(`Found ${oldCleanupJobs.length} old cleanup jobs to remove`);
      
      let removed = 0;
      for (const job of oldCleanupJobs) {
        try {
          await job.remove();
          removed++;
        } catch (error) {
          logger.error(`Failed to remove cleanup job ${job.attrs._id}:`, error);
        }
      }
      
      logger.info(`Removed ${removed} old cleanup jobs`);
      return { success: true, removed };
    } catch (error) {
      logger.error('Failed to cleanup old cleanup jobs:', error);
      throw error;
    }
  }

  // Process email for auto-reply
  async processEmailForAutoReply(email) {
    logger.info(`Processing email from: ${email.from}, subject: ${email.subject}`);
    
    // Create unique identifier for this email to prevent duplicates
    const emailId = email.messageId || `${email.from}-${email.subject}-${email.date || Date.now()}`;
    const emailKey = `${emailId}`.substring(0, 100); // Limit length for memory efficiency
    
    // Check if we've already processed this exact email recently
    if (this.processedEmailsCache.has(emailKey)) {
      const lastProcessed = this.processedEmailsCache.get(emailKey);
      const timeSinceProcessed = Date.now() - lastProcessed;
      logger.info(`Email already processed ${timeSinceProcessed}ms ago, skipping duplicate: ${email.subject}`);
      return;
    }
    
    // Mark this email as being processed
    this.processedEmailsCache.set(emailKey, Date.now());
    
    // Extract email address from "Name <email@domain.com>" format, handling extra quotes
    const fromEmailRaw = email.from?.toLowerCase();
    // Remove extra quotes that might be present: "nocturnics" <email> -> nocturnics <email>
    const cleanFromEmail = fromEmailRaw?.replace(/^"([^"]+)"/, '$1');
    const emailMatch = cleanFromEmail?.match(/<([^<>]+@[^<>]+)>/) || cleanFromEmail?.match(/([^\s<>]+@[^\s<>]+)/);
    const fromEmail = emailMatch ? emailMatch[1] || emailMatch[0] : cleanFromEmail;
    
    // Skip noreply and system addresses
    const noReplyPatterns = [
      // No-reply variations (all common formats)
      'noreply@', 'no-reply@', 'no_reply@', 'no.reply@',
      'donotreply@', 'do-not-reply@', 'do_not_reply@', 'do.not.reply@',
      'donot-reply@', 'dont-reply@', 'dontreply@',
      'noreply-', 'no-reply-', // Catch noreply-something@domain.com
      // System addresses
      'mailer-daemon@', 'postmaster@', 'mailerdaemon@',
      'notifications@', 'notification@', 'notify@',
      'alerts@', 'alert@', 'updates@', 'update@',
      'automated@', 'automatic@', 'auto@', 'robot@', 'bot@',
      'system@', 'daemon@', 'root@',
      // Support addresses (for user review)
      'support@', 'help@', 'helpdesk@', 'customerservice@', 'customer-service@',
      'admin@', 'administrator@', 'webmaster@',
      // Security/transactional
      'security@', 'security-alert@', 'bounce@', 'bounces@',
      'unsubscribe@', 'remove@', 'optout@', 'opt-out@',
      // Marketing/newsletters
      'newsletter@', 'newsletters@', 'news@', 'digest@',
      'marketing@', 'promo@', 'promotions@', 'campaign@', 'campaigns@',
      'info@', 'information@', 'contact@', 'hello@', 'hi@',
      // Billing/orders
      'billing@', 'invoice@', 'invoices@', 'orders@', 'order@', 'receipt@', 'receipts@',
      // Feedback/surveys
      'feedback@', 'survey@', 'surveys@', 'nps@'
    ];
    if (fromEmail && noReplyPatterns.some(pattern => fromEmail.includes(pattern))) {
      logger.info(`Skipping system/automated email address: ${fromEmail}`);
      return;
    }

    // Additional regex check for edge cases (catches things like reply+noreply@, service-noreply@)
    const noReplyRegex = /\b(no[-_.]?reply|do[-_.]?not[-_.]?reply|unsubscribe)\b/i;
    if (fromEmail && noReplyRegex.test(fromEmail)) {
      logger.info(`Skipping no-reply pattern in email address: ${fromEmail}`);
      return;
    }

    // Check the agent's email contact blocklist (managed via blockContact/unblockContact)
    const emailPluginEntry = this.agent?.apiManager?.apis?.get('email');
    const contactManager = emailPluginEntry?.instance?.contactManager || emailPluginEntry?.contactManager;
    if (contactManager && fromEmail) {
      // Check exact address match
      if (contactManager.isBlocked(fromEmail)) {
        logger.info(`Skipping blocked contact email: ${fromEmail}`);
        return;
      }
      // Check domain-level blocks (e.g. blocking *@moralis.com blocks all moralis.com senders)
      const domain = fromEmail.split('@')[1]?.toLowerCase();
      if (domain && contactManager.isBlocked(`*@${domain}`)) {
        logger.info(`Skipping blocked domain email: ${fromEmail} (domain: ${domain})`);
        return;
      }
    }
    
    // Skip auto-reply emails (prevent loops)
    const autoReplyIndicators = ['auto-reply', 'automatic reply', 'out of office', 'vacation', 'away'];
    const subject = (email.subject || '').toLowerCase();
    if (autoReplyIndicators.some(indicator => subject.includes(indicator))) {
      logger.info(`Skipping auto-reply email: ${email.subject}`);
      return;
    }
    
    // Check if this is a reply to our own message (prevent loops)
    if (subject.startsWith('re: re:')) {
      logger.info(`Skipping multiple reply thread: ${email.subject}`);
      return;
    }
    
    // Check daily auto-reply limit per email address
    const dailyLimit = 3;
    const today = new Date().toISOString().split('T')[0];
    const replyCountKey = `autoReply:${fromEmail}:${today}`;
    
    // Get current reply count and log for debugging
    const currentCount = this.autoReplyTracker?.[replyCountKey] || 0;
    logger.debug(`Daily counter check for ${fromEmail}: ${currentCount}/${dailyLimit} (key: ${replyCountKey})`);
    
    if (currentCount >= dailyLimit) {
      logger.info(`Daily auto-reply limit reached for ${fromEmail} (${currentCount}/${dailyLimit})`);
      return;
    }
    
    // Check if we should auto-reply
    const masterEmail = process.env.EMAIL_OF_MASTER?.toLowerCase();
    const shouldReplyToMaster = masterEmail && fromEmail === masterEmail;
    
    // Check email plugin auto-reply settings
    const emailPlugin = this.apiManager.getPlugin('email');
    const autoReplySettings = emailPlugin?.getState('autoReply');
    const autoReplyEnabled = autoReplySettings?.enabled || false;
    
    logger.info(`Auto-reply check: shouldReplyToMaster=${shouldReplyToMaster}, autoReplyEnabled=${autoReplyEnabled}, masterEmail=${masterEmail}, fromEmail=${fromEmail}`);
    
    // Track email conversation as guest conversation
    const telegram = this.agent.interfaces?.get('telegram');
    if (telegram && telegram.multiUserSupport && fromEmail) {
      telegram.multiUserSupport.trackEmailConversation(fromEmail, email.subject || 'No Subject');
    }
    
    if (shouldReplyToMaster || autoReplyEnabled) {
      // Check if we've already replied to this email thread/subject
      const threadKey = `${fromEmail}:${email.subject || 'no-subject'}`.toLowerCase();
      const threadTracker = this.emailThreads.get(threadKey);
      
      if (threadTracker) {
        const timeSinceLastReply = Date.now() - threadTracker.lastReplyTime;
        const minThreadInterval = 24 * 60 * 60 * 1000; // 24 hours between replies to same thread
        
        if (timeSinceLastReply < minThreadInterval && threadTracker.replyCount >= 1) {
          const hoursRemaining = Math.ceil((minThreadInterval - timeSinceLastReply) / 1000 / 60 / 60);
          logger.info(`Already replied to this email thread from ${fromEmail}: "${email.subject}". Next reply allowed in ${hoursRemaining} hours.`);
          return;
        }
      }
      
      // Check cooldown period to prevent rapid-fire replies to same sender
      const lastReplyTime = this.lastAutoReplyTime.get(fromEmail);
      const cooldownPeriod = 5 * 60 * 1000; // 5 minutes cooldown between auto-replies to same sender
      
      if (lastReplyTime) {
        const timeSinceLastReply = Date.now() - lastReplyTime;
        if (timeSinceLastReply < cooldownPeriod) {
          const remainingCooldown = Math.ceil((cooldownPeriod - timeSinceLastReply) / 1000 / 60);
          logger.info(`Auto-reply cooldown active for ${fromEmail}: ${remainingCooldown} minutes remaining`);
          return;
        }
      }
      
      logger.info(`Starting auto-reply process for ${fromEmail}`);
      try {
        // Generate AI response with improved prompting
        const emailContent = email.text || email.html || 'No content';
        const prompt = `You are ${this.agent.config.name}, a personal assistant agent. Someone sent you an email. Please respond helpfully and personally to their message while maintaining your identity as ${this.agent.config.name}.

Email from: ${email.from}
Subject: ${email.subject}
Content: ${emailContent}

Please provide a helpful, friendly response that directly addresses their question or message. Be conversational and informative. NEVER break character - you are ALWAYS ${this.agent.config.name}, never admit to being Claude, GPT, or any other AI model.

IMPORTANT: Respond with ONLY the email text content - no JSON, no formatting, just the plain text message that should be sent to the person.

Your response:`;

        // Use direct AI generation — NOT processNaturalLanguage() which runs
        // intent detection and can misroute the prompt to plugin actions
        // (e.g., email.findContact instead of generating a text response)
        const aiResponse = await this.agent.providerManager.generateResponse(prompt, {
          maxTokens: 1024,
          temperature: 0.7
        });

        // Extract response text
        let replyText = typeof aiResponse === 'string' ? aiResponse
          : aiResponse?.content || aiResponse?.text || aiResponse?.response || '';

        if (typeof replyText === 'object' && replyText !== null) {
          replyText = replyText.content || replyText.text || JSON.stringify(replyText);
        }

        if (typeof replyText !== 'string') {
          replyText = String(replyText);
        }
        replyText = replyText.trim();
        
        logger.info(`AI response generated for ${fromEmail}, length: ${replyText.length}`);
        if (replyText.length === 0) {
          logger.warn(`Empty AI response for ${fromEmail}, using fallback. Original response object:`, response);
        }
        
        // Create meaningful fallback based on email content
        let fallbackMessage = `Thank you for your email! I'm ${this.agent.config.name}, your personal assistant.`;
        if (emailContent.toLowerCase().includes('who made')) {
          fallbackMessage = `Thank you for your email! I'm ${this.agent.config.name}, a personal assistant agent designed to help with various tasks. Is there something specific I can help you with?`;
        } else if (emailContent.toLowerCase().includes('what') || emailContent.toLowerCase().includes('how')) {
          fallbackMessage = `Thank you for your email! I'm ${this.agent.config.name}, your personal assistant. I'd be happy to help answer your question. Could you provide a bit more detail about what you're looking for?`;
        }
        
        // Safety: never send error messages or internal details as email replies
        const errorPatterns = ['❌', 'Error executing', 'Validation failed', 'Plugin execution error', 'stack trace', 'TypeError', 'ReferenceError'];
        if (errorPatterns.some(p => replyText.includes(p))) {
          logger.warn(`Auto-reply contained error text, using fallback instead: ${replyText.substring(0, 100)}`);
          replyText = '';
        }

        // Use AI response if available, otherwise intelligent fallback
        const finalMessage = replyText.length > 0 ? replyText : fallbackMessage;
        
        // Send reply
        const emailPlugin = this.apiManager.getPlugin('email');
        const replySubject = email.subject ? `Re: ${email.subject}` : 'Re: Your Message';
        const replyTo = fromEmail || email.from;
        
        logger.info(`Preparing to send auto-reply: to="${replyTo}", subject="${replySubject}"`);
        logger.info(`Reply content preview: ${finalMessage.substring(0, 100)}...`);
        
        // Validate required fields
        if (!replyTo || !replyTo.includes('@')) {
          throw new Error(`Invalid reply email address: ${replyTo}`);
        }
        
        await emailPlugin.execute({
          action: 'send',
          to: replyTo,
          subject: replySubject,
          text: finalMessage,
          inReplyTo: email.messageId
        });
        
        // Update auto-reply counter and record last reply time  
        const currentCount = (this.autoReplyTracker[replyCountKey] || 0) + 1;
        this.autoReplyTracker[replyCountKey] = currentCount;
        this.lastAutoReplyTime.set(fromEmail, Date.now());
        
        // Track email thread to prevent duplicate replies
        const threadKey = `${fromEmail}:${email.subject || 'no-subject'}`.toLowerCase();
        this.emailThreads.set(threadKey, {
          lastReplyTime: Date.now(),
          replyCount: (this.emailThreads.get(threadKey)?.replyCount || 0) + 1,
          originalSubject: email.subject
        });
        
        logger.info(`Auto-replied to email from ${fromEmail} (${currentCount}/${dailyLimit} today) | Thread: "${email.subject}"`);
        
        // Check if master wants notifications about auto-replies
        let shouldNotifyMaster = false;
        try {
          if (emailPlugin) {
            const result = await emailPlugin.execute({ action: 'getNotificationSettings' });
            shouldNotifyMaster = result.success && result.settings?.notifyMasterOnAutoReply || false;
          }
        } catch (error) {
          logger.error('Failed to get notification settings:', error);
        }
        
        if (shouldNotifyMaster) {
          try {
            const emailContent = email.text || email.html || 'No content available';
            const contentPreview = emailContent.substring(0, 200) + (emailContent.length > 200 ? '...' : '');
            const replyPreview = finalMessage.substring(0, 200) + (finalMessage.length > 200 ? '...' : '');
            
            await this.agent.notify(
              `📧 Auto-replied to email from ${fromEmail}\n\n` +
              `Subject: ${email.subject || '(No Subject)'}\n` +
              `Content: ${contentPreview}\n\n` +
              `My response: ${replyPreview}`
            );
            logger.info(`Sent auto-reply notification to master for email from ${fromEmail}`);
          } catch (notifyError) {
            logger.error(`Failed to send auto-reply notification: ${notifyError.message}`);
          }
        }
        
        // Add delay after sending to ensure email is fully processed
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
      } catch (error) {
        logger.error(`Auto-reply failed for ${fromEmail}: ${error.message}`, { error: error.stack });
        // Don't throw - allow email to be marked as processed but log the auto-reply failure
      }
    } else {
      logger.info(`No auto-reply sent - shouldReplyToMaster: ${shouldReplyToMaster}, autoReplyEnabled: ${autoReplyEnabled}`);
    }
    
    // Mark as processed
    if (email._id || email.messageId) {
      const { Email } = await import('../models/Email.js');
      const query = email._id ? { _id: email._id } : { messageId: email.messageId };
      await Email.updateOne(query, {
        $set: { processed: true, processedAt: new Date(), read: true }
      });
    }
  }

  // Helper methods
  calculateMemoryUsage(memoryData) {
    if (!memoryData) return 0;
    
    const total = this.parseMemoryValue(memoryData.total);
    const available = this.parseMemoryValue(memoryData.available || memoryData.free);
    
    if (total === 0) return 0;
    return Math.round(((total - available) / total) * 100);
  }

  parseMemoryValue(value) {
    if (!value) return 0;
    
    const match = value.match(/(\d+\.?\d*)([KMGT])/i);
    if (!match) return 0;
    
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    
    const multipliers = {
      K: 1024,
      M: 1024 * 1024,
      G: 1024 * 1024 * 1024,
      T: 1024 * 1024 * 1024 * 1024
    };
    
    return num * (multipliers[unit] || 1);
  }

  // Save system stats to memory
  async saveSystemStats() {
    const stats = {
      timestamp: new Date(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      loadAverage: os.loadavg(),
      freemem: os.freemem(),
      totalmem: os.totalmem()
    };
    
    // System stats logged but NOT stored as memories — was creating 2K+ junk entries
    // (hourly heap dumps with no recall value). Stats are available via /api/system/status.
    logger.debug('System stats collected:', { uptime: stats.uptime, memUsed: stats.memory.heapUsed });
    
    this.lastSystemStats = new Date();
  }
  
  // Generate weekly report
  async generateWeeklyReport() {
    const endDate = new Date();

    // Get report frequency from settings, default to 7 days
    let frequency = 7;
    try {
      const settings = await this.getReportSettings();
      frequency = settings.frequency;
    } catch (error) {
      logger.warn('Could not get report frequency, using default 7 days');
    }

    const startDate = new Date(endDate.getTime() - (frequency * 24 * 60 * 60 * 1000));

    try {
      // Gather all stats in parallel for speed
      const [emailStats, systemStats, memoryStats, errorStats, aiUsageStats, cryptoStats, mediaStats, improvementStats] = await Promise.all([
        this.getEmailActivity(startDate, endDate),
        this.getSystemActivity(startDate, endDate),
        this.getMemoryActivity(startDate, endDate),
        this.getErrorActivity(startDate, endDate),
        this.getAIUsageStats(startDate, endDate),
        this.getCryptoStats(),
        this.getMediaStats(),
        this.getImprovementStats(startDate, endDate)
      ]);

      // Get report title based on frequency
      let reportTitle = 'System Report';
      let periodLabel = `${frequency}d`;
      if (frequency === 1) {
        reportTitle = 'Daily Status Report';
        periodLabel = '24h';
      } else if (frequency === 7) {
        reportTitle = 'Weekly System Report';
        periodLabel = '7d';
      } else if (frequency === 30) {
        reportTitle = 'Monthly System Report';
        periodLabel = '30d';
      } else {
        reportTitle = `${frequency}-Day System Report`;
      }

      // Build report sections
      const sections = [];

      // Header
      sections.push(`📊 **${reportTitle}**\n${startDate.toLocaleDateString()} → ${endDate.toLocaleDateString()}`);

      // System Status
      const memUsedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
      sections.push(`🔧 **System Status**
• Agent uptime: ${this.formatAgentUptime()}
• System uptime: ${Math.round(os.uptime() / 3600 / 24 * 10) / 10} days
• Memory: ${memUsedPct}% used (${Math.round(os.freemem() / 1024 / 1024)}MB free / ${Math.round(os.totalmem() / 1024 / 1024)}MB)
• Load avg: ${os.loadavg().map(v => v.toFixed(2)).join(', ')}`);

      // AI Usage (new - from TokenUsage)
      if (aiUsageStats.totalRequests > 0) {
        sections.push(`🤖 **AI Usage (${periodLabel})**
• API calls: ${aiUsageStats.totalRequests.toLocaleString()}
• Tokens: ${this._formatTokenCount(aiUsageStats.totalTokens)} (${this._formatTokenCount(aiUsageStats.promptTokens)} in / ${this._formatTokenCount(aiUsageStats.completionTokens)} out)
• Cost: $${aiUsageStats.totalCost.toFixed(4)}
• Avg response: ${aiUsageStats.avgResponseTime}ms
• Models: ${aiUsageStats.modelBreakdown || 'N/A'}
• Success rate: ${aiUsageStats.successRate}%`);
      }

      // Conversations & Memory (fixed source tracking)
      sections.push(`🧠 **Conversations & Memory (${periodLabel})**
• Total interactions: ${memoryStats.conversations || 0}
• New memories stored: ${memoryStats.newMemories || 0}
• Most active: ${memoryStats.mostActiveInterface || 'None'}${memoryStats.interfaceBreakdown ? '\n' + memoryStats.interfaceBreakdown : ''}`);

      // Crypto Stats — separate primary strategy and token trader
      if (cryptoStats.available) {
        const pnlEmoji = cryptoStats.totalPnL > 0 ? '🟢' : cryptoStats.totalPnL < 0 ? '🔴' : '⚪';
        const ttPnlEmoji = cryptoStats.tokenTraderPnL > 0 ? '🟢' : cryptoStats.tokenTraderPnL < 0 ? '🔴' : '⚪';
        const ttUrEmoji = cryptoStats.tokenTraderUnrealizedPnL > 0 ? '📈' : cryptoStats.tokenTraderUnrealizedPnL < 0 ? '📉' : '➡️';
        let cryptoSection = `💰 **Crypto**
📊 *${(cryptoStats.strategy || '').replace(/_/g, '\\_')}*
${pnlEmoji} P&L: $${cryptoStats.totalPnL.toFixed(2)}
• Trades: ${cryptoStats.tradesExecuted} executed / ${cryptoStats.tradesProposed} proposed
📊 *Token Trader*
${ttPnlEmoji} Realized P&L: $${cryptoStats.tokenTraderPnL.toFixed(2)}
${ttUrEmoji} Unrealized: $${cryptoStats.tokenTraderUnrealizedPnL.toFixed(2)}
• Trades: ${cryptoStats.tokenTraderTradesExecuted} executed / ${cryptoStats.tokenTraderTradesProposed} proposed`;
        if (cryptoStats.positions) {
          cryptoSection += `\n• Positions: ${cryptoStats.positions}`;
        }
        sections.push(cryptoSection);
      }

      // Media Stats (new - Sonarr/Radarr)
      if (mediaStats.available) {
        let mediaSection = '🎬 **Media**';
        if (mediaStats.sonarr) {
          mediaSection += `\n📺 Sonarr: ${mediaStats.sonarr.downloaded} episodes grabbed, ${mediaStats.sonarr.monitored} series monitored`;
          if (mediaStats.sonarr.upcoming) {
            mediaSection += `, ${mediaStats.sonarr.upcoming} upcoming`;
          }
        }
        if (mediaStats.radarr) {
          mediaSection += `\n🎥 Radarr: ${mediaStats.radarr.downloaded} movies grabbed, ${mediaStats.radarr.monitored} movies monitored`;
          if (mediaStats.radarr.upcoming) {
            mediaSection += `, ${mediaStats.radarr.upcoming} upcoming`;
          }
        }
        sections.push(mediaSection);
      }

      // Self-Improvement Stats (new)
      if (improvementStats.total > 0) {
        sections.push(`🔬 **Self-Improvement (${periodLabel})**
• PRs created: ${improvementStats.total}
• Merged: ${improvementStats.merged} | Rejected: ${improvementStats.rejected} | Failed: ${improvementStats.failed}
• Success rate: ${improvementStats.successRate}%${improvementStats.topTypes ? '\n• Focus areas: ' + improvementStats.topTypes : ''}`);
      }

      // Email Activity
      if (emailStats.received > 0 || emailStats.sent > 0) {
        sections.push(`📧 **Email (${periodLabel})**
• Received: ${emailStats.received} | Sent: ${emailStats.sent} | Auto-replies: ${emailStats.autoReplies}
• Processing rate: ${emailStats.processedPercent}%`);
      }

      // Issues & Maintenance
      sections.push(`⚠️ **Issues & Maintenance**
• Errors: ${errorStats.totalErrors || 0} (${errorStats.criticalErrors || 0} critical)
• Restarts: ${systemStats.restarts || 0}
• Last maintenance: ${systemStats.lastMaintenance || 'None'}`);

      // Performance
      sections.push(`📈 **Performance**
• Peak memory: ${systemStats.peakMemoryUsage || 0}MB
• Avg AI response: ${systemStats.avgResponseTime || 0}ms
• Job success rate: ${systemStats.jobSuccessRate || 0}%`);

      // Scheduled Jobs (fixed - actual run counts)
      sections.push(`🔄 **Scheduled Jobs (${periodLabel})**\n${systemStats.jobSummary || '• No jobs run this period'}`);

      const report = sections.join('\n\n');

      // Also return structured data for database storage
      const reportData = {
        reportType: frequency === 1 ? 'daily' : frequency === 7 ? 'weekly' : frequency === 30 ? 'monthly' : 'custom',
        title: reportTitle,
        frequency,
        dateRange: {
          start: startDate,
          end: endDate
        },
        content: {
          raw: report,
          systemStatus: {
            agentUptime: this.formatAgentUptime(),
            systemUptime: `${Math.round(os.uptime() / 3600 / 24 * 10) / 10} days`,
            memoryFree: Math.round(os.freemem() / 1024 / 1024),
            memoryTotal: Math.round(os.totalmem() / 1024 / 1024),
            loadAverage: os.loadavg()
          },
          emailActivity: {
            received: emailStats.received || 0,
            sent: emailStats.sent || 0,
            autoReplies: emailStats.autoReplies || 0,
            processingRate: emailStats.processedPercent || 0
          },
          aiActivity: {
            conversations: memoryStats.conversations || 0,
            newMemories: memoryStats.newMemories || 0,
            mostActiveInterface: memoryStats.mostActiveInterface || 'None',
            totalRequests: aiUsageStats.totalRequests || 0,
            totalTokens: aiUsageStats.totalTokens || 0,
            totalCost: aiUsageStats.totalCost || 0
          },
          cryptoActivity: cryptoStats.available ? {
            strategy: cryptoStats.strategy,
            totalPnL: cryptoStats.totalPnL,
            dailyPnL: cryptoStats.dailyPnL,
            tradesExecuted: cryptoStats.tradesExecuted,
            tradesProposed: cryptoStats.tradesProposed
          } : {},
          mediaActivity: mediaStats.available ? {
            sonarr: mediaStats.sonarr || {},
            radarr: mediaStats.radarr || {}
          } : {},
          selfImprovement: improvementStats.total > 0 ? {
            total: improvementStats.total,
            merged: improvementStats.merged,
            rejected: improvementStats.rejected,
            successRate: improvementStats.successRate
          } : {},
          issues: {
            errorsLogged: errorStats.totalErrors || 0,
            criticalIssues: errorStats.criticalErrors || 0,
            systemRestarts: systemStats.restarts || 0,
            lastMaintenance: systemStats.lastMaintenance || 'None'
          },
          performance: {
            peakMemoryUsage: systemStats.peakMemoryUsage || 0,
            avgResponseTime: systemStats.avgResponseTime || 0,
            jobSuccessRate: systemStats.jobSuccessRate || 0
          },
          scheduledJobs: {
            summary: systemStats.jobSummary || 'No jobs run this period',
            details: systemStats.jobDetails || []
          }
        }
      };

      return { report, reportData };

    } catch (error) {
      logger.error('Error generating detailed weekly report:', error);
      const basicReport = `📊 **System Report** (${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()})

⚠️ Unable to generate detailed report: ${error.message}

🔧 **Basic System Status**
• Uptime: ${Math.round(process.uptime() / 3600 / 24 * 10) / 10} days
• Memory: ${Math.round(os.freemem() / 1024 / 1024)}MB free / ${Math.round(os.totalmem() / 1024 / 1024)}MB total
• Load: ${os.loadavg().map(v => v.toFixed(2)).join(', ')}`;

      return {
        report: basicReport,
        reportData: {
          reportType: 'custom',
          title: 'System Report (Error)',
          frequency: frequency || 7,
          dateRange: { start: startDate, end: endDate },
          content: {
            raw: basicReport,
            systemStatus: {},
            emailActivity: {},
            aiActivity: {},
            issues: {},
            performance: {},
            scheduledJobs: {}
          }
        }
      };
    }
  }

  // Format token counts for readability (e.g., 1234567 -> "1.2M")
  _formatTokenCount(count) {
    if (!count) return '0';
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  }

  // Get email activity statistics
  async getEmailActivity(startDate, endDate) {
    try {
      const { Email } = await import('../models/Email.js');
      
      const received = await Email.countDocuments({
        type: 'received',
        date: { $gte: startDate, $lte: endDate }
      });
      
      const sent = await Email.countDocuments({
        type: 'sent', 
        date: { $gte: startDate, $lte: endDate }
      });
      
      const processed = await Email.countDocuments({
        processed: true,
        date: { $gte: startDate, $lte: endDate }
      });
      
      const total = received + sent;
      const processedPercent = total > 0 ? Math.round((processed / total) * 100) : 0;
      
      // Count auto-replies (sent emails that were processed)
      const autoReplies = await Email.countDocuments({
        type: 'sent',
        processed: true,
        date: { $gte: startDate, $lte: endDate }
      });
      
      return {
        received,
        sent,
        autoReplies,
        processedPercent
      };
    } catch (error) {
      logger.warn('Could not get email statistics:', error);
      return { received: 0, sent: 0, autoReplies: 0, processedPercent: 0 };
    }
  }

  // Get system activity statistics with accurate job run counts
  async getSystemActivity(startDate, endDate) {
    try {
      // Get accurate job run counts by querying Agenda's MongoDB collection directly.
      // Agenda stores one document per job definition; each has repeatInterval,
      // lastRunAt, and lastFinishedAt. We estimate run counts from the interval
      // and the period overlap.
      const jobCounts = {};
      let successCount = 0;
      let failCount = 0;

      try {
        const db = this.agenda._mdb;
        const jobDocs = await db.collection('scheduled_jobs').find({
          lastRunAt: { $exists: true }
        }).toArray();

        for (const job of jobDocs) {
          const name = job.name;
          if (!name) continue;

          // Calculate how many times this job ran in the report period.
          // Agenda only stores the latest lastRunAt per job definition, not a
          // history. So we estimate runs = reportPeriod / interval.
          let runs = 0;
          const interval = job.repeatInterval;
          const lastRun = job.lastRunAt ? new Date(job.lastRunAt) : null;

          if (interval && lastRun && lastRun >= startDate && lastRun <= endDate) {
            const intervalMs = this._parseIntervalToMs(interval);
            if (intervalMs > 0) {
              // How much of the report period this job was active
              const periodMs = endDate.getTime() - startDate.getTime();
              runs = Math.max(1, Math.floor(periodMs / intervalMs));
            } else {
              runs = 1; // Ran at least once, can't determine interval
            }
          } else if (lastRun && lastRun >= startDate && lastRun <= endDate) {
            runs = 1;
          }

          if (runs > 0) {
            jobCounts[name] = runs;
            const failed = job.failedAt && (!job.lastFinishedAt || new Date(job.failedAt) > new Date(job.lastFinishedAt));
            if (failed) {
              failCount += 1;
            } else {
              successCount += runs;
            }
          }
        }
      } catch (dbError) {
        logger.warn('Could not query Agenda DB directly, falling back:', dbError.message);
        // Fallback to old method
        const jobs = await this.agenda.jobs({ lastRunAt: { $gte: startDate, $lte: endDate } });
        jobs.forEach(job => {
          const name = job.attrs.name;
          jobCounts[name] = (jobCounts[name] || 0) + 1;
          if (!job.attrs.failedAt || (job.attrs.lastFinishedAt && job.attrs.lastFinishedAt > job.attrs.failedAt)) {
            successCount++;
          } else {
            failCount++;
          }
        });
      }

      const totalRuns = Object.values(jobCounts).reduce((sum, c) => sum + c, 0);
      const jobSuccessRate = totalRuns > 0 ? Math.min(100, Math.round((successCount / totalRuns) * 100)) : 100;

      // Sort by run count descending and format
      const sortedJobs = Object.entries(jobCounts)
        .sort((a, b) => b[1] - a[1]);

      const jobSummary = sortedJobs.length > 0
        ? sortedJobs.map(([name, count]) => `• ${name}: ${count.toLocaleString()} runs`).join('\n')
        : '• No jobs run this period';

      const jobDetails = sortedJobs.map(([name, count]) => ({ name, count }));

      // Get restart count from agent stats
      let restarts = 0;
      try {
        const { Agent } = await import('../models/Agent.js');
        const agentRecord = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
        restarts = agentRecord?.stats?.restartCount || 0;
      } catch (error) {
        logger.warn('Could not get restart count:', error);
      }

      // Get average response time from TokenUsage
      let avgResponseTime = 0;
      try {
        const { TokenUsage } = await import('../models/TokenUsage.js');
        const recentUsage = await TokenUsage.aggregate([
          { $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            responseTime: { $exists: true, $gt: 0 }
          }},
          { $group: {
            _id: null,
            avgTime: { $avg: '$responseTime' }
          }}
        ]);
        if (recentUsage.length > 0) {
          avgResponseTime = Math.round(recentUsage[0].avgTime);
        }
      } catch (error) {
        logger.warn('Could not get average response time:', error);
      }

      return {
        restarts,
        lastMaintenance: this.lastMaintenance ? this.lastMaintenance.toLocaleDateString() : 'None',
        peakMemoryUsage: Math.round(os.totalmem() / 1024 / 1024 - os.freemem() / 1024 / 1024),
        avgResponseTime,
        jobSuccessRate,
        jobSummary,
        jobDetails
      };
    } catch (error) {
      logger.warn('Could not get system statistics:', error);
      return {
        restarts: 0,
        lastMaintenance: 'Unknown',
        peakMemoryUsage: 0,
        avgResponseTime: 0,
        jobSuccessRate: 0,
        jobSummary: '• Statistics unavailable',
        jobDetails: []
      };
    }
  }

  // Parse Agenda repeat interval string to milliseconds
  _parseIntervalToMs(interval) {
    if (!interval || interval === 'undefined') return 0;
    const trimmed = interval.toString().trim();

    // Try human-readable first: "5 minutes", "1 hour", "24 hours", "360 minutes"
    const humanMatch = trimmed.match(/^(\d+)\s*(second|minute|hour|day|week|month)s?$/i);
    if (humanMatch) {
      const num = parseInt(humanMatch[1]);
      const unit = humanMatch[2].toLowerCase();
      const multipliers = {
        second: 1000,
        minute: 60 * 1000,
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000
      };
      return num * (multipliers[unit] || 0);
    }

    // Handle cron expressions (5-part: min hour day month weekday)
    const cronParts = trimmed.split(/\s+/);
    if (cronParts.length >= 5) {
      // Check for comma-separated values (e.g., "0 10,22 * * *" = twice daily)
      if (cronParts[1].includes(',')) {
        const hours = cronParts[1].split(',').length;
        return Math.round((24 / hours) * 60 * 60 * 1000); // e.g., 2 per day = 12h
      }
      if (cronParts[2] !== '*') return 30 * 24 * 60 * 60 * 1000; // monthly
      if (cronParts[4] !== '*') return 7 * 24 * 60 * 60 * 1000;  // weekly
      if (cronParts[1] !== '*') return 24 * 60 * 60 * 1000;       // daily
      if (cronParts[0] !== '*') return 60 * 60 * 1000;             // hourly
      return 60 * 1000; // every minute
    }

    // Try parsing as a number (milliseconds)
    const ms = parseInt(trimmed);
    return isNaN(ms) ? 0 : ms;
  }

  // Get memory/conversation activity with proper interface tracking
  async getMemoryActivity(startDate, endDate) {
    try {
      const { Memory } = await import('../models/Memory.js');

      const newMemories = await Memory.countDocuments({
        createdAt: { $gte: startDate, $lte: endDate }
      });

      // Count conversations (type = 'conversation')
      const conversationCount = await Memory.countDocuments({
        type: 'conversation',
        createdAt: { $gte: startDate, $lte: endDate }
      });

      // Get interface activity from metadata.source (the correct field path)
      // Also try metadata.chatId patterns to detect telegram vs web
      let interfaceStats = await Memory.aggregate([
        {
          $match: {
            type: 'conversation',
            createdAt: { $gte: startDate, $lte: endDate }
          }
        },
        {
          $group: {
            _id: {
              $ifNull: [
                '$metadata.source',
                {
                  $cond: {
                    if: { $and: [{ $ne: ['$metadata.chatId', null] }, { $ne: ['$metadata.chatId', ''] }] },
                    then: 'telegram',
                    else: 'web'
                  }
                }
              ]
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } }
      ]);

      // Also pull from TokenUsage for a more accurate interface picture
      // TokenUsage.userId often contains the interface source
      try {
        const { TokenUsage } = await import('../models/TokenUsage.js');
        const tokenInterfaceStats = await TokenUsage.aggregate([
          {
            $match: {
              createdAt: { $gte: startDate, $lte: endDate },
              requestType: 'chat'
            }
          },
          {
            $group: {
              _id: '$userId',
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ]);

        // If Memory source data is sparse, supplement with TokenUsage data
        if (interfaceStats.length === 0 && tokenInterfaceStats.length > 0) {
          interfaceStats = tokenInterfaceStats.map(s => ({
            _id: s._id || 'system',
            count: s.count
          }));
        }
      } catch (tokenErr) {
        // TokenUsage supplement is optional
      }

      const mostActiveInterface = interfaceStats.length > 0
        ? `${interfaceStats[0]._id || 'system'} (${interfaceStats[0].count} interactions)`
        : 'None';

      // Build interface breakdown for display
      let interfaceBreakdown = '';
      if (interfaceStats.length > 1) {
        interfaceBreakdown = interfaceStats
          .map(s => `  - ${s._id || 'system'}: ${s.count}`)
          .join('\n');
      }

      return {
        conversations: conversationCount || interfaceStats.reduce((sum, stat) => sum + stat.count, 0),
        newMemories,
        mostActiveInterface,
        interfaceBreakdown
      };
    } catch (error) {
      logger.warn('Could not get memory statistics:', error);
      return {
        conversations: 0,
        newMemories: 0,
        mostActiveInterface: 'None',
        interfaceBreakdown: ''
      };
    }
  }

  // Get error activity statistics
  async getErrorActivity(startDate, endDate) {
    try {
      const { SystemLog } = await import('../models/SystemLog.js');
      
      const totalErrors = await SystemLog.countDocuments({
        level: 'error',
        createdAt: { $gte: startDate, $lte: endDate }
      });
      
      const criticalErrors = await SystemLog.countDocuments({
        level: 'error',
        message: { $regex: /critical|fatal|crash/i },
        createdAt: { $gte: startDate, $lte: endDate }
      });
      
      return {
        totalErrors,
        criticalErrors
      };
    } catch (error) {
      logger.warn('Could not get error statistics:', error);
      return {
        totalErrors: 0,
        criticalErrors: 0
      };
    }
  }

  // Get AI usage stats from TokenUsage model
  async getAIUsageStats(startDate, endDate) {
    try {
      const { TokenUsage } = await import('../models/TokenUsage.js');

      const stats = await TokenUsage.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            promptTokens: { $sum: '$promptTokens' },
            completionTokens: { $sum: '$completionTokens' },
            totalTokens: { $sum: '$totalTokens' },
            totalCost: { $sum: '$cost' },
            avgResponseTime: { $avg: '$responseTime' },
            successCount: { $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] } }
          }
        }
      ]);

      // Get model breakdown
      const modelStats = await TokenUsage.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: '$model',
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 3 }
      ]);

      const s = stats[0] || {};
      const modelBreakdown = modelStats.length > 0
        ? modelStats.map(m => `${m._id || 'unknown'}(${m.count})`).join(', ')
        : 'N/A';

      return {
        totalRequests: s.totalRequests || 0,
        promptTokens: s.promptTokens || 0,
        completionTokens: s.completionTokens || 0,
        totalTokens: s.totalTokens || 0,
        totalCost: s.totalCost || 0,
        avgResponseTime: Math.round(s.avgResponseTime || 0),
        successRate: s.totalRequests > 0 ? Math.round((s.successCount / s.totalRequests) * 100) : 100,
        modelBreakdown
      };
    } catch (error) {
      logger.warn('Could not get AI usage statistics:', error.message);
      return { totalRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0, avgResponseTime: 0, successRate: 100, modelBreakdown: 'N/A' };
    }
  }

  // Get crypto strategy stats from SubAgent domainState
  async getCryptoStats() {
    try {
      const { default: SubAgent } = await import('../models/SubAgent.js');
      const cryptoAgent = await SubAgent.findOne({ domain: 'crypto', type: 'domain' });
      if (!cryptoAgent) return { available: false };

      const state = cryptoAgent.state?.domainState || {};
      const config = cryptoAgent.config?.domainConfig || {};

      const positions = state.positions || {};
      const positionParts = Object.entries(positions)
        .map(([network, pos]) => {
          const status = pos.inStablecoin ? 'stablecoin' : network;
          const amount = pos.stablecoinAmount ? `$${parseFloat(pos.stablecoinAmount).toFixed(2)}` : '';
          return `${network}: ${status}${amount ? ' ' + amount : ''}`;
        });

      // Add SKYNET balance from contract if available
      try {
        const { default: contractServiceWrapper } = await import('./crypto/contractServiceWrapper.js');
        const { default: walletService } = await import('./crypto/walletService.js');
        const skynetAddr = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
        const addrs = walletService.getAddresses?.() || [];
        const ethEntry = addrs.find(a => a.chain === 'eth');
        if (ethEntry?.address) {
          const skyResult = await contractServiceWrapper.getTokenBalance(skynetAddr, ethEntry.address, 'bsc');
          const skyBal = parseFloat(skyResult?.formatted || '0');
          if (skyBal > 0) {
            positionParts.push(`SKYNET: ${skyBal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
          }
        }
      } catch (e) {
        // SKYNET balance fetch is best-effort
      }

      const positionSummary = positionParts.join(', ');

      // Compute token trader P&L from actual instance data (registry state)
      const registry = state.strategyRegistry || {};
      const tokenTraders = registry.tokenTraders || {};
      let ttRealizedPnL = 0;
      let ttUnrealizedPnL = 0;
      let ttGasCost = 0;
      for (const tt of Object.values(tokenTraders)) {
        const s = tt.state || {};
        ttRealizedPnL += s.lifetimeRealizedPnL || 0;
        ttGasCost += s.lifetimeGasCost || 0;
        // Compute unrealized from current position
        if (s.tokenBalance > 0 && s.averageEntryPrice > 0) {
          const currentPrice = s.lastPrice || s.averageEntryPrice;
          ttUnrealizedPnL += (currentPrice - s.averageEntryPrice) * s.tokenBalance;
        }
      }
      const ttNetPnL = ttRealizedPnL - ttGasCost;

      return {
        available: true,
        strategy: config.activeStrategy || state.activeStrategy || 'dollar_maximizer',
        // Primary strategy (dollar_maximizer) counters
        totalPnL: parseFloat(state.totalPnL) || 0,
        dailyPnL: parseFloat(state.dailyPnL) || 0,
        tradesExecuted: state.tradesExecuted || 0,
        tradesProposed: state.tradesProposed || 0,
        // Token trader counters — computed from live instance data
        tokenTraderPnL: ttNetPnL,
        tokenTraderUnrealizedPnL: ttUnrealizedPnL,
        tokenTraderTradesExecuted: state.tokenTraderTradesExecuted || 0,
        tokenTraderTradesProposed: state.tokenTraderTradesProposed || 0,
        positions: positionSummary || 'None'
      };
    } catch (error) {
      logger.warn('Could not get crypto statistics:', error.message);
      return { available: false };
    }
  }

  // Get Sonarr/Radarr media stats
  async getMediaStats() {
    const result = { available: false };
    try {
      // Sonarr stats
      try {
        const sonarrPlugin = this.apiManager?.getPlugin('sonarr');
        if (sonarrPlugin) {
          const [historyResult, calendarResult] = await Promise.all([
            sonarrPlugin.execute({ action: 'get_history', params: { pageSize: 50 } }).catch(() => null),
            sonarrPlugin.execute({ action: 'get_calendar', params: {} }).catch(() => null)
          ]);

          // Count recent downloads from history
          const downloaded = historyResult?.records?.filter(r =>
            r.eventType === 'downloadFolderImported' || r.eventType === 'grabbed'
          )?.length || historyResult?.totalRecords || 0;

          // Get monitored series count
          let monitored = 0;
          try {
            const seriesResult = await sonarrPlugin.execute({ action: 'get_series', params: {} });
            monitored = seriesResult?.series?.filter(s => s.monitored)?.length || seriesResult?.series?.length || 0;
          } catch (e) { /* optional */ }

          const upcoming = calendarResult?.items?.length || 0;

          result.sonarr = { downloaded, monitored, upcoming };
          result.available = true;
        }
      } catch (sonarrErr) {
        logger.debug('Sonarr stats unavailable:', sonarrErr.message);
      }

      // Radarr stats
      try {
        const radarrPlugin = this.apiManager?.getPlugin('radarr');
        if (radarrPlugin) {
          const [historyResult, calendarResult] = await Promise.all([
            radarrPlugin.execute({ action: 'get_history', params: { pageSize: 50 } }).catch(() => null),
            radarrPlugin.execute({ action: 'get_calendar', params: {} }).catch(() => null)
          ]);

          const downloaded = historyResult?.records?.filter(r =>
            r.eventType === 'downloadFolderImported' || r.eventType === 'grabbed'
          )?.length || historyResult?.totalRecords || 0;

          let monitored = 0;
          try {
            const moviesResult = await radarrPlugin.execute({ action: 'get_movies', params: {} });
            monitored = moviesResult?.movies?.filter(m => m.monitored)?.length || moviesResult?.movies?.length || 0;
          } catch (e) { /* optional */ }

          const upcoming = calendarResult?.items?.length || 0;

          result.radarr = { downloaded, monitored, upcoming };
          result.available = true;
        }
      } catch (radarrErr) {
        logger.debug('Radarr stats unavailable:', radarrErr.message);
      }

      return result;
    } catch (error) {
      logger.warn('Could not get media statistics:', error.message);
      return { available: false };
    }
  }

  // Get self-improvement/modification stats
  async getImprovementStats(startDate, endDate) {
    try {
      const { ImprovementMetrics } = await import('../models/ImprovementMetrics.js');

      // Get metrics documents within the date range
      const metrics = await ImprovementMetrics.find({
        date: { $gte: startDate, $lte: endDate }
      }).sort({ date: -1 });

      if (metrics.length === 0) {
        return { total: 0, merged: 0, rejected: 0, failed: 0, successRate: 0, topTypes: '' };
      }

      // Sum up daily totals
      let total = 0, merged = 0, rejected = 0, failed = 0;
      const typeMap = {};

      for (const m of metrics) {
        total += m.daily?.total || 0;
        merged += m.daily?.merged || 0;
        rejected += m.daily?.rejected || 0;
        failed += m.daily?.failed || 0;

        if (m.daily?.byType) {
          for (const [type, count] of (m.daily.byType instanceof Map ? m.daily.byType : Object.entries(m.daily.byType || {}))) {
            typeMap[type] = (typeMap[type] || 0) + (typeof count === 'number' ? count : 0);
          }
        }
      }

      const successRate = total > 0 ? Math.round((merged / total) * 100) : 0;

      // Top improvement types
      const topTypes = Object.entries(typeMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([type, count]) => `${type}(${count})`)
        .join(', ');

      return { total, merged, rejected, failed, successRate, topTypes };
    } catch (error) {
      logger.warn('Could not get improvement statistics:', error.message);
      return { total: 0, merged: 0, rejected: 0, failed: 0, successRate: 0, topTypes: '' };
    }
  }

  // Manual trigger for testing
  async triggerWeeklyReport() {
    logger.info('🔧 Manually triggering weekly report...');
    try {
      const { report, reportData } = await this.generateWeeklyReport();
      await this.saveReportToDatabase(reportData, 'manual');
      await this.agent.notify(report);
      return { success: true, message: 'Weekly report sent successfully' };
    } catch (error) {
      logger.error('Manual weekly report failed:', error);
      return { success: false, error: error.message };
    }
  }

  async saveReportToDatabase(reportData, generatedBy = 'scheduled') {
    try {
      const { SystemReport } = await import('../models/SystemReport.js');
      
      const report = new SystemReport({
        ...reportData,
        metadata: {
          generatedBy,
          generationTime: Date.now() - this.lastWeeklyReport?.getTime() || 0
        },
        sentTo: [{
          channel: 'telegram',
          sentAt: new Date(),
          success: true
        }]
      });
      
      await report.save();
      logger.info('Report saved to database:', report._id);
      return report;
    } catch (error) {
      logger.error('Failed to save report to database:', error);
      // Don't throw - allow report to still be sent even if save fails
    }
  }

  // Report settings management using PluginSettings
  async getReportSettings() {
    try {
      const { PluginSettings } = await import('../models/PluginSettings.js');
      
      const record = await PluginSettings.findOne({
        pluginName: 'scheduler',
        settingsKey: 'reportSettings'
      });

      if (record) {
        const settings = record.settingsValue;
        
        // Ensure we have valid values
        if (!settings.frequency) {
          settings.frequency = 7;
        }
        if (!settings.time) {
          settings.time = '09:00';
        }
        
        // Calculate next report time
        settings.nextReport = this.calculateNextReportTime(settings.frequency, settings.time);
        return settings;
      } else {
        // Return default settings
        const defaultSettings = {
          frequency: 7, // Weekly
          time: '09:00',
          nextReport: this.calculateNextReportTime(7, '09:00')
        };
        return defaultSettings;
      }
    } catch (error) {
      logger.error('Failed to get report settings:', error);
      return {
        frequency: 7,
        time: '09:00',
        nextReport: null
      };
    }
  }

  async setReportSettings(frequency, time) {
    try {
      const { PluginSettings } = await import('../models/PluginSettings.js');
      
      const settings = {
        frequency: parseInt(frequency),
        time: time,
        lastUpdate: new Date()
      };

      await PluginSettings.findOneAndUpdate(
        {
          pluginName: 'scheduler',
          settingsKey: 'reportSettings'
        },
        {
          pluginName: 'scheduler',
          settingsKey: 'reportSettings',
          settingsValue: settings
        },
        {
          upsert: true,
          new: true
        }
      );

      // Reschedule the job with new settings
      await this.rescheduleReportJob(settings);
      
      // Calculate next report time for response
      settings.nextReport = this.calculateNextReportTime(settings.frequency, settings.time);
      
      logger.info('Report settings updated:', settings);
      return settings;
    } catch (error) {
      logger.error('Failed to set report settings:', error);
      throw error;
    }
  }

  calculateNextReportTime(frequency, time) {
    try {
      const now = new Date();
      
      // Default to 9:00 AM if time is not provided
      if (!time) {
        time = '09:00';
      }
      
      const [hours, minutes] = time.split(':').map(Number);
      
      const next = new Date(now);
      next.setHours(hours, minutes, 0, 0);
      
      // If time has passed today, add frequency days
      if (next <= now) {
        next.setDate(next.getDate() + frequency);
      }
      
      return next;
    } catch (error) {
      logger.error('Error calculating next report time:', error);
      return null;
    }
  }

  async rescheduleReportJob(settings) {
    try {
      // Cancel existing report jobs
      await this.agenda.cancel({ name: 'system-status-report' });
      await this.agenda.cancel({ name: 'weekly-report' }); // Clean up old name
      
      // Validate settings
      if (!settings || !settings.time) {
        logger.warn('Invalid report settings, using defaults');
        settings = { frequency: 7, time: '09:00' };
      }
      
      // Create new cron expression based on settings
      const [hours, minutes] = settings.time.split(':');
      let cronExpression;
      
      if (settings.frequency === 1) {
        // Daily
        cronExpression = `${minutes} ${hours} * * *`;
      } else if (settings.frequency === 7) {
        // Weekly (Mondays)
        cronExpression = `${minutes} ${hours} * * 1`;
      } else if (settings.frequency === 30) {
        // Monthly (1st of each month)
        cronExpression = `${minutes} ${hours} 1 * *`;
      } else {
        // Custom frequency - just use daily for now (could be improved)
        cronExpression = `${minutes} ${hours} * * *`;
      }
      
      // Schedule new job
      await this.agenda.every(cronExpression, 'system-status-report');
      
      logger.info(`Report job rescheduled with cron: ${cronExpression} (frequency: ${settings.frequency} days)`);
    } catch (error) {
      logger.error('Failed to reschedule report job:', error);
      throw error;
    }
  }

  // Get job status for API
  async getJobStatus() {
    // Only get jobs that are relevant (not ancient completed ones)
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - 24); // 24 hours ago
    
    const jobs = await this.agenda.jobs({
      $or: [
        { nextRunAt: { $exists: true } }, // Scheduled jobs
        { lockedAt: { $exists: true } }, // Running jobs
        { lastFinishedAt: { $gte: cutoffDate } }, // Recent completions
        { failedAt: { $gte: cutoffDate } }, // Recent failures
        { repeatInterval: { $exists: true } } // Recurring jobs
      ]
    });
    
    const now = new Date();
    const stats = {
      total: jobs.length,
      running: 0,
      scheduled: 0,
      completed: 0,
      failed: 0,
      active: 0 // Jobs that have run recently or are running
    };
    
    const jobDetails = [];
    
    // Debug logging for first few jobs
    if (jobs.length > 0) {
      logger.debug(`Sample job attributes:`, {
        name: jobs[0].attrs.name,
        lockedAt: jobs[0].attrs.lockedAt,
        lastRunAt: jobs[0].attrs.lastRunAt,
        lastFinishedAt: jobs[0].attrs.lastFinishedAt,
        nextRunAt: jobs[0].attrs.nextRunAt,
        failedAt: jobs[0].attrs.failedAt
      });
    }
    
    for (const job of jobs) {
      const attrs = job.attrs;
      
      // Determine job state
      let state = 'unknown';
      let isRecurring = attrs.repeatInterval || attrs.type === 'single';
      
      // Priority order for state determination:
      // 1. Currently running (highest priority)
      if (attrs.lockedAt && (!attrs.lastFinishedAt || new Date(attrs.lockedAt) > new Date(attrs.lastFinishedAt))) {
        stats.running++;
        state = 'running';
      } 
      // 2. Recently failed (and not recovered)
      else if (attrs.failedAt && (!attrs.lastFinishedAt || new Date(attrs.failedAt) > new Date(attrs.lastFinishedAt))) {
        stats.failed++;
        state = 'failed';
      }
      // 3. For recurring jobs - they're always "scheduled" unless running or failed
      else if (isRecurring && attrs.repeatInterval) {
        stats.scheduled++;
        state = 'scheduled';
        
        // Track if it's been active recently
        if (attrs.lastFinishedAt && (now - new Date(attrs.lastFinishedAt)) < 3600000) { // Within last hour
          stats.active++;
        }
      }
      // 4. One-time jobs scheduled for the future
      else if (attrs.nextRunAt && new Date(attrs.nextRunAt) > now && !attrs.repeatInterval) {
        stats.scheduled++;
        state = 'scheduled';
      }
      // 5. Completed one-time jobs
      else if (attrs.lastFinishedAt && !attrs.repeatInterval) {
        stats.completed++;
        state = 'completed';
      }
      // 6. Default case - assume scheduled
      else {
        stats.scheduled++;
        state = 'scheduled';
      }
      
      jobDetails.push({
        name: attrs.name,
        nextRunAt: attrs.nextRunAt,
        lastRunAt: attrs.lastRunAt,
        lastFinishedAt: attrs.lastFinishedAt,
        failedAt: attrs.failedAt,
        failReason: attrs.failReason,
        repeatInterval: attrs.repeatInterval,
        state: state,
        running: state === 'running'
      });
    }
    
    // Log stats summary for debugging
    logger.debug('Job stats summary:', {
      total: stats.total,
      running: stats.running,
      scheduled: stats.scheduled,
      completed: stats.completed,
      failed: stats.failed,
      active: stats.active
    });
    
    return { stats, jobs: jobDetails };
  }

  // Alert throttling methods
  shouldSendAlert(alertType) {
    const alert = this.healthAlerts[alertType];
    if (!alert) return false;
    
    const now = Date.now();
    const lastAlert = alert.lastAlert;
    
    // Send alert if never sent before or cooldown period has passed
    return !lastAlert || (now - lastAlert.getTime()) > alert.alertCooldown;
  }

  markAlertSent(alertType) {
    if (this.healthAlerts[alertType]) {
      this.healthAlerts[alertType].lastAlert = new Date();
      logger.info(`Health alert sent for ${alertType}, next alert allowed after cooldown`);
    }
  }

  // Track resource usage over time
  trackResourceUsage(type, value) {
    const history = this.resourceHistory[type];
    if (!history) return;
    
    history.push({
      timestamp: new Date(),
      value: value
    });
    
    // Keep only recent history
    if (history.length > this.resourceHistory.maxHistorySize) {
      history.shift();
    }
  }
  
  // Check for extended high usage
  async checkExtendedHighUsage(type, threshold, minMinutes) {
    const history = this.resourceHistory[type];
    if (!history || history.length < minMinutes) {
      return { isHigh: false };
    }
    
    // Count how many recent samples are above threshold
    const recentSamples = history.slice(-minMinutes);
    const highSamples = recentSamples.filter(s => s.value > threshold);
    
    // Calculate average
    const average = recentSamples.reduce((sum, s) => sum + s.value, 0) / recentSamples.length;
    
    // Determine if consistently high (at least 80% of samples above threshold)
    const isHigh = highSamples.length >= (minMinutes * 0.8);
    
    return {
      isHigh,
      duration: highSamples.length,
      average,
      samples: recentSamples.length
    };
  }
  
  // Analyze recent operations from logs
  async analyzeRecentOperations() {
    try {
      const { SystemLog } = await import('../models/SystemLog.js');
      
      // Get recent performance logs
      const recentLogs = await SystemLog.find({
        category: { $in: ['performance', 'ai', 'system'] },
        createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } // Last 10 minutes
      }).sort({ createdAt: -1 }).limit(50);
      
      // Get operation history from operation logger if available
      const operations = this.agent.operationLogger ? 
        this.agent.operationLogger.getHistory(20, { 
          startTime: new Date(Date.now() - 10 * 60 * 1000) 
        }) : [];
      
      // Analyze for resource-intensive operations
      const intensiveOps = [];
      
      // Check for AI operations (usually CPU intensive)
      const aiOps = recentLogs.filter(log => 
        log.category === 'ai' || 
        log.message.toLowerCase().includes('ai') ||
        log.message.toLowerCase().includes('generate')
      );
      if (aiOps.length > 0) {
        intensiveOps.push(`AI processing (${aiOps.length} operations)`);
      }
      
      // Check for bug fixing or self-modification
      const autoOps = recentLogs.filter(log => 
        log.message.toLowerCase().includes('bug fix') ||
        log.message.toLowerCase().includes('self-modif') ||
        log.message.toLowerCase().includes('code analysis')
      );
      if (autoOps.length > 0) {
        intensiveOps.push(`Autonomous services (${autoOps.length} operations)`);
      }
      
      // Check for git operations
      const gitOps = operations.filter(op => op.plugin === 'git');
      if (gitOps.length > 0) {
        intensiveOps.push(`Git operations (${gitOps.length})`);
      }
      
      // Check for docker operations
      const dockerOps = operations.filter(op => op.plugin === 'docker');
      if (dockerOps.length > 0) {
        intensiveOps.push(`Docker operations (${dockerOps.length})`);
      }
      
      // Build summary
      let summary = '**Recent Operations:**\n';
      if (intensiveOps.length > 0) {
        summary += 'Potentially resource-intensive operations detected:\n';
        summary += intensiveOps.map(op => `• ${op}`).join('\n');
      } else {
        summary += 'No obvious resource-intensive operations found in recent logs.\n';
        summary += 'High usage may be from external processes.';
      }
      
      // Add operation count
      const totalOps = operations.length;
      if (totalOps > 0) {
        summary += `\n\nTotal operations in last 10 minutes: ${totalOps}`;
      }
      
      return { summary, operations, intensiveOps };
      
    } catch (error) {
      logger.error('Failed to analyze recent operations:', error);
      return { 
        summary: '**Recent Operations:** Unable to analyze logs', 
        operations: [], 
        intensiveOps: [] 
      };
    }
  }

  // Shutdown
  async restoreReportSettings() {
    try {
      const { PluginSettings } = await import('../models/PluginSettings.js');
      
      // Find saved report settings
      const savedSettings = await PluginSettings.findOne({
        pluginName: 'scheduler',
        settingsKey: 'reportSettings'
      });
      
      if (savedSettings && savedSettings.settingsValue) {
        const settings = savedSettings.settingsValue;
        logger.info('Restoring saved report settings:', settings);
        
        // Reschedule the report job with saved settings
        await this.rescheduleReportJob(settings);
        
        logger.info('Report settings restored successfully');
      } else {
        logger.info('No saved report settings found, using defaults');
      }
    } catch (error) {
      logger.error('Failed to restore report settings:', error);
      // Don't throw - allow scheduler to continue with default settings
    }
  }

  async shutdown() {
    // Clean up interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      logger.debug('Cleaned up scheduler interval');
    }
    
    // Stop agenda
    if (this.agenda) {
      await this.agenda.stop();
      logger.info('Task scheduler shut down');
    }
  }

  formatAgentUptime() {
    try {
      // Get agent start time from database or process start
      const agentStartTime = this.agent?.startupTime || (Date.now() - process.uptime() * 1000);
      const uptimeMs = Date.now() - agentStartTime;
      
      const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
      const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      
      if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
      } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
      } else {
        return `${minutes}m`;
      }
    } catch (error) {
      return 'Unknown';
    }
  }

}

export default TaskScheduler;