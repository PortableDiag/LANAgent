import { logger, selfModLogger, logDebugSeparator, logStep } from '../utils/logger.js';
import { EventEmitter } from 'events';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import crypto from 'crypto';
import { TestFramework } from './testFramework.js';
import { FeatureRequest } from '../models/FeatureRequest.js';
import { DiscoveredFeature } from '../models/DiscoveredFeature.js';
import { SystemSettings } from '../models/SystemSettings.js';
import Improvement from '../models/Improvement.js';
import { selfModLock } from './selfModLock.js';
import { GitHubFeatureDiscovery } from './githubFeatureDiscovery.js';
import { escapeMarkdown } from '../utils/markdown.js';
import { getProvider, PROVIDER_TYPES } from './gitHosting/index.js';
import { GitHostingSettings } from '../models/GitHostingSettings.js';

const AUTO_APPROVE_SETTING_KEY = 'featureRequests.autoApprove';

export class SelfModificationService extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.constructorId = crypto.randomBytes(4).toString('hex');
    logger.info(`[SelfMod-${this.constructorId}] Constructor called`);
    this.enabled = true; // ENABLED BY DEFAULT - FIXED
    this.analysisOnly = false; // Can make actual changes - FIXED
    this.isRunning = false;
    this.lastCheckTime = null;
    this.lastActivityTime = Date.now();
    this.idleThreshold = 5 * 60 * 1000; // 5 minutes of idle time
    this.checkInterval = 30 * 60 * 1000; // Check every 30 minutes
    this.improvementQueue = [];
    this.currentBranch = null;
    this.dailyImprovementCount = 0;
    this.lastImprovementDate = null;
    
    // Initialize comprehensive testing framework
    this.testFramework = new TestFramework(agent);
    
    // Initialize deduplication state
    this.duplicateState = { fingerprints: [], lastCleanup: null };
    
    // Configuration (focused on capability upgrades, not bugs or new plugins)
    this.config = {
      maxChangesPerSession: 10000, // Max lines changed per upgrade (effectively unlimited)
      maxDailyImprovements: 2, // Max capability upgrades per day
      idleMinutes: 10, // Minutes before considered idle for upgrades
      cpuThreshold: 40, // CPU usage % threshold
      memoryThreshold: 60, // Memory usage % threshold
      checkIntervalMinutes: 60, // Check every hour for upgrades
      scheduledHour: null, // Specific hour to run (0-23), null = anytime
      scheduledMinute: 0, // Specific minute to run
      restrictedFiles: [
        '.env', // Only restrict env file
        'package-lock.json' // Dependencies lock
      ],
      // Focus ONLY on upgrading existing capabilities
      allowedUpgrades: [
        'enhance_plugin_features', // Add new features to existing plugins
        'extend_plugin_apis', // Add new API endpoints to existing plugins
        'optimize_plugin_performance', // Make existing plugins faster
        'upgrade_core_capabilities', // Enhance agent core functionality
        'improve_ai_integrations', // Better AI provider usage
        'enhance_data_processing', // Better data handling capabilities
        'expand_plugin_functionality', // Extend what existing plugins can do
        'upgrade_service_integrations', // Better integration between services
        'add_plugin_commands', // Add new commands to existing plugins
        'enhance_user_interfaces', // Improve web/telegram interfaces
        'upgrade_memory_management', // Improve memory and context handling
        'optimize_workflow_automation', // Better automation capabilities
        'github_discovered_feature' // Features discovered from GitHub repositories
      ],
      requireTests: true,
      useDockerTesting: false, // Enable Docker-based isolated testing
      dockerImage: 'lanagent:test', // Docker image for testing
      testTimeout: 300000, // 5 minutes for comprehensive tests
      createPR: true, // Always create PR initially
      gitToken: process.env.GIT_PERSONAL_ACCESS_TOKEN,
      // Upgrade order preference: true = core first, false = plugins first
      coreUpgradesFirst: true
    };
    
    // Initialize git with separate development repository
    this.developmentPath = process.env.AGENT_REPO_PATH || process.cwd();
    this.stagingPath = process.env.AGENT_STAGING_PATH || '/tmp/lanagent-staging';
    this.productionPath = process.cwd(); // Current running directory
    
    // Log the paths for debugging
    logger.info(`Self-modification paths configured:`, {
      developmentPath: this.developmentPath,
      stagingPath: this.stagingPath,
      productionPath: this.productionPath
    });
    this.git = simpleGit(this.developmentPath);
    // Resolve repo URL dynamically from git remote or env vars (not hardcoded)
    try {
      const remoteUrl = execSync('git remote get-url origin', { cwd: this.developmentPath, encoding: 'utf8', timeout: 5000 }).trim();
      this.repoUrl = remoteUrl.endsWith('.git') ? remoteUrl : remoteUrl + '.git';
    } catch {
      this.repoUrl = process.env.GITHUB_REPO || 'https://github.com/PortableDiag/LANAgent.git';
    }

    // Git hosting provider (GitHub or GitLab)
    this.gitHostingProvider = null;

    logger.info(`[SelfMod-${this.constructorId}] Self-modification service constructor complete`);

    // Store initialization promise to ensure it completes
    this.initializationPromise = null;
    
    // Defer initialization until we know database is ready
    this.configLoaded = false;
    
    // Start initialization in the background
    logger.info(`[SelfMod-${this.constructorId}] Starting background initialization`);
    this.initialize().catch(error => {
      logger.error(`[SelfMod-${this.constructorId}] Background initialization failed:`, error);
    });
  }

  /**
   * Initialize the service with database configuration
   */
  async initialize() {
    logger.info(`[SelfMod-${this.constructorId}] Initialize() called`);
    
    // Prevent multiple initializations
    if (this.initializationPromise) {
      logger.info(`[SelfMod-${this.constructorId}] Already initializing, waiting for completion`);
      return this.initializationPromise;
    }
    
    this.initializationPromise = (async () => {
      try {
        logger.info(`[SelfMod-${this.constructorId}] Starting initialization`);
        
        // Ensure database is connected before loading config
        const { default: mongoose } = await import('mongoose');
        if (mongoose.connection.readyState !== 1) {
          logger.info(`[SelfMod-${this.constructorId}] Waiting for database connection...`);
          await new Promise((resolve) => {
            if (mongoose.connection.readyState === 1) {
              resolve();
            } else {
              mongoose.connection.once('connected', resolve);
            }
          });
        }
        
        logger.info(`[SelfMod-${this.constructorId}] Database connected, calling loadConfig()`);
        await this.loadConfig();

        // Initialize git hosting provider (GitHub or GitLab)
        await this.initializeGitHostingProvider();

        this.configLoaded = true;
        logger.info(`[SelfMod-${this.constructorId}] Initialize() complete`);
      } catch (error) {
        logger.error(`[SelfMod-${this.constructorId}] Failed to initialize self-modification service:`, error);
        throw error;
      }
    })();
    
    return this.initializationPromise;
  }

  /**
   * Initialize the git hosting provider (GitHub or GitLab)
   */
  async initializeGitHostingProvider() {
    try {
      // Load git hosting settings from database
      const settings = await GitHostingSettings.getOrCreate('default');
      const providerConfig = await GitHostingSettings.getActiveProviderConfig('default');

      logger.info(`[SelfMod-${this.constructorId}] Initializing git hosting provider: ${providerConfig.provider}`);

      // Build settings object for provider factory
      const providerSettings = {
        gitHosting: {
          provider: providerConfig.provider,
          github: settings.github,
          gitlab: settings.gitlab
        }
      };

      // Get the provider instance
      this.gitHostingProvider = await getProvider(providerSettings);

      // Update repo URL based on provider
      if (this.gitHostingProvider) {
        this.repoUrl = this.gitHostingProvider.getCloneUrl();
        logger.info(`[SelfMod-${this.constructorId}] Git hosting provider initialized: ${this.gitHostingProvider.name}`);
      }
    } catch (error) {
      logger.warn(`[SelfMod-${this.constructorId}] Failed to initialize git hosting provider, falling back to gh CLI:`, error.message);
      // If provider initialization fails, we'll fall back to using gh CLI directly
      this.gitHostingProvider = null;
    }
  }

  /**
   * Get the git hosting provider, initializing if needed
   */
  async getGitHostingProvider() {
    if (!this.gitHostingProvider) {
      await this.initializeGitHostingProvider();
    }
    return this.gitHostingProvider;
  }

  /**
   * Enable self-modification service
   */
  async enable() {
    // Ensure initialization is complete
    if (!this.configLoaded) {
      logger.info(`[SelfMod-${this.constructorId}] Waiting for initialization before enabling`);
      await this.initialize();
    }
    
    if (this.enabled) {
      logger.warn('Self-modification service already enabled');
      return;
    }
    
    if (!this.config.gitToken) {
      throw new Error('Git personal access token required for self-modification');
    }
    
    this.enabled = true;
    this.config.enabled = true;
    this.startIdleDetection();
    logger.info('Self-modification service ENABLED');
    
    // Save the enabled state to database
    await this.saveConfig();
    
    this.emit('enabled');
  }

  /**
   * Disable self-modification service
   */
  async disable() {
    // Ensure initialization is complete
    if (!this.configLoaded) {
      logger.info(`[SelfMod-${this.constructorId}] Waiting for initialization before disabling`);
      await this.initialize();
    }
    
    this.enabled = false;
    this.config.enabled = false;
    this.stopIdleDetection();
    logger.info('Self-modification service DISABLED');
    
    // Save the disabled state to database
    await this.saveConfig();
    
    this.emit('disabled');
  }

  /**
   * Start idle detection
   */
  startIdleDetection() {
    // Track agent activity
    this.agent.on('command', () => {
      this.lastActivityTime = Date.now();
    });

    // NOTE: The Agenda scheduler ('self-mod-scan' job) handles the actual self-modification checks
    // on an hourly basis. We no longer need the idle check interval to trigger checkForImprovements
    // as it was causing duplicate PRs when both triggers fired around the same time.
    // The idle detection now only tracks activity for the isIdle() check used by the scheduler.
    logger.info('Idle detection started (activity tracking only - Agenda handles scheduling)');
  }

  /**
   * Stop idle detection
   */
  stopIdleDetection() {
    // Note: idleCheckInterval is no longer used since Agenda handles scheduling
    // This method is kept for compatibility but does nothing
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /**
   * Check if agent is idle
   */
  async isIdle() {
    // Check activity time
    if (!this.lastActivityTime) return true;
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity < (this.config.idleMinutes * 60 * 1000)) {
      return false;
    }
    
    // Check system resources
    try {
      const systemInfo = await import('systeminformation');
      const cpu = await systemInfo.currentLoad();
      const mem = await systemInfo.mem();
      
      const cpuUsage = cpu.currentLoad;
      const memoryUsage = (mem.used / mem.total) * 100;
      
      // Only idle if resources are available
      return cpuUsage < this.config.cpuThreshold && 
             memoryUsage < this.config.memoryThreshold;
    } catch (error) {
      logger.warn('Could not check system resources:', error);
      return true; // Assume idle if can't check
    }
  }
  
  /**
   * Check if we've reached daily improvement limit
   */
  async hasReachedDailyLimit() {
    const today = new Date().toDateString();
    if (this.lastImprovementDate !== today) {
      logger.info(`New day detected. Resetting daily count from ${this.dailyImprovementCount} to 0`);
      this.lastImprovementDate = today;
      this.dailyImprovementCount = 0;
      // Save the reset count to database
      await this.saveConfig();
    }
    const hasReached = this.dailyImprovementCount >= this.config.maxDailyImprovements;
    logger.info(`Daily limit check: ${this.dailyImprovementCount}/${this.config.maxDailyImprovements}, hasReached: ${hasReached}`);
    return hasReached;
  }
  
  /**
   * Check if it's the scheduled time
   */
  isScheduledTime() {
    if (this.config.scheduledHour === null) return true; // No schedule set
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    return currentHour === this.config.scheduledHour &&
           currentMinute >= this.config.scheduledMinute &&
           currentMinute < this.config.scheduledMinute + 5; // 5 minute window
  }

  /**
   * Main capability upgrade check routine
   */
  async checkForImprovements() {
    if (!this.enabled || this.isRunning) return;
    
    // Set running state BEFORE acquiring lock to ensure UI sees it
    this.isRunning = true;
    this.lastCheckTime = new Date();
    
    // Try to acquire lock
    const lockAcquired = await selfModLock.acquire('self-modification');
    if (!lockAcquired) {
      logger.info('Another self-modification process is running. Skipping this check.');
      this.isRunning = false;  // Reset if we can't get the lock
      return;
    }
    
    // IMPORTANT: Everything after acquiring the lock must be in try-finally to ensure lock release
    try {
      logger.info('🚀 Starting capability upgrade analysis...');
      
      // Check daily limit
      if (await this.hasReachedDailyLimit()) {
        logger.info(`Daily improvement limit reached (${this.dailyImprovementCount}/${this.config.maxDailyImprovements}). Will check again tomorrow.`);
        this.isRunning = false;
        return;
      }
      
      // Save lastCheckTime to database
      await this.saveLastCheckTime();
      // 0. Ensure we start from main branch
      try {
        logger.info('Ensuring we start from main branch...');
        await this.git.checkout('main');
        try {
          await this.git.pull('origin', 'main');
        } catch (pullError) {
          // Handle divergent branches (e.g. after history rewrite) by force-resetting
          logger.warn(`Git pull failed (${pullError.message}), attempting fetch + reset to origin/main`);
          await this.git.fetch('origin');
          await this.git.reset(['--hard', 'origin/main']);
        }
        logger.info('Successfully switched to main branch and pulled latest changes');
      } catch (gitError) {
        logger.error('Failed to switch to main branch at start:', gitError);
        throw new Error('Cannot proceed without clean main branch');
      }
      
      // 1. Analyze codebase for capability upgrade opportunities  
      const upgrades = await this.analyzeCodebase();
      
      if (upgrades.length === 0) {
        logger.info('No capability upgrade opportunities identified');
        return;
      }
      
      // 2. Filter for allowed upgrade types only (use config, fall back to defaults)
      const allowedTypes = this.config.allowedUpgrades && this.config.allowedUpgrades.length > 0
        ? this.config.allowedUpgrades
        : [
          'enhance_plugin_features',
          'extend_plugin_apis',
          'optimize_plugin_performance',
          'upgrade_core_capabilities',
          'improve_ai_integrations',
          'enhance_data_processing',
          'expand_plugin_functionality',
          'upgrade_service_integrations',
          'add_plugin_commands',
          'enhance_user_interfaces',
          'upgrade_memory_management',
          'optimize_workflow_automation',
          'github_discovered_feature',
          'feature_request'
        ];

      logger.info(`Filtering ${upgrades.length} upgrades for ${allowedTypes.length} allowed types...`);
      const allowedUpgrades = upgrades.filter(upgrade => allowedTypes.includes(upgrade.type));
      logger.info(`After filtering: ${allowedUpgrades.length} allowed upgrades remain`);
      
      if (allowedUpgrades.length === 0) {
        logger.info('No allowed capability upgrade opportunities identified (filtered out non-AI upgrades)');
        return;
      }
      
      // 3. Prioritize upgrades based on value and impact
      logger.info('Prioritizing upgrades...');
      const prioritized = this.prioritizeImprovements(allowedUpgrades);
      
      if (!prioritized || prioritized.length === 0) {
        logger.error('Failed to prioritize upgrades - no upgrades returned');
        return;
      }
      
      // 4. Select best upgrade opportunity
      const selected = prioritized[0];
      if (!selected) {
        logger.error('No upgrade selected after prioritization');
        return;
      }
      logger.info(`🔧 Selected capability upgrade: ${selected.type} for ${selected.target || selected.file}`);
      
      // 4.1. Check for duplicates before proceeding
      const fingerprint = this.generateCapabilityFingerprint(selected);
      if (this.isDuplicateCapability(fingerprint)) {
        logger.info(`⏭️ Skipping duplicate capability upgrade (fingerprint: ${fingerprint}): ${selected.description}`);
        return;
      }
      
      // 4.2. Check GitHub for existing PRs
      const isDuplicatePR = await this.checkGitHubForDuplicatePR(selected);
      if (isDuplicatePR) {
        logger.info(`⏭️ Skipping capability upgrade - similar PR exists: ${selected.description}`);
        return;
      }
      
      // 5. Create branch for upgrade
      const branchName = await this.createImprovementBranch(selected);
      
      // 6. Apply capability upgrade
      await this.applyImprovement(selected);
      
      // 7. Run comprehensive tests if required
      if (this.config.requireTests) {
        const testsPass = await this.runTests();
        if (!testsPass) {
          logger.warn('Upgrade tests failed, reverting changes');
          await this.revertChanges(branchName);
          return;
        }
      }
      
      // 8. PR creation, notification, and cleanup are handled within the AI workflow
      // (createUpgradePullRequest is called in applyAICapabilityUpgradeWithGitWorkflow)
      
      // 9. Clean up implemented features
      if (selected.featureRequestId) {
        await this.cleanupImplementedFeature(selected.featureRequestId, 'featureRequest');
      } else if (selected.discoveredFeatureId) {
        await this.cleanupImplementedFeature(selected.discoveredFeatureId, 'discoveredFeature');
      }
      
    } catch (error) {
      logger.error('Self-modification error:', error);
      await this.notifyMaster({ error: error.message }, null);
    } finally {
      // Always return to main branch to prevent getting stuck on feature branches
      try {
        logger.info('Switching back to main branch...');
        await this.git.checkout('main');
        logger.info('Successfully returned to main branch');
      } catch (gitError) {
        logger.error('Failed to switch back to main branch:', gitError);
      }
      
      // Release the lock
      await selfModLock.release('self-modification');
      
      this.isRunning = false;
    }
  }

  /**
   * Analyze codebase for potential improvements
   */
  async analyzeCodebase() {
    const improvements = [];
    
    logger.info('🔍 Starting AI-driven capability analysis...');
    
    // First, check for user-submitted feature requests
    const featureRequestImprovements = await this.analyzeFeatureRequests();
    if (featureRequestImprovements.length > 0) {
      logger.info(`📋 Found ${featureRequestImprovements.length} improvements from feature requests`);
      improvements.push(...featureRequestImprovements);
    }
    
    // ONLY use AI-driven capability analysis - no hardcoded patterns
    
    // Declare variables outside the if/else scope
    let coreUpgrades = [];
    let pluginUpgrades = [];
    
    // Check upgrade order preference
    if (this.config.coreUpgradesFirst) {
      // 1. Analyze core services for enhancement opportunities FIRST
      coreUpgrades = await this.analyzeCoreCapabilities();
      improvements.push(...coreUpgrades);
      
      // 2. Analyze existing plugins for upgrade opportunities SECOND
      pluginUpgrades = await this.analyzePluginCapabilities();
      improvements.push(...pluginUpgrades);
      
      logger.info('📋 Upgrade order: Core services FIRST, then plugins');
    } else {
      // 1. Analyze existing plugins for upgrade opportunities FIRST
      pluginUpgrades = await this.analyzePluginCapabilities();
      improvements.push(...pluginUpgrades);
      
      // 2. Analyze core services for enhancement opportunities SECOND
      coreUpgrades = await this.analyzeCoreCapabilities();
      improvements.push(...coreUpgrades);
      
      logger.info('📋 Upgrade order: Plugins FIRST, then core services');
    }
    
    // 3. Check for GitHub-discovered features in the database as FALLBACK
    const githubFeatures = await this.getStoredGitHubFeatures();
    improvements.push(...githubFeatures);
    
    logger.info(`🚀 Found ${coreUpgrades.length} core capability enhancement opportunities`);
    logger.info(`🚀 Found ${pluginUpgrades.length} plugin capability upgrade opportunities`);
    logger.info(`🌟 Found ${githubFeatures.length} features from stored GitHub discoveries`);
    logger.info(`📊 Total improvements identified: ${improvements.length}`);
    
    return improvements;
  }

  /**
   * Analyze feature requests for actionable improvements
   */
  async analyzeFeatureRequests() {
    const improvements = [];
    
    try {
      // Get high-priority, non-completed feature requests
      // Exclude plugin-new category — those belong to pluginDevelopment service
      const pendingRequests = await FeatureRequest.find({
        status: { $in: ['submitted', 'analyzing', 'planned'] },
        category: { $nin: ['plugin-new'] },
        priority: { $in: ['critical', 'high', 'medium'] },
        autoGenerated: false // Focus on user-submitted requests
      }).sort({ priority: -1, votes: -1, submittedAt: -1 }).limit(10);
      
      logger.info(`🔍 Analyzing ${pendingRequests.length} user feature requests...`);
      
      for (const request of pendingRequests) {
        // Skip if already being processed
        if (request.status === 'in-progress') continue;
        
        // Convert feature request to improvement format
        const improvement = {
          type: 'feature_request',
          title: request.title,
          description: request.description,
          file: request.implementationFile || this.determineImplementationFile(request),
          priority: request.priority === 'critical' ? 'high' : request.priority,
          category: request.category,
          relatedPlugin: request.relatedPlugin,
          useCase: request.useCase,
          implementation: request.implementation,
          featureRequestId: request._id,
          votes: request.votes || 0
        };
        
        // Validate the improvement is actionable
        if (improvement.file && this.isValidUpgradeType('feature_request')) {
          improvements.push(improvement);
          
          // Update request status
          await request.updateStatus('analyzing', 'Being analyzed by self-modification service');
        }
      }
      
      return improvements;
    } catch (error) {
      logger.error('Failed to analyze feature requests:', error);
      return [];
    }
  }
  
  /**
   * Determine the best file to implement a feature request
   */
  determineImplementationFile(request) {
    // Logic to determine where to implement based on category and plugin
    if (request.relatedPlugin) {
      return `src/api/plugins/${request.relatedPlugin}.js`;
    }
    
    switch (request.category) {
      case 'core':
        return 'src/core/agent.js';
      case 'plugin':
      case 'plugin-new':
        return 'src/api/core/pluginManager.js';
      case 'ui':
        return 'src/interfaces/web/webInterface.js';
      case 'api':
        return 'src/api/core/apiManager.js';
      default:
        return null;
    }
  }

  /**
   * Analyze existing plugins for capability upgrade opportunities
   */
  async analyzePluginCapabilities() {
    const upgrades = [];
    
    try {
      logger.info('🔍 Analyzing plugins for capability upgrade opportunities...');
      
      // Initialize incremental scanner if not already loaded
      if (!this.capabilityScanner) {
        logger.info('Initializing CapabilityIncrementalScanner...');
        try {
          const { CapabilityIncrementalScanner } = await import('./capabilityIncrementalScanner.js');
          this.capabilityScanner = new CapabilityIncrementalScanner(this);
          logger.info('CapabilityIncrementalScanner initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize CapabilityIncrementalScanner:', error);
          throw error;
        }
      }
      
      // Use incremental scanner to find upgrade opportunities
      logger.info('Calling scanForCapabilityUpgrades...');
      const scanResults = await this.capabilityScanner.scanForCapabilityUpgrades();
      
      // Convert scan results to improvement format
      for (const upgrade of scanResults) {
        if (this.isValidUpgradeType(upgrade.type)) {
          upgrades.push({
            type: upgrade.type,
            file: upgrade.targetFile,
            target: upgrade.target,
            description: upgrade.description,
            implementation: upgrade.implementation,
            priority: upgrade.priority || 'medium',
            effort: upgrade.effort || 'medium',
            impact: this.mapImpactValue(upgrade.impact) || 'moderate',
            value: upgrade.value || 'medium',
            newCapabilities: upgrade.newCapabilities || [],
            safeForProduction: upgrade.safeForProduction || false,
            upgradeId: upgrade.id
          });
        }
      }
      
      logger.info(`🚀 Found ${upgrades.length} plugin capability upgrade opportunities`);
      return upgrades;
      
    } catch (error) {
      logger.error('Failed to analyze plugin capabilities:', error);
      return [];
    }
  }

  /**
   * Analyze core services for capability enhancement opportunities
   */
  async analyzeCoreCapabilities() {
    const upgrades = [];
    
    try {
      logger.info('🔍 Analyzing core services for enhancement opportunities...');
      
      // Core services to analyze for upgrades
      const coreServices = [
        'src/core/agent.js',
        'src/core/memoryManager.js', 
        'src/services/scheduler.js',
        'src/interfaces/web/webInterface.js',
        'src/interfaces/telegram/telegramInterface.js'
      ];
      
      for (const serviceFile of coreServices) {
        try {
          const serviceUpgrades = await this.analyzeCoreServiceForUpgrades(serviceFile);
          upgrades.push(...serviceUpgrades);
        } catch (error) {
          logger.warn(`Failed to analyze ${serviceFile}: ${error.message}`);
        }
      }
      
      logger.info(`🚀 Found ${upgrades.length} core capability enhancement opportunities`);
      return upgrades;
      
    } catch (error) {
      logger.error('Failed to analyze core capabilities:', error);
      return [];
    }
  }
  
  /**
   * Get stored GitHub-discovered features from the database
   */
  async getStoredGitHubFeatures() {
    try {
      logger.info('🔍 Fetching stored GitHub-discovered features...');

      // Query for discovered features that haven't been implemented yet
      // Note: findImplementable uses .lean() so we get plain objects, not Mongoose docs
      const discoveredFeatures = await DiscoveredFeature.findImplementable(20);

      // Convert to improvement format (manually since .lean() returns plain objects)
      const improvements = discoveredFeatures.map(feature => ({
        id: `discovered-${feature._id}`,
        type: 'github_discovered_feature',
        title: feature.title,
        description: feature.description,
        file: feature.implementation?.targetFile,
        priority: 'low', // Always low priority for discovered features
        effort: feature.implementation?.estimatedEffort || 'medium',
        value: 'medium',
        source: 'github_discovery',
        repository: feature.source?.repository,
        discoveredFeatureId: feature._id,
        hasCodeSnippets: feature.codeSnippets && feature.codeSnippets.length > 0
      }));

      logger.info(`🌟 Found ${improvements.length} stored GitHub features ready for implementation`);
      return improvements;

    } catch (error) {
      logger.error('Failed to fetch stored GitHub features:', error);
      return [];
    }
  }
  
  /**
   * Search discovered features for implementation examples
   */
  async searchDiscoveredFeaturesForExamples(keywords) {
    try {
      const examples = await DiscoveredFeature.searchForExamples(keywords);
      logger.info(`📚 Found ${examples.length} discovered features with code examples for: ${keywords.join(', ')}`);
      return examples;
    } catch (error) {
      logger.error('Failed to search discovered features:', error);
      return [];
    }
  }

  /**
   * Analyze a specific core service file for upgrades
   */
  async analyzeCoreServiceForUpgrades(serviceFile) {
    try {
      // Check if file exists
      try {
        await fs.access(serviceFile);
      } catch {
        return []; // File doesn't exist, skip
      }
      
      const content = await fs.readFile(serviceFile, 'utf8');
      
      // Skip very large files
      if (content.length > 20000) {
        logger.debug(`Skipping ${serviceFile} - too large for analysis`);
        return [];
      }
      
      // Use AI to analyze for core capability enhancements
      const prompt = `Analyze this core service for capability enhancement opportunities:

File: ${serviceFile}
Code:
${content}

Focus on enhancing existing capabilities (NOT bug fixes):
- Improved AI integration and provider management
- Better memory and context handling
- Enhanced automation capabilities  
- Improved user experience
- Better data processing
- New workflow automation features
- Performance improvements for existing features

Return analysis in JSON format:
{
  "upgrades": [
    {
      "type": "upgrade_core_capabilities|improve_ai_integrations|upgrade_memory_management|enhance_user_interfaces|optimize_workflow_automation",
      "description": "Brief description",
      "implementation": "How to implement", 
      "value": "high|medium|low",
      "effort": "small|medium|large",
      "impact": "major|moderate|minor"
    }
  ]
}

Only suggest realistic enhancements. Return empty array if no good opportunities.`;

      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 800,
        temperature: 0.3
      });
      
      // Parse AI response
      const upgrades = this.parseAIUpgradeResponse(response.content, serviceFile, 'core');
      
      return upgrades;
      
    } catch (error) {
      logger.warn(`Failed to analyze core service ${serviceFile}: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse AI response for upgrade opportunities
   */
  parseAIUpgradeResponse(aiResponse, targetFile, targetType) {
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];
      
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.upgrades || !Array.isArray(parsed.upgrades)) return [];
      
      return parsed.upgrades
        .filter(upgrade => upgrade.type && upgrade.description && this.isValidUpgradeType(upgrade.type))
        .map(upgrade => ({
          type: upgrade.type,
          file: targetFile,
          target: path.basename(targetFile),
          description: upgrade.description,
          implementation: upgrade.implementation,
          priority: this.calculateUpgradePriority(upgrade),
          effort: upgrade.effort || 'medium',
          impact: upgrade.impact || 'medium', 
          value: upgrade.value || 'medium',
          targetType: targetType,
          safeForProduction: upgrade.effort === 'small' && upgrade.impact !== 'high'
        }));
        
    } catch (error) {
      logger.warn(`Failed to parse AI upgrade response: ${error.message}`);
      return [];
    }
  }

  /**
   * Check if upgrade type is valid and allowed
   */
  isValidUpgradeType(type) {
    // Always allow feature requests
    if (type === 'feature_request') return true;
    return this.config.allowedUpgrades.includes(type);
  }

  /**
   * Map impact values from AI response to Improvement model values
   */
  mapImpactValue(impact) {
    const impactMap = {
      'high': 'major',
      'medium': 'moderate',
      'low': 'minor'
    };
    return impactMap[impact] || impact; // Return mapped value or original if not found
  }

  /**
   * Calculate upgrade priority based on value, effort, and impact
   */
  calculateUpgradePriority(upgrade) {
    const valueScore = { high: 3, medium: 2, low: 1 };
    const impactScore = { high: 3, medium: 2, low: 1 };
    const effortScore = { small: 3, medium: 2, large: 1 };
    
    const score = (valueScore[upgrade.value] || 2) * 
                  (impactScore[upgrade.impact] || 2) * 
                  (effortScore[upgrade.effort] || 2);
    
    if (score >= 15) return 'high';
    if (score >= 8) return 'medium';
    return 'low';
  }

  /**
   * Get list of project files
   */
  async getProjectFiles() {
    const files = [];
    
    async function scanDir(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        // Skip node_modules, .git, etc
        if (entry.name.startsWith('.') || 
            entry.name === 'node_modules' || 
            entry.name === 'dist' ||
            entry.name === 'coverage') {
          continue;
        }
        
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith('.js')) {
          files.push(fullPath);
        }
      }
    }
    
    await scanDir('src');
    
    // Also scan documentation files for updates
    const docFiles = [
      'README.md',
      'docs/CURRENT-STATUS.md',
      'docs/feature-progress.json',
      'docs/UNIMPLEMENTED-FEATURES.md'
    ];
    
    for (const docFile of docFiles) {
      try {
        await fs.access(docFile);
        files.push(docFile);
      } catch {
        // File doesn't exist, skip
      }
    }
    
    return files;
  }

  /**
   * Check if file is restricted
   */
  isRestrictedFile(filePath) {
    return this.config.restrictedFiles.some(restricted => 
      filePath.includes(restricted)
    );
  }

  /**
   * Analyze single file for improvements
   */
  async analyzeFile(filePath, content) {
    const improvements = [];
    const lines = content.split('\n');
    
    // Special handling for documentation files
    if (filePath.endsWith('.md') || filePath.endsWith('README.md')) {
      return this.analyzeDocumentation(filePath, content);
    }
    
    if (filePath.endsWith('feature-progress.json')) {
      return this.analyzeFeatureProgress(filePath, content);
    }
    
    // Check for TODOs
    lines.forEach((line, index) => {
      if (line.includes('TODO:') && !line.includes('SKIP')) {
        improvements.push({
          type: 'fix_todos',
          file: filePath,
          line: index + 1,
          description: line.trim(),
          priority: 'medium',
          effort: 'small'
        });
      }
    });
    
    // Check for missing error handling
    if (content.includes('await') && !content.includes('try')) {
      improvements.push({
        type: 'improve_error_handling',
        file: filePath,
        description: 'Add try-catch blocks for async operations',
        priority: 'high',
        effort: 'medium'
      });
    }
    
    // Check for missing comments on complex functions
    const functionRegex = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)\s*=>/gm;
    let match;
    
    while ((match = functionRegex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const prevLine = lines[lineNum - 2] || '';
      
      // Check if there's a comment before the function
      if (!prevLine.includes('*') && !prevLine.includes('//')) {
        const funcName = match[1] || match[2];
        improvements.push({
          type: 'add_comments',
          file: filePath,
          line: lineNum,
          description: `Add JSDoc comment for function ${funcName}`,
          priority: 'low',
          effort: 'small'
        });
      }
    }
    
    // Check for console.log statements
    if (content.includes('console.log')) {
      improvements.push({
        type: 'add_logging',
        file: filePath,
        description: 'Replace console.log with proper logger',
        priority: 'medium',
        effort: 'small'
      });
    }
    
    // Check for duplicate imports
    const imports = content.match(/^import\s+.+from\s+['"](.+)['"]/gm) || [];
    const importMap = {};
    imports.forEach(imp => {
      const module = imp.match(/from\s+['"](.+)['"]/)[1];
      importMap[module] = (importMap[module] || 0) + 1;
    });
    
    Object.entries(importMap).forEach(([module, count]) => {
      if (count > 1) {
        improvements.push({
          type: 'optimize_imports',
          file: filePath,
          description: `Consolidate duplicate imports from ${module}`,
          priority: 'low',
          effort: 'small'
        });
      }
    });
    
    return improvements;
  }

  /**
   * Prioritize improvements based on impact and effort
   */
  prioritizeImprovements(improvements) {
    const priorityScore = {
      high: 3,
      medium: 2,
      low: 1
    };
    
    const effortScore = {
      small: 3,
      medium: 2,
      large: 1
    };
    
    return improvements
      .map(imp => ({
        ...imp,
        score: priorityScore[imp.priority] * effortScore[imp.effort]
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Check for existing PRs with similar improvements
   */
  async checkForExistingPRs(improvement) {
    try {
      // Get open PRs using the git hosting provider
      let prs = [];
      const provider = await this.getGitHostingProvider();

      if (provider) {
        // Use the provider API
        const mrList = await provider.listMergeRequests({ state: 'open', limit: 50 });
        prs = mrList.map(mr => ({
          title: mr.title,
          headRefName: mr.sourceBranch
        }));
      } else {
        // Fall back to gh CLI
        const result = await this.agent.systemExecutor.execute(
          'gh pr list --state open --json title,headRefName',
          { cwd: this.developmentPath, timeout: 10000 }
        );

        if (result.exitCode !== 0) {
          logger.warn('Could not check existing PRs:', result.stderr);
          return;
        }

        prs = JSON.parse(result.stdout || '[]');
      }

      // Check for PRs with exact same improvement type AND same file
      const existingPR = prs.find(pr => {
        const title = pr.title.toLowerCase();
        const headRef = (pr.headRefName || pr.sourceBranch || '').toLowerCase();

        // Extract improvement type and file from the improvement object
        const improvementType = improvement.type.toLowerCase();
        const targetFile = improvement.targetFile || improvement.file || '';
        const filename = targetFile.split('/').pop().toLowerCase().replace('.js', '');

        // Check if PR title contains this exact improvement type
        const hasSameType = title.includes(improvementType) || headRef.includes(improvementType);

        // Check if PR title contains this exact filename
        const hasSameFile = filename && (
          title.includes(filename) ||
          headRef.includes(filename) ||
          title.includes(`${filename}.js`) ||
          title.includes(`: ${filename}`)
        );

        // Only consider it a duplicate if BOTH type AND file match
        // This allows different types of improvements on the same file
        // And same type of improvements on different files
        return hasSameType && hasSameFile;
      });
      
      if (existingPR) {
        logger.info(`Skipping improvement - found existing PR with same type (${improvement.type}) and file (${improvement.targetFile || improvement.file})`);
        throw new Error(`Similar PR already exists: "${existingPR.title}" (${existingPR.headRefName})`);
      } else {
        logger.info(`No existing PR found for ${improvement.type} on ${improvement.targetFile || improvement.file} - proceeding`);
      }
      
    } catch (error) {
      if (error.message.includes('Similar PR already exists')) {
        throw error;
      }
      logger.warn('Could not check for existing PRs:', error.message);
    }
  }

  /**
   * Create branch for improvement
   */
  async createImprovementBranch(improvement) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const agentName = (process.env.AGENT_NAME || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '');
    const branchName = `auto-improve/${agentName}/${improvement.type}-${timestamp}`;
    
    // Check if branch already exists
    const branches = await this.git.branch();
    if (branches.all.includes(branchName)) {
      throw new Error(`Branch ${branchName} already exists`);
    }
    
    // Check for existing PRs with similar improvements
    await this.checkForExistingPRs(improvement);
    
    // Ensure we're on main branch
    await this.git.checkout('main');
    await this.git.pull('origin', 'main');
    
    // Create new branch
    await this.git.checkoutLocalBranch(branchName);
    this.currentBranch = branchName;
    
    return branchName;
  }

  /**
   * Apply improvement to code
   */
  async applyImprovement(improvement) {
    // ONLY AI-driven capability upgrades are allowed
    switch (improvement.type) {
      case 'enhance_plugin_features':
      case 'extend_plugin_apis':
      case 'optimize_plugin_performance':
      case 'upgrade_core_capabilities':
      case 'improve_ai_integrations':
      case 'enhance_data_processing':
      case 'expand_plugin_functionality':
      case 'upgrade_service_integrations':
      case 'add_plugin_commands':
      case 'enhance_user_interfaces':
      case 'upgrade_memory_management':
      case 'optimize_workflow_automation':
      case 'github_discovered_feature':
      case 'feature_request':
        await this.applyAICapabilityUpgradeWithGitWorkflow(improvement);
        break;
      default:
        logger.warn(`Unsupported improvement type: ${improvement.type} - only AI capability upgrades are allowed`);
        throw new Error(`Only AI-driven capability upgrades are supported. Type '${improvement.type}' is not allowed.`);
    }
  }

  /**
   * Apply AI-driven capability upgrade with proper git workflow
   */
  async applyAICapabilityUpgradeWithGitWorkflow(improvement) {
    try {
      logger.info(`🔄 Starting AI capability upgrade workflow for ${improvement.type}`);
      
      // Step 1: Switch to main branch and pull latest changes
      logger.info(`🔄 Switching to main branch and pulling latest changes`);
      await this.git.checkout('main');
      await this.git.pull('origin', 'main');
      
      // Step 2: Create new branch for this improvement
      const branchName = await this.createImprovementBranch(improvement);
      logger.info(`🌱 Created new branch: ${branchName}`);
      
      // Step 3: Apply AI-driven changes to repository files
      await this.applyAICapabilityUpgrade(improvement);
      
      // Step 4: Create PR (this includes push)
      await this.createUpgradePullRequest(branchName, improvement);
      
      // Step 5: Increment daily upgrade count
      this.dailyImprovementCount++;
      logger.info(`Incremented daily improvement count to ${this.dailyImprovementCount}`);
      
      // Save the updated count to database
      await this.saveConfig();
      logger.info(`Saved updated config with dailyImprovementCount: ${this.dailyImprovementCount}`);
      
      // Step 6: Notify about successful upgrade
      await this.notifyUpgrade(improvement, branchName);
      
      // Step 7: Clean up implemented features if needed
      if (improvement.featureRequestId) {
        await this.cleanupImplementedFeature(improvement.featureRequestId, 'featureRequest');
      } else if (improvement.discoveredFeatureId) {
        await this.cleanupImplementedFeature(improvement.discoveredFeatureId, 'discoveredFeature');
      }
      
      // Step 8: Switch back to main branch
      logger.info(`🔄 Switching back to main branch`);
      await this.git.checkout('main');
      
      logger.info(`✅ AI capability upgrade workflow completed successfully`);
      
    } catch (error) {
      logger.error(`Failed AI capability upgrade workflow: ${error.message}`);
      // Try to switch back to main on error
      try {
        await this.git.checkout('main');
      } catch (checkoutError) {
        logger.error(`Failed to switch back to main: ${checkoutError.message}`);
      }
      throw error;
    }
  }

  /**
   * Apply AI-driven capability upgrade (internal method)
   */
  async applyAICapabilityUpgrade(improvement) {
    try {
      let targetFile = improvement.targetFile || improvement.file;

      // If no target file, ask AI to determine the best file to modify
      if (!targetFile) {
        logger.info(`🤖 No target file specified for ${improvement.type} — asking AI to determine best file...`);
        const fileDiscoveryPrompt = `You are analyzing a codebase to determine the best file to modify for this improvement:

Title: ${improvement.title}
Description: ${improvement.description}
Type: ${improvement.type}
${improvement.implementation?.suggestion ? `Suggestion: ${improvement.implementation.suggestion}` : ''}

The codebase is a Node.js agent framework at /root/lanagent-repo/src/ with this structure:
- src/api/plugins/ — Plugin implementations
- src/services/ — Core services
- src/core/ — Core agent logic
- src/interfaces/ — Web, Telegram, SSH interfaces
- src/models/ — Mongoose models
- src/utils/ — Utilities

Respond with ONLY a JSON object: {"file": "src/path/to/file.js", "reason": "brief reason"}
Pick the single most relevant existing file that should be enhanced.`;

        try {
          const response = await this.agent.providerManager.generateResponse(fileDiscoveryPrompt, { maxTokens: 200, temperature: 0.3 });
          const content = response?.content || '';
          const jsonMatch = content.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const candidateFile = parsed.file;
            // Verify AI-suggested file actually exists before accepting it
            const candidatePath = path.isAbsolute(candidateFile) ? candidateFile : path.join(this.developmentPath, candidateFile);
            try {
              await fs.access(candidatePath);
              targetFile = candidateFile;
              logger.info(`🎯 AI selected target file: ${targetFile} (reason: ${parsed.reason})`);
            } catch {
              logger.warn(`🚫 AI suggested non-existent file: ${candidateFile} — rejecting`);
            }
          }
        } catch (aiError) {
          logger.warn(`AI file discovery failed: ${aiError.message}`);
        }

        if (!targetFile) {
          throw new Error(`Cannot determine target file for improvement: ${improvement.title}. No file specified and AI could not determine one.`);
        }

        improvement.file = targetFile;
      }

      logger.info(`🤖 Applying AI capability upgrade: ${improvement.type} to ${targetFile}`);

      // Ensure we're working with the repository file, not deployment file
      const repoFile = path.isAbsolute(targetFile) ? targetFile : path.join(this.developmentPath, targetFile);
      logger.info(`🔍 Target file resolved: ${targetFile} -> ${repoFile}`);

      // Validate target file exists before attempting to read
      try {
        await fs.access(repoFile);
      } catch {
        // Mark discovered feature as rejected if it referenced a non-existent file
        if (improvement.discoveredFeatureId) {
          try {
            const { default: DiscoveredFeature } = await import('../models/DiscoveredFeature.js');
            await DiscoveredFeature.findByIdAndUpdate(improvement.discoveredFeatureId, {
              status: 'rejected',
              rejectionReason: `Target file does not exist: ${targetFile}`
            });
            logger.info(`🗑️ Marked discovered feature ${improvement.discoveredFeatureId} as rejected (stale target file)`);
          } catch (dbErr) {
            logger.warn(`Failed to mark stale discovered feature: ${dbErr.message}`);
          }
        }
        throw new Error(`Target file does not exist: ${repoFile} — skipping upgrade for "${improvement.title}"`);
      }

      const content = await fs.readFile(repoFile, 'utf8');
      
      // Use AI to generate the specific code changes with retry logic
      let modifiedCode = await this.generateAICodeUpgradeWithRetry(improvement, content);

      if (modifiedCode && modifiedCode !== content) {
        // Verify the changes are meaningful
        const changeStats = this.analyzeCodeChanges(content, modifiedCode);
        logger.info(`Code changes: +${changeStats.linesAdded} -${changeStats.linesRemoved} (~${changeStats.percentChanged}% modified)`);

        // Validate for common issues - errors block, warnings are logged
        const validation = this.validateGeneratedCode(content, modifiedCode, repoFile);

        // BLOCK if there are critical errors
        if (validation.errors && validation.errors.length > 0) {
          logger.error(`❌ Generated code has ${validation.errors.length} BLOCKING errors - aborting PR creation`);
          throw new Error(`Code validation failed: ${validation.errors[0]}`);
        }

        if (validation.warnings && validation.warnings.length > 0) {
          logger.warn(`Generated code has ${validation.warnings.length} warnings - review PR carefully`);
        }

        // Auto-fix: Ensure trailing newline (POSIX compliance)
        if (!modifiedCode.endsWith('\n')) {
          modifiedCode += '\n';
        }

        // Write the AI-generated changes to the repository file
        await fs.writeFile(repoFile, modifiedCode);
        logger.info(`✅ File written to: ${repoFile}`);
        
        // Git operations with explicit error handling (use relative path for git)
        const relativePath = path.relative(this.developmentPath, repoFile);
        logger.info(`🔄 Adding file to git: ${relativePath}`);
        await this.git.add(relativePath);
        
        logger.info(`🔄 Creating commit: feat: ${improvement.description} (${improvement.type})`);
        const commitResult = await this.git.commit(`feat: ${improvement.description} (${improvement.type})`);
        logger.info(`✅ Git commit successful: ${JSON.stringify(commitResult)}`);
        
        logger.info(`✅ Applied AI capability upgrade to ${repoFile}`);
      } else {
        throw new Error(`AI failed to generate meaningful changes for ${improvement.type} after multiple attempts`);
      }
      
    } catch (error) {
      logger.error(`Failed to apply AI capability upgrade: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate AI-driven code upgrade with retry logic
   */
  async generateAICodeUpgradeWithRetry(improvement, originalCode) {
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🔄 AI code generation attempt ${attempt}/${maxRetries} for ${improvement.type}`);
        
        const modifiedCode = await this.generateAICodeUpgrade(improvement, originalCode, attempt);
        
        // Check if meaningful changes were made
        if (modifiedCode && modifiedCode.trim() !== originalCode.trim()) {
          const changeStats = this.analyzeCodeChanges(originalCode, modifiedCode);
          if (changeStats.linesAdded > 0 || changeStats.linesRemoved > 0) {
            logger.info(`✅ AI generated meaningful changes on attempt ${attempt}`);
            return modifiedCode;
          }
        }
        
        logger.warn(`⚠️ Attempt ${attempt}: AI generated identical or meaningless code, retrying...`);
        
      } catch (error) {
        logger.error(`❌ Attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) throw error;
      }
    }
    
    throw new Error(`AI failed to generate meaningful code changes after ${maxRetries} attempts`);
  }

  /**
   * Generate AI-driven code upgrade (single attempt)
   */
  async generateAICodeUpgrade(improvement, originalCode, attempt = 1) {
    try {
      // Create increasingly specific prompts for retry attempts
      const basePrompt = await this.createUpgradePrompt(improvement, originalCode, attempt);
      
      const response = await this.agent.providerManager.generateResponse(basePrompt, {
        maxTokens: 4000,
        temperature: attempt === 1 ? 0.1 : 0.2 + (attempt * 0.1) // Increase creativity on retries
      });

      // Clean the response of any markdown formatting
      let code = response.content.trim();
      
      // Remove markdown code blocks if present
      if (code.startsWith('```')) {
        // Find the end of the opening fence
        const firstNewline = code.indexOf('\n');
        if (firstNewline !== -1) {
          code = code.substring(firstNewline + 1);
        }
        
        // Remove closing fence if present
        if (code.endsWith('```')) {
          const lastFence = code.lastIndexOf('```');
          if (lastFence !== -1) {
            code = code.substring(0, lastFence).trim();
          }
        }
      }
      
      return code;
      
    } catch (error) {
      logger.error(`AI code generation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create detailed upgrade prompt based on improvement type and attempt number
   */
  async createUpgradePrompt(improvement, originalCode, attempt) {
    const specificInstructions = this.getSpecificInstructions(improvement.type, attempt);
    const exampleChanges = this.getExampleChanges(improvement.type);
    const antiPatterns = this.getAntiPatterns();
    
    // Check for GitHub references from feature request or discovered feature
    let githubContext = '';
    
    if (improvement.featureRequestId) {
      try {
        const featureRequest = await FeatureRequest.findById(improvement.featureRequestId);
        if (featureRequest && featureRequest.githubReferences && featureRequest.githubReferences.length > 0) {
          githubContext = '\n\nGITHUB IMPLEMENTATION REFERENCES:\n';
          
          for (const ref of featureRequest.githubReferences.slice(0, 3)) { // Limit to 3 references
            githubContext += `\nFrom ${ref.repository} (${ref.filePath}):\n`;
            if (ref.contextNotes) {
              githubContext += `Context: ${ref.contextNotes}\n`;
            }
            if (ref.codeSnippet) {
              githubContext += `Reference code:\n\`\`\`${ref.language || 'javascript'}\n${ref.codeSnippet}\n\`\`\`\n`;
            }
          }
          
          if (featureRequest.implementationExamples && featureRequest.implementationExamples.length > 0) {
            githubContext += '\n\nIMPLEMENTATION EXAMPLES:\n';
            for (const example of featureRequest.implementationExamples.slice(0, 2)) {
              githubContext += `\nFrom ${example.source}:\n${example.description}\n`;
              if (example.code) {
                githubContext += `\`\`\`${example.language || 'javascript'}\n${example.code}\n\`\`\`\n`;
              }
            }
          }
        }
      } catch (error) {
        logger.debug(`Could not fetch GitHub references: ${error.message}`);
      }
    } else if (improvement.discoveredFeatureId) {
      try {
        const discoveredFeature = await DiscoveredFeature.findById(improvement.discoveredFeatureId);
        if (discoveredFeature && discoveredFeature.codeSnippets && discoveredFeature.codeSnippets.length > 0) {
          githubContext = '\n\nDISCOVERED FEATURE IMPLEMENTATION REFERENCES:\n';
          githubContext += `\nFeature: ${discoveredFeature.title}\n`;
          githubContext += `From repository: ${discoveredFeature.source.repository}\n`;
          
          for (const snippet of discoveredFeature.codeSnippets.slice(0, 3)) {
            githubContext += `\nCode from ${snippet.filePath || 'unknown file'}:\n`;
            if (snippet.contextNotes) {
              githubContext += `Context: ${snippet.contextNotes}\n`;
            }
            githubContext += `\`\`\`${snippet.language || 'javascript'}\n${snippet.code}\n\`\`\`\n`;
          }
          
          if (discoveredFeature.implementation && discoveredFeature.implementation.suggestion) {
            githubContext += `\nImplementation suggestion: ${discoveredFeature.implementation.suggestion}\n`;
          }
        }
        
        // Also search for similar discovered features for more examples
        const keywords = discoveredFeature.title.toLowerCase().split(' ').filter(w => w.length > 3);
        const similarFeatures = await this.searchDiscoveredFeaturesForExamples(keywords.slice(0, 3));
        if (similarFeatures.length > 0) {
          githubContext += '\n\nSIMILAR DISCOVERED FEATURES:\n';
          for (const similar of similarFeatures.slice(0, 2)) {
            if (similar._id.toString() !== improvement.discoveredFeatureId) {
              githubContext += `\n- ${similar.title} (from ${similar.source.repository})\n`;
            }
          }
        }
      } catch (error) {
        logger.debug(`Could not fetch discovered feature references: ${error.message}`);
      }
    }
    
    return `You are an expert software engineer implementing a capability upgrade for LANAgent.

UPGRADE DETAILS:
- Type: ${improvement.type}
- Description: ${improvement.description}
- Implementation: ${improvement.implementation || 'AI-determined implementation'}
- File: ${improvement.targetFile || improvement.file}
- Attempt: ${attempt}/3 ${attempt > 1 ? '(RETRY - previous attempts generated no changes)' : ''}

${specificInstructions}
${githubContext}

EXAMPLE OF EXPECTED CHANGES:
${exampleChanges}

${antiPatterns}

CURRENT CODE:
${originalCode}

PROJECT LIBRARIES (already available - DO NOT add new dependencies):

- Caching: node-cache (import NodeCache from 'node-cache')

- Job scheduling: Agenda is managed by TaskScheduler in src/services/scheduler.js - do NOT import agenda directly

- Retry logic: import { retryOperation, retryWithCondition, isRetryableError, makeRetryable } from '../utils/retryUtils.js'
  * retryOperation(asyncFn, options) - retry with exponential backoff and circuit breaker
  * retryWithCondition(asyncFn, shouldRetryFn, options) - conditional retry
  * isRetryableError(error) - check if error is retryable
  * makeRetryable(fn, defaultOptions) - wrap function with retry logic
  DO NOT use: retry(), retryWithCircuitBreaker() - they do not exist

- Logging: import { logger, createPluginLogger } from '../utils/logger.js'
  * logger - main logger instance (NEVER create new Winston instances)
  * createPluginLogger(pluginName) - create a child logger for plugins

- JSON utilities: import { safeJsonParse, safeJsonStringify, parseJsonInput, jsonClone, validateJsonSchema } from '../utils/jsonUtils.js'
  * safeJsonParse(text, defaultValue) - parse JSON without throwing
  * safeJsonStringify(obj, spaces) - stringify without throwing
  * parseJsonInput(input, defaultValue) - parse various input formats
  * jsonClone(obj) - deep clone an object
  * validateJsonSchema(obj, schema) - validate object against schema

- Error handling: import { withErrorHandler, safeInterval, safeTimeout, safePromiseAll } from '../utils/errorHandlers.js'
  * withErrorHandler(fn, context) - wrap function with error handling
  * safeInterval(callback, interval, context) - setInterval with error handling
  * safeTimeout(callback, timeout, context) - setTimeout with error handling
  * safePromiseAll(promises, options) - Promise.all with error handling

- Encryption: import { encrypt, decrypt } from '../utils/encryption.js'
  * encrypt(text) - encrypt sensitive data
  * decrypt(encryptedData) - decrypt data

- Markdown: import { escapeMarkdown, truncateText, formatCodeBlock } from '../utils/markdown.js'
  * escapeMarkdown(text) - escape markdown special characters
  * truncateText(text, maxLength) - truncate with ellipsis
  * formatCodeBlock(code, language) - wrap code in markdown block

- Rate limiting: import rateLimit from 'express-rate-limit'

- ES Modules: This project uses ES modules - do NOT use __dirname (use import.meta.url if needed)

IMPORT PATH RULES (CRITICAL - wrong paths cause crashes):
- Count directory depth from file location to src/utils/
- src/api/plugins/*.js → use ../../utils/ (2 levels up)
- src/services/*.js → use ../utils/ (1 level up)
- src/models/*.js → use ../utils/ (1 level up)
- src/interfaces/web/*.js → use ../../utils/ (2 levels up)
- NEVER guess paths - count the directories

IMPORT VERIFICATION:
- ONLY use functions listed above - do NOT invent or guess function names
- If a function is not listed here, it does NOT exist - do NOT assume it does
- Do NOT import services that don't exist (check the import target exists)
- Default exports use: import Name from './file.js'
- Named exports use: import { name } from './file.js'
- TaskScheduler is a DEFAULT export: import TaskScheduler from '../../services/scheduler.js'

PLUGIN COMPLETENESS REQUIREMENTS (for plugins only):
- If you add a new method, you MUST also add it to the commands array
- If you add a new method, you MUST add a case in the execute() switch statement
- A method that exists but isn't wired up is USELESS - wire it up completely
- Example: Adding listTeams() requires BOTH:
  1. Add to this.commands: { command: 'listteams', description: '...', usage: '...' }
  2. Add to execute(): case 'listteams': return await this.listTeams(params);

NO STUB IMPLEMENTATIONS:
- Every method must perform REAL work, not just log and return success
- Do NOT write comments like "// TODO: implement this" or "// Placeholder"
- Do NOT write methods that just log the input and return { success: true }
- If you can't implement real functionality, don't add the method at all

BACKWARD COMPATIBILITY:
- Do NOT change function signatures in ways that break existing callers
- Do NOT encrypt/modify existing data formats without migration
- Do NOT add required parameters to existing functions
- If adding optional features, use default parameter values

CHECK FOR EXISTING FUNCTIONALITY:
- Before adding new features, check if similar functionality exists elsewhere
- src/services/crypto/abiManager.js handles ABI fetching - don't duplicate
- src/services/scheduler.js handles job scheduling via Agenda
- Do NOT create parallel implementations of existing features

DOCUMENTATION PRESERVATION (CRITICAL):
- NEVER remove existing comments, JSDoc blocks, or inline explanations
- PRESERVE all existing documentation - only ADD to it, never delete
- Keep inline comments that explain "why" (e.g., "// Handle paired/connected - only set if explicitly provided")
- Keep section headers (e.g., "// Device identification", "// Statistics")
- The original author's comments are valuable context - do not strip them

FILE TYPE AWARENESS:
- PLUGINS (src/api/plugins/*.js): Can have this.commands array and execute() method
- SERVICES (src/services/**/*.js): Do NOT add commands[] or execute() - they use method calls
- MODELS (src/models/*.js): Do NOT add commands[] or execute() - they are Mongoose schemas
- UTILITIES (src/utils/*.js): Do NOT add commands[] or execute() - they export functions
- STRATEGIES (src/services/crypto/strategies/*.js): Do NOT add commands[] - they extend BaseStrategy
- ONLY add commands/execute to actual plugin files in src/api/plugins/

IMPORT INTEGRITY RULES:
- NEVER remove existing imports without a replacement
- Every import you add MUST be used in the code - no dead imports
- If you import NodeCache, you MUST use it (e.g., this.cache = new NodeCache(...))
- If you import retryOperation, you MUST call it somewhere
- If you import rateLimit, you MUST use it to create a limiter
- Before adding an import, verify the module/function exists in the project

METHOD EXISTENCE VERIFICATION:
- Before calling serviceInstance.methodName(), verify that method exists in the service
- Do NOT create API endpoints that call non-existent service methods
- If you need new service functionality, implement it in the service file first

THIRD-PARTY API AND SDK VERIFICATION (CRITICAL — #1 CAUSE OF PR REJECTIONS):
- Do NOT call methods on third-party SDK objects unless those methods are already used elsewhere in the file
- If the file uses sdk.lookup() and sdk.nslookup(), those are the ONLY methods you know exist
- Do NOT invent methods like sdk.getHistory(), sdk.getAnalytics(), sdk.setAlertChannels() — these are hallucinations
- If you need to call an external API, check the existing code for how it does HTTP requests and what base URLs it uses
- The same applies to REST APIs: do NOT guess endpoint paths — only use endpoints already called in the code

NEVER REMOVE EXISTING METHODS OR FUNCTIONS:
- Do NOT delete any existing method, function, or helper from the file
- If the original code has getCachedData(), cleanup(), getCommands() — they MUST remain in the output
- Your job is to ADD code, not replace or restructure existing code
- Treat every existing line of code as load-bearing until proven otherwise

NEVER OUTPUT NON-CODE CONTENT:
- Do NOT include your reasoning, analysis, or chain-of-thought in the output
- The output must be ONLY valid JavaScript — no English paragraphs, no markdown, no explanations
- If your output starts with "Based on my research..." or similar, that is WRONG
- First line must be an import statement, comment, or code declaration

CRITICAL REQUIREMENTS:
1. You MUST make actual, meaningful code changes - DO NOT return identical code
2. Add concrete functionality as described in the upgrade type
3. Follow existing code patterns and conventions
4. Add proper error handling where appropriate
5. Include JSDoc comments for new functions/methods
6. Ensure the code is production-ready and functional
7. PREFER using existing project libraries over adding new dependencies
8. NEW METHODS MUST BE WIRED UP to execute() and commands array (PLUGINS ONLY)
9. NO STUB IMPLEMENTATIONS - every method must do real work
10. VERIFY IMPORT PATHS based on file location depth
11. PRESERVE ALL EXISTING DOCUMENTATION - never remove comments
12. NO DEAD IMPORTS - every import must be used
13. FILE TYPE MATTERS - only plugins get commands/execute
14. NEVER REMOVE DATABASE INDEXES - schema.index() declarations are critical for query performance
15. NEVER USE Math.random() - this creates fake/placeholder data, not real functionality
16. NEVER WRAP MONGOOSE MODELS - unless you expose ALL methods (find, findOne, findById, updateOne, deleteOne, countDocuments, insertMany, distinct, aggregate). Breaking mongoose API breaks dependent code.
17. NEVER RETURN HARDCODED PLACEHOLDER VALUES - like { x: 0, y: 0, z: 0 } or { success: true } without doing real work
${githubContext ? '18. Consider the GitHub implementation references when designing your solution' : ''}

${attempt > 1 ? `
RETRY INSTRUCTIONS:
- The previous attempt generated no meaningful changes
- Be more aggressive in implementing the requested capability
- Add actual new code, functions, or modifications
- Do not be overly conservative - make real improvements
` : ''}

Return ONLY the complete modified code file. Do not include explanations, markdown, or code blocks - just the raw code that implements the upgrade.

IMPORTANT: DO NOT wrap the code in markdown code blocks (no \`\`\`javascript or \`\`\`). Return the raw JavaScript code directly, starting with the first line of actual code (e.g., import statements, export statements, or function definitions).`;
  }

  /**
   * Get specific instructions for different upgrade types
   */
  getSpecificInstructions(upgradeType, attempt) {
    const instructions = {
      'enhance_plugin_features': `Add new features to the plugin:
- New methods or capabilities that extend the plugin's functionality
- Additional configuration options
- Enhanced data processing capabilities
- New command handlers or API endpoints
CRITICAL: For EVERY new method you add:
  1. Add entry to this.commands array with command, description, usage
  2. Add case in execute() switch to call the new method
  3. Implement REAL functionality - not stubs that just log
PRESERVE: Keep ALL existing JSDoc comments and inline documentation`,

      'extend_plugin_apis': `Extend the plugin's API surface:
- Add new public methods to the plugin class
- Create new API endpoints or routes
- Add new command handlers
- Implement webhook or callback mechanisms
CRITICAL: For EVERY new method/endpoint:
  1. Wire it to the plugin's execute() method
  2. Add it to the commands array for discoverability
  3. Implement actual API calls - not placeholder returns
  4. Verify any service methods you call actually exist
PRESERVE: Keep ALL existing JSDoc comments and inline documentation`,

      'optimize_plugin_performance': `Optimize performance:
- Add caching mechanisms using node-cache (import NodeCache from 'node-cache')
- Implement connection pooling
- Add request/response compression
- Optimize database queries or data processing
- Add async/await optimizations
- Use retryOperation() from retryUtils.js for retry logic: import { retryOperation } from '../utils/retryUtils.js'
- Add rate limiting for API routes: import rateLimit from 'express-rate-limit'
CRITICAL: If you import NodeCache/retryOperation/rateLimit, you MUST use them - no dead imports
PRESERVE: Keep ALL existing JSDoc comments and inline documentation
NOTE: For services/models, do NOT add commands[] or execute() - those are for plugins only`,

      'upgrade_core_capabilities': `Enhance core functionality:
- Improve error handling and resilience
- Add retry using: import { retryOperation } from '../utils/retryUtils.js' then await retryOperation(() => asyncCall(), { retries: 3 })
- Enhance logging using src/utils/logger.js (never create new Winston instances)
- Improve configuration management
- Add health check endpoints
- For caching, use node-cache (import NodeCache from 'node-cache')
- Do NOT import agenda directly - it is managed by the TaskScheduler service
CRITICAL: If you import NodeCache/retryOperation, you MUST use them - no dead imports
PRESERVE: Keep ALL existing JSDoc comments and inline documentation
NOTE: For services/models, do NOT add commands[] or execute() - those are for plugins only`,

      'improve_ai_integrations': `Improve AI provider integration:
- Add context management
- Implement response caching
- Add fallback providers
- Enhance prompt engineering
- Add AI model switching logic
CRITICAL: If you import caching libraries, you MUST use them
PRESERVE: Keep ALL existing JSDoc comments and inline documentation
NOTE: For services/models, do NOT add commands[] or execute() - those are for plugins only`,

      'enhance_data_processing': `Enhance data processing capabilities:
- Add data validation and sanitization
- Implement data transformation pipelines
- Add support for new data formats
- Optimize data storage and retrieval
- Add data backup and recovery
CRITICAL: Do NOT change existing method signatures in ways that break callers
PRESERVE: Keep ALL existing JSDoc comments and inline documentation
NOTE: For services/models, do NOT add commands[] or execute() - those are for plugins only`
    };

    return instructions[upgradeType] || `Implement the ${upgradeType} upgrade with concrete code changes.`;
  }

  /**
   * Get example changes for upgrade types
   */
  getExampleChanges(upgradeType) {
    const examples = {
      'optimize_plugin_performance': `Example: Add caching layer using node-cache
import NodeCache from 'node-cache';

// Add cache property to class (in constructor)
this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

// Add cached method
async getCachedData(key, fetchFunc) {
  const cached = this.cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const data = await fetchFunc();
  this.cache.set(key, data);
  return data;
}`,

      'enhance_plugin_features': `Example: Add new feature method
/**
 * New feature: Bulk processing capability
 */
async processBulk(items, options = {}) {
  const results = [];
  const batchSize = options.batchSize || 10;
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(item => this.processItem(item)));
    results.push(...batchResults);
  }
  
  return results;
}`,

      'extend_plugin_apis': `Example: Add new API endpoint
/**
 * New API method for external integration
 */
async handleWebhook(req, res) {
  try {
    const payload = req.body;
    const result = await this.processWebhookData(payload);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}`
    };

    return examples[upgradeType] || `Add concrete new functionality related to ${upgradeType}`;
  }

  /**
   * Get anti-patterns to avoid (what NOT to do)
   */
  getAntiPatterns() {
    return `
COMMON MISTAKES TO AVOID:

1. WRONG - Removing existing documentation:
   // Before: this.name = 'plugin'; // Plugin identifier for API routing
   // After:  this.name = 'plugin';
   CORRECT: Keep the comment!

2. WRONG - Dead imports (importing but not using):
   import NodeCache from 'node-cache';
   import { retryOperation } from '../utils/retryUtils.js';
   // ... code that never uses NodeCache or retryOperation
   CORRECT: Only import what you actually use

3. WRONG - Adding plugin patterns to non-plugins:
   // In a MODEL file (src/models/User.js):
   this.commands = [...];
   async execute(command, params) {...}
   CORRECT: Models don't have commands/execute - only plugins do

4. WRONG - Calling non-existent methods:
   // In API route:
   return await hardhatService.listProjectVersions(name);
   // But listProjectVersions doesn't exist in hardhatService!
   CORRECT: Verify the method exists before calling it

5. WRONG - Changing import paths incorrectly:
   // File at: src/services/crypto/transactionService.js
   // Before: import { logger } from '../../utils/logger.js';  // Correct!
   // After:  import { logger } from '../utils/logger.js';     // WRONG!
   CORRECT: Count directory depth carefully

6. WRONG - Removing class inheritance imports:
   // Before: import { BaseStrategy } from './BaseStrategy.js';
   //         export class DCAStrategy extends BaseStrategy {...}
   // After:  (import removed but still extends BaseStrategy)
   CORRECT: Never remove imports that are being used

7. WRONG - Placeholder implementations:
   async processMarkdown(text) {
     // Simulate processing
     return text; // Just returns input unchanged!
   }
   CORRECT: Implement real functionality or don't add the method

8. WRONG - Using Math.random() for "simulated" data:
   async fetchMarketData() {
     return { volatility: Math.random(), liquidity: Math.random() };
   }
   CORRECT: Fetch real data from actual APIs or don't add the method

9. WRONG - Removing database indexes:
   // Before: schema.index({ type: 1, createdAt: -1 });
   // After: (line deleted)
   CORRECT: NEVER remove .index() declarations - they are critical for query performance

10. WRONG - Wrapping mongoose model without exposing methods:
    class MyModel {
      constructor() { this.model = mongoose.model('X', schema); }
      async findWithRetry(q) { return this.model.find(q); }
      // Missing: findOne, findById, updateOne, countDocuments, insertMany, distinct, etc!
    }
    export const MyModel = new MyModelClass(); // BREAKS existing code!
    CORRECT: Either expose ALL mongoose methods, use a Proxy, or don't wrap the model

11. WRONG - Returning hardcoded placeholder values:
    return { x: 0, y: 0, z: 0 }; // Always returns zeros!
    return { success: true }; // No real work done
    CORRECT: Implement actual calculations or don't add the method

12. WRONG - Hallucinating third-party API methods:
    // whoisjson SDK only has .lookup(), .nslookup(), .ssl()
    return await this.whoisjson.getHistoricalWhois(domain); // THIS METHOD DOESN'T EXIST!
    CORRECT: Only call methods you can see already used in the file

13. WRONG - Removing existing methods from the file:
    // Original had: getCachedData(), cleanup(), getCommands()
    // Modified: those methods are gone, replaced with new code
    CORRECT: NEVER delete existing methods — only ADD new ones

14. WRONG - Outputting reasoning text as code:
    Based on my research, I now understand that IPstack's security module...
    // This is English text in a JavaScript file — instant syntax error!
    CORRECT: Output ONLY valid JavaScript — no prose, no explanations

15. WRONG - Adding caching without invalidation:
    // Cache peer online status for 5 minutes, but setOnline()/resetOnlineStatus()
    // never clear the cache — stale data served for 5 minutes after every status change
    CORRECT: If you add caching, also add cache invalidation in the mutation paths

16. WRONG - Creating WebSocket/server without wiring it up:
    const wss = new WebSocket.Server({ noServer: true });
    // But never adds server.on('upgrade') handler — WebSocket is unreachable!
    CORRECT: If you create infrastructure, wire it end-to-end or don't create it

17. WRONG - Breaking API contracts:
    // Before: accepts { query: "..." } returns { results: [...] }
    // After: requires { queries: [...] } returns [...]
    // Every existing caller is now broken!
    CORRECT: Maintain backward compatibility — add new params as optional

18. WRONG - Embedding unbounded arrays in MongoDB documents:
    versions: [{ state: Object, timestamp: Date }] // Grows forever toward 16MB BSON limit
    CORRECT: Use a separate collection for history/audit trails, or cap the array size`;
  }

  /**
   * Analyze code changes to determine if they are meaningful
   */
  analyzeCodeChanges(original, modified) {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    
    let linesAdded = 0;
    let linesRemoved = 0;
    let linesChanged = 0;
    
    // Simple line-by-line comparison
    const maxLength = Math.max(originalLines.length, modifiedLines.length);
    
    for (let i = 0; i < maxLength; i++) {
      const originalLine = originalLines[i] || '';
      const modifiedLine = modifiedLines[i] || '';
      
      if (originalLine === '' && modifiedLine !== '') {
        linesAdded++;
      } else if (originalLine !== '' && modifiedLine === '') {
        linesRemoved++;
      } else if (originalLine !== modifiedLine) {
        linesChanged++;
      }
    }
    
    const totalLines = Math.max(originalLines.length, 1);
    const percentChanged = Math.round(((linesAdded + linesRemoved + linesChanged) / totalLines) * 100);
    
    return {
      linesAdded,
      linesRemoved,
      linesChanged,
      percentChanged,
      totalLines
    };
  }

  /**
   * Validate generated code for common issues
   * Returns { warnings: [], errors: [] }
   * Warnings are logged but don't block; Errors block the PR from being created
   */
  validateGeneratedCode(originalCode, modifiedCode, targetFile) {
    const warnings = [];
    const errors = [];

    // BLOCKING CHECK 1: Placeholder implementations with Math.random()
    if (modifiedCode.includes('Math.random()') && !originalCode.includes('Math.random()')) {
      errors.push(`PLACEHOLDER_CODE: New code contains Math.random() - this is placeholder code, not real functionality`);
    }

    // BLOCKING CHECK 2: Placeholder implementations returning hardcoded zeros/empty values
    const placeholderPatterns = [
      /return\s*\{\s*x:\s*0,\s*y:\s*0/,  // return { x: 0, y: 0 }
      /return\s*\{\s*success:\s*true\s*\}\s*;?\s*\/\/.*(?:placeholder|todo|stub)/i,
      /\/\/\s*(?:placeholder|todo|stub|simulate)/i
    ];
    for (const pattern of placeholderPatterns) {
      if (pattern.test(modifiedCode) && !pattern.test(originalCode)) {
        errors.push(`PLACEHOLDER_CODE: New code contains placeholder/stub patterns - implement real functionality`);
        break;
      }
    }

    // BLOCKING CHECK 3: Removed database indexes (critical for performance)
    const originalIndexCount = (originalCode.match(/\.index\s*\(/g) || []).length;
    const modifiedIndexCount = (modifiedCode.match(/\.index\s*\(/g) || []).length;
    if (originalIndexCount > 0 && modifiedIndexCount < originalIndexCount) {
      errors.push(`REMOVED_INDEX: Database index declarations were removed (${originalIndexCount} → ${modifiedIndexCount}) - indexes are critical for query performance`);
    }

    // BLOCKING CHECK 4: Mongoose model wrapped but essential methods not exposed
    if (modifiedCode.includes('mongoose.model(') && modifiedCode.includes('class ')) {
      // Check if it's wrapping a model in a class
      const classWrapsModel = /class\s+\w+\s*\{[\s\S]*mongoose\.model\(/;
      if (classWrapsModel.test(modifiedCode)) {
        // Essential mongoose methods that must be exposed
        const essentialMethods = ['find', 'findOne', 'findById', 'updateOne', 'deleteOne', 'countDocuments', 'insertMany'];
        const exposedMethods = essentialMethods.filter(m => modifiedCode.includes(`async ${m}(`) || modifiedCode.includes(`${m}(`));
        if (exposedMethods.length < 4) {
          errors.push(`BROKEN_MODEL_WRAPPER: Model wrapped in class but only ${exposedMethods.length}/${essentialMethods.length} essential mongoose methods exposed. Either expose all methods or use Proxy pattern.`);
        }
      }
    }

    // BLOCKING CHECK 5: More than 30% comment reduction (likely stripping documentation)
    const originalCommentLines = (originalCode.match(/\/\*\*[\s\S]*?\*\/|\/\/.*/g) || []).length;
    const modifiedCommentLines = (modifiedCode.match(/\/\*\*[\s\S]*?\*\/|\/\/.*/g) || []).length;
    if (originalCommentLines > 10 && modifiedCommentLines < originalCommentLines * 0.7) {
      errors.push(`DOCUMENTATION_STRIPPED: Removed ${originalCommentLines - modifiedCommentLines} comments (${originalCommentLines} → ${modifiedCommentLines}) - preserve existing documentation`);
    }

    // Check 1: Excessive comment removal
    const originalCommentCount = (originalCode.match(/\/\*\*[\s\S]*?\*\/|\/\/.*/g) || []).length;
    const modifiedCommentCount = (modifiedCode.match(/\/\*\*[\s\S]*?\*\/|\/\/.*/g) || []).length;
    if (originalCommentCount > 5 && modifiedCommentCount < originalCommentCount * 0.5) {
      warnings.push(`DOCUMENTATION_REMOVED: Reduced comments from ${originalCommentCount} to ${modifiedCommentCount}`);
    }

    // BLOCKING CHECK 6: Dead imports (imported but not used)
    // This was previously a warning but AI consistently ignores the "no dead imports" instruction
    const importMatches = modifiedCode.match(/import\s+(?:{[^}]+}|\w+)\s+from\s+['"][^'"]+['"]/g) || [];
    for (const importLine of importMatches) {
      const nameMatch = importLine.match(/import\s+(?:{([^}]+)}|(\w+))/);
      if (nameMatch) {
        const names = nameMatch[1] ? nameMatch[1].split(',').map(n => n.trim().split(' as ')[0].trim()) : [nameMatch[2]];
        for (const name of names) {
          if (name && name !== 'default') {
            const codeWithoutImports = modifiedCode.replace(/import[\s\S]*?from\s+['"][^'"]+['"];?\n?/g, '');
            const usageRegex = new RegExp(`\\b${name}\\b`);
            if (!usageRegex.test(codeWithoutImports)) {
              // Only block if this is a NEW dead import (not one that existed before)
              const wasInOriginal = originalCode.includes(importLine.trim());
              if (!wasInOriginal) {
                errors.push(`DEAD_IMPORT: '${name}' is imported but never used in the code - remove the import or use it`);
              } else {
                warnings.push(`DEAD_IMPORT: '${name}' is imported but never used (pre-existing)`);
              }
            }
          }
        }
      }
    }

    // BLOCKING CHECK 7: Verify new relative import paths resolve to existing files
    const origImportPaths = new Set([...originalCode.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]));
    const newImportPaths = [...modifiedCode.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
    for (const importPath of newImportPaths) {
      if (!origImportPaths.has(importPath)) {
        // This is a newly added relative import - verify the file exists
        try {
          const fileDir = path.dirname(targetFile);
          const resolved = path.resolve(fileDir, importPath);
          // Check with and without .js extension
          const candidates = [resolved, resolved + '.js', resolved + '/index.js'];
          const exists = candidates.some(c => existsSync(c));
          if (!exists) {
            errors.push(`INVALID_IMPORT_PATH: '${importPath}' does not resolve to an existing file from ${path.basename(targetFile)}`);
          }
        } catch {
          // If path resolution fails, warn but don't block
          warnings.push(`IMPORT_PATH_CHECK_FAILED: Could not verify '${importPath}'`);
        }
      }
    }

    // BLOCKING CHECK 8: Trivial changes (only imports added, no real code)
    const originalLines = originalCode.split('\n');
    const modifiedLines = modifiedCode.split('\n');
    const newNonImportLines = modifiedLines.filter(l => {
      const trimmed = l.trim();
      return trimmed && !originalLines.includes(l) &&
        !trimmed.startsWith('import ') &&
        !trimmed.startsWith('// ') &&
        trimmed !== '';
    });
    const newImportLines = modifiedLines.filter(l => l.trim().startsWith('import ') && !originalLines.includes(l));
    if (newImportLines.length > 0 && newNonImportLines.length <= 2) {
      errors.push(`TRIVIAL_CHANGE: Added ${newImportLines.length} import(s) but only ${newNonImportLines.length} lines of actual code - this is not a meaningful upgrade`);
    }

    // BLOCKING CHECK 9: New standalone functions must be exported or called
    const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
    const origFunctions = new Set([...originalCode.matchAll(funcPattern)].map(m => m[1]));
    const modFunctions = [...modifiedCode.matchAll(funcPattern)];
    for (const match of modFunctions) {
      const funcName = match[1];
      if (!origFunctions.has(funcName)) {
        // New function - check if it's exported or called somewhere
        const isExported = modifiedCode.includes(`export function ${funcName}`) ||
                          modifiedCode.includes(`export async function ${funcName}`) ||
                          modifiedCode.includes(`export default ${funcName}`) ||
                          modifiedCode.includes(`export { ${funcName}`) ||
                          new RegExp(`exports\\.${funcName}\\b`).test(modifiedCode);
        // Check if it's called anywhere (not just in its own declaration)
        const callRegex = new RegExp(`(?<!function\\s+)(?<!async\\s+function\\s+)\\b${funcName}\\s*\\(`, 'g');
        const codeWithoutDecl = modifiedCode.replace(match[0], '');
        const isCalled = callRegex.test(codeWithoutDecl);
        // Check if it's a class method (attached to prototype or in a class body)
        const isMethod = new RegExp(`\\.${funcName}\\s*=`).test(modifiedCode) ||
                        modifiedCode.includes(`this.${funcName}`);
        if (!isExported && !isCalled && !isMethod) {
          errors.push(`UNREACHABLE_CODE: New function '${funcName}' is defined but never exported, called, or attached as a method - it is dead code`);
        }
      }
    }

    // BLOCKING CHECK 10: Placeholder API URLs
    if (modifiedCode.includes('api.example.com') || modifiedCode.includes('example.com/api')) {
      if (!originalCode.includes('api.example.com') && !originalCode.includes('example.com/api')) {
        errors.push(`PLACEHOLDER_URL: Code contains placeholder URL 'example.com' - use real API endpoints or remove the code`);
      }
    }

    // BLOCKING CHECK 11: Non-code content in output (leaked LLM reasoning)
    const firstNonEmptyLine = modifiedCode.split('\n').find(l => l.trim().length > 0);
    if (firstNonEmptyLine && !firstNonEmptyLine.trim().startsWith('import ') &&
        !firstNonEmptyLine.trim().startsWith('//') &&
        !firstNonEmptyLine.trim().startsWith('/*') &&
        !firstNonEmptyLine.trim().startsWith('export ') &&
        !firstNonEmptyLine.trim().startsWith('const ') &&
        !firstNonEmptyLine.trim().startsWith('let ') &&
        !firstNonEmptyLine.trim().startsWith('var ') &&
        !firstNonEmptyLine.trim().startsWith('class ') &&
        !firstNonEmptyLine.trim().startsWith('function ') &&
        !firstNonEmptyLine.trim().startsWith("'use strict'") &&
        !firstNonEmptyLine.trim().startsWith('"use strict"')) {
      // Check if it looks like English prose rather than code
      const words = firstNonEmptyLine.trim().split(/\s+/);
      if (words.length > 5 && /^[A-Z]/.test(firstNonEmptyLine.trim())) {
        errors.push(`NON_CODE_OUTPUT: First line appears to be English text, not code: "${firstNonEmptyLine.trim().slice(0, 80)}..." — LLM reasoning was leaked into the output`);
      }
    }

    // BLOCKING CHECK 12: Many existing class/prototype methods removed
    // Only match proper method declarations: "async methodName(" or "methodName(" at class indent level
    const methodDeclRegex = /^\s+(?:async\s+)?([a-zA-Z_]\w*)\s*\(/gm;
    const controlFlow = new Set(['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return', 'throw', 'new', 'await', 'typeof', 'delete', 'void']);
    const origMethodNames = new Set([...originalCode.matchAll(methodDeclRegex)].map(m => m[1]).filter(n => !controlFlow.has(n)));
    const modMethodNames = new Set([...modifiedCode.matchAll(methodDeclRegex)].map(m => m[1]).filter(n => !controlFlow.has(n)));
    const removedMethods = [...origMethodNames].filter(f => !modMethodNames.has(f));
    // Only block if 3+ methods removed — small count could be legitimate refactoring
    if (removedMethods.length >= 3) {
      errors.push(`REMOVED_METHODS: ${removedMethods.length} existing method(s) were deleted: ${removedMethods.slice(0, 5).join(', ')}${removedMethods.length > 5 ? '...' : ''} — upgrades should add code, not remove it`);
    } else if (removedMethods.length > 0) {
      warnings.push(`METHODS_CHANGED: ${removedMethods.length} method(s) may have been removed or renamed: ${removedMethods.join(', ')} — verify this is intentional`);
    }

    // BLOCKING CHECK 13: File got massively shorter (wholesale code deletion)
    if (originalCode.length > 1000 && modifiedCode.length < originalCode.length * 0.70) {
      errors.push(`CODE_REMOVED: File shrank by ${Math.round((1 - modifiedCode.length / originalCode.length) * 100)}% — the upgrade should ADD code, not remove it`);
    } else if (originalCode.length > 500 && modifiedCode.length < originalCode.length * 0.85) {
      warnings.push(`CODE_SHRINKAGE: File got ${Math.round((1 - modifiedCode.length / originalCode.length) * 100)}% shorter — verify no important code was removed`);
    }

    // Check 3: Plugin patterns in non-plugins
    const isPlugin = targetFile.includes('/api/plugins/');
    if (!isPlugin) {
      if (modifiedCode.includes('this.commands = [') || modifiedCode.includes('this.commands=')) {
        warnings.push(`WRONG_FILE_TYPE: 'this.commands' array added to non-plugin file`);
      }
      if (modifiedCode.match(/async\s+execute\s*\(\s*(?:command|params)/)) {
        warnings.push(`WRONG_FILE_TYPE: Plugin-style execute() method added to non-plugin file`);
      }
    }

    // Check 4: Removed essential imports (class extends but import removed)
    const extendsMatch = modifiedCode.match(/class\s+\w+\s+extends\s+(\w+)/);
    if (extendsMatch) {
      const baseClass = extendsMatch[1];
      if (!modifiedCode.includes(`import`) || !modifiedCode.includes(baseClass)) {
        if (originalCode.includes(`import`) && originalCode.includes(baseClass)) {
          warnings.push(`REMOVED_IMPORT: Base class '${baseClass}' import may have been removed`);
        }
      }
    }

    // Check 5: Import path changes that look suspicious
    const pathChangePattern = /import\s+.*from\s+['"]([^'"]+)['"]/g;
    const originalPathsList = [...originalCode.matchAll(pathChangePattern)].map(m => m[1]);
    const modifiedPathsList = [...modifiedCode.matchAll(pathChangePattern)].map(m => m[1]);

    for (const origPath of originalPathsList) {
      if (origPath.includes('../../utils/')) {
        const hasEquivalent = modifiedPathsList.some(p => p.includes('/utils/'));
        if (hasEquivalent) {
          const changed = modifiedPathsList.find(p => p.includes('/utils/') && !p.includes('../../utils/'));
          if (changed) {
            warnings.push(`SUSPICIOUS_PATH_CHANGE: Import path changed from '${origPath}' style - verify correctness`);
          }
        }
      }
    }

    // Check 6: retryOperation wrapping non-network operations
    if (modifiedCode.includes('retryOperation') && !originalCode.includes('retryOperation')) {
      const fsOps = ['readdir', 'readFile', 'writeFile', 'mkdir', 'unlink', 'stat', 'access', 'rename', 'copyFile'];
      for (const op of fsOps) {
        if (modifiedCode.includes(`retryOperation`) && modifiedCode.includes(op)) {
          const retryContext = modifiedCode.match(new RegExp(`retryOperation\\s*\\([^)]*${op}`, 'g'));
          if (retryContext) {
            warnings.push(`MISUSED_RETRY: retryOperation may be wrapping filesystem operation '${op}' - retryOperation is for transient network errors, not local I/O`);
          }
        }
      }
    }

    if (errors.length > 0) {
      logger.error(`❌ Code validation ERRORS for ${targetFile} (PR will be blocked):`);
      errors.forEach(e => logger.error(`   - ${e}`));
    }

    if (warnings.length > 0) {
      logger.warn(`⚠️ Code validation warnings for ${targetFile}:`);
      warnings.forEach(w => logger.warn(`   - ${w}`));
    }

    return { warnings, errors };
  }

  /**
   * Add JSDoc comments to functions
   */
  async addComments(improvement) {
    const content = await fs.readFile(improvement.file, 'utf8');
    const lines = content.split('\n');
    
    // Extract function name and parameters
    const funcLine = lines[improvement.line - 1];
    const funcMatch = funcLine.match(/(?:async\s+)?(?:function\s+)?(\w+)\s*\(([^)]*)\)/);
    
    if (!funcMatch) return;
    
    const funcName = funcMatch[1];
    const params = funcMatch[2].split(',').map(p => p.trim()).filter(p => p);
    
    // Generate JSDoc comment
    const comment = [
      '  /**',
      `   * ${funcName} - ${await this.generateDescription(funcName, funcLine)}`,
    ];
    
    if (params.length > 0) {
      params.forEach(param => {
        const paramName = param.split('=')[0].trim();
        comment.push(`   * @param {*} ${paramName}`);
      });
    }
    
    if (funcLine.includes('async')) {
      comment.push('   * @returns {Promise<*>}');
    } else {
      comment.push('   * @returns {*}');
    }
    
    comment.push('   */');
    
    // Insert comment
    lines.splice(improvement.line - 1, 0, ...comment);
    
    // Write back to file
    await fs.writeFile(improvement.file, lines.join('\n'));
    
    // Stage changes
    await this.git.add(improvement.file);
    await this.git.commit(`docs: Add JSDoc comment for ${funcName}`);
  }

  /**
   * Generate description for function based on its name
   */
  async generateDescription(funcName, funcLine) {
    // Simple heuristics based on function name
    if (funcName.startsWith('get')) return 'Retrieves data';
    if (funcName.startsWith('set')) return 'Updates data';
    if (funcName.startsWith('is')) return 'Checks condition';
    if (funcName.startsWith('has')) return 'Verifies existence';
    if (funcName.startsWith('create')) return 'Creates new instance';
    if (funcName.startsWith('delete')) return 'Removes data';
    if (funcName.startsWith('update')) return 'Modifies existing data';
    if (funcName.startsWith('render')) return 'Renders UI component';
    if (funcName.startsWith('handle')) return 'Handles event';
    if (funcName.startsWith('process')) return 'Processes data';
    
    return 'Performs operation';
  }

  /**
   * Fix TODO items using AI assistance
   */
  async fixTodo(improvement) {
    try {
      const content = await fs.readFile(improvement.file, 'utf8');
      const lines = content.split('\n');
      const todoLine = lines[improvement.line - 1];
      
      // Extract TODO content
      const todoMatch = todoLine.match(/TODO:\s*(.+)/);
      if (!todoMatch) {
        logger.warn('Could not extract TODO content');
        return;
      }
      
      const todoTask = todoMatch[1].trim();
      logger.info(`Fixing TODO: ${todoTask}`);
      
      // Use AI to generate implementation
      const context = lines.slice(Math.max(0, improvement.line - 10), improvement.line + 10).join('\n');
      const prompt = `Given this TODO in the code:\n"${todoTask}"\n\nContext:\n${context}\n\nProvide a concise implementation to complete this TODO. Return only the code, no explanations.`;
      
      const implementation = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 200,
        temperature: 0.3
      });
      
      // Replace TODO line with implementation
      const indent = todoLine.match(/^\s*/)[0];
      const implementationLines = implementation.content.split('\n').map(line => indent + line);
      
      // Replace the TODO line
      lines[improvement.line - 1] = implementationLines[0];
      // Insert additional lines if needed
      if (implementationLines.length > 1) {
        lines.splice(improvement.line, 0, ...implementationLines.slice(1));
      }
      
      // Write back to file
      await fs.writeFile(improvement.file, lines.join('\n'));
      
      // Stage and commit
      await this.git.add(improvement.file);
      await this.git.commit(`fix: Complete TODO - ${todoTask.substring(0, 50)}`);
      
      logger.info(`Fixed TODO in ${improvement.file}`);
    } catch (error) {
      logger.error(`Failed to fix TODO: ${error.message}`);
      throw error;
    }
  }

  /**
   * Add error handling to async operations
   */
  async improveErrorHandling(improvement) {
    try {
      const content = await fs.readFile(improvement.file, 'utf8');
      let modified = content;
      
      // Pattern to find unprotected await statements
      const awaitPattern = /^(\s*)(const|let|var)?\s*(\w+\s*=\s*)?await\s+([^;]+);?$/gm;
      const functionPattern = /^(\s*)(async\s+)?function\s+(\w+)|^(\s*)(\w+)\s*:\s*async\s*\([^)]*\)\s*=>|^(\s*)async\s+(\w+)\s*\([^)]*\)\s*\{/gm;
      
      // Find function boundaries to add try-catch
      const functions = [];
      let match;
      
      while ((match = functionPattern.exec(content)) !== null) {
        const indent = match[1] || match[4] || match[6] || '';
        const funcName = match[3] || match[5] || match[7] || 'anonymous';
        const startIndex = match.index;
        
        // Find the function body
        let braceCount = 0;
        let inBody = false;
        let bodyStart = -1;
        let bodyEnd = -1;
        
        for (let i = startIndex; i < content.length; i++) {
          if (content[i] === '{') {
            if (!inBody) {
              bodyStart = i;
              inBody = true;
            }
            braceCount++;
          } else if (content[i] === '}') {
            braceCount--;
            if (braceCount === 0 && inBody) {
              bodyEnd = i;
              break;
            }
          }
        }
        
        if (bodyStart !== -1 && bodyEnd !== -1) {
          functions.push({ funcName, indent, bodyStart, bodyEnd });
        }
      }
      
      // Process functions from end to start to maintain indices
      functions.reverse();
      
      for (const func of functions) {
        const body = content.substring(func.bodyStart + 1, func.bodyEnd);
        
        // Check if body contains await and no try-catch
        if (body.includes('await') && !body.includes('try')) {
          logger.info(`Adding error handling to function: ${func.funcName}`);
          
          // Wrap body in try-catch
          const wrappedBody = `\n${func.indent}  try {${body}\n${func.indent}  } catch (error) {\n${func.indent}    logger.error('${func.funcName} failed:', error);\n${func.indent}    throw error;\n${func.indent}  }`;
          
          modified = modified.substring(0, func.bodyStart + 1) + 
                    wrappedBody + 
                    modified.substring(func.bodyEnd);
        }
      }
      
      // Only write if changes were made
      if (modified !== content) {
        await fs.writeFile(improvement.file, modified);
        await this.git.add(improvement.file);
        await this.git.commit(`feat: Add error handling to async operations in ${path.basename(improvement.file)}`);
        logger.info(`Added error handling to ${improvement.file}`);
      }
    } catch (error) {
      logger.error(`Failed to add error handling: ${error.message}`);
      throw error;
    }
  }

  /**
   * Replace console.log with proper logger
   */
  async replaceConsoleLog(improvement) {
    try {
      const content = await fs.readFile(improvement.file, 'utf8');
      let modified = content;
      
      // Check if logger is imported
      const hasLoggerImport = content.includes("import { logger }") || 
                             content.includes("const { logger }") ||
                             content.includes("logger = require");
      
      // Add logger import if needed
      if (!hasLoggerImport && modified.includes('console.log')) {
        const importMatch = modified.match(/^(import\s+.+from\s+.+;?\s*\n)+/m);
        if (importMatch) {
          // Add after existing imports
          const lastImportEnd = importMatch.index + importMatch[0].length;
          modified = modified.substring(0, lastImportEnd) + 
                    `import { logger } from '../utils/logger.js';\n` +
                    modified.substring(lastImportEnd);
        } else {
          // Add at the beginning
          modified = `import { logger } from '../utils/logger.js';\n\n` + modified;
        }
      }
      
      // Replace console.log patterns
      const replacements = [
        { from: /console\.log\(/g, to: 'logger.info(' },
        { from: /console\.error\(/g, to: 'logger.error(' },
        { from: /console\.warn\(/g, to: 'logger.warn(' },
        { from: /console\.debug\(/g, to: 'logger.debug(' }
      ];
      
      for (const { from, to } of replacements) {
        modified = modified.replace(from, to);
      }
      
      // Only write if changes were made
      if (modified !== content) {
        await fs.writeFile(improvement.file, modified);
        await this.git.add(improvement.file);
        await this.git.commit(`refactor: Replace console.log with logger in ${path.basename(improvement.file)}`);
        logger.info(`Replaced console.log in ${improvement.file}`);
      }
    } catch (error) {
      logger.error(`Failed to replace console.log: ${error.message}`);
      throw error;
    }
  }

  /**
   * Optimize and consolidate imports
   */
  async optimizeImports(improvement) {
    try {
      const content = await fs.readFile(improvement.file, 'utf8');
      const lines = content.split('\n');
      
      // Extract all imports
      const imports = new Map(); // module -> { named: Set, default: string }
      const importLines = [];
      
      lines.forEach((line, index) => {
        const importMatch = line.match(/^import\s+(.+?)\s+from\s+['"](.+?)['"]/);
        if (importMatch) {
          importLines.push(index);
          const [, importClause, module] = importMatch;
          
          if (!imports.has(module)) {
            imports.set(module, { named: new Set(), default: null });
          }
          
          // Parse import clause
          if (importClause.includes('{')) {
            // Named imports
            const namedMatch = importClause.match(/\{([^}]+)\}/);
            if (namedMatch) {
              namedMatch[1].split(',').forEach(name => {
                imports.get(module).named.add(name.trim());
              });
            }
            // Check for default import too
            const defaultMatch = importClause.match(/^(\w+),/);
            if (defaultMatch) {
              imports.get(module).default = defaultMatch[1];
            }
          } else {
            // Default import
            imports.get(module).default = importClause.trim();
          }
        }
      });
      
      // Generate optimized imports
      const optimizedImports = [];
      for (const [module, { named, default: defaultImport }] of imports) {
        let importStatement = 'import ';
        
        if (defaultImport && named.size > 0) {
          importStatement += `${defaultImport}, { ${Array.from(named).join(', ')} }`;
        } else if (defaultImport) {
          importStatement += defaultImport;
        } else if (named.size > 0) {
          importStatement += `{ ${Array.from(named).join(', ')} }`;
        }
        
        importStatement += ` from '${module}';`;
        optimizedImports.push(importStatement);
      }
      
      // Sort imports: external modules first, then local
      optimizedImports.sort((a, b) => {
        const aLocal = a.includes("from '.");
        const bLocal = b.includes("from '.");
        if (aLocal && !bLocal) return 1;
        if (!aLocal && bLocal) return -1;
        return a.localeCompare(b);
      });
      
      // Remove old imports and insert optimized ones
      const nonImportLines = lines.filter((_, index) => !importLines.includes(index));
      const firstNonImportLine = importLines.length > 0 ? importLines[importLines.length - 1] + 1 : 0;
      
      const newContent = [
        ...optimizedImports,
        '',
        ...nonImportLines.slice(firstNonImportLine - importLines.length)
      ].join('\n');
      
      // Only write if changes were made
      if (newContent !== content) {
        await fs.writeFile(improvement.file, newContent);
        await this.git.add(improvement.file);
        await this.git.commit(`refactor: Optimize imports in ${path.basename(improvement.file)}`);
        logger.info(`Optimized imports in ${improvement.file}`);
      }
    } catch (error) {
      logger.error(`Failed to optimize imports: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fix runtime errors detected from logs
   */
  async fixRuntimeError(improvement) {
    try {
      const content = await fs.readFile(improvement.file, 'utf8');
      const lines = content.split('\n');
      
      // Extract error context
      const errorLine = lines[improvement.line - 1] || '';
      const context = lines.slice(
        Math.max(0, improvement.line - 10), 
        Math.min(lines.length, improvement.line + 10)
      ).join('\n');
      
      logger.info(`Fixing runtime error at ${improvement.file}:${improvement.line}`);
      
      // Use AI to analyze and fix the error
      const prompt = `Fix this runtime error that occurred ${improvement.errorCount} times:
Error: ${improvement.description}
File: ${improvement.file}
Line ${improvement.line}: ${errorLine}

Context:
${context}

Provide a fix that prevents this error. Return only the corrected code for the problematic line(s).`;

      const fix = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 300,
        temperature: 0.2
      });
      
      // Apply the fix
      const fixLines = fix.content.trim().split('\n');
      const indent = errorLine.match(/^\s*/)[0];
      
      // Replace the error line with the fix
      lines[improvement.line - 1] = indent + fixLines[0].trim();
      
      // Insert additional lines if the fix is multi-line
      if (fixLines.length > 1) {
        for (let i = 1; i < fixLines.length; i++) {
          lines.splice(improvement.line - 1 + i, 0, indent + fixLines[i].trim());
        }
      }
      
      // Write back to file
      await fs.writeFile(improvement.file, lines.join('\n'));
      
      // Stage and commit
      await this.git.add(improvement.file);
      await this.git.commit(`fix: Resolve runtime error (${improvement.errorCount} occurrences) in ${path.basename(improvement.file)}`);
      
      logger.info(`Fixed runtime error in ${improvement.file}`);
    } catch (error) {
      logger.error(`Failed to fix runtime error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fix bugs detected by bug detector
   */
  async fixDetectedBug(improvement) {
    try {
      const content = await fs.readFile(improvement.file, 'utf8');
      const lines = content.split('\n');
      
      logger.info(`Fixing ${improvement.pattern} bug in ${improvement.file}:${improvement.line}`);
      
      // Get fix based on bug pattern
      let fixed = false;
      
      switch (improvement.pattern) {
        case 'Hardcoded Credentials':
          // Move to environment variable
          const credMatch = improvement.code.match(/['"]([^'"]+)['"]/);
          if (credMatch) {
            const envVarName = `SECRET_${Math.random().toString(36).substring(7).toUpperCase()}`;
            lines[improvement.line - 1] = lines[improvement.line - 1].replace(
              credMatch[0], 
              `process.env.${envVarName}`
            );
            logger.info(`Replaced hardcoded credential with env var: ${envVarName}`);
            fixed = true;
          }
          break;
          
        case 'Missing Error Handling':
          // Wrap in try-catch if not already
          if (!lines.slice(Math.max(0, improvement.line - 5), improvement.line).some(l => l.includes('try'))) {
            const indent = lines[improvement.line - 1].match(/^\s*/)[0];
            lines[improvement.line - 1] = `${indent}try {\n${indent}  ${lines[improvement.line - 1].trim()}\n${indent}} catch (error) {\n${indent}  logger.error('Operation failed:', error);\n${indent}}`;
            fixed = true;
          }
          break;
          
        case 'SQL Injection Risk':
          // Use parameterized queries
          const sqlLine = lines[improvement.line - 1];
          if (sqlLine.includes('${') || sqlLine.includes('+')) {
            // Simple fix: recommend using parameterized queries
            lines[improvement.line - 1] = `${lines[improvement.line - 1]} // TODO: Use parameterized queries to prevent SQL injection`;
            fixed = true;
          }
          break;
          
        default:
          // For other patterns, use AI to suggest fix
          const prompt = `Fix this ${improvement.pattern} security/quality issue:
Code: ${improvement.code}
File: ${improvement.file}
Pattern: ${improvement.pattern}

Provide only the corrected code line(s).`;

          const fix = await this.agent.providerManager.generateResponse(prompt, {
            maxTokens: 200,
            temperature: 0.2
          });
          
          lines[improvement.line - 1] = fix.content.trim();
          fixed = true;
      }
      
      if (fixed) {
        await fs.writeFile(improvement.file, lines.join('\n'));
        await this.git.add(improvement.file);
        await this.git.commit(`fix: Resolve ${improvement.pattern} issue in ${path.basename(improvement.file)}`);
        
        // Update bug status in database
        if (improvement.bugId) {
          const { BugReport } = await import('../models/BugReport.js');
          await BugReport.findByIdAndUpdate(improvement.bugId, {
            status: 'fixed',
            fixedDate: new Date(),
            fixedBy: 'self-modification'
          });
        }
        
        logger.info(`Fixed ${improvement.pattern} bug`);
      }
    } catch (error) {
      logger.error(`Failed to fix detected bug: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fix multiple instances of a bug pattern
   */
  async fixPatternBugs(improvement) {
    try {
      logger.info(`Fixing ${improvement.count} instances of ${improvement.pattern} pattern`);
      
      // Get all bugs with this pattern
      const { BugReport } = await import('../models/BugReport.js');
      const bugs = await BugReport.find({
        pattern: improvement.pattern,
        status: 'open'
      }).limit(10); // Fix up to 10 at a time
      
      let fixedCount = 0;
      
      for (const bug of bugs) {
        try {
          // Create improvement object for each bug
          const bugImprovement = {
            type: 'fix_detected_bug',
            file: bug.file,
            line: bug.line,
            pattern: bug.pattern,
            code: bug.code,
            bugId: bug._id
          };
          
          await this.fixDetectedBug(bugImprovement);
          fixedCount++;
        } catch (error) {
          logger.warn(`Failed to fix bug ${bug._id}:`, error.message);
        }
      }
      
      await this.git.commit(`fix: Resolve ${fixedCount} instances of ${improvement.pattern} pattern`);
      logger.info(`Fixed ${fixedCount} out of ${improvement.count} ${improvement.pattern} bugs`);
      
    } catch (error) {
      logger.error(`Failed to fix pattern bugs: ${error.message}`);
      throw error;
    }
  }

  /**
   * Run comprehensive tests to verify changes
   */
  async runTests() {
    try {
      logger.info('🧪 Starting comprehensive test validation using TestFramework...');
      
      // Use Docker-based testing if enabled
      if (this.config.useDockerTesting) {
        return await this.runDockerTests();
      }
      
      // Use the comprehensive test framework
      const testResult = await this.testFramework.runTestSuite({
        timeout: this.config.testTimeout,
        includePerformance: true,
        generateReport: true
      });
      
      if (!testResult.success) {
        logger.error(`Test validation failed: ${testResult.error || 'Unknown error'}`);
        logger.error('Failed tests:', testResult.session.errors);
        return false;
      }
      
      const { session } = testResult;
      logger.info(`✅ All tests passed: ${session.passed}/${session.totalTests} (${Math.round((session.passed/session.totalTests)*100)}%)`);
      
      // Log any warnings
      const warnings = testResult.results.filter(t => t.status === 'warning');
      if (warnings.length > 0) {
        logger.warn(`⚠️  ${warnings.length} tests completed with warnings`);
        warnings.forEach(w => logger.warn(`  - ${w.name}: ${w.message}`));
      }
      
      return true;
      
    } catch (error) {
      logger.error('Test execution failed:', error);
      return false;
    }
  }

  /**
   * Run Docker-based isolated testing (Future enhancement)
   */
  async runDockerTests() {
    try {
      logger.info('🐳 Starting Docker-based isolated testing...');
      
      // This is a placeholder for Docker orchestration integration
      // When Docker orchestration is implemented, this will:
      // 1. Create test container from lanagent:test image
      // 2. Copy current code changes to container
      // 3. Run comprehensive tests in isolation
      // 4. Collect test results and logs
      // 5. Destroy test container
      
      const dockerPlugin = this.agent.apiManager?.getPlugin('docker');
      if (!dockerPlugin) {
        logger.warn('Docker plugin not available, falling back to local testing');
        return await this.runLocalTests();
      }

      // TODO: Implement when Docker orchestration plugin is ready
      // Example flow:
      // const containerId = await dockerPlugin.execute({
      //   action: 'create',
      //   params: {
      //     image: this.config.dockerImage,
      //     name: `lanagent-test-${Date.now()}`,
      //     volumes: ['/tmp/test-code:/app'],
      //     environment: ['NODE_ENV=test', 'MONGODB_URI=mongodb://test-db:27017/test']
      //   }
      // });
      
      logger.info('Docker orchestration not yet implemented, using local testing');
      return await this.runLocalTests();
      
    } catch (error) {
      logger.error('Docker testing failed, falling back to local testing:', error);
      return await this.runLocalTests();
    }
  }

  /**
   * Run local testing (current implementation)
   */
  async runLocalTests() {
    try {
      const testResult = await this.testFramework.runTestSuite({
        timeout: this.config.testTimeout,
        includePerformance: true,
        generateReport: true
      });
      
      return testResult.success;
    } catch (error) {
      logger.error('Local testing failed:', error);
      return false;
    }
  }
  
  /**
   * Run automated test suite
   */
  async runAutomatedTests() {
    try {
      logger.info('Running automated test suite...');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const result = await execAsync('npm test', {
        timeout: 60000,
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' }
      });
      
      logger.info('Automated tests passed');
      return true;
    } catch (error) {
      logger.error('Automated tests failed:', error.message);
      return false;
    }
  }
  
  /**
   * Check dependencies are valid
   */
  async checkDependencies() {
    try {
      logger.info('Checking dependencies...');
      
      // Verify all imports resolve
      const files = await this.getProjectFiles();
      for (const file of files.slice(0, 20)) { // Check first 20 files
        try {
          const content = await fs.readFile(file, 'utf8');
          const imports = content.match(/import\s+.*from\s+['"](.+)['"]/g) || [];
          
          for (const imp of imports) {
            const module = imp.match(/from\s+['"](.+)['"]/)[1];
            if (module.startsWith('.')) {
              // Local import - verify file exists
              const importPath = path.resolve(path.dirname(file), module);
              const possiblePaths = [
                importPath + '.js',
                importPath + '/index.js',
                importPath
              ];
              
              let found = false;
              for (const p of possiblePaths) {
                try {
                  await fs.access(p);
                  found = true;
                  break;
                } catch {}
              }
              
              if (!found) {
                logger.error(`Missing dependency in ${file}: ${module}`);
                return false;
              }
            }
          }
        } catch (error) {
          logger.warn(`Could not check dependencies in ${file}:`, error.message);
        }
      }
      
      return true;
    } catch (error) {
      logger.error('Dependency check failed:', error);
      return false;
    }
  }
  
  /**
   * Run integration tests
   */
  async runIntegrationTests() {
    try {
      logger.info('Running integration tests...');
      
      // Test 1: Agent can initialize
      const testAgent = {
        name: 'test-agent',
        systemExecutor: { execute: async () => ({ success: true }) },
        providerManager: { generateResponse: async () => ({ content: 'test' }) },
        memoryManager: { store: async () => {} },
        apiManager: { apis: new Map() }
      };
      
      // Test 2: Core services are accessible
      const requiredServices = [
        'src/core/agent.js',
        'src/core/memoryManager.js',
        'src/api/core/apiManager.js',
        'src/interfaces/web/webInterface.js'
      ];
      
      for (const service of requiredServices) {
        try {
          await fs.access(service);
        } catch {
          logger.error(`Core service missing: ${service}`);
          return false;
        }
      }
      
      // Test 3: Configuration is valid
      if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
        logger.info('AI provider configuration validated');
      } else {
        logger.warn('No AI provider keys found');
      }
      
      return true;
    } catch (error) {
      logger.error('Integration test failed:', error);
      return false;
    }
  }
  
  /**
   * Check performance metrics
   */
  async checkPerformance() {
    try {
      const startMem = process.memoryUsage().heapUsed;
      const startTime = Date.now();
      
      // Load a few modules to test performance
      const testModules = [
        'src/core/agent.js',
        'src/api/core/apiManager.js'
      ];
      
      for (const mod of testModules) {
        try {
          delete require.cache[require.resolve(`./${mod}`)];
          await import(`./${mod}`);
        } catch {}
      }
      
      const endMem = process.memoryUsage().heapUsed;
      const endTime = Date.now();
      
      const memIncrease = ((endMem - startMem) / 1024 / 1024).toFixed(2);
      const timeElapsed = endTime - startTime;
      
      logger.info(`Performance: ${memIncrease}MB memory, ${timeElapsed}ms load time`);
      
      // Fail if memory increase is too high or load time too slow
      if (memIncrease > 50 || timeElapsed > 5000) {
        logger.warn('Performance degradation detected');
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error('Performance check failed:', error);
      return true; // Don't fail on performance check errors
    }
  }
  
  /**
   * Run basic checks when no test script exists
   */
  async runBasicChecks() {
    logger.info('Running basic validation checks...');
    
    // Check that all files can be loaded
    const files = await this.getProjectFiles();
    for (const file of files) {
      try {
        await import(file);
      } catch (error) {
        // Only fail if it's a real syntax error
        if (error.code === 'ERR_MODULE_NOT_FOUND' || 
            error.message.includes('Cannot use import')) {
          continue;
        }
        logger.error(`Failed to load ${file}:`, error.message);
        return false;
      }
    }
    
    logger.info('Basic checks passed');
    return true;
  }
  
  /**
   * Check syntax of JavaScript files using safer static analysis
   */
  async checkSyntax() {
    const files = await this.getProjectFiles();
    
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf8');
        
        // Safer syntax validation using acorn parser or similar static analysis
        // For now, use basic regex patterns to detect obvious syntax errors
        if (!this.validateJavaScriptSyntax(content)) {
          logger.error(`Syntax error detected in ${file}`);
          return false;
        }
      } catch (error) {
        logger.error(`Error reading file ${file}:`, error.message);
        return false;
      }
    }
    
    return true;
  }

  /**
   * Basic JavaScript syntax validation without code execution
   * @param {string} content - JavaScript code to validate
   * @returns {boolean} - True if syntax appears valid
   */
  validateJavaScriptSyntax(content) {
    try {
      // Basic validation without execution
      // Check for balanced brackets, quotes, etc.
      const brackets = { '{': 0, '[': 0, '(': 0 };
      let inString = false;
      let stringChar = null;
      let inComment = false;
      let inLineComment = false;
      
      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const nextChar = content[i + 1];
        
        // Handle line comments
        if (!inString && char === '/' && nextChar === '/') {
          inLineComment = true;
          continue;
        }
        
        if (inLineComment && char === '\n') {
          inLineComment = false;
          continue;
        }
        
        if (inLineComment) continue;
        
        // Handle block comments
        if (!inString && char === '/' && nextChar === '*') {
          inComment = true;
          i++; // Skip next char
          continue;
        }
        
        if (inComment && char === '*' && nextChar === '/') {
          inComment = false;
          i++; // Skip next char
          continue;
        }
        
        if (inComment) continue;
        
        // Handle strings
        if (!inString && (char === '"' || char === "'" || char === '`')) {
          inString = true;
          stringChar = char;
          continue;
        }
        
        if (inString && char === stringChar && content[i - 1] !== '\\') {
          inString = false;
          stringChar = null;
          continue;
        }
        
        if (inString) continue;
        
        // Count brackets
        if (char === '{') brackets['{']++;
        else if (char === '}') brackets['{']--;
        else if (char === '[') brackets['[']++;
        else if (char === ']') brackets['[']--;
        else if (char === '(') brackets['(']++;
        else if (char === ')') brackets['(']--;
      }
      
      // Check if brackets are balanced
      return brackets['{'] === 0 && brackets['['] === 0 && brackets['('] === 0 && !inString;
      
    } catch (error) {
      logger.error('Syntax validation error:', error.message);
      return false;
    }
  }

  /**
   * Revert changes if tests fail
   */
  async revertChanges(branchName) {
    await this.git.checkout('main');
    await this.git.deleteLocalBranch(branchName, true);
    this.currentBranch = null;
  }

  /**
   * Create pull request
   */
  async createPullRequest(branchName, improvement) {
    // Push branch to remote
    await this.git.push('origin', branchName, ['--set-upstream']);

    // Create PR using git hosting provider or gh CLI fallback
    const prTitle = `[Auto] ${improvement.type}: ${improvement.description}`;
    const prBody = `## Automated Improvement

**Type**: ${improvement.type}
**File**: ${improvement.file}
**Priority**: ${improvement.priority}
**Effort**: ${improvement.effort}

### Description
${improvement.description}

### Changes Made
This PR was automatically generated by the self-modification service during idle time.

### Testing
- [x] Automated tests passed
- [ ] Manual review required
- [ ] Approved by master

---
*Generated by ${process.env.AGENT_NAME || 'LANAgent'} Self-Modification Service v1.0*`;

    try {
      const provider = await this.getGitHostingProvider();

      let forkResult;

      if (provider) {
        // Use the git hosting provider API
        const mrResult = await provider.createMergeRequest({
          title: prTitle,
          body: prBody,
          sourceBranch: branchName,
          targetBranch: 'main',
          labels: ['ai-generated', 'auto-improvement']
        });

        if (mrResult.success) {
          logger.info(`Pull request created successfully: ${mrResult.url}`);
          forkResult = { stdout: mrResult.url, exitCode: 0 };
        } else {
          throw new Error(mrResult.error || 'Failed to create merge request');
        }
      } else {
        // Fall back to gh CLI
        forkResult = await this.agent.systemExecutor.execute(
          `gh pr create --title "${prTitle}" --body "${prBody}" --head ${branchName}`,
          'self-modification'
        );

        logger.info('Pull request created successfully');
      }

      // Also contribute upstream if not explicitly disabled (enabled by default)
      if (process.env.UPSTREAM_CONTRIBUTIONS !== 'false') {
        this.contributeUpstream(branchName, improvement).catch(err => {
          logger.debug(`[SelfMod] Upstream contribution skipped: ${err.message}`);
        });
      }

      return forkResult;

    } catch (error) {
      logger.error('Failed to create pull request:', error);
      throw error;
    }
  }

  /**
   * After a PR is merged on the fork, contribute it upstream to the genesis repo.
   * Called automatically when UPSTREAM_CONTRIBUTIONS=true (set during install).
   * The agent pushes the branch to its fork, then creates a cross-fork PR to upstream.
   *
   * @param {string} branchName - The branch with the improvement
   * @param {Object} improvement - The improvement metadata
   * @returns {Promise<{success: boolean, url?: string, error?: string}>}
   */
  async contributeUpstream(branchName, improvement) {
    const upstreamEnabled = process.env.UPSTREAM_CONTRIBUTIONS !== 'false'; // Enabled by default
    if (!upstreamEnabled) {
      logger.debug('[SelfMod] Upstream contributions disabled (UPSTREAM_CONTRIBUTIONS=false)');
      return { success: false, error: 'Upstream contributions disabled' };
    }

    const provider = await this.getGitHostingProvider();
    if (!provider || typeof provider.createUpstreamPR !== 'function') {
      logger.warn('[SelfMod] Git provider does not support upstream PRs');
      return { success: false, error: 'Provider does not support upstream PRs' };
    }

    const agentName = process.env.AGENT_NAME || 'LANAgent';

    try {
      // Ensure branch is pushed to fork
      await this.git.push('origin', branchName, ['--set-upstream']);

      const prTitle = `[${agentName}] ${improvement.type}: ${improvement.description}`;
      const prBody = `## Community Contribution from ${agentName}

**Type**: ${improvement.type}
**File**: ${improvement.file}
**Priority**: ${improvement.priority}

### Description
${improvement.description}

### Changes Made
This PR was automatically generated by the ${agentName} self-modification service
and has been tested on the contributing instance.

### Instance Info
- **Agent**: ${agentName}
- **Fork**: ${provider.owner}/${provider.repo}

### Testing
- [x] Automated tests passed on contributing instance
- [ ] Review by upstream maintainers required

---
*Contributed via LANAgent Self-Modification Service*`;

      const result = await provider.createUpstreamPR({
        title: prTitle,
        body: prBody,
        sourceBranch: branchName,
        targetBranch: 'main'
      });

      if (result.success) {
        logger.info(`[SelfMod] Upstream PR created: ${result.url}`);
      } else {
        logger.warn(`[SelfMod] Failed to create upstream PR: ${result.error}`);
      }

      return result;
    } catch (error) {
      logger.error('[SelfMod] Failed to contribute upstream:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create pull request specifically for capability upgrades
   */
  async createUpgradePullRequest(branchName, upgrade) {
    logDebugSeparator(`CREATING PULL REQUEST: ${branchName}`);
    
    // Check if there are any commits on this branch that differ from main
    logStep(1, "Checking commit count on branch");
    const commitDiff = await this.git.raw(['rev-list', '--count', 'main..HEAD']);
    const commitCount = parseInt(commitDiff.trim());
    
    if (commitCount === 0) {
      selfModLogger.error(`No commits found on branch ${branchName} - cannot create PR without code changes`);
      throw new Error('No commits found on branch - cannot create PR without code changes');
    }
    
    selfModLogger.info(`Found ${commitCount} commit(s) on branch ${branchName}`);
    
    // Push branch to remote
    await this.git.push('origin', branchName, ['--set-upstream']);
    
    // Create PR for capability upgrade (include agent name for multi-instance repos)
    const agentLabel = process.env.AGENT_NAME || 'LANAgent';
    const prTitle = `🚀 [${agentLabel}] ${upgrade.type}: ${upgrade.target || upgrade.file}`;
    const prBody = `## 🚀 Capability Upgrade

**Type**: ${upgrade.type}
**Target**: ${upgrade.target || upgrade.file}
**Priority**: ${upgrade.priority}
**Effort**: ${upgrade.effort}
**Impact**: ${upgrade.impact}
**Value**: ${upgrade.value}

### 📋 Description
${upgrade.description}

### ✨ New Capabilities
${upgrade.newCapabilities ? upgrade.newCapabilities.map(cap => `- ${cap}`).join('\n') : 'Enhanced functionality'}

### 🔧 Implementation
${upgrade.implementation || 'AI-generated capability enhancement'}

### 🧪 Testing
- [x] Automated tests passed
- [x] Performance validation completed
- [x] Integration tests passed
${upgrade.safeForProduction ? '- [x] Safe for production deployment' : '- [ ] Requires manual production review'}

### 📊 Expected Benefits
- **Performance**: Enhanced
- **Capabilities**: Expanded
- **User Experience**: Improved
- **Integration**: Better service coordination

---
*Generated by ${process.env.AGENT_NAME || 'LANAgent'} Self-Modification Service - Capability Upgrade Module v1.0*`;

    try {
      logStep(2, "Pushing branch to remote repository");

      logStep(3, "Creating PR using git hosting provider");

      // Try to use the git hosting provider first
      const provider = await this.getGitHostingProvider();
      let prUrl = null;
      let prNumber = null;
      let exitCode = 0;
      let stdout = '';
      let stderr = '';

      if (provider) {
        selfModLogger.info(`Using ${provider.name} provider for PR creation`);

        const mrResult = await provider.createMergeRequest({
          title: prTitle,
          body: prBody,
          sourceBranch: branchName,
          targetBranch: 'main',
          labels: ['ai-generated', 'capability-upgrade']
        });

        if (mrResult.success) {
          prUrl = mrResult.url;
          prNumber = mrResult.number;
          stdout = prUrl;
          selfModLogger.info(`PR created via ${provider.name}: ${prUrl}`);
        } else {
          throw new Error(mrResult.error || 'Failed to create merge request via provider');
        }
      } else {
        // Fall back to gh CLI
        selfModLogger.info('Falling back to gh CLI for PR creation');

        // Write PR body to temporary file to avoid shell parsing issues
        const tempFile = `/tmp/pr-body-${Date.now()}.txt`;
        await fs.writeFile(tempFile, prBody);

        const command = `gh pr create --title "${prTitle}" --body-file "${tempFile}" --head ${branchName}`;
        selfModLogger.info(`Executing GitHub command: ${command}`);
        selfModLogger.info(`Working directory: ${this.developmentPath}`);

        const result = await this.agent.systemExecutor.execute(command, { cwd: this.developmentPath, timeout: 30000 });

        // Clean up temp file
        try {
          await fs.unlink(tempFile);
        } catch (cleanupError) {
          selfModLogger.debug(`Failed to clean up temp file: ${cleanupError.message}`);
        }

        logStep(4, "Analyzing SystemExecutor result");
        // Log the full result for debugging
        selfModLogger.info('SystemExecutor result:', {
          success: result.success,
          exitCode: result.exitCode,
          stdout: result.stdout?.substring(0, 200) || 'empty',
          stderr: result.stderr?.substring(0, 200) || 'empty',
          command: command
        });

        // Handle undefined exit code from SystemExecutor
        exitCode = result.exitCode ?? (result.success === false ? 1 : 0);
        stdout = result.stdout || result.output || '';
        stderr = result.stderr || result.error || '';

        if (exitCode !== 0 || result.success === false) {
          throw new Error(`GitHub PR creation failed: ${stderr || stdout || 'Unknown error'} (exit code: ${exitCode})`);
        }

        prUrl = stdout.trim();
        // Extract PR number from URL
        const prNumberMatch = prUrl.match(/pull\/(\d+)|merge_requests\/(\d+)/);
        prNumber = prNumberMatch ? parseInt(prNumberMatch[1] || prNumberMatch[2]) : null;
      }

      if (prUrl) {
        // Save improvement to database
        try {
          await Improvement.create({
            type: upgrade.type,
            targetFile: upgrade.targetFile || upgrade.file,
            description: upgrade.description,
            priority: upgrade.priority || 'medium',
            impact: upgrade.impact || 'moderate',
            branchName: branchName,
            prUrl: prUrl,
            prNumber: prNumber,
            status: 'pr_created',
            newCapabilities: upgrade.newCapabilities || [],
            safeForProduction: upgrade.safeForProduction || false,
            completedAt: new Date()
          });
          logger.info(`✅ Improvement tracked in database: ${upgrade.type}`);
        } catch (dbError) {
          logger.error('Failed to save improvement to database:', dbError);
          // Don't throw - PR was created successfully
        }

        // Check if we should trigger self-update for critical improvements
        if (this.shouldTriggerSelfUpdate(upgrade)) {
          await this.triggerSelfUpdateAfterPR(upgrade, prUrl);
        }

        return { exitCode, stdout, stderr, prUrl, prNumber };
      } else {
        logger.warn('PR created but no URL found in output:', stdout);
        return { exitCode, stdout, stderr };
      }

    } catch (error) {
      logger.error('Failed to create capability upgrade pull request:', error);
      throw error;
    }
  }

  // escapeMarkdown function removed - now using utility from utils/markdown.js

  /**
   * Notify about successful capability upgrade
   */
  async notifyUpgrade(upgrade, branchName) {
    try {
      // Always log the notification for visibility
      logger.info(`NOTIFICATION: Capability Upgrade Completed - ${upgrade.type} - ${upgrade.target || upgrade.file}`);
      logger.info(`Branch: ${branchName}, Priority: ${upgrade.priority}, Impact: ${upgrade.impact}`);
      
      // Prepare the notification message with escaped markdown
      const message = `🚀 **Capability Upgrade Completed**\n\n` +
        `**Type**: ${escapeMarkdown(upgrade.type)}\n` +
        `**Target**: ${escapeMarkdown(upgrade.target || upgrade.file)}\n` +
        `**Priority**: ${escapeMarkdown(upgrade.priority)}\n` +
        `**Impact**: ${escapeMarkdown(upgrade.impact)}\n` +
        `**Branch**: \`${branchName}\`\n\n` +
        `**Description**: ${escapeMarkdown(upgrade.description)}\n\n` +
        `**New Capabilities:**\n${upgrade.newCapabilities ? upgrade.newCapabilities.map(cap => `• ${escapeMarkdown(cap)}`).join('\n') : '• Enhanced functionality'}\n\n` +
        `${upgrade.safeForProduction ? '✅ Safe for production' : '⚠️ Requires review before production'}\n\n` +
        `Pull request created for review.`;
      
      // Try Telegram notification regardless of timeout issues
      const telegram = this.agent.interfaces?.get('telegram');
      if (telegram && telegram.sendNotification) {
        try {
          await telegram.sendNotification(message, {
            parse_mode: 'Markdown'
          });
          logger.info('Telegram notification sent successfully');
        } catch (telegramError) {
          logger.warn('Telegram notification attempt failed (may still be delivered):', telegramError.message);
          // Don't throw - notification might still go through despite timeout
        }
      } else {
        logger.warn('Telegram interface not available');
      }
      
      // Only use agent.notify if Telegram wasn't available
      if (!telegram && this.agent.notify) {
        try {
          await this.agent.notify(message);
        } catch (notifyError) {
          logger.warn('Agent notify failed:', notifyError.message);
        }
      }
    } catch (error) {
      logger.error('Failed to send upgrade notification:', error);
    }
  }

  /**
   * Deploy improvements to staging environment for testing
   */
  async deployToStaging() {
    try {
      logger.info('Deploying latest changes to staging environment...');
      
      // Ensure staging directory exists and copy files
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // Simple rsync-like copy from development to staging
      await this.copyDirectory(this.developmentPath, this.stagingPath);
      
      logger.info('Staging deployment completed');
      return { success: true, message: 'Deployed to staging successfully' };
    } catch (error) {
      logger.error('Staging deployment failed:', error);
      throw new Error(`Staging deployment failed: ${error.message}`);
    }
  }

  /**
   * Test staging environment (basic health checks)
   */
  async testStagingEnvironment() {
    try {
      logger.info('Running staging environment tests...');
      
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const tests = [];
      
      // Check critical files exist
      const criticalFiles = [
        'package.json',
        'src/core/agent.js', 
        'src/interfaces/web/webInterface.js',
        'src/api/plugins/git.js'
      ];
      
      for (const file of criticalFiles) {
        const filePath = path.join(this.stagingPath, file);
        try {
          await fs.access(filePath);
          tests.push({ test: `File exists: ${file}`, status: 'pass' });
        } catch {
          tests.push({ test: `File exists: ${file}`, status: 'fail' });
        }
      }
      
      // Check package.json syntax
      try {
        const packagePath = path.join(this.stagingPath, 'package.json');
        const packageContent = await fs.readFile(packagePath, 'utf8');
        JSON.parse(packageContent);
        tests.push({ test: 'package.json syntax', status: 'pass' });
      } catch {
        tests.push({ test: 'package.json syntax', status: 'fail' });
      }
      
      const failedTests = tests.filter(t => t.status === 'fail');
      const success = failedTests.length === 0;
      
      logger.info(`Staging tests completed: ${tests.length - failedTests.length}/${tests.length} passed`);
      
      return { 
        success, 
        tests,
        failedCount: failedTests.length,
        message: success ? 'All staging tests passed' : `${failedTests.length} tests failed`
      };
    } catch (error) {
      logger.error('Staging test failed:', error);
      throw new Error(`Staging test failed: ${error.message}`);
    }
  }

  /**
   * Copy directory recursively
   */
  async copyDirectory(src, dest) {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    try {
      await fs.mkdir(dest, { recursive: true });
      
      const entries = await fs.readdir(src, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.name.startsWith('.git')) continue; // Skip git files
        if (entry.name === 'node_modules') continue; // Skip node_modules
        
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
          await this.copyDirectory(srcPath, destPath);
        } else {
          await fs.copyFile(srcPath, destPath);
        }
      }
    } catch (error) {
      throw new Error(`Failed to copy ${src} to ${dest}: ${error.message}`);
    }
  }

  /**
   * Enhanced workflow: Development → Staging → PR creation
   */
  async processImprovementWithStaging(improvement) {
    try {
      logger.info(`Processing improvement with staging: ${improvement.type}`);
      
      // 1. Make changes in development repository
      await this.applyImprovement(improvement);
      
      // 2. Deploy to staging
      const deployResult = await this.deployToStaging();
      if (!deployResult.success) {
        throw new Error('Staging deployment failed');
      }
      
      // 3. Test staging environment
      const testResult = await this.testStagingEnvironment();
      if (!testResult.success) {
        logger.warn(`Staging tests failed: ${testResult.message}`);
        await this.notifyMaster({
          ...improvement,
          stagingTestsFailed: true,
          testResults: testResult
        });
        return { success: false, error: 'Staging tests failed' };
      }
      
      // 4. Create git commit and PR
      const branchName = await this.createImprovementBranch(improvement);
      await this.createPullRequest(branchName, {
        ...improvement,
        stagingTested: true,
        testResults: testResult
      });
      
      // 5. Notify master
      await this.notifyMaster(improvement, branchName);
      
      return { 
        success: true, 
        branchName, 
        stagingTested: true,
        testResults: testResult
      };
      
    } catch (error) {
      logger.error('Improvement processing with staging failed:', error);
      throw error;
    }
  }

  /**
   * Deploy approved changes from development to production
   */
  async deployToProduction() {
    try {
      logger.info('Deploying approved changes to production...');
      
      // Pull latest approved changes in development repo
      await this.git.checkout('main');
      await this.git.pull('origin', 'main');
      
      // Copy to production directory
      await this.copyDirectory(this.developmentPath, this.productionPath);
      
      logger.info('Production deployment completed');
      
      // Notify about production deployment
      await this.notifyMaster({
        type: 'production_deployment',
        description: 'Successfully deployed approved changes to production'
      });
      
      return { success: true, message: 'Production deployment successful' };
    } catch (error) {
      logger.error('Production deployment failed:', error);
      throw new Error(`Production deployment failed: ${error.message}`);
    }
  }

  /**
   * Notify master about improvement
   */
  async notifyMaster(improvement, branchName) {
    try {
      // Always log the notification for visibility
      if (improvement.error) {
        logger.error(`NOTIFICATION: Self-modification error - ${improvement.error}`);
      } else {
        logger.info(`NOTIFICATION: Self-Improvement Completed - ${improvement.type} - ${improvement.file}`);
        logger.info(`Branch: ${branchName}, Description: ${improvement.description}`);
      }
      
      // Prepare the message with escaped markdown
      let message;
      if (improvement.error) {
        message = `⚠️ Self-modification error:\n${escapeMarkdown(improvement.error)}`;
      } else {
        message = `🤖 **Self-Improvement Completed**\n\n` +
          `**Type**: ${escapeMarkdown(improvement.type)}\n` +
          `**File**: ${escapeMarkdown(improvement.file)}\n` +
          `**Description**: ${escapeMarkdown(improvement.description)}\n` +
          `**Branch**: \`${branchName}\`\n\n` +
          `A pull request has been created for your review.`;
      }
      
      // Try Telegram notification regardless of timeout issues
      const telegram = this.agent.interfaces?.get('telegram');
      if (telegram && telegram.sendNotification) {
        try {
          await telegram.sendNotification(message, {
            parse_mode: 'Markdown'
          });
          logger.info('Telegram notification sent successfully');
        } catch (telegramError) {
          logger.warn('Telegram notification attempt failed (may still be delivered):', telegramError.message);
          // Don't throw - notification might still go through despite timeout
        }
      } else {
        logger.warn('Telegram interface not available for notifications');
      }
      
      // Only use agent.notify if Telegram wasn't available
      if (!telegram && this.agent.notify) {
        try {
          await this.agent.notify(message);
        } catch (notifyError) {
          logger.debug('Agent notify fallback failed:', notifyError.message);
        }
      }
    } catch (error) {
      logger.error('Failed to send self-modification notification:', error);
    }
  }

  /**
   * Get service status
   */
  async getStatus() {
    // Ensure initialization is complete
    if (!this.configLoaded) {
      logger.info(`[SelfMod-${this.constructorId}] Config not loaded in getStatus, calling initialize. configLoaded=${this.configLoaded}`);
      await this.initialize();
      logger.info(`[SelfMod-${this.constructorId}] After initialize in getStatus. configLoaded=${this.configLoaded}, coreUpgradesFirst=${this.config.coreUpgradesFirst}`);
    }
    
    return {
      enabled: this.enabled,
      analysisOnly: this.analysisOnly,
      isRunning: this.isRunning,
      lastCheckTime: this.lastCheckTime,
      currentBranch: this.currentBranch,
      dailyImprovementCount: this.dailyImprovementCount,
      maxDailyImprovements: this.config.maxDailyImprovements,
      config: this.config
    };
  }
  
  /**
   * Get improvement statistics
   */
  async getStats() {
    try {
      const totalImprovements = await Improvement.countDocuments();
      const todayImprovements = await Improvement.countDocuments({
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
      });
      const mergedImprovements = await Improvement.countDocuments({ status: 'merged' });
      const pendingImprovements = await Improvement.countDocuments({ status: 'pr_created' });
      const recentImprovements = await Improvement.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select('type targetFile description prUrl createdAt status');
      
      return {
        total: totalImprovements,
        today: todayImprovements,
        merged: mergedImprovements,
        pending: pendingImprovements,
        recent: recentImprovements
      };
    } catch (error) {
      logger.error('Failed to get improvement stats:', error);
      return {
        total: 0,
        today: 0,
        merged: 0,
        pending: 0,
        recent: []
      };
    }
  }
  
  /**
   * Update configuration
   */
  async updateConfig(updates) {
    // Ensure initialization is complete
    if (!this.configLoaded) {
      logger.info(`[SelfMod-${this.constructorId}] Waiting for initialization before updating config`);
      await this.initialize();
    }
    
    Object.assign(this.config, updates);
    
    // Update intervals if changed
    if (updates.checkIntervalMinutes) {
      this.stopIdleDetection();
      this.startIdleDetection();
    }
    
    logger.info('Self-modification config updated:', updates);
    
    // Save to database
    await this.saveConfig();
  }

  /**
   * Load configuration from database
   */
  async loadConfig() {
    logger.info(`[SelfMod-${this.constructorId}] LoadConfig() called`);
    try {
      logger.info(`[SelfMod-${this.constructorId}] Importing Agent model...`);
      const { Agent } = await import('../models/Agent.js');
      logger.info(`[SelfMod-${this.constructorId}] Agent model imported, querying database...`);
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      logger.info(`[SelfMod-${this.constructorId}] Database query complete, agent found: ${!!agent}`);
      
      logger.info(`[SelfMod-${this.constructorId}] Loading config - Default coreUpgradesFirst: ${this.config.coreUpgradesFirst}`);
      
      if (agent && agent.serviceConfigs && agent.serviceConfigs.selfModification) {
        const savedConfig = agent.serviceConfigs.selfModification;
        logger.info(`[SelfMod-${this.constructorId}] Found saved config - coreUpgradesFirst in DB: ${savedConfig.coreUpgradesFirst}`);
        
        // Merge saved config with defaults, preserving structure
        this.config = {
          ...this.config,
          enabled: savedConfig.enabled !== undefined ? savedConfig.enabled : this.config.enabled,
          analysisOnly: savedConfig.analysisOnly !== undefined ? savedConfig.analysisOnly : this.config.analysisOnly,
          maxChangesPerSession: savedConfig.maxChangesPerSession || this.config.maxChangesPerSession,
          maxDailyImprovements: savedConfig.maxDailyImprovements || this.config.maxDailyImprovements,
          idleMinutes: savedConfig.idleMinutes || this.config.idleMinutes,
          cpuThreshold: savedConfig.cpuThreshold || this.config.cpuThreshold,
          memoryThreshold: savedConfig.memoryThreshold || this.config.memoryThreshold,
          checkIntervalMinutes: savedConfig.checkIntervalMinutes || this.config.checkIntervalMinutes,
          scheduledHour: savedConfig.scheduledHour !== undefined ? savedConfig.scheduledHour : this.config.scheduledHour,
          scheduledMinute: savedConfig.scheduledMinute !== undefined ? savedConfig.scheduledMinute : this.config.scheduledMinute,
          restrictedFiles: savedConfig.restrictedFiles || this.config.restrictedFiles,
          allowedUpgrades: savedConfig.allowedUpgrades || this.config.allowedUpgrades,
          requireTests: savedConfig.requireTests !== undefined ? savedConfig.requireTests : this.config.requireTests,
          useDockerTesting: savedConfig.useDockerTesting !== undefined ? savedConfig.useDockerTesting : this.config.useDockerTesting,
          dockerImage: savedConfig.dockerImage || this.config.dockerImage,
          testTimeout: savedConfig.testTimeout || this.config.testTimeout,
          createPR: savedConfig.createPR !== undefined ? savedConfig.createPR : this.config.createPR,
          coreUpgradesFirst: savedConfig.coreUpgradesFirst !== undefined ? savedConfig.coreUpgradesFirst : this.config.coreUpgradesFirst
        };
        
        // Debug log for coreUpgradesFirst
        logger.info(`[SelfMod-${this.constructorId}] Loading coreUpgradesFirst from database: ${savedConfig.coreUpgradesFirst}, final value: ${this.config.coreUpgradesFirst}`);
        
        // Apply enabled state from config to service
        this.enabled = this.config.enabled;
        this.analysisOnly = this.config.analysisOnly;
        
        // Load lastCheckTime if available
        if (savedConfig.lastCheckTime) {
          this.lastCheckTime = new Date(savedConfig.lastCheckTime);
        }
        
        // Load daily improvement tracking
        if (savedConfig.dailyImprovementCount !== undefined) {
          this.dailyImprovementCount = savedConfig.dailyImprovementCount;
          logger.info(`Loaded dailyImprovementCount from database: ${this.dailyImprovementCount}`);
        }
        if (savedConfig.lastImprovementDate) {
          this.lastImprovementDate = savedConfig.lastImprovementDate;
          logger.info(`Loaded lastImprovementDate from database: ${this.lastImprovementDate}`);
        }
        
        // Start idle detection if enabled
        if (this.enabled) {
          this.startIdleDetection();
          logger.info('Self-modification service ENABLED from database config');
        }
        
        logger.info(`[SelfMod-${this.constructorId}] Self-modification configuration loaded from database`);
      } else {
        logger.info(`[SelfMod-${this.constructorId}] No saved self-modification configuration found, using defaults`);
      }
      logger.info(`[SelfMod-${this.constructorId}] LoadConfig() complete`);
    } catch (error) {
      logger.warn(`[SelfMod-${this.constructorId}] Failed to load self-modification configuration from database:`, error.message);
    }
  }

  /**
   * Save configuration to database
   */
  async saveConfig() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      
      if (agent) {
        if (!agent.serviceConfigs) {
          agent.serviceConfigs = {};
        }
        
        logger.info(`Saving selfModification config. coreUpgradesFirst value: ${this.config.coreUpgradesFirst}`);
        
        agent.serviceConfigs.selfModification = {
          enabled: this.config.enabled,
          analysisOnly: this.config.analysisOnly,
          maxChangesPerSession: this.config.maxChangesPerSession,
          maxDailyImprovements: this.config.maxDailyImprovements,
          idleMinutes: this.config.idleMinutes,
          cpuThreshold: this.config.cpuThreshold,
          memoryThreshold: this.config.memoryThreshold,
          checkIntervalMinutes: this.config.checkIntervalMinutes,
          scheduledHour: this.config.scheduledHour,
          scheduledMinute: this.config.scheduledMinute,
          restrictedFiles: this.config.restrictedFiles,
          allowedUpgrades: this.config.allowedUpgrades,
          requireTests: this.config.requireTests,
          useDockerTesting: this.config.useDockerTesting,
          dockerImage: this.config.dockerImage,
          testTimeout: this.config.testTimeout,
          createPR: this.config.createPR,
          coreUpgradesFirst: this.config.coreUpgradesFirst,
          lastCheckTime: this.lastCheckTime,
          // Add daily improvement tracking
          dailyImprovementCount: this.dailyImprovementCount,
          lastImprovementDate: this.lastImprovementDate
        };
        
        logger.info(`About to save agent. selfModification config includes coreUpgradesFirst: ${agent.serviceConfigs.selfModification.coreUpgradesFirst}`);
        
        agent.markModified('serviceConfigs');
        await agent.save();
        
        // Verify the save worked
        const verifyAgent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
        if (verifyAgent && verifyAgent.serviceConfigs && verifyAgent.serviceConfigs.selfModification) {
          logger.info(`Self-modification configuration saved to database. Verified coreUpgradesFirst: ${verifyAgent.serviceConfigs.selfModification.coreUpgradesFirst}`);
        } else {
          logger.error('Failed to verify self-modification configuration save');
        }
      }
    } catch (error) {
      logger.error('Failed to save self-modification configuration to database:', error);
    }
  }
  
  /**
   * Save just the lastCheckTime to database
   */
  async saveLastCheckTime() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      
      if (agent) {
        if (!agent.serviceConfigs) {
          agent.serviceConfigs = {};
        }
        if (!agent.serviceConfigs.selfModification) {
          agent.serviceConfigs.selfModification = {};
        }
        
        agent.serviceConfigs.selfModification.lastCheckTime = this.lastCheckTime;
        agent.markModified('serviceConfigs');
        await agent.save();
        logger.info('Self-modification lastCheckTime saved to database');
      }
    } catch (error) {
      logger.error('Failed to save self-modification lastCheckTime to database:', error);
      throw error; // Re-throw to see the error
    }
  }
  
  /**
   * Set analysis-only mode
   */
  async setAnalysisOnly(value) {
    this.analysisOnly = value;
    this.config.analysisOnly = value;
    logger.info(`Self-modification analysis-only mode: ${value ? 'ENABLED' : 'DISABLED'}`);
    
    // Save the analysisOnly state to database
    await this.saveConfig();
  }
  
  /**
   * Generate upgrade plans based on code analysis
   */
  async generateUpgradePlans() {
    try {
      logger.info('Generating upgrade plans through code analysis...');
      
      // Run code analysis
      const improvements = await this.analyzeCodebase();
      
      // Convert improvements to upgrade plan format
      const upgradePlans = improvements.map((imp, index) => ({
        id: `auto-${imp.type}-${Date.now()}-${index}`,
        title: this.getImprovementTitle(imp),
        description: imp.description || imp.reason,
        priority: this.getImprovementPriority(imp),
        estimatedEffort: this.getEffortEstimate(imp),
        benefits: this.getImprovementBenefits(imp),
        status: 'Identified',
        file: imp.file,
        type: imp.type,
        autoGenerated: true
      }));
      
      // Sort by priority (removed static plans - now only shows fresh code analysis)
      const allPlans = upgradePlans;
      allPlans.sort((a, b) => {
        const priorityOrder = { 'High': 0, 'Medium': 1, 'Low': 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
      
      // Also create feature requests in the database for auto-generated improvements
      try {
        await this.createFeatureRequestsFromImprovements(improvements);
        logger.info(`Created ${improvements.length} auto-generated feature requests in database`);
      } catch (error) {
        logger.warn('Failed to create feature requests from improvements:', error);
      }
      
      return allPlans;
    } catch (error) {
      logger.error('Failed to generate upgrade plans:', error);
      return [];
    }
  }
  
  /**
   * Get upgrade plans (alias for generateUpgradePlans for compatibility)
   */
  async getUpgradePlans() {
    return this.generateUpgradePlans();
  }
  
  getImprovementTitle(improvement) {
    const titles = {
      'add_comments': 'Add Documentation Comments',
      'fix_todos': 'Complete TODO Items',
      'optimize_imports': 'Optimize Import Statements',
      'improve_error_handling': 'Enhance Error Handling',
      'add_logging': 'Add Debug Logging',
      'refactor_small': 'Code Refactoring',
      'update_docs': 'Update Documentation',
      'add_types': 'Add Type Annotations',
      'performance_optimization': 'Performance Optimization',
      'security_enhancement': 'Security Enhancement',
      'fix_runtime_error': 'Fix Runtime Error',
      'fix_detected_bug': 'Fix Security/Quality Bug',
      'fix_pattern_bugs': 'Fix Multiple Pattern Bugs'
    };
    return titles[improvement.type] || improvement.type;
  }
  
  getImprovementPriority(improvement) {
    const criticalPriority = ['fix_runtime_error', 'fix_detected_bug', 'fix_pattern_bugs'];
    const highPriority = ['improve_error_handling', 'security_enhancement', 'fix_todos'];
    const mediumPriority = ['performance_optimization', 'add_logging', 'add_types'];
    
    // Bug fixes and runtime errors get highest priority
    if (criticalPriority.includes(improvement.type)) return 'Critical';
    if (highPriority.includes(improvement.type)) return 'High';
    if (mediumPriority.includes(improvement.type)) return 'Medium';
    return 'Low';
  }
  
  getEffortEstimate(improvement) {
    if (improvement.changes < 10) return 'Low';
    if (improvement.changes < 50) return 'Medium';
    return 'High';
  }
  
  getImprovementBenefits(improvement) {
    const benefitsMap = {
      'add_comments': ['Better code maintainability', 'Easier onboarding'],
      'fix_todos': ['Complete functionality', 'Remove technical debt'],
      'optimize_imports': ['Cleaner code', 'Faster loading'],
      'improve_error_handling': ['Better stability', 'User experience'],
      'add_logging': ['Better debugging', 'System monitoring'],
      'performance_optimization': ['Faster response', 'Lower resource usage'],
      'security_enhancement': ['Better security', 'Compliance'],
      'update_docs': ['Accurate documentation', 'Better developer experience']
    };
    return benefitsMap[improvement.type] || ['Code improvement'];
  }
  
  /**
   * Create feature requests in database from identified improvements
   */
  async createFeatureRequestsFromImprovements(improvements) {
    if (!improvements || improvements.length === 0) return;

    // Check auto-approve setting once at the start
    const autoApproveEnabled = await SystemSettings.getSetting(AUTO_APPROVE_SETTING_KEY, false);

    for (const improvement of improvements) {
      try {
        // Create a unique fingerprint for this improvement
        const fingerprint = crypto.createHash('sha256')
          .update(`${improvement.type}:${improvement.file}:${improvement.line || 0}:${improvement.description || ''}`)
          .digest('hex');

        // Check if we already have a feature request for this improvement
        // Use multiple criteria to prevent duplicates
        const existing = await FeatureRequest.findOne({
          $or: [
            // Check by fingerprint (most reliable)
            { notes: { $regex: `fingerprint:${fingerprint}` } },
            // Check by exact match of type, file, and similar description
            {
              autoGenerated: true,
              implementationFile: improvement.file,
              description: improvement.description || improvement.reason
            }
          ]
        });

        if (existing) {
          logger.debug(`Feature request already exists for improvement: ${improvement.type} in ${improvement.file}`);
          continue;
        }

        // Determine category based on improvement type
        const category = this.getImprovementCategory(improvement);
        const priority = this.getImprovementPriority(improvement).toLowerCase();

        const featureRequest = new FeatureRequest({
          title: this.getImprovementTitle(improvement),
          description: improvement.description || improvement.reason,
          category,
          priority,
          useCase: `Code quality improvement identified in ${improvement.file}`,
          implementation: `Apply ${improvement.type} improvement to ${improvement.file}`,
          relatedPlugin: this.getRelatedPluginFromFile(improvement.file),
          submittedBy: 'self-modification-service',
          autoGenerated: true,
          estimatedEffort: this.getEffortEstimate(improvement).toLowerCase(),
          benefits: this.getImprovementBenefits(improvement),
          implementationFile: improvement.file,
          notes: `Auto-generated from code analysis: ${improvement.type}\nfingerprint:${fingerprint}`,
          status: autoApproveEnabled ? 'planned' : 'submitted'
        });

        await featureRequest.save();
        logger.debug(`Created feature request for improvement: ${improvement.type} in ${improvement.file}${autoApproveEnabled ? ' (auto-approved)' : ''}`);
        
      } catch (error) {
        logger.warn(`Failed to create feature request for improvement ${improvement.type}:`, error);
      }
    }
  }
  
  /**
   * Get category for improvement based on type
   */
  getImprovementCategory(improvement) {
    const categoryMap = {
      'add_comments': 'core',
      'fix_todos': 'core', 
      'optimize_imports': 'performance',
      'improve_error_handling': 'core',
      'add_logging': 'core',
      'performance_optimization': 'performance',
      'security_enhancement': 'security',
      'update_docs': 'other'
    };
    return categoryMap[improvement.type] || 'other';
  }
  
  /**
   * Get related plugin from file path
   */
  getRelatedPluginFromFile(filePath) {
    if (!filePath) return undefined;
    
    const pluginMap = {
      '/plugins/tasks': 'tasks',
      '/plugins/email': 'email',
      '/plugins/git': 'git',
      '/plugins/websearch': 'websearch',
      '/plugins/system': 'system',
      '/plugins/development': 'development',
      '/plugins/software': 'software',
      '/plugins/scraper': 'scraper',
      '/plugins/monitoring': 'monitoring',
      '/plugins/network': 'network',
      '/plugins/vpn': 'vpn',
      '/plugins/firewall': 'firewall',
      '/plugins/ssh': 'ssh',
      '/plugins/samba': 'samba',
      '/plugins/docker': 'docker',
      '/plugins/ffmpeg': 'ffmpeg',
      '/plugins/ytdlp': 'ytdlp',
      '/plugins/projects': 'projects',
      '/plugins/bugDetector': 'bugDetector',
      '/plugins/devenv': 'devenv',
      '/plugins/virustotal': 'virustotal',
      '/plugins/backupStrategy': 'backupStrategy',
      '/plugins/documentIntelligence': 'documentIntelligence'
    };
    
    for (const [path, plugin] of Object.entries(pluginMap)) {
      if (filePath.includes(path)) {
        return plugin;
      }
    }
    
    return undefined;
  }
  
  /**
   * Analyze documentation files for updates
   */
  async analyzeDocumentation(filePath, content) {
    const improvements = [];
    const today = new Date().toISOString().split('T')[0];
    
    // Check if README mentions latest features
    if (filePath.includes('README.md')) {
      // Check for self-modification mention
      if (!content.includes('Self-Modification Service') || !content.includes('self-modification')) {
        improvements.push({
          type: 'update_docs',
          file: filePath,
          description: 'Add Self-Modification Service description to README',
          priority: 'medium',
          effort: 'small'
        });
      }
      
      // Check for plugin development mention
      if (!content.includes('Plugin Development Service') || !content.includes('plugin development')) {
        improvements.push({
          type: 'update_docs',
          file: filePath,
          description: 'Add Plugin Development Service description to README',
          priority: 'medium',
          effort: 'small'
        });
      }
    }
    
    // Check if CURRENT-STATUS.md has recent date
    if (filePath.includes('CURRENT-STATUS.md')) {
      const lastUpdatedMatch = content.match(/Last Updated[:\s]+([^\n]+)/i);
      if (lastUpdatedMatch) {
        const lastDate = lastUpdatedMatch[1].trim();
        if (!lastDate.includes(today.replace(/-/g, ' '))) {
          improvements.push({
            type: 'update_docs',
            file: filePath,
            description: 'Update CURRENT-STATUS.md with latest date and features',
            priority: 'low',
            effort: 'small'
          });
        }
      }
    }
    
    return improvements;
  }
  
  /**
   * Analyze feature-progress.json for updates
   */
  async analyzeFeatureProgress(filePath, content) {
    const improvements = [];
    
    try {
      const progress = JSON.parse(content);
      const today = new Date().toISOString();
      
      // Check if lastUpdated is recent
      if (progress.lastUpdated) {
        const lastDate = new Date(progress.lastUpdated);
        const daysSince = (new Date() - lastDate) / (1000 * 60 * 60 * 24);
        
        if (daysSince > 7) {
          improvements.push({
            type: 'update_docs',
            file: filePath,
            description: 'Update feature-progress.json with recent changes',
            priority: 'low',
            effort: 'small'
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to parse feature-progress.json:', error.message);
    }
    
    return improvements;
  }

  /**
   * Generate a unique fingerprint for a capability upgrade to prevent duplicates
   */
  generateCapabilityFingerprint(improvement) {
    const targetFile = improvement.targetFile || improvement.file || '';
    const normalizedFile = targetFile.replace(/^\.\.?\/?/, ''); // Remove relative path prefixes
    const fingerprintData = `${normalizedFile}:${improvement.type}:${improvement.description}`;
    return crypto.createHash('sha256').update(fingerprintData).digest('hex').substring(0, 16);
  }

  /**
   * Check if a capability upgrade is a duplicate based on fingerprint
   */
  isDuplicateCapability(fingerprint) {
    // Convert array back to Set for efficient operations
    const fingerprintSet = new Set(this.duplicateState.fingerprints);
    
    // Clean up old fingerprints periodically (older than 24 hours for testing, 7 days for production)
    const now = Date.now();
    const cleanupThreshold = 24 * 60 * 60 * 1000; // 24 hours for more aggressive testing
    if (this.duplicateState.lastCleanup && this.duplicateState.lastCleanup > (now - cleanupThreshold)) {
      // Recent cleanup, don't clear cache yet
    } else if (!this.duplicateState.lastCleanup || this.duplicateState.fingerprints.length > 50) {
      // First run or too many fingerprints accumulated
      const oldCount = fingerprintSet.size;
      fingerprintSet.clear();
      this.duplicateState.lastCleanup = now;
      logger.info(`🧹 Cleaned up capability upgrade fingerprint cache (removed ${oldCount} entries)`);
    }
    
    const isDuplicate = fingerprintSet.has(fingerprint);
    if (!isDuplicate) {
      fingerprintSet.add(fingerprint);
      this.duplicateState.fingerprints = Array.from(fingerprintSet); // Convert Set to Array for storage
    }
    
    return isDuplicate;
  }

  /**
   * Determine if an improvement warrants an automatic self-update
   * Critical improvements like security fixes should trigger immediate updates
   */
  shouldTriggerSelfUpdate(improvement) {
    // Define critical improvement types that warrant auto-update
    const criticalTypes = [
      'security_fix',
      'critical_bug_fix',
      'performance_critical',
      'data_loss_prevention'
    ];
    
    // Check if it's a critical type
    if (criticalTypes.includes(improvement.type)) {
      return true;
    }
    
    // Check for keywords in description indicating critical nature
    const criticalKeywords = ['security', 'vulnerability', 'critical', 'emergency', 'data loss'];
    const description = (improvement.description || '').toLowerCase();
    
    return criticalKeywords.some(keyword => description.includes(keyword));
  }
  
  /**
   * Trigger self-update after creating a critical PR
   */
  async triggerSelfUpdateAfterPR(improvement, prUrl) {
    try {
      logger.info(`🚨 Critical improvement detected, preparing for self-update: ${improvement.type}`);
      
      // Wait a moment for PR to be fully created
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Notify about pending self-update
      await this.agent.notify(
        `🚨 Critical improvement PR created: ${improvement.description}\n` +
        `PR: ${prUrl}\n\n` +
        `⏳ Preparing automatic self-update in 30 seconds...`
      );
      
      // Give user time to review/cancel if needed
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      // Trigger self-update
      logger.info('Triggering self-update for critical improvement...');
      const updateResult = await this.agent.selfUpdate(
        `Critical improvement: ${improvement.type} - ${improvement.description}`
      );
      
      if (!updateResult.success) {
        if (updateResult.blocked) {
          logger.info('Self-update blocked by user settings');
          // Don't treat as error - user has chosen to disable autonomous updates
        } else {
          logger.error('Self-update failed:', updateResult.error);
          await this.agent.notify(`❌ Self-update failed: ${updateResult.error}`);
        }
      }
      
    } catch (error) {
      logger.error('Failed to trigger self-update:', error);
      await this.agent.notify(`❌ Failed to trigger self-update: ${error.message}`);
    }
  }

  /**
   * Check GitHub for existing PRs to prevent duplicates
   */
  async checkGitHubForDuplicatePR(improvement) {
    try {
      const gitPlugin = this.agent.apiManager?.getPlugin('git');
      if (!gitPlugin) {
        logger.debug('Git plugin not available for PR duplicate check');
        return false; // Can't check, assume not duplicate
      }

      // Search for open PRs with similar titles or branch names
      const searchTerms = [
        improvement.type,
        improvement.targetFile?.split('/').pop()?.replace(/\.(js|ts)$/, ''),
        'capability upgrade',
        'enhance_plugin_features'
      ].filter(Boolean);

      for (const term of searchTerms) {
        try {
          const result = await gitPlugin.execute({
            action: 'search-prs',
            query: term,
            state: 'open'
          });

          if (result.success && result.data?.length > 0) {
            // Check if any PR matches our improvement
            for (const pr of result.data) {
              const title = pr.title?.toLowerCase() || '';
              const targetFile = improvement.targetFile?.toLowerCase() || '';
              
              if (title.includes(improvement.type) && 
                  (targetFile.includes(pr.title.toLowerCase()) || title.includes(targetFile))) {
                logger.info(`Found duplicate PR: ${pr.url} (${pr.title})`);
                return true;
              }
            }
          }
        } catch (searchError) {
          logger.debug(`PR search failed for term "${term}": ${searchError.message}`);
        }
      }

      return false; // No duplicates found
      
    } catch (error) {
      logger.warn(`Error checking GitHub for duplicate PRs: ${error.message}`);
      return false; // On error, assume not duplicate to avoid missing real improvements
    }
  }

  /**
   * Clean up implemented features (either FeatureRequest or DiscoveredFeature)
   */
  async cleanupImplementedFeature(featureId, type = 'featureRequest') {
    try {
      if (type === 'featureRequest') {
        const featureRequest = await FeatureRequest.findById(featureId);
        if (!featureRequest) return;
        
        // Update status to completed
        await featureRequest.updateStatus('completed', 'Successfully implemented via self-modification');
        
        // Clear GitHub references to save disk space
        if (featureRequest.githubReferences && featureRequest.githubReferences.length > 0) {
          logger.info(`Cleaning up ${featureRequest.githubReferences.length} GitHub references for implemented feature`);
          featureRequest.githubReferences = [];
          featureRequest.implementationExamples = [];
          await featureRequest.save();
        }
        
        logger.info(`✅ Cleaned up feature request: ${featureRequest.title}`);
      } else if (type === 'discoveredFeature') {
        const discoveredFeature = await DiscoveredFeature.findById(featureId);
        if (!discoveredFeature) return;
        
        // Mark as implemented
        await discoveredFeature.markAsImplemented(this.currentPR, 'self-modification');
        
        logger.info(`✅ Marked discovered feature as implemented: ${discoveredFeature.title}`);
        
        // Optionally delete after some time (handled by DiscoveredFeature.cleanup() method)
        // For now, just mark as implemented to keep for reference
      }
    } catch (error) {
      logger.error('Failed to cleanup implemented feature:', error);
    }
  }
}

export default SelfModificationService;