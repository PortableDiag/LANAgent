import { logger as baseLogger } from '../utils/logger.js';
import { EventEmitter } from 'events';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { MongoClient } from 'mongodb';
import { FeatureRequest } from '../models/FeatureRequest.js';
import { DiscoveredFeature } from '../models/DiscoveredFeature.js';
import { PluginDevelopment } from '../models/PluginDevelopment.js';
import { selfModLock } from './selfModLock.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);
import { GitHubFeatureDiscovery } from './githubFeatureDiscovery.js';
import { escapeMarkdown } from '../utils/markdown.js';

// Create a child logger with plugin-development service metadata
const logger = baseLogger.child({ service: 'plugin-development' });

export class PluginDevelopmentService extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.enabled = true; // ENABLED BY DEFAULT
    this.isRunning = false;
    this.lastCheckTime = null;
    this.checkInterval = 24 * 60 * 60 * 1000; // Daily by default
    this.developmentQueue = [];
    
    // MongoDB connection
    this.mongoClient = null;
    this.db = null;
    this.dedupeCollection = null;
    
    // Configuration
    this.config = {
      enabled: true,
      checkIntervalHours: 24, // How often to look for new plugin opportunities
      maxPluginsPerDay: 10, // Maximum plugins per day (hard limit)
      focusAreas: [
        'productivity', // Task management, calendars, notes
        'monitoring', // System monitoring, analytics
        'communication', // Slack, Discord, Teams integrations
        'automation', // IFTTT, Zapier-like services
        'data', // Databases, analytics, visualization
        'development', // GitHub, GitLab, CI/CD tools
        'ai', // AI services, ML platforms
        'iot', // Smart home, sensors
        'finance', // Crypto, stocks, budgeting
        'health' // Fitness trackers, health monitoring
      ],
      excludeAPIs: [
        'twitter', // Already exists
        'elevenlabs', // Already exists
        'projects', // Already exists
        'git', // Already exists
        'email', // Already exists
        'weatherapi', // Already exists
        'newsapi', // Already exists
        'openweathermap', // Already attempted
      ],
      requireTests: true,
      createPR: true,
      gitToken: process.env.GIT_PERSONAL_ACCESS_TOKEN
    };
    
    // Use same git setup as self-modification
    this.developmentPath = process.env.AGENT_REPO_PATH || process.cwd();
    
    // Configure git with timeout and progress logging
    this.git = simpleGit(this.developmentPath, {
      progress: ({ method, stage, progress }) => {
        logger.info(`Git ${method} progress: ${stage} ${progress}%`);
      },
      timeout: {
        block: 30000  // 30 second timeout for blocking operations
      }
    });
    
    logger.info(`Plugin development service initialized (ENABLED by default) - Git path: ${this.developmentPath}`);
    
    // Load configuration from database and then start the development cycle
    this.initialize();
  }

  /**
   * Initialize the service with database configuration
   */
  async initialize() {
    try {
      await this.initializeMongoDB();
      await this.loadConfig();
      await this.loadDevelopmentHistory();
      
      // Reset isRunning state on startup in case of previous crash
      this.isRunning = false;
      logger.info('Reset isRunning state on startup');
      
      this.startDevelopmentCycle();
    } catch (error) {
      logger.error('Failed to initialize plugin development service:', error);
      // Still start with default config if initialization fails
      this.isRunning = false;
      this.startDevelopmentCycle();
    }
  }
  
  /**
   * Load development history from database
   */
  async loadDevelopmentHistory() {
    const maxRetries = 5;
    const baseDelay = 1000; // 1 second
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if Mongoose is connected
        const mongoose = await import('mongoose');
        if (!mongoose.default?.connection || mongoose.default.connection.readyState !== 1) {
          logger.warn(`MongoDB not ready, attempt ${attempt}/${maxRetries}`);
          
          // Try to establish connection
          try {
            const { connectDatabase } = await import('../utils/database.js');
            await connectDatabase();
          } catch (dbError) {
            logger.error('Failed to connect to database:', dbError);
          }
          
          if (attempt < maxRetries) {
            // Exponential backoff: 1s, 2s, 4s, 8s, 16s
            const delay = baseDelay * Math.pow(2, attempt - 1);
            logger.info(`Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          } else {
            logger.error('MongoDB connection failed after all retries');
            return;
          }
        }
        
        // Load last 50 plugin developments
        const history = await PluginDevelopment.find()
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();
      
      // Convert to the format expected by developmentQueue
      // Reverse the array so oldest items are first, matching how new items are pushed
      this.developmentQueue = history.reverse().map(item => ({
        api: item.api,
        branchName: item.branchName,
        prUrl: item.prUrl,
        createdAt: item.createdAt.toISOString(),
        status: item.status,
        error: item.error
      }));
      
      logger.info(`Loaded ${this.developmentQueue.length} plugin development history items`);
      break; // Success, exit retry loop
      
      } catch (error) {
        if (attempt === maxRetries) {
          logger.error('Failed to load plugin development history after all retries:', error);
        } else {
          logger.warn(`Failed to load history on attempt ${attempt}/${maxRetries}:`, error.message);
          const delay = baseDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  /**
   * Initialize MongoDB connection
   */
  async initializeMongoDB() {
    try {
      const mongoUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017';
      this.mongoClient = new MongoClient(mongoUrl);
      await this.mongoClient.connect();
      this.db = this.mongoClient.db(process.env.MONGODB_DB || 'lanagent');
      this.dedupeCollection = this.db.collection('pluginDevelopmentDedupe');
      logger.info('Plugin development service connected to MongoDB');
    } catch (error) {
      logger.error('Failed to connect to MongoDB:', error);
      throw error;
    }
  }

  /**
   * Enable plugin development service
   */
  async enable() {
    if (this.enabled) {
      logger.warn('Plugin development service already enabled');
      return;
    }
    
    if (!this.config.gitToken) {
      throw new Error('Git personal access token required for plugin development');
    }
    
    this.enabled = true;
    this.config.enabled = true;
    this.startDevelopmentCycle();
    logger.info('Plugin development service ENABLED');
    
    // Save the enabled state to database
    await this.saveConfig();
    
    this.emit('enabled');
  }

  /**
   * Disable plugin development service
   */
  async disable() {
    this.enabled = false;
    this.config.enabled = false;
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    
    // Clear next check time
    this.nextCheckTime = null;
    
    // Close MongoDB connection
    if (this.mongoClient) {
      try {
        await this.mongoClient.close();
        logger.info('MongoDB connection closed for plugin development service');
      } catch (error) {
        logger.error('Error closing MongoDB connection:', error);
      }
    }
    
    // Save the disabled state to database
    await this.saveConfig();
    
    logger.info('Plugin development service DISABLED');
    this.emit('disabled');
  }

  /**
   * Start the development cycle
   */
  startDevelopmentCycle() {
    // Schedule next check
    this.scheduleNextCheck();
  }

  /**
   * Schedule the next plugin development check
   */
  scheduleNextCheck() {
    if (!this.enabled) return;
    
    const nextCheckIn = this.config.checkIntervalHours * 60 * 60 * 1000;
    this.checkTimer = setTimeout(() => {
      this.checkForPluginOpportunities();
    }, nextCheckIn);
    
    this.nextCheckTime = new Date(Date.now() + nextCheckIn);
    logger.info(`Next plugin development check scheduled for ${this.nextCheckTime.toISOString()}`);
  }

  /**
   * Main method to check for plugin development opportunities
   */
  async checkForPluginOpportunities() {
    if (!this.enabled) {
      logger.info('Plugin development check skipped - service is disabled');
      return;
    }
    
    if (this.isRunning) {
      logger.info('Plugin development check already in progress');
      return;
    }
    
    // Acquire lock with timeout
    let lockAcquired = false;
    try {
      lockAcquired = await selfModLock.acquire('plugin-development');
      if (!lockAcquired) {
        logger.warn('Could not acquire lock for plugin development check');
        return;
      }
    } catch (lockError) {
      logger.error('Error acquiring lock:', lockError);
      return;
    }
    
    // Create a promise that will resolve when operation completes or timeout occurs
    let operationComplete = false;
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        if (!operationComplete) {
          logger.error('Plugin development operation timed out after 30 minutes');
          resolve({ timedOut: true });
        }
      }, 30 * 60 * 1000); // 30 minute timeout for entire operation
    });
    
    // IMPORTANT: Everything after acquiring the lock must be in try-finally to ensure lock release
    try {
      // Wrap actual work in a promise
      const workPromise = this._doPluginDevelopmentWork();
      
      // Race between work and timeout
      const result = await Promise.race([workPromise, timeoutPromise]);
      
      if (result && result.timedOut) {
        logger.error('Plugin development work timed out - cleaning up');
        await this.emergencyCleanup();
        return;
      }
      
      operationComplete = true;
      logger.info('Plugin development check completed successfully');
      
    } catch (error) {
      logger.error('Plugin development check failed:', error);
      await this.emergencyCleanup();
    } finally {
      this.isRunning = false;
      if (lockAcquired) {
        await selfModLock.release('plugin-development');
      }
      
      // Schedule next check
      this.scheduleNextCheck();
    }
  }
  
  async _doPluginDevelopmentWork() {
    try {
      this.isRunning = true;
      this.lastCheckTime = new Date();
      
      // Save the lastCheckTime to database
      await this.saveLastCheckTime();
      
      logger.info('Starting plugin development opportunity scan...');
      
      // Check if developmentPath is set
      try {
        const devPath = this.developmentPath || 'NOT SET';
        logger.info(`Development path configured as: ${devPath}`);
        if (!this.developmentPath) {
          throw new Error('Development path not configured - check AGENT_REPO_PATH environment variable');
        }
      } catch (pathError) {
        logger.error('Error checking development path:', pathError);
        throw pathError;
      }
      
      // 0. Validate git repository by checking git status
      try {
        logger.info(`Validating git repository at: ${this.developmentPath}`);
        logger.info(`Current working directory: ${process.cwd()}`);
        
        // Use exec directly with absolute path
        const gitCommand = `cd ${this.developmentPath} && git status --porcelain`;
        const { stdout, stderr } = await execPromise(gitCommand, {
          timeout: 5000 // 5 second timeout
        });
        
        logger.info(`Git validation successful using exec`);
        
        // Get current branch using exec
        const branchCommand = `cd ${this.developmentPath} && git branch --show-current`;
        const { stdout: branchOut } = await execPromise(branchCommand, {
          timeout: 5000
        });
        
        logger.info(`Current git branch: ${branchOut.trim()}`);
      } catch (repoError) {
        logger.error('Git repository validation failed:', repoError);
        logger.error(`Failed path: ${this.developmentPath}`);
        logger.error(`Error details: ${JSON.stringify(repoError)}`);
        throw new Error(`Git repository issue: ${repoError.message}`);
      }
      
      // 0.5 Ensure we start from main branch
      try {
        logger.info('Ensuring we start from main branch...');
        
        logger.info('Switching to main branch...');
        await execPromise(`cd ${this.developmentPath} && git checkout main`, {
          timeout: 10000
        });
        logger.info('Successfully switched to main branch');
        
        logger.info('Pulling latest changes from origin/main...');
        await execPromise(`cd ${this.developmentPath} && git pull origin main`, {
          timeout: 30000 // 30 seconds for pull
        });
        logger.info('Successfully pulled latest changes');
      } catch (gitError) {
        logger.error('Failed to switch to main branch at start:', gitError);
        throw new Error('Cannot proceed without clean main branch');
      }
      
      // 0.4 Clean up stale in-progress plugins (older than 2 hours)
      await this.cleanupStaleInProgressPlugins();
      
      // 0.5 First check for user-requested plugin features
      const featureRequestedPlugins = await this.checkFeatureRequestsForPlugins();
      if (featureRequestedPlugins.length > 0) {
        logger.info(`📋 Found ${featureRequestedPlugins.length} plugin requests from users`);
        // Prioritize user-requested plugins
        for (const pluginRequest of featureRequestedPlugins) {
          // Add per-plugin timeout (15 minutes)
          const pluginTimeout = new Promise((resolve) => {
            setTimeout(() => {
              logger.error(`Plugin development for ${pluginRequest.name} timed out after 15 minutes`);
              resolve({ success: false, reason: 'timeout' });
            }, 15 * 60 * 1000);
          });
          
          try {
            // Race between plugin development and timeout
            const result = await Promise.race([
              this.developPlugin(pluginRequest),
              pluginTimeout
            ]);
            
            if (result && !result.success && result.reason === 'timeout') {
              logger.error(`Skipping ${pluginRequest.name} due to timeout`);
              continue;
            }
          } catch (error) {
            logger.error(`Failed to develop plugin for ${pluginRequest.name}:`, error);
            // Continue with next plugin instead of breaking the entire loop
            continue;
          }
        }
        logger.info(`Plugin development completed for ${featureRequestedPlugins.length} user-requested features.`);
        return;
      }
      
      // 1. Analyze existing plugins to understand patterns
      const existingPlugins = await this.analyzeExistingPlugins();
      
      // 2. Search for popular APIs in focus areas
      logger.info('Searching for API candidates...');
      const apiCandidates = await this.searchForAPICandidates(existingPlugins);
      logger.info(`Found ${apiCandidates.length} API candidates`);
      
      // 3. Evaluate and prioritize candidates
      logger.info('Evaluating candidates...');
      const prioritizedCandidates = await this.evaluateCandidates(apiCandidates);
      logger.info(`Evaluated ${prioritizedCandidates.length} candidates`);
      
      // 4. Select top candidate(s) based on weekly limit
      const selectedAPIs = await this.selectTopCandidates(prioritizedCandidates);
      logger.info(`Selected ${selectedAPIs.length} APIs for development`);
      
      // 5. Develop plugins for selected APIs
      let successfulPlugins = 0;
      let failedPlugins = 0;
      
      for (const api of selectedAPIs) {
        logger.info(`Developing plugin for ${api.name}...`);
        
        // Add per-plugin timeout (15 minutes)
        const pluginTimeout = new Promise((resolve) => {
          setTimeout(() => {
            logger.error(`Plugin development for ${api.name} timed out after 15 minutes`);
            resolve({ success: false, reason: 'timeout' });
          }, 15 * 60 * 1000);
        });
        
        try {
          // Race between plugin development and timeout
          const result = await Promise.race([
            this.developPlugin(api),
            pluginTimeout
          ]);
          
          if (result && !result.success && result.reason === 'timeout') {
            logger.error(`Skipping ${api.name} due to timeout`);
            failedPlugins++;
            continue;
          }
          
          // Check if the result was actually successful
          if (result && result.success) {
            successfulPlugins++;
            logger.info(`Successfully developed plugin for ${api.name}`);
          } else {
            failedPlugins++;
            logger.error(`Failed to develop plugin for ${api.name}:`, result?.error || 'Unknown error');
          }
        } catch (error) {
          logger.error(`Failed to develop plugin for ${api.name}:`, error);
          failedPlugins++;
          // Continue with next plugin instead of breaking the entire loop
          continue;
        }
      }
      
      logger.info(`Plugin development check completed. Successfully developed ${successfulPlugins} plugins, ${failedPlugins} failed.`);
      return { success: true };
      
    } catch (error) {
      logger.error('Plugin development check failed:', error);
      throw error;
    } finally {
      // Ensure we're back on main branch after all operations
      try {
        await this.git.checkout('main');
        logger.info('Returned to main branch at end of plugin development check');
      } catch (gitError) {
        logger.error('Failed to return to main branch:', gitError);
      }
    }
  }

  /**
   * Emergency cleanup when operation times out
   */
  async emergencyCleanup() {
    logger.error('Performing emergency cleanup due to timeout');
    try {
      // Try to return to main branch
      await this.git.checkout('main');
    } catch (e) {
      logger.error('Failed to checkout main during emergency cleanup:', e);
    }
    
    // TEMPORARY: Skip lock operations
    logger.warn('TEMPORARY: Skipping lock force clear in emergency cleanup');
    // // Force release the lock
    // try {
    //   await selfModLock.forceClear();
    //   logger.warn('Force cleared lock during emergency cleanup');
    // } catch (e) {
    //   logger.error('Failed to force clear lock:', e);
    // }
    
    this.isRunning = false;
  }

  /**
   * Check feature requests for plugin-related requests
   */
  async checkFeatureRequestsForPlugins() {
    const pluginRequests = [];
    
    try {
      // Get plugin-related feature requests (include 'analyzing' to recover from race conditions)
      const requests = await FeatureRequest.find({
        status: { $in: ['submitted', 'planned', 'analyzing'] },
        category: { $in: ['plugin', 'plugin-new'] },
        priority: { $in: ['critical', 'high', 'medium'] },
        autoGenerated: false // Focus on user-submitted requests
      }).sort({ priority: -1, votes: -1, submittedAt: -1 }).limit(5);
      
      logger.info(`Found ${requests.length} plugin-related feature requests`);
      
      for (const request of requests) {
        // Convert feature request to API candidate format
        const apiCandidate = {
          name: request.title,
          description: request.description,
          category: request.category,
          useCase: request.useCase,
          implementation: request.implementation,
          score: request.priority === 'critical' ? 100 : 
                 request.priority === 'high' ? 80 : 60,
          votes: request.votes || 0,
          featureRequestId: request._id,
          fromFeatureRequest: true
        };
        
        // Check if this plugin already exists
        if (!this.config.excludeAPIs.includes(apiCandidate.name.toLowerCase())) {
          pluginRequests.push(apiCandidate);
          
          // Update request status
          await request.updateStatus('in-progress', 'Being developed by plugin development service');
        }
      }
      
      return pluginRequests;
    } catch (error) {
      logger.error('Failed to check feature requests for plugins:', error);
      return [];
    }
  }

  /**
   * Analyze existing plugins to understand patterns and structure
   */
  async analyzeExistingPlugins() {
    const pluginsDir = path.join(this.developmentPath, 'src/api/plugins');
    const plugins = [];
    
    try {
      const files = await fs.readdir(pluginsDir);
      
      for (const file of files) {
        if (file.endsWith('.js')) {
          const pluginPath = path.join(pluginsDir, file);
          const content = await fs.readFile(pluginPath, 'utf8');
          
          // Extract plugin metadata
          const nameMatch = content.match(/this\.name\s*=\s*['"]([^'"]+)['"]/);
          const descMatch = content.match(/this\.description\s*=\s*['"]([^'"]+)['"]/);
          const commandsMatch = content.match(/this\.commands\s*=\s*\[([\s\S]*?)\]/);
          
          if (nameMatch) {
            plugins.push({
              name: nameMatch[1],
              description: descMatch ? descMatch[1] : '',
              file: file,
              hasCommands: !!commandsMatch,
              usesAPI: content.includes('fetch(') || content.includes('axios'),
              hasTests: false // Would need to check test directory
            });
          }
        }
      }
      
      logger.info(`Analyzed ${plugins.length} existing plugins`);
      return plugins;
      
    } catch (error) {
      logger.error('Failed to analyze existing plugins:', error);
      return [];
    }
  }

  /**
   * Search for API candidates using web search with retry logic
   */
  async searchForAPICandidates(existingPlugins) {
    // Add timeout wrapper for the entire search process
    const searchTimeout = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('searchForAPICandidates timed out after 10 minutes'));
      }, 10 * 60 * 1000); // 10 minute timeout
    });
    
    const searchWork = this._searchForAPICandidatesInternal(existingPlugins);
    
    try {
      return await Promise.race([searchWork, searchTimeout]);
    } catch (error) {
      logger.error('searchForAPICandidates failed:', error);
      return []; // Return empty array on timeout/error
    }
  }
  
  async _searchForAPICandidatesInternal(existingPlugins) {
    const candidates = [];
    
    // Load comprehensive deduplication tracking
    const deduplicationData = await this.loadDeduplicationData();
    
    // Create comprehensive list of existing API names and keywords for better duplication prevention
    const existingKeywords = new Set();
    existingPlugins.forEach(plugin => {
      existingKeywords.add(plugin.name.toLowerCase());
      existingKeywords.add(plugin.file.replace('.js', '').toLowerCase());
      // Extract potential API names from descriptions
      if (plugin.description) {
        const words = plugin.description.toLowerCase().match(/\b\w+\b/g) || [];
        words.forEach(word => {
          if (word.length > 3) existingKeywords.add(word);
        });
      }
    });
    
    // Add deduplication tracking data
    deduplicationData.completed_apis.forEach(api => {
      if (typeof api === 'string') {
        existingKeywords.add(api.toLowerCase());
      } else if (api && api.name) {
        existingKeywords.add(api.name.toLowerCase());
      }
    });
    deduplicationData.excluded_apis.forEach(api => {
      if (typeof api === 'string') {
        existingKeywords.add(api.toLowerCase());
      } else if (api && api.name) {
        existingKeywords.add(api.name.toLowerCase());
      }
    });
    this.config.excludeAPIs.forEach(api => existingKeywords.add(api.toLowerCase()));
    
    for (const focusArea of this.config.focusAreas) {
      // Skip if we've recently attempted this focus area with no results
      // TEMPORARY: Reduce threshold to 5 minutes for testing
      if (deduplicationData.attempted_apis.some(attempt => 
        attempt.focusArea === focusArea && 
        attempt.attemptedAt && 
        (Date.now() - new Date(attempt.attemptedAt).getTime()) < 5 * 60 * 1000 // 5 minutes for testing
      )) {
        logger.info(`Skipping ${focusArea} - recently attempted with no results (within 5 min)`);
        continue;
      }
      
      // Add timeout for each focus area (2 minutes max per focus area)
      const focusAreaTimeout = new Promise((resolve) => {
        setTimeout(() => {
          logger.warn(`Timeout processing focus area: ${focusArea}`);
          resolve(null);
        }, 2 * 60 * 1000);
      });
      
      const processFocusArea = async () => {
        // Try up to 5 different search terms for this focus area
        let foundCandidate = false;
        for (let attempt = 1; attempt <= 5 && !foundCandidate; attempt++) {
        try {
          // Use current month/year for dynamic search queries
          const now = new Date();
          const currentMonth = now.toLocaleString('default', { month: 'long' });
          const currentYear = now.getFullYear();
          
          // Create varied search queries for each attempt - prioritizing APIs with free tiers
          const searchQueries = [
            `best free tier ${focusArea} APIs ${currentYear}`,
            `${focusArea} APIs with generous free plan`,
            `free ${focusArea} REST API documentation examples`,
            `${focusArea} API services free tier comparison`,
            `top ${focusArea} APIs for developers free usage`,
            `${focusArea} API free plan no credit card`,
            `popular ${focusArea} APIs with free quotas`,
            `${focusArea} web services API free tier ${currentYear}`
          ];
          
          // Select query based on attempt number to ensure variety
          const searchQuery = searchQueries[(attempt - 1) % searchQueries.length];
          
          logger.info(`Searching for APIs (attempt ${attempt}/5): "${searchQuery}"`);
          
          // Perform web search
          const searchResults = await this.performWebSearch(searchQuery, focusArea);
          
          if (searchResults && searchResults.length > 0) {
            // Parse text results to extract API candidates
            const extractedAPIs = await this.extractAPIsFromSearchResults(searchResults, focusArea, existingKeywords);
            
            if (extractedAPIs && extractedAPIs.length > 0) {
              candidates.push(...extractedAPIs);
              foundCandidate = true;
              logger.info(`Found ${extractedAPIs.length} potential APIs for ${focusArea}`);
              break; // Exit retry loop for this focus area
            } else {
              logger.warn(`No valid APIs extracted from search results (attempt ${attempt}/5)`);
            }
          } else {
            logger.warn(`No search results for ${focusArea} (attempt ${attempt}/5)`);
          }
          
        } catch (error) {
          logger.error(`Search attempt ${attempt} failed for ${focusArea}:`, error);
        }
      }
      
      // If no candidates found after 5 attempts, record this attempt
      if (!foundCandidate) {
        await this.recordAttemptedAPI({ focusArea, reason: 'no_results_after_5_attempts' });
        logger.info(`No APIs found for ${focusArea} after 5 attempts`);
      }
      return foundCandidate;
    };
      
      // Race between processing and timeout
      const focusAreaResult = await Promise.race([processFocusArea(), focusAreaTimeout]);
      
      if (focusAreaResult === null) {
        logger.warn(`Skipped ${focusArea} due to timeout`);
        await this.recordAttemptedAPI({ focusArea, reason: 'timeout_after_2_minutes' });
      }
    }
    
    // 4. Get plugin ideas from stored GitHub discoveries
    try {
      logger.info('🔍 Checking stored GitHub discoveries for plugin ideas...');
      
      const githubPlugins = await this.getStoredGitHubPluginIdeas();
      candidates.push(...githubPlugins);
      
      logger.info(`Found ${githubPlugins.length} plugin ideas from stored GitHub discoveries`);
    } catch (error) {
      logger.warn('Failed to get stored GitHub plugin ideas:', error.message);
    }
    
    logger.info(`Total API candidates found: ${candidates.length}`);
    return candidates;
  }

  /**
   * Perform web search with provider fallback logic
   */
  async performWebSearch(searchQuery, focusArea) {
    try {
      let webSearchPlugin = null;
      if (this.agent.apiManager) {
        webSearchPlugin = this.agent.apiManager.getPlugin('websearch');
      } else {
        logger.warn('API Manager not available, using fallback method');
        return null;
      }
      
      if (webSearchPlugin) {
        // Determine the best provider for web search (Anthropic or OpenAI)
        const currentProvider = this.agent.providerManager?.getCurrentProvider();
        let searchProvider = null;
        
        if (currentProvider?.name === 'anthropic') {
          searchProvider = 'anthropic';
        } else if (this.agent.providerManager?.providers?.has('openai')) {
          searchProvider = 'openai';
          logger.info(`Using OpenAI fallback for web search`);
        } else {
          logger.warn('No suitable provider for web search available');
          return null;
        }
        
        const searchResponse = await webSearchPlugin.execute({
          action: 'search',
          query: searchQuery,
          maxResults: 10,
          provider: searchProvider
        });
        
        if (searchResponse.success && searchResponse.data && searchResponse.data.length > 0) {
          return searchResponse.data;
        } else {
          logger.warn(`Web search returned no results for: ${searchQuery}`);
          return null;
        }
      } else {
        // Fallback to direct AI search
        return await this.performFallbackSearch(searchQuery, focusArea);
      }
    } catch (error) {
      logger.error(`Web search failed:`, error);
      return null;
    }
  }

  /**
   * Extract API candidates from search results using scraper for better data
   */
  async extractAPIsFromSearchResults(searchResults, focusArea, existingKeywords) {
    try {
      const candidates = [];
      
      // First, try to use scraper on free API directory sites with public documentation
      const scrapedCandidates = await this.scrapeAPIDirectories(focusArea);
      if (scrapedCandidates.length > 0) {
        candidates.push(...scrapedCandidates);
      }
      
      // If we have search results, also extract from those
      if (searchResults && searchResults.length > 0) {
        const extractedFromSearch = await this.extractFromSearchWithRobustParsing(searchResults, focusArea);
        candidates.push(...extractedFromSearch);
      }
      
      // Remove duplicates and apply existing keyword filtering
      const uniqueCandidates = this.filterAndDeduplicateCandidates(candidates, existingKeywords);
      
      logger.info(`Extracted ${uniqueCandidates.length} unique API candidates for ${focusArea}`);
      return uniqueCandidates;
      
    } catch (error) {
      logger.error('Failed to extract APIs from search results:', error);
      return [];
    }
  }

  /**
   * Scrape free API directories with publicly accessible documentation
   */
  async scrapeAPIDirectories(focusArea) {
    const candidates = [];
    
    try {
      const scraperPlugin = this.agent.apiManager?.getPlugin('scraper');
      if (!scraperPlugin) {
        logger.warn('Scraper plugin not available, skipping API directory scraping');
        return [];
      }
      
      // Define API directory URLs to scrape - prioritizing APIs with free tiers and public docs
      // These sources don't require login to VIEW documentation (unlike RapidAPI)
      const baseUrls = [
        `https://github.com/public-apis/public-apis`, // Community-curated, 1400+ APIs with auth info
        `https://publicapis.dev`, // Modern interface, 1400+ APIs with categories
        `https://apilist.fun`, // Free API directory with categories
        `https://mixedanalytics.com/blog/list-actually-free-open-no-auth-needed-apis/`, // No-auth APIs (subset)
        `https://www.apipheny.io/free-api/` // Curated list of 90+ free tier APIs
      ];
      
      // Build URLs based on whether they support categories
      const directoryUrls = [];
      for (const baseUrl of baseUrls) {
        if (baseUrl.includes('publicapis.dev') || baseUrl.includes('apilist.fun')) {
          // These sites support categories
          directoryUrls.push(`${baseUrl}/category/${focusArea}`);
        } else {
          // These are general lists - we'll filter by focus area during extraction
          directoryUrls.push(baseUrl);
        }
      }
      
      // Process up to 3 URLs, starting with the most comprehensive sources
      const urlsToProcess = directoryUrls.slice(0, 3);
      
      for (const url of urlsToProcess) {
        try {
          logger.info(`Scraping API directory: ${url}`);
          
          const scrapeResult = await scraperPlugin.execute({
            action: 'scrape',
            url: url,
            waitFor: 2000
          });
          
          if (scrapeResult.success && scrapeResult.content) {
            // Extract text content from the scraped result
            const textContent = scrapeResult.content.text || '';
            const extractedAPIs = await this.extractAPIsFromScrapedContent(textContent, focusArea, url);
            if (extractedAPIs.length > 0) {
              candidates.push(...extractedAPIs);
              logger.info(`Found ${extractedAPIs.length} APIs from ${url}`);
            }
          } else {
            logger.warn(`Failed to scrape ${url}: ${scrapeResult.error || 'Unknown error'}`);
          }
        } catch (error) {
          logger.warn(`Error scraping ${url}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('Failed to scrape API directories:', error);
    }
    
    return candidates;
  }

  /**
   * Extract APIs from scraped content with robust parsing
   */
  async extractAPIsFromScrapedContent(scrapedContent, focusArea, sourceUrl) {
    try {
      const extractionPrompt = `Extract API services from this content about ${focusArea} APIs:

${scrapedContent.substring(0, 8000)}

You MUST respond with a simple list in this EXACT format (pipe-separated):
API_NAME | Brief description | Documentation URL

Example:
OpenWeatherMap | Weather data and forecasts API | https://openweathermap.org/api
Spoonacular | Recipe and nutrition data API | https://spoonacular.com/food-api
Skyscanner | Flight search and booking API | https://developers.skyscanner.net

IMPORTANT: DO NOT include numbers before API names (no "1. ", "2. ", etc.)
Just provide the API name directly, like the examples above.

ONLY provide APIs that:
- Have REST/HTTP endpoints  
- Are mentioned in the content above
- Have FREE TIERS or generous free plans (API key signup is fine)
- Have PUBLICLY VIEWABLE documentation (no login required to read docs)
- Are NOT behind RapidAPI or similar API hubs that hide documentation
- Have clear examples and getting started guides
- Match the ${focusArea} category

Respond with 3-5 APIs maximum. Use the EXACT pipe format shown above.
NO NUMBERING, NO BULLETS, JUST PIPE-SEPARATED VALUES.`;
      
      const response = await this.processWithRobustProvider(extractionPrompt);
      return this.parseAPIListFromDelimitedText(response, focusArea, sourceUrl);
      
    } catch (error) {
      logger.error('Failed to extract APIs from scraped content:', error);
      return [];
    }
  }

  /**
   * Extract APIs from search results with robust parsing
   */
  async extractFromSearchWithRobustParsing(searchResults, focusArea) {
    try {
      const searchContext = searchResults.map(result => 
        `Title: ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`
      ).join('\n\n');
      
      const extractionPrompt = `Find specific API services from these search results about ${focusArea}:

${searchContext}

You MUST respond in this EXACT pipe-separated format:
API_NAME | Brief description | Documentation URL

Example:
GitHub | Code repository and collaboration API | https://docs.github.com/en/rest
Stripe | Payment processing API | https://stripe.com/docs
OpenWeatherMap | Weather data API | https://openweathermap.org/api

IMPORTANT: DO NOT include numbers before API names (no "1. ", "2. ", etc.)
Just provide the API name directly, like the examples above.

ONLY extract APIs that:
- Are specifically mentioned in the search results above
- Have REST/HTTP endpoints
- Are relevant to ${focusArea}
- Have documentation URLs

Provide 2-4 APIs maximum using the EXACT pipe format.
NO NUMBERING, NO BULLETS, JUST PIPE-SEPARATED VALUES.`;
      
      const response = await this.processWithRobustProvider(extractionPrompt);
      return this.parseAPIListFromDelimitedText(response, focusArea, 'search_results');
      
    } catch (error) {
      logger.error('Failed to extract from search results:', error);
      return [];
    }
  }

  /**
   * Parse API list from delimited text response (more robust)
   */
  parseAPIListFromDelimitedText(responseText, focusArea, source) {
    const candidates = [];
    
    try {
      // Handle case where responseText might be an object or not a string
      const textContent = typeof responseText === 'string' ? responseText : 
                         (responseText?.content || responseText?.result || JSON.stringify(responseText));
      
      const lines = textContent.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        let name, description, url;
        
        // Skip lines that don't look like API entries
        if (!line.includes('|') && !line.includes(':') && !line.includes('-')) {
          continue;
        }
        
        // Try multiple parsing patterns
        // Pattern 1: "API_NAME | Description | URL"
        let match = line.match(/^([^|]+)\s*\|\s*([^|]+)\s*\|\s*(.+)$/);
        if (match) {
          [, name, description, url] = match;
        } else {
          // Pattern 2: "API_NAME: Description - URL"
          match = line.match(/^([^:]+):\s*([^-]+)\s*-\s*(.+)$/);
          if (match) {
            [, name, description, url] = match;
          } else {
            // Pattern 3: "API_NAME - Description (URL)"
            match = line.match(/^([^-]+)\s*-\s*([^(]+)\s*\((.+)\)$/);
            if (match) {
              [, name, description, url] = match;
            } else {
              // Pattern 4: Just look for recognizable API names in the content
              const apiKeywords = ['API', 'api', 'REST', 'HTTP', 'endpoint', 'service'];
              if (apiKeywords.some(keyword => line.includes(keyword))) {
                // Extract first word as potential API name
                const words = line.trim().split(/\s+/);
                const potentialName = words[0].replace(/[^a-zA-Z0-9]/g, '');
                if (potentialName.length > 2 && potentialName.length < 20) {
                  name = potentialName;
                  description = line.substring(0, 100).trim();
                  url = `https://example.com/${potentialName.toLowerCase()}-api-docs`;
                }
              }
            }
          }
        }
        
        if (name && description && url) {
          let cleanName = name.trim();
          const cleanDesc = description.trim();
          const cleanUrl = url.trim();
          
          // Remove leading numbers and dots from API names (e.g., "1. OpenWeather" -> "OpenWeather")
          cleanName = cleanName.replace(/^\d+\.\s*/, '');
          
          // Remove any remaining non-alphanumeric characters from the start
          cleanName = cleanName.replace(/^[^a-zA-Z]+/, '');
          
          // Remove common suffixes that shouldn't be in the name
          cleanName = cleanName.replace(/\s*(API|api|Api)$/, '');
          
          // Basic validation
          if (cleanName.length > 2 && cleanDesc.length > 10 && cleanUrl.includes('http')) {
            candidates.push({
              name: cleanName,
              description: cleanDesc,
              url: cleanUrl,
              category: focusArea,
              focusArea: focusArea,
              source: source,
              searchScore: 1.0
            });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to parse API list from text:', error);
    }
    
    return candidates;
  }

  /**
   * Filter candidates and remove duplicates
   */
  filterAndDeduplicateCandidates(candidates, existingKeywords) {
    const filtered = [];
    const seen = new Set();
    
    for (const candidate of candidates) {
      const nameLower = candidate.name.toLowerCase().replace(/\s+/g, '');
      
      // Skip duplicates within this batch
      if (seen.has(nameLower)) {
        continue;
      }
      seen.add(nameLower);
      
      // Check against existing plugins
      const nameWords = candidate.name.toLowerCase().split(/\s+/);
      let isDuplicate = false;
      
      // Check exact matches
      if (existingKeywords.has(nameLower)) {
        logger.info(`Skipping ${candidate.name}: exact match with existing plugin`);
        continue;
      }
      
      // Check partial matches
      for (const keyword of existingKeywords) {
        if (nameLower.includes(keyword) || keyword.includes(nameLower)) {
          logger.info(`Skipping ${candidate.name}: partial match with '${keyword}'`);
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        // Check word matches
        for (const word of nameWords) {
          if (word.length > 3 && existingKeywords.has(word)) {
            logger.info(`Skipping ${candidate.name}: word '${word}' matches existing plugin`);
            isDuplicate = true;
            break;
          }
        }
      }
      
      if (!isDuplicate) {
        filtered.push(candidate);
        logger.info(`Added candidate: ${candidate.name} (from ${candidate.source})`);
      }
    }
    
    return filtered;
  }

  /**
   * Process AI request with robust provider handling
   */
  async processWithRobustProvider(prompt) {
    const currentProvider = this.agent.providerManager?.getCurrentProvider();
    
    // Use current provider if it's Anthropic or OpenAI
    if (currentProvider?.name === 'anthropic' || currentProvider?.name === 'openai') {
      return await this.agent.processNaturalLanguage(prompt, 'system');
    }
    
    // Switch to OpenAI for better parsing reliability
    if (this.agent.providerManager?.providers?.has('openai')) {
      logger.info('Switching to OpenAI for reliable API extraction');
      const originalProvider = this.agent.providerManager.getCurrentProvider();
      
      try {
        await this.agent.providerManager.switchProvider('openai');
        const response = await this.agent.processNaturalLanguage(prompt, 'system');
        return response;
      } finally {
        // Switch back only if we had an original provider
        if (originalProvider?.name && originalProvider.name !== 'openai') {
          await this.agent.providerManager.switchProvider(originalProvider.name);
        }
      }
    }
    
    // Fallback to current provider
    return await this.agent.processNaturalLanguage(prompt, 'system');
  }

  /**
   * Fallback search method when web search plugin is unavailable
   */
  async performFallbackSearch(searchQuery, focusArea) {
    try {
      const currentProvider = this.agent.providerManager?.getCurrentProvider();
      
      if (currentProvider?.name !== 'anthropic' && this.agent.providerManager?.providers?.has('openai')) {
        logger.info('Switching to OpenAI for fallback search');
        const originalProvider = this.agent.providerManager.getCurrentProvider();
        await this.agent.providerManager.switchProvider('openai');
        
        try {
          const response = await this.agent.processNaturalLanguage(
            `Search for information about: "${searchQuery}". Provide information about available APIs in the ${focusArea} category that developers can use.`,
            'system'
          );
          
          // Return mock search results format for consistency
          return [{
            title: `${focusArea} APIs Information`,
            url: 'https://example.com',
            snippet: response
          }];
        } finally {
          if (originalProvider?.name !== 'openai') {
            await this.agent.providerManager.switchProvider(originalProvider.name);
          }
        }
      } else {
        const response = await this.agent.processNaturalLanguage(
          `Search for information about: "${searchQuery}". Provide information about available APIs in the ${focusArea} category that developers can use.`,
          'system'
        );
        
        return [{
          title: `${focusArea} APIs Information`,
          url: 'https://example.com',
          snippet: response
        }];
      }
    } catch (error) {
      logger.error('Fallback search failed:', error);
      return null;
    }
  }
        
        

  /**
   * Evaluate and score API candidates with robust parsing
   */
  async evaluateCandidates(candidates) {
    const evaluated = [];
    
    for (const candidate of candidates) {
      try {
        logger.info(`Evaluating candidate: ${candidate.name}`);
        
        // Use more structured evaluation prompt
        const evaluationPrompt = `Evaluate the ${candidate.name} API at ${candidate.url} and respond in this format:

REST_API: yes/no
AUTH_TYPE: apiKey/oauth2/basic/none
FREE_TIER: yes/no
DOCS_QUALITY: good/fair/poor
POPULARITY: high/medium/low
USE_CASES: case1, case2, case3
ENDPOINTS: endpoint1, endpoint2, endpoint3

Be concise and specific.`;
        
        const researchResult = await this.processWithRobustProvider(evaluationPrompt);
        
        // Extract the content from the response object
        const responseText = researchResult?.content || researchResult || '';
        
        // Parse the structured response
        const details = this.parseEvaluationResponse(responseText);
        
        if (details) {
          // Calculate score based on various factors
          let score = candidate.searchScore;
          
          // Prefer APIs with good documentation
          if (details.documentation === 'good') score += 0.3;
          else if (details.documentation === 'poor') score -= 0.3;
          
          // Prefer popular APIs
          if (details.popularity === 'high') score += 0.2;
          else if (details.popularity === 'low') score -= 0.2;
          
          // Prefer APIs with free tier
          if (details.freeTeir) score += 0.2;
          
          // Prefer simpler auth methods
          if (details.authType === 'apiKey') score += 0.1;
          else if (details.authType === 'oauth2') score -= 0.1;
          
          evaluated.push({
            ...candidate,
            ...details,
            finalScore: score,
            evaluatedAt: new Date().toISOString()
          });
          
          logger.info(`Successfully evaluated ${candidate.name} with score ${score.toFixed(2)}`);
        } else {
          logger.warn(`Failed to parse evaluation for ${candidate.name}, using default scoring`);
          
          // Use default scoring if parsing fails
          evaluated.push({
            ...candidate,
            hasRESTAPI: true,
            requiresAuth: true,
            authType: 'apiKey',
            freeTeir: true,
            documentation: 'fair',
            popularity: 'medium',
            useCases: ['general', 'integration'],
            endpoints: ['api/endpoint1', 'api/endpoint2'],
            finalScore: 1.0,
            evaluatedAt: new Date().toISOString()
          });
        }
        
      } catch (error) {
        logger.error(`Failed to evaluate ${candidate.name}:`, error);
        
        // Add with minimal scoring if evaluation fails completely
        evaluated.push({
          ...candidate,
          hasRESTAPI: true,
          finalScore: 0.5,
          evaluatedAt: new Date().toISOString()
        });
      }
    }
    
    // Sort by score
    evaluated.sort((a, b) => b.finalScore - a.finalScore);
    
    logger.info(`Evaluated ${evaluated.length} candidates`);
    return evaluated;
  }

  /**
   * Parse evaluation response with multiple fallback methods
   */
  parseEvaluationResponse(responseText) {
    try {
      // Ensure responseText is a string
      if (typeof responseText !== 'string') {
        logger.warn('parseEvaluationResponse received non-string input:', typeof responseText);
        responseText = String(responseText || '');
      }
      
      // Try to parse as JSON first
      try {
        return JSON.parse(responseText);
      } catch (jsonError) {
        // Fallback to structured text parsing
        const details = {};
        const lines = responseText.split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim().toLowerCase();
          
          if (trimmed.includes('rest_api:') || trimmed.includes('rest api:')) {
            details.hasRESTAPI = trimmed.includes('yes');
          } else if (trimmed.includes('auth_type:') || trimmed.includes('auth type:')) {
            if (trimmed.includes('apikey') || trimmed.includes('api key')) details.authType = 'apiKey';
            else if (trimmed.includes('oauth')) details.authType = 'oauth2';
            else if (trimmed.includes('basic')) details.authType = 'basic';
            else details.authType = 'none';
          } else if (trimmed.includes('free_tier:') || trimmed.includes('free tier:')) {
            details.freeTeir = trimmed.includes('yes');
          } else if (trimmed.includes('docs_quality:') || trimmed.includes('documentation:')) {
            if (trimmed.includes('good')) details.documentation = 'good';
            else if (trimmed.includes('poor')) details.documentation = 'poor';
            else details.documentation = 'fair';
          } else if (trimmed.includes('popularity:')) {
            if (trimmed.includes('high')) details.popularity = 'high';
            else if (trimmed.includes('low')) details.popularity = 'low';
            else details.popularity = 'medium';
          } else if (trimmed.includes('use_cases:') || trimmed.includes('use cases:')) {
            const casesText = line.substring(line.indexOf(':') + 1);
            details.useCases = casesText.split(',').map(c => c.trim()).filter(c => c);
          } else if (trimmed.includes('endpoints:')) {
            const endpointsText = line.substring(line.indexOf(':') + 1);
            details.endpoints = endpointsText.split(',').map(e => e.trim()).filter(e => e);
          }
        }
        
        // Ensure we have at least basic fields
        if (!details.hasRESTAPI) details.hasRESTAPI = true;
        if (!details.authType) details.authType = 'apiKey';
        if (details.freeTeir === undefined) details.freeTeir = true;
        if (!details.documentation) details.documentation = 'fair';
        if (!details.popularity) details.popularity = 'medium';
        if (!details.useCases) details.useCases = ['integration', 'automation'];
        if (!details.endpoints) details.endpoints = ['api/data', 'api/info'];
        
        return details;
      }
    } catch (error) {
      logger.error('Failed to parse evaluation response:', error);
      return null;
    }
  }

  /**
   * Select top candidates based on daily limit and recent attempt history
   */
  async selectTopCandidates(candidates) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Count plugins created today
    const pluginsToday = this.developmentQueue.filter(
      item => {
        const itemDate = new Date(item.createdAt);
        itemDate.setHours(0, 0, 0, 0);
        return itemDate.getTime() === today.getTime() && item.status === 'completed';
      }
    ).length;
    
    const remainingSlots = Math.max(0, this.config.maxPluginsPerDay - pluginsToday);
    
    if (remainingSlots === 0) {
      logger.info('Daily plugin development limit reached');
      return [];
    }
    
    // Filter out recently attempted plugins
    const filteredCandidates = [];
    for (const candidate of candidates) {
      if (!(await this.hasRecentAttempt(candidate.name))) {
        filteredCandidates.push(candidate);
      } else {
        logger.info(`Skipping ${candidate.name} - recently attempted`);
      }
    }
    
    if (filteredCandidates.length === 0) {
      logger.info('No suitable candidates after filtering recent attempts');
      return [];
    }
    
    // Select top candidates based on remaining slots, but cap at 3 per run
    const maxPerRun = 3;
    const slotsToUse = Math.min(remainingSlots, maxPerRun);
    logger.info(`Selecting ${slotsToUse} plugins to develop (${remainingSlots} daily slots remaining, max ${maxPerRun} per run)`);
    return filteredCandidates.slice(0, slotsToUse);
  }

  /**
   * Check if this plugin was recently attempted (within 7 days)
   */
  async hasRecentAttempt(apiName) {
    try {
      // Ensure MongoDB is connected
      const mongoose = await import('mongoose');
      if (mongoose.connection.readyState !== 1) {
        logger.warn('MongoDB not ready for hasRecentAttempt check, waiting...');
        // Wait up to 5 seconds for connection
        let waited = 0;
        while (mongoose.connection.readyState !== 1 && waited < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
          waited += 100;
        }
        if (mongoose.connection.readyState !== 1) {
          logger.error('MongoDB still not ready after 5s, skipping check');
          return false; // Assume no recent attempt to avoid blocking
        }
      }
      
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      // Check for any recent attempt, including completed ones to avoid redoing successful work
      const recentAttempt = await PluginDevelopment.findOne({
        api: apiName,
        createdAt: { $gte: sevenDaysAgo },
        status: { $in: ['failed', 'in_progress', 'completed', 'postponed', 'rejected'] }
      });
      
      if (recentAttempt) {
        logger.info(`Found recent attempt for ${apiName}: ${recentAttempt.status} on ${recentAttempt.createdAt}`);
        
        // Don't retry completed plugins within 7 days
        if (recentAttempt.status === 'completed') {
          return true;
        }
        
        // Don't retry postponed or rejected plugins within 7 days
        if (recentAttempt.status === 'postponed' || recentAttempt.status === 'rejected') {
          return true;
        }
        
        // For failed plugins, check if it was very recent (within 24 hours)
        if (recentAttempt.status === 'failed') {
          const oneDayAgo = new Date();
          oneDayAgo.setDate(oneDayAgo.getDate() - 1);
          
          if (recentAttempt.createdAt >= oneDayAgo) {
            logger.info(`Plugin ${apiName} failed too recently (within 24 hours), skipping`);
            return true;
          }
        }
        
        // For in_progress, always skip
        if (recentAttempt.status === 'in_progress') {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      logger.error('Error checking recent attempts:', error);
      return false;
    }
  }
  
  /**
   * Get versioned branch name if a branch already exists
   */
  async getVersionedBranchName(baseBranchName) {
    try {
      // Check all existing branches (local and remote)
      const branches = await this.git.branch(['-a']);
      const allBranches = branches.all;
      
      // Check if base branch exists
      let version = 1;
      let versionedBranchName = baseBranchName;
      
      // Extract existing versions
      const versionPattern = new RegExp(`${baseBranchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-v(\d+))?$`);
      
      for (const branch of allBranches) {
        const cleanBranch = branch.replace(/^remotes\/origin\//, '');
        const match = cleanBranch.match(versionPattern);
        if (match) {
          if (match[1]) {
            version = Math.max(version, parseInt(match[1]) + 1);
          } else {
            // Base branch exists, start with v2
            version = Math.max(version, 2);
          }
        }
      }
      
      // Add version suffix if needed
      if (version > 1) {
        versionedBranchName = `${baseBranchName}-v${version}`;
        logger.info(`Using versioned branch name: ${versionedBranchName} (found existing versions up to v${version-1})`);
      }
      
      return versionedBranchName;
    } catch (error) {
      logger.error('Error getting versioned branch name:', error);
      return baseBranchName; // Fallback to base name
    }
  }

  /**
   * Check if a PR already exists for this plugin
   */
  async hasExistingPR(apiName) {
    try {
      const existingPRs = await this.checkForExistingPRs(apiName);
      const openPRs = existingPRs.filter(pr => pr.state === 'OPEN');
      
      if (openPRs.length > 0) {
        logger.info(`Found ${openPRs.length} open PRs for ${apiName}`);
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error('Error checking existing PRs:', error);
      return false;
    }
  }
  
  /**
   * Store rejection feedback in database for future attempts
   */
  async storeRejectionFeedback(apiName, feedback) {
    try {
      // Find the most recent development record for this API
      const record = await PluginDevelopment.findOne({
        api: apiName,
        status: { $in: ['completed', 'failed'] }
      }).sort({ createdAt: -1 });
      
      if (record) {
        record.rejectionFeedback = feedback;
        await record.save();
        logger.info(`Stored rejection feedback for ${apiName}`);
      }
    } catch (error) {
      logger.error('Failed to store rejection feedback:', error);
    }
  }

  /**
   * Develop a plugin for the selected API with implementation research
   */
  async developPlugin(api) {
    const startTime = Date.now();
    logger.info(`[${api.name}] Starting plugin development at ${new Date().toISOString()}`);
    
    // Helper function to log elapsed time
    const logElapsed = (step) => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`[${api.name}] ${step} - Elapsed: ${elapsed}s`);
    };
    
    // Check if this plugin was recently attempted
    if (await this.hasRecentAttempt(api.name)) {
      logger.warn(`Skipping ${api.name} - recently attempted`);
      return { success: false, reason: 'recently_attempted' };
    }
    
    // Check if a PR already exists
    if (await this.hasExistingPR(api.name)) {
      logger.warn(`Skipping ${api.name} - PR already exists`);
      return { success: false, reason: 'pr_exists' };
    }
    
    // Check if plugin already exists
    const pluginsDir = path.join(this.developmentPath, 'src/plugins');
    const pluginFileName = `${api.name.toLowerCase()}.js`;
    const pluginFilePath = path.join(pluginsDir, pluginFileName);
    
    try {
      await fs.access(pluginFilePath);
      logger.warn(`Skipping ${api.name} - plugin file already exists`);
      return { success: false, reason: 'plugin_exists' };
    } catch (error) {
      // File doesn't exist, which is what we want
    }
    
    // Create in-progress record
    let developmentRecord;
    try {
      developmentRecord = await PluginDevelopment.create({
        api: api.name,
        status: 'in_progress',
        apiDetails: {
          name: api.name,
          description: api.description,
          category: api.category,
          documentation: api.documentation,
          features: api.features,
          evaluation: api.evaluation
        }
      });
    } catch (dbError) {
      logger.error('Failed to create in-progress record:', dbError);
    }
    
    try {
      // 0. Check for previous rejection feedback
      const rejectionFeedback = await this.getRejectionFeedback(api.name);
      if (rejectionFeedback && rejectionFeedback.rejectionReasons.length > 0) {
        logger.info(`Found previous rejection feedback for ${api.name}:`);
        rejectionFeedback.rejectionReasons.forEach(reason => {
          logger.info(`  - ${reason}`);
        });
        
        // Add feedback to context for better implementation
        api.previousRejectionFeedback = rejectionFeedback;
      }
      
      // 1. Perform targeted implementation research
      logger.info(`[${api.name}] Step 1/14: Performing implementation research...`);
      const implementationResearch = await this.performImplementationResearch(api);
      logger.info(`[${api.name}] Implementation research completed`);
      logElapsed('Step 1 complete');
      
      // 2. Research API documentation thoroughly
      logger.info(`[${api.name}] Step 2/14: Researching API documentation...`);
      const apiDocs = await this.researchAPIDocumentation(api);
      logger.info(`[${api.name}] API documentation research completed`);
      logElapsed('Step 2 complete');
      
      // 3. Generate plugin code using implementation research as context
      logger.info(`[${api.name}] Step 3/14: Generating plugin code...`);
      const pluginCode = await this.generatePluginCode(api, apiDocs, implementationResearch);
      logger.info(`[${api.name}] Plugin code generated (${pluginCode.length} characters)`);
      logElapsed('Step 3 complete');
      
      // 3.5. Validate plugin code quality
      logger.info(`[${api.name}] Step 3.5/14: Validating plugin code quality...`);
      const validationResult = this.validatePluginCode(pluginCode, api);
      if (!validationResult.valid) {
        logger.error(`[${api.name}] Plugin code validation failed: ${validationResult.reasons.join(', ')}`);
        
        // Record failed attempt with validation reasons
        try {
          await PluginDevelopment.create({
            api: api.name,
            status: 'failed',
            reason: 'validation_failed',
            error: validationResult.reasons.join(', '),
            validationErrors: validationResult.reasons,
            elapsed: Math.round((Date.now() - startTime) / 1000),
            createdAt: new Date().toISOString(),
            completedAt: new Date()
          });
        } catch (dbError) {
          logger.error('Failed to save validation failure to database:', dbError);
        }
        
        return { 
          success: false, 
          reason: 'validation_failed',
          errors: validationResult.reasons
        };
      }
      logger.info(`[${api.name}] Plugin code validation passed`);
      
      // 4. Generate test code
      logger.info(`[${api.name}] Step 4/14: Generating test code...`);
      const testCode = await this.generateTestCode(api, apiDocs);
      logger.info(`[${api.name}] Test code generated (${testCode.length} characters)`);
      logElapsed('Step 4 complete');
      
      // 5. Create feature branch
      logger.info(`[${api.name}] Step 5/14: Creating feature branch...`);
      const cleanBranchName = api.name
        .toLowerCase()
        .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
        .replace(/[^a-z0-9\s]/g, '') // Keep only alphanumeric and spaces
        .replace(/\s+/g, '-') // Replace spaces with dashes
        .replace(/api$/i, ''); // Remove trailing "api"
      
      const baseBranchName = `feature/plugin-${cleanBranchName}`;
      const branchName = await this.getVersionedBranchName(baseBranchName);
      await this.createFeatureBranch(branchName);
      
      // 6. Write plugin and test files
      // Clean the API name for file naming
      const cleanApiName = api.name
        .toLowerCase()
        .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
        .replace(/[^a-z0-9]+/g, '') // Keep only alphanumeric characters
        .replace(/api$/i, ''); // Remove trailing "api" if present
      
      const pluginFileName = `${cleanApiName}.js`;
      const testFileName = `${cleanApiName}.test.js`;
      const pluginPath = path.join(this.developmentPath, 'src/api/plugins', pluginFileName);
      const testPath = path.join(this.developmentPath, 'tests/plugins', testFileName);
      
      logger.info(`Writing plugin file to: ${pluginPath}`);
      logger.info(`Writing test file to: ${testPath}`);
      
      // Ensure directories exist
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.mkdir(path.dirname(testPath), { recursive: true });
      
      // Write files
      await fs.writeFile(pluginPath, pluginCode);
      logger.info(`Plugin file written successfully`);
      
      await fs.writeFile(testPath, testCode);
      logger.info(`Test file written successfully`);
      
      // 7. Run tests if enabled
      let testResults = null;
      if (this.config.requireTests) {
        logger.info('Running tests for new plugin...');
        testResults = await this.runPluginTests(testFileName);
        
        if (!testResults.success && this.config.requireTests) {
          // If tests fail and are required, we should still commit but note in PR
          logger.warn(`Tests failed for ${api.name} plugin:`, testResults.error);
        }
      }
      
      // 8. Scan and update documentation files
      await this.scanAndUpdateDocumentation(api, pluginFileName);
      
      // 9. Update AI intent detection
      await this.updateAIIntentDetection(api, pluginFileName);
      
      // 10. Commit changes
      await this.commitPluginChanges(api, branchName);
      
      // 11. Create pull request
      const prUrl = await this.createPluginPullRequest(api, branchName, testResults);
      
      // 12. Record successful completion
      await this.recordCompletedAPI({
        name: api.name,
        category: api.category,
        url: api.url,
        prUrl: prUrl,
        branchName: branchName,
        completedAt: new Date().toISOString(),
        featureRequestId: api.featureRequestId, // Pass the feature request ID for cleanup
        discoveredFeatureId: api.discoveredFeatureId // Pass the discovered feature ID for cleanup
      });
      
      // 13. Switch back to main branch after successful PR creation
      await this.git.checkout('main');
      logger.info(`Switched back to main branch after PR creation`);
      
      // 14. Record in development queue and database
      const queueRecord = {
        api: api.name,
        branchName: branchName,
        prUrl: prUrl,
        createdAt: new Date().toISOString(),
        status: 'completed'
      };
      
      this.developmentQueue.push(queueRecord);
      
      // Update database record to completed
      try {
        if (developmentRecord && developmentRecord._id) {
          await PluginDevelopment.findByIdAndUpdate(developmentRecord._id, {
            status: 'completed',
            branchName: branchName,
            prUrl: prUrl,
            pluginCode: pluginCode,
            testCode: testCode,
            completedAt: new Date()
          });
        } else {
          // Create new record if we don't have one
          await PluginDevelopment.create({
            ...queueRecord,
            apiDetails: {
              name: api.name,
              description: api.description,
              category: api.category,
              documentation: api.documentation,
              features: api.features,
              evaluation: api.evaluation
            },
            pluginCode: pluginCode,
            testCode: testCode,
            completedAt: new Date()
          });
        }
      } catch (dbError) {
        logger.error('Failed to save plugin development to database:', dbError);
      }
      
      logger.info(`Successfully created plugin for ${api.name}. PR: ${prUrl}`);
      
      // 15. Send Telegram notification
      await this.sendTelegramNotification({
        type: 'success',
        api: api,
        prUrl: prUrl,
        branchName: branchName
      });
      
      // Log final elapsed time
      const totalElapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`[${api.name}] Plugin development completed in ${totalElapsed}s`);
      
      // Return success result
      return { success: true, prUrl: prUrl, branchName: branchName };
      
    } catch (error) {
      logger.error(`Failed to develop plugin for ${api.name}:`, error);
      
      // Ensure we're back on main branch
      try {
        await this.git.checkout('main');
        logger.info('Returned to main branch after error');
      } catch (gitError) {
        logger.error('Failed to return to main branch:', gitError);
      }
      
      const failedRecord = {
        api: api.name,
        error: error.message,
        createdAt: new Date().toISOString(),
        status: 'failed'
      };
      
      this.developmentQueue.push(failedRecord);
      
      // Update database record to failed
      try {
        if (developmentRecord) {
          await PluginDevelopment.findByIdAndUpdate(developmentRecord._id, {
            status: 'failed',
            error: error.message
          });
        } else {
          // Create new record if we don't have one
          await PluginDevelopment.create({
            ...failedRecord,
            apiDetails: api ? {
              name: api.name,
              description: api.description,
              category: api.category,
              documentation: api.documentation
            } : undefined
          });
        }
      } catch (dbError) {
        logger.error('Failed to save failed plugin development to database:', dbError);
      }
      
      // Skip failure notification - not needed
      
      // Return failure result
      return { success: false, reason: 'error', error: error.message };
    }
  }

  /**
   * Research API documentation in detail
   */
  async researchAPIDocumentation(api) {
    const docsResult = await this.agent.processNaturalLanguage(
      `Research the ${api.name} API documentation at ${api.url} and provide detailed information about:
      1. Base URL and endpoints
      2. Authentication method and setup
      3. Rate limits
      4. Most useful endpoints for integration (list 3-5)
      5. Request/response formats
      6. Error handling patterns
      7. Any SDKs or libraries available
      
      IMPORTANT: Respond ONLY with valid JSON, no markdown, no explanations.
      Use this exact JSON structure:
      {
        "baseUrl": "string",
        "authMethod": "string",
        "authSetup": "string",
        "rateLimits": "string",
        "endpoints": ["string"],
        "requestFormat": "string",
        "responseFormat": "string",
        "errorCodes": "string",
        "sdks": "string"
      }`,
      'system'
    );
    
    // Extract the actual content from the response object
    let docsText = '';
    
    if (typeof docsResult === 'string') {
      docsText = docsResult;
    } else if (docsResult && typeof docsResult === 'object') {
      // Handle various response formats from different providers
      docsText = docsResult.content || docsResult.result || docsResult.text || docsResult.message || '';
      
      // If still not found, check for nested response
      if (!docsText && docsResult.response) {
        docsText = docsResult.response.content || docsResult.response.result || docsResult.response.text || '';
      }
      
      // Last resort - stringify the object
      if (!docsText) {
        logger.warn('Could not extract docs text from response object:', docsResult);
        docsText = JSON.stringify(docsResult);
      }
    }
    
    try {
      // Clean up any markdown formatting
      docsText = docsText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      // Try to extract JSON if it's embedded in other text
      const jsonMatch = docsText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        docsText = jsonMatch[0];
      }
      
      return JSON.parse(docsText);
    } catch (error) {
      logger.error('Failed to parse API documentation research:', error);
      logger.warn('Docs text was:', docsText.substring(0, 200) + '...');
      
      // If the response contains markdown or structured text, try to parse it manually
      if (docsText.includes('**') || docsText.includes('##') || docsText.includes('- ')) {
        logger.info('Attempting to parse markdown/structured response manually');
      }
      
      // Try to extract structured information from the text
      let structuredInfo = {
        baseUrl: api.url,
        authMethod: 'apiKey',
        endpoints: [],
        requestFormat: 'json',
        responseFormat: 'json'
      };
      
      // Try to find URLs in the text
      const urlMatches = docsText.match(/https?:\/\/[^\s"'<>]+/g);
      if (urlMatches && urlMatches.length > 0) {
        structuredInfo.baseUrl = urlMatches[0];
      }
      
      // Try to find auth method mentions
      if (docsText.toLowerCase().includes('bearer')) {
        structuredInfo.authMethod = 'bearer';
      } else if (docsText.toLowerCase().includes('oauth')) {
        structuredInfo.authMethod = 'oauth';
      }
      
      return structuredInfo;
    }
  }

  /**
   * Generate plugin code using AI with implementation research context
   */
  /**
   * Determine if plugin should have UI based on API characteristics
   */
  shouldHaveUI(apiDocs) {
    const uiKeywords = ['dashboard', 'devices', 'list', 'manage', 'control', 'monitor', 'view', 'display'];
    const apiText = JSON.stringify(apiDocs).toLowerCase();
    
    // Check for collection management
    if (apiDocs.endpoints?.some(ep => ep.method === 'GET' && (ep.path.includes('/list') || ep.path.includes('/all')))) {
      return true;
    }
    
    // Check for UI-related keywords
    return uiKeywords.some(keyword => apiText.includes(keyword));
  }
  
  /**
   * Determine if plugin needs custom routes
   */
  shouldHaveRoutes(apiDocs) {
    // If it manages stateful resources or needs webhooks
    return apiDocs.endpoints?.some(ep => 
      ep.path.includes(':id') || 
      ep.path.includes('webhook') ||
      ep.path.includes('callback')
    );
  }
  
  /**
   * Determine if plugin needs persistence
   */
  shouldHavePersistence(apiDocs) {
    const persistKeywords = ['save', 'store', 'cache', 'history', 'settings', 'config', 'preference'];
    const apiText = JSON.stringify(apiDocs).toLowerCase();
    
    return persistKeywords.some(keyword => apiText.includes(keyword));
  }

  async generatePluginCode(api, apiDocs, implementationResearch) {
    // Read the AI-optimized template
    const aiTemplate = await fs.readFile(
      path.join(this.developmentPath, 'src/api/plugins/_ai_template.js'),
      'utf8'
    );
    
    // Read the template guide
    const templateGuide = await fs.readFile(
      path.join(this.developmentPath, 'src/api/plugins/_ai_template_guide.json'),
      'utf8'
    );
    
    // Clean API name for class naming and other uses
    const cleanApiName = api.name
      .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
      .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters but keep spaces
      .trim();
    
    const className = cleanApiName.replace(/\s+/g, ''); // Remove spaces for class name
    const pluginName = cleanApiName.toLowerCase().replace(/\s+/g, ''); // Lowercase without spaces for plugin name
    const envVarName = cleanApiName.toUpperCase().replace(/\s+/g, '_'); // Uppercase with underscores for env var
    
    // Parse the template guide
    const guide = JSON.parse(templateGuide);
    
    // Prepare the AI prompt with clear structure and requirements
    const pluginGenerationPrompt = `Generate a complete LANAgent plugin for the ${cleanApiName} API.

PLUGIN STRUCTURE:
\`\`\`javascript
import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';

export default class ${className}Plugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = '${pluginName}';
    this.version = '1.0.0';
    this.description = '${api.description.replace(/'/g, "\\'")}';

    // Define required credentials for this plugin
    // These are configured via the web UI: Settings > Plugins > [Plugin] > Credentials tab
    // Credentials are stored encrypted in MongoDB, with env var fallback
    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: '${envVarName}_API_KEY', required: true }
      // Add more credentials if needed:
      // { key: 'apiSecret', label: 'API Secret', envVar: '${envVarName}_API_SECRET', required: true }
    ];

    // Commands array - CRITICAL for AI natural language support
    this.commands = [
      // Generate 3-5 commands based on the API capabilities
      // Each command MUST have this exact structure:
      {
        command: 'action_name',
        description: 'Clear description of what this does',
        usage: 'action_name({ param1: "value", param2: 123 })',
        examples: [
          'natural language example 1',
          'natural language example 2',
          'natural language example 3'
        ]
      }
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null, // Loaded in initialize() from DB or env var
      baseUrl: '${apiDocs.baseUrl || api.url}', // Use the REAL API URL
      // Add other config as needed
    };

    this.initialized = false;
    this.cache = new Map();
  }

  async initialize() {
    this.logger.info(\`Initializing \${this.name} plugin...\`);

    try {
      // Load credentials using BasePlugin helper
      // This checks MongoDB first (encrypted), then falls back to env var
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.apiKey = credentials.apiKey;
        this.logger.info('Loaded API credentials');
      } catch (credError) {
        // Not fatal - plugin can work with limited functionality
        this.logger.warn(\`Credentials not configured: \${credError.message}\`);
      }

      // Load other cached configuration
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { apiKey, ...otherConfig } = savedConfig; // Don't overwrite credentials
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      // Check if API key is configured
      if (!this.config.apiKey) {
        this.logger.warn('API key not configured - plugin will have limited functionality');
      }

      // Save non-credential config to cache
      const { apiKey, ...configToCache } = this.config;
      await PluginSettings.setCached(this.name, 'config', configToCache);

      this.initialized = true;
      this.logger.info(\`\${this.name} plugin initialized successfully\`);
    } catch (error) {
      this.logger.error(\`Failed to initialize \${this.name} plugin:\`, error);
      throw error;
    }
  }
  
  async execute(params) {
    const { action, ...data } = params;
    
    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });
    
    // Handle AI parameter extraction
    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }
    
    try {
      switch (action) {
        // Generate cases for each command
        default:
          throw new Error(\`Unknown action: \${action}\`);
      }
    } catch (error) {
      this.logger.error(\`\${action} failed:\`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  async extractParameters(input, action) {
    const prompt = \`Extract parameters from: "\${input}"
    For \${this.name} plugin action: \${action}

    Return JSON with appropriate parameters based on the action.\`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    // Use safeJsonParse to avoid throwing on malformed JSON
    const parsed = safeJsonParse(response.content, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      this.logger.warn('Failed to parse AI parameters from response');
    }
    return parsed;
  }
  
  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }
  
  // Add implementation methods for each action
  // Each method should use axios to call the real API
  
  async cleanup() {
    this.logger.info(\`Cleaning up \${this.name} plugin...\`);
    this.cache.clear();
    await PluginSettings.clearCache(this.name);
    this.initialized = false;
  }
  
  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}
\`\`\`

API DOCUMENTATION:
${JSON.stringify(apiDocs, null, 2)}

${implementationResearch ? `IMPLEMENTATION RESEARCH:
${implementationResearch}` : ''}

CRITICAL REQUIREMENTS:
1. You MUST generate a COMPLETE plugin file - this is the MAIN DELIVERABLE
2. If you cannot generate a working plugin, respond with "CANNOT_GENERATE" instead
3. Generate REAL, WORKING code - NO placeholders, NO "example.com", NO "TODO"
4. FORBIDDEN WORDS - DO NOT USE: "placeholder", "hypothetical", "dummy", "mock", "fake", "test", "sample"
5. Create 3-5 meaningful commands based on what the API can actually do
6. Each command needs 'examples' array with natural language variations
7. Use axios for all API calls with the ACTUAL endpoints from the docs
8. ALWAYS use PluginSettings for caching:
   - Load settings: await PluginSettings.getCached(this.name, 'key')
   - Save settings: await PluginSettings.setCached(this.name, 'key', value)
   - Custom TTL: await PluginSettings.getCached(this.name, 'key', 600) // 10 min
9. Return {success: true, data: result} or {success: false, error: message}
10. Validate all parameters using this.validateParams()
11. The baseUrl MUST be the real API URL from the documentation
12. Use REAL descriptions - not "This is a placeholder" or "hypothetical endpoint"
13. The plugin MUST include actual implementation methods that call the API
14. CREDENTIALS SYSTEM - DO NOT use process.env for API keys:
   - Define this.requiredCredentials array in constructor with key, label, envVar, required
   - In initialize(), use: const credentials = await this.loadCredentials(this.requiredCredentials)
   - Access via this.config.apiKey after loading
   - Users configure credentials via web UI (Settings > Plugins > Credentials tab)
   - Credentials are encrypted in MongoDB with env var fallback

PROJECT UTILITIES (plugins are in src/api/plugins/ so use ../../utils/ paths):

- In-memory caching: import NodeCache from 'node-cache'
  * const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
  * cache.get(key), cache.set(key, value), cache.del(key)
  * Use for temporary API response caching (PluginSettings is for persistent config)

- Retry logic: import { retryOperation } from '../../utils/retryUtils.js'
  * retryOperation(asyncFn, options) - retry API calls with exponential backoff
  * Usage: const result = await retryOperation(() => axios.get(url), { retries: 3, context: 'API call' });

- Safe JSON parsing: import { safeJsonParse, safeJsonStringify } from '../../utils/jsonUtils.js'
  * safeJsonParse(text, defaultValue) - parse JSON without throwing
  * safeJsonStringify(obj) - stringify without throwing

- Encryption (for sensitive data): import { encrypt, decrypt } from '../../utils/encryption.js'
  * encrypt(text) - encrypt API keys or tokens before storing
  * decrypt(encryptedData) - decrypt when needed

- Rate limiting (for plugin routes): import rateLimit from 'express-rate-limit'
  * Use for any routes that should be rate-limited

WARNINGS:
- DO NOT import logger directly - use this.logger (inherited from BasePlugin)
- DO NOT create new Winston instances
- DO NOT use these non-existent functions: retry(), retryWithCircuitBreaker()
- DO NOT import Agenda directly - scheduled tasks are managed by TaskScheduler service

EXAMPLE OF A GOOD COMMAND:
{
  command: 'search',
  description: 'Search for items by query',
  usage: 'search({ query: "example", limit: 10 })',
  examples: [
    'search for documentation',
    'find items about testing',
    'look up user guides',
    'search database for errors'
  ]
}

Generate the complete plugin implementation now.`;

    // OLD hardcoded template approach - keeping for reference but not using
    const oldPluginTemplate = "import { BasePlugin } from '../core/basePlugin.js';\n" +
"import axios from 'axios';\n" +
"// For persistent settings with caching, use PluginSettings:\n" +
"import { PluginSettings } from '../../models/PluginSettings.js';\n" +
"\n\n// IMPORTANT: For plugins that need to store data, use MongoDB instead of flat files\n" +
"// Example MongoDB model import (create in src/models/):\n" +
"// import MyModel from '../../models/MyModel.js';\n" +
"\n" +
"export default class " + className + "Plugin extends BasePlugin {\n" +
"  constructor(agent) {\n" +
"    super(agent);\n" +
"    this.name = '" + pluginName + "';\n" +
"    this.version = '1.0.0';\n" +
"    this.description = '" + api.description.replace(/'/g, "\\'") + "';\n" +
"    \n" +
"    // Required credentials - configured via web UI\n" +
"    this.requiredCredentials = [\n" +
"      { key: 'apiKey', label: 'API Key', envVar: '" + envVarName + "_API_KEY', required: true }\n" +
"    ];\n" +
"    \n" +
"    this.commands = [\n" +
"      // IMPORTANT: Commands enable natural language use of your plugin!\n" +
"      // Example format:\n" +
"      // {\n" +
"      //   command: 'search',\n" +
"      //   description: 'Search for items',\n" +
"      //   usage: 'search({ query: \"example\", limit: 10 })'\n" +
"      // },\n" +
"      // Commands will be generated based on API endpoints\n" +
"    ];\n" +
"    \n" +
"    // Configuration - apiKey loaded via loadCredentials()\n" +
"    this.config = {\n" +
"      apiKey: null,\n" +
"      baseUrl: '" + (apiDocs.baseUrl || api.url) + "',\n" +
"      // Add other config options here\n" +
"    };\n" +
"    \n" +
"    // Initialize any caches or state\n" +
"    this.cache = new Map();\n" +
"  }\n" +
"\n\n  async initialize() {\n" +
"    // Load credentials from DB or env var\n" +
"    try {\n" +
"      const credentials = await this.loadCredentials(this.requiredCredentials);\n" +
"      this.config.apiKey = credentials.apiKey;\n" +
"    } catch (e) {\n" +
"      this.logger.warn('Credentials not configured');\n" +
"    }\n" +
"    // Load cached settings\n" +
"    const savedConfig = await PluginSettings.getCached(this.name, 'config');\n" +
"    if (savedConfig) {\n" +
"      const { apiKey, ...other } = savedConfig;\n" +
"      Object.assign(this.config, other);\n" +
"    }\n" +
"    return true;\n" +
"  }\n" +
"\n" +
"  async execute(params) {\n" +
"    this.validateParams(params, {\n" +
"      action: {\n" +
"        required: true,\n" +
"        type: 'string',\n" +
"        enum: this.commands.map(c => c.command)\n" +
"      }\n" +
"    });\n" +
"\n" +
"    const { action } = params;\n" +
"    \n" +
"    try {\n" +
"      switch(action) {\n" +
"        // Cases will be generated based on endpoints\n" +
"        default:\n" +
"          return { \n" +
"            success: false, \n" +
"            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')\n" +
"          };\n" +
"      }\n" +
"    } catch (error) {\n" +
"      logger.error('" + cleanApiName + " plugin error:', error);\n" +
"      return { success: false, error: error.message };\n" +
"    }\n" +
"  }\n" +
"\n" +
"  // Add getIntents() for AI natural language support\n" +
"  getIntents() {\n" +
"    return [\n" +
"      // Intent handlers will be generated\n" +
"    ];\n" +
"  }\n" +
"\n" +
"  // Add getAICapabilities() for dynamic AI discovery\n" +
"  async getAICapabilities() {\n" +
"    return {\n" +
"      enabled: true,\n" +
"      capabilities: [\n" +
"        // List what this plugin can do\n" +
"      ],\n" +
"      examples: [\n" +
"        // Natural language examples\n" +
"      ]\n" +
"    };\n" +
"  }\n" +
"\n" +
"  // Add routes if the plugin needs API endpoints\n" +
"  getRoutes() {\n" +
"    return [\n" +
"      // Define any REST API routes here\n" +
"    ];\n" +
"  }\n" +
"  \n" +
"  // Implementation methods will be generated based on API\n" +
"}";
    
    let contextualPrompt = `You are generating a plugin for the LANAgent system.

CRITICAL REQUIREMENTS - READ CAREFULLY:

1. You MUST generate a REAL, WORKING plugin implementation - NOT placeholder code
2. Use the ACTUAL API endpoints and parameters from the documentation below
3. DO NOT use any of these placeholder indicators:
   - example.com, test.com, placeholder.com, your-api-here
   - "hypothetical", "example implementation", "dummy"
   - TODO, FIXME, "replace with", "insert your"
   - Generic descriptions like "description API"
4. The baseUrl MUST be the real API URL from the documentation, NOT example.com
5. Each command MUST have real implementation with actual axios calls
6. The plugin MUST have at least 3-5 meaningful commands based on the API's capabilities
7. Use the EXACT authentication method specified in the API docs (API key, OAuth, etc.)
8. USE PluginSettings for caching persistent data instead of flat files:
   - Import: import { PluginSettings } from '../../models/PluginSettings.js';
   - Save config: await PluginSettings.setCached(this.name, 'config', this.config);
   - Load config: await PluginSettings.getCached(this.name, 'config');
   - Custom TTL: await PluginSettings.getCached(this.name, 'apiTokens', 600); // 10 min cache

Now generate a complete, production-ready plugin for the ${cleanApiName} API using this template as a starting point:

${aiTemplate}

REAL API Documentation (use these exact endpoints and parameters):
${JSON.stringify(apiDocs, null, 2)}`;

    // Add implementation research context if available
    if (implementationResearch) {
      contextualPrompt += `

Implementation Research Context (use these real examples):
${implementationResearch}

IMPORTANT: Use the real endpoints, authentication, and parameters from the research above. This is NOT a hypothetical exercise - generate actual working code.`;
    }
    
    // Add rejection feedback if this is a retry
    if (api.previousRejectionFeedback) {
      contextualPrompt += `

IMPORTANT: This plugin was previously rejected with the following feedback:
`;
      
      if (api.previousRejectionFeedback.rejectionReasons.length > 0) {
        contextualPrompt += `\nRejection Reasons:\n`;
        api.previousRejectionFeedback.rejectionReasons.forEach(reason => {
          contextualPrompt += `- ${reason}\n`;
        });
      }
      
      if (api.previousRejectionFeedback.suggestions.length > 0) {
        contextualPrompt += `\nSuggestions for Improvement:\n`;
        api.previousRejectionFeedback.suggestions.forEach(suggestion => {
          contextualPrompt += `- ${suggestion}\n`;
        });
      }
      
      contextualPrompt += `\nPlease address these issues in the new implementation. Make sure to:\n`;
      contextualPrompt += `1. Fix all mentioned problems\n`;
      contextualPrompt += `2. Follow any specific suggestions\n`;
      contextualPrompt += `3. Avoid repeating the same mistakes\n`;
    }

    contextualPrompt += "\n\nRequirements:\n" +
    "1. Use the template WITHOUT backticks - use string concatenation for any embedded HTML/JS\n" +
    "2. Fill in the commands array with 3-5 most useful actions\n" +
    "3. Each command MUST have: command (string), description (string), usage (string with example)\n" +
    "4. Add corresponding case statements in execute() method\n" +
    "5. Implement proper parameter validation using this.validateParams()\n" +
    "6. Add getIntents() method with natural language examples and handlers\n" +
    "7. Add getAICapabilities() if the plugin would benefit from AI discovery\n" +
    "8. Add getRoutes() ONLY if the plugin needs REST endpoints (e.g., for UI callbacks)\n" +
    "9. Add getUIConfig() and getUIContent() ONLY if managing visual data or devices\n" +
    "10. For device/item plugins, add name resolution methods (see Govee example)\n" +
    "11. Use axios for HTTP requests, return consistent {success, data/error} format\n" +
    "12. For settings persistence, use PluginSettings model (not fs.writeFile)\n" +
    "13. Any HTML in getUIContent must use string concatenation, not template literals\n" +
    "\n\nIMPORTANT PATTERNS TO FOLLOW:\n" +
    "\n" +
    "1. String concatenation for UI content (NO nested backticks):\n" +
    "   return '<div class=\"container\">' +\n" +
    "     '<h1>' + title + '</h1>' +\n" +
    "     '<script>' +\n" +
    "     '(function() {' +\n" +
    "     '  // JavaScript here' +\n" +
    "     '})();' +\n" +
    "     '</script>' +\n" +
    "   '</div>';\n" +
    "\n" +
    "2. For settings that need to persist (like toggles):\n" +
    "   import { PluginSettings } from '../../models/PluginSettings.js';\n" +
    "   // Use PluginSettings.getCached() and setCached() for automatic caching\n" +
    "\n" +
    "3. For device/name resolution (if managing named items):\n" +
    "   async resolveDeviceName(name) {\n" +
    "     // Handle 'all', exact match, partial match\n" +
    "     // Return device ID or array of IDs\n" +
    "   }\n" +
    "\n" +
    "4. For API routes with URL parameters:\n" +
    "   handler: async (body, req) => {\n" +
    "     const id = decodeURIComponent(req.params.id);\n" +
    "     // Always decode URL parameters\n" +
    "   }\n" +
    "\n" +
    "5. CRITICAL - Add getIntents() for natural language:\n" +
    "   getIntents() {\n" +
    "     return [\n" +
    "       {\n" +
    "         intent: '" + pluginName + ".list',\n" +
    "         examples: [\n" +
    "           'show " + pluginName + " items',\n" +
    "           'list my " + pluginName + "',\n" +
    "           'what " + pluginName + " do I have'\n" +
    "         ],\n" +
    "         handler: async (params) => {\n" +
    "           return await this.execute({ action: 'list' });\n" +
    "         }\n" +
    "       },\n" +
    "       // Add more intents for each major action\n" +
    "     ];\n" +
    "   }\n" +
    "\n\n6. For AI capabilities discovery:\n" +
    "   async getAICapabilities() {\n" +
    "     // Return current state, available actions, examples\n" +
    "     // This helps AI understand what the plugin can do dynamically\n" +
    "   }\n" +
    "\n" +
    "UI INTEGRATION GUIDELINES:\n" +
    "IMPORTANT: Only add UI methods if the plugin manages visual data, devices, or complex configurations that benefit from a dedicated interface.\n" +
    "\n" +
    "DO NOT create UI for plugins that:\n" +
    "- Only fetch/search data (use regular command responses)\n" +
    "- Have simple settings (use the existing plugin settings modal)\n" +
    "- Perform background tasks or automation\n" +
    "- Are purely API wrappers without visual components\n" +
    "\n" +
    "DO create UI for plugins that:\n" +
    "- Manage collections of items (devices, projects, media)\n" +
    "- Display real-time data or dashboards\n" +
    "- Require complex forms or configuration\n" +
    "- Show visual content (images, charts, maps)\n" +
    "- Control physical devices with multiple settings";

    contextualPrompt += "\n\nIf UI is needed, add these methods:\n" +
    "  getUIConfig() {\n" +
    "    return {\n" +
    "      menuItem: {\n" +
    "        id: '" + pluginName + "',\n" +
    "        title: '" + cleanApiName + "',\n" +
    "        icon: 'fas fa-icon-name', // Choose appropriate icon\n" +
    "        order: 100, // Alphabetical position\n" +
    "        section: 'main'\n" +
    "      },\n" +
    "      hasUI: true\n" +
    "    };\n" +
    "  }\n" +
    "\n" +
    "  getUIContent() {\n" +
    "    // MUST use string concatenation, NO template literals\n" +
    "    return '<div class=\"" + pluginName + "-container\">' +\n" +
    "      '<h2>" + cleanApiName + "</h2>' +\n" +
    "      // Build UI with string concatenation\n" +
    "    '</div>';\n" +
    "  }\n" +
    "\n" +
    "Important patterns to follow:\n" +
    "- Parameter validation: this.validateParams(params, {fieldName: {required: true, type: 'string'}})\n" +
    "- API key check: if (!this.config.apiKey) return {success: false, error: 'API key not configured. Please configure it in Settings > Plugins > Credentials.'}\n" +
    "- Consistent response format\n" +
    "- Meaningful error messages\n" +
    "- Follow authentication patterns from the implementation research\n" +
    "- Use the EXACT class name from the template: " + className + "Plugin\n" +
    "- Use the EXACT plugin name from the template: " + pluginName + "\n" +
    "- DO NOT use generic class names like WebSearchPlugin\n" +
    "- Each plugin MUST have a unique class name based on the API name\n" +
    "\n\nGenerate the complete plugin code following these patterns. DO NOT use backticks in the template - use string concatenation for any embedded code.\n" +
    "\n" +
    "FINAL REMINDERS:\n" +
    "- This is a REAL plugin for a REAL API - no placeholders!\n" +
    "- Use the ACTUAL base URL from the API documentation\n" +
    "- Implement REAL endpoints with proper axios calls\n" +
    "- If you use example.com or any placeholder, the plugin will be REJECTED\n" +
    "- Generate production-ready code that can be deployed immediately";

    // Use the new template-based prompt
    const prompt = pluginGenerationPrompt;

    // Use direct AI provider call to bypass intent detection
    const response = await this.agent.providerManager.generateResponse(prompt, {
      maxTokens: 4000,
      temperature: 0.7,
      format: 'text'
    });
    
    // Extract the actual content from the response object
    let pluginCode = '';
    
    if (typeof response === 'string') {
      pluginCode = response;
    } else if (response && response.content) {
      pluginCode = response.content;
    } else {
      logger.error('Unexpected response format from AI provider:', response);
      throw new Error('Failed to generate plugin code - invalid response format');
    }
    
    // Check if AI indicated it cannot generate the plugin
    if (pluginCode.includes('CANNOT_GENERATE') || pluginCode.trim().length < 100) {
      logger.warn(`AI indicated it cannot generate a proper plugin for ${api.name}`);
      throw new Error('AI cannot generate a working plugin for this API - insufficient information or unsupported API type');
    }
    
    // Ensure we have a string
    if (typeof pluginCode !== 'string') {
      logger.error('Plugin code is not a string:', typeof pluginCode, pluginCode);
      pluginCode = String(pluginCode);
    }
    
    // Clean up the response (remove any markdown formatting)
    return pluginCode.replace(/```javascript\n?/g, '').replace(/```\n?/g, '').trim();
  }

  /**
   * Validate that generated plugin code is not placeholder content
   */
  validatePluginCode(pluginCode, api) {
    const reasons = [];
    
    // Check for placeholder URLs
    const placeholderUrls = [
      'example.com',
      'example.org',
      'test.com',
      'placeholder.com',
      'your-api-here',
      'api-endpoint-here',
      'dummy-api'
    ];
    
    const lowerCode = pluginCode.toLowerCase();
    for (const placeholder of placeholderUrls) {
      if (lowerCode.includes(placeholder)) {
        reasons.push(`Contains placeholder URL: ${placeholder}`);
      }
    }
    
    // Check for placeholder content indicators
    const placeholderPhrases = [
      'hypothetical',
      'example implementation',
      'placeholder',
      'dummy',
      'todo:',
      'fixme:',
      'replace with',
      'your api key here',
      'insert your',
      'based on the provided api documentation',
      'using the provided template',
      'here\'s a plugin implementation',
      'below is the complete plugin code',
      'certainly!'
    ];
    
    for (const phrase of placeholderPhrases) {
      if (lowerCode.includes(phrase)) {
        reasons.push(`Contains placeholder phrase: "${phrase}"`);
      }
    }
    
    // Check if it's just template with minimal implementation
    const commandCount = (pluginCode.match(/command:\s*'/g) || []).length;
    if (commandCount < 2) {
      reasons.push('Plugin has fewer than 2 commands implemented');
    }
    
    // Check if the plugin has real endpoint implementations
    const hasRealEndpoints = pluginCode.includes('async ') && 
                            (pluginCode.includes('axios.get') || 
                             pluginCode.includes('axios.post') || 
                             pluginCode.includes('axios.put') ||
                             pluginCode.includes('axios.delete'));
    
    if (!hasRealEndpoints) {
      reasons.push('Plugin lacks real API endpoint implementations');
    }
    
    // Check if baseUrl is properly set from apiDocs
    if (pluginCode.includes("baseUrl: ''") || pluginCode.includes('baseUrl: ""')) {
      reasons.push('Plugin has empty baseUrl');
    }
    
    // Check for generic descriptions
    if (pluginCode.includes(api.description) && api.description.toLowerCase().includes('description')) {
      reasons.push('Plugin uses generic placeholder description');
    }
    
    // Check if the code is too short (likely just template)
    if (pluginCode.length < 3000) {
      reasons.push('Plugin code is suspiciously short (likely just template)');
    }
    
    return {
      valid: reasons.length === 0,
      reasons: reasons
    };
  }

  /**
   * Generate test code for the plugin
   */
  async generateTestCode(api, apiDocs) {
    // Clean the API name for consistent usage
    const cleanApiName = api.name
      .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
      .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters but keep spaces
      .trim();
    
    const pluginFileName = cleanApiName.toLowerCase().replace(/\s+/g, '').replace(/api$/i, '');
    
    // Use a more direct prompt that avoids triggering feature consideration
    const prompt = `Write Jest test code for a plugin named "${cleanApiName}". The plugin is located at src/api/plugins/${pluginFileName}.js

IMPORTANT: The plugin extends BasePlugin and has this structure:
- plugin.name (string) - lowercase plugin name
- plugin.description (string)
- plugin.commands (array) - array of {command, description, usage, examples}
- plugin.execute({ action, ...params }) - async method to execute commands
- plugin.initialize() - async method called on startup
- plugin.cleanup() - async method called on shutdown

The plugin is a CLASS that needs to be instantiated with a mock agent:
const mockAgent = { providerManager: { generateResponse: jest.fn() } };
const plugin = new ${pluginFileName.charAt(0).toUpperCase() + pluginFileName.slice(1)}Plugin(mockAgent);

Requirements:
- Import the plugin class: import ${pluginFileName.charAt(0).toUpperCase() + pluginFileName.slice(1)}Plugin from '../../src/api/plugins/${pluginFileName}.js';
- Mock axios for API calls using jest.mock('axios')
- Create a mock agent object when instantiating the plugin
- Test plugin structure: name, description, commands array
- Test execute() method with valid and invalid actions
- Test error handling for API failures

Return ONLY the test code, no explanations or analysis.

CRITICAL: DO NOT include any conversational text like "Self-modification is ENABLED" or "Would you like me to..." in the code.
The response must contain ONLY valid JavaScript test code that can be executed.`;

    // Use direct AI provider call to bypass intent detection
    const response = await this.agent.providerManager.generateResponse(prompt, {
      maxTokens: 2000,
      temperature: 0.5,
      format: 'text'
    });
    
    // Extract the actual content from the response object
    let testCode = '';
    
    if (typeof response === 'string') {
      testCode = response;
    } else if (response && response.content) {
      testCode = response.content;
    } else {
      logger.error('Unexpected response format from AI provider for test generation:', response);
      // Generate a basic test template as fallback
      testCode = this.generateBasicTestTemplate(api);
    }
    
    // Ensure we have a string
    if (typeof testCode !== 'string') {
      logger.error('Test code is not a string:', typeof testCode);
      testCode = this.generateBasicTestTemplate(api);
    }
    
    // Clean up the response - remove markdown code blocks and any non-code content
    testCode = testCode.replace(/```javascript\n?/gi, '').replace(/```js\n?/gi, '').replace(/```\n?/g, '').trim();
    
    // If the response starts with explanation text, try to extract just the code
    const codeMatch = testCode.match(/(?:^|\n)((?:const|let|var|import|describe|test|it|jest)[\s\S]*)/);
    if (codeMatch) {
      testCode = codeMatch[1];
    }
    
    // Check if we got feature consideration or other non-code response
    if (testCode.includes('Feature Consideration') || 
        testCode.includes('Feasibility Analysis') ||
        testCode.includes('🤔') ||
        !testCode.includes('describe(') ||
        !testCode.includes('test(')) {
      logger.warn('AI returned non-code response, using template');
      testCode = this.generateBasicTestTemplate(api);
    }
    
    // Validate that it looks like a real test file
    const hasImport = testCode.includes('import ');
    const hasDescribe = testCode.includes('describe(');
    const hasTest = testCode.includes('test(') || testCode.includes('it(');
    
    if (!hasImport || !hasDescribe || !hasTest) {
      logger.warn('Generated test code missing essential elements, using template');
      testCode = this.generateBasicTestTemplate(api);
    }
    
    return testCode;
  }

  /**
   * Generate a basic test template as fallback
   */
  generateBasicTestTemplate(api) {
    // Clean the API name consistently
    const cleanApiName = api.name
      .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
      .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters but keep spaces
      .trim();

    const pluginName = cleanApiName.toLowerCase().replace(/\s+/g, '').replace(/api$/i, '');
    const className = cleanApiName.charAt(0).toUpperCase() + cleanApiName.slice(1).replace(/\s+/g, '').replace(/api$/i, '') + 'Plugin';
    const envVarName = cleanApiName.toUpperCase().replace(/\s+/g, '_');

    return `import ${className} from '../../src/api/plugins/${pluginName}.js';
import axios from 'axios';

// Mock axios
jest.mock('axios');

describe('${cleanApiName} Plugin', () => {
  let plugin;
  let mockAgent;

  beforeEach(() => {
    // Create mock agent with required providerManager
    mockAgent = {
      providerManager: {
        generateResponse: jest.fn().mockResolvedValue({ content: '{}' })
      }
    };

    // Instantiate plugin with mock agent
    plugin = new ${className}(mockAgent);

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('Plugin Structure', () => {
    test('should have required properties', () => {
      expect(plugin.name).toBe('${pluginName}');
      expect(plugin.description).toBeDefined();
      expect(Array.isArray(plugin.commands)).toBe(true);
    });

    test('should have at least one command', () => {
      expect(plugin.commands.length).toBeGreaterThan(0);
    });

    test('should have valid command structure', () => {
      plugin.commands.forEach(cmd => {
        expect(cmd).toHaveProperty('command');
        expect(cmd).toHaveProperty('description');
        expect(cmd).toHaveProperty('usage');
      });
    });
  });

  describe('Execute Method', () => {
    test('should reject unknown actions', async () => {
      const result = await plugin.execute({ action: 'unknownAction' });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should validate action parameter is required', async () => {
      await expect(plugin.execute({})).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    test('should handle API errors gracefully', async () => {
      // Mock axios to simulate network error
      axios.get.mockRejectedValue(new Error('Network error'));
      axios.post.mockRejectedValue(new Error('Network error'));
      axios.request.mockRejectedValue(new Error('Network error'));

      // Get first command to test
      const firstCommand = plugin.commands[0]?.command;
      if (firstCommand) {
        const result = await plugin.execute({ action: firstCommand });
        expect(result.success).toBe(false);
      }
    });
  });
});`;
  }

  /**
   * Run tests for a plugin
   */
  async runPluginTests(testFileName) {
    try {
      const testPath = `tests/plugins/${testFileName}`;
      logger.info(`Running Jest tests for ${testPath}`);
      
      // Import execSync for ESM
      const { execSync } = await import('child_process');
      const result = execSync(
        `cd ${this.developmentPath} && npm test -- ${testPath} --passWithNoTests`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      
      // Parse test results from output
      const passedMatches = result.match(/✓/g) || [];
      const failedMatches = result.match(/✕/g) || [];
      const testsMatch = result.match(/Tests:\s+(\d+)\s+passed/);
      const passedCount = testsMatch ? parseInt(testsMatch[1]) : passedMatches.length;
      
      logger.info('Tests passed successfully');
      return { 
        success: true, 
        output: result,
        summary: `All ${passedCount} tests passed`
      };
    } catch (error) {
      logger.error('Test execution failed:', error);
      
      // Parse the error output to get a summary
      const errorOutput = error.stdout || error.stderr || error.message || 'Unknown test failure';
      const failedTests = (errorOutput.match(/✕/g) || []).length;
      const passedTests = (errorOutput.match(/✓/g) || []).length;
      
      // Check for specific error patterns
      let summary = '';
      let details = '';
      
      if (errorOutput.includes('No tests found')) {
        summary = 'No valid tests found in file';
        details = 'The test file exists but contains no executable tests';
      } else if (errorOutput.includes('SyntaxError')) {
        summary = 'Syntax error in test file';
        details = errorOutput.match(/SyntaxError[^\n]*/)?.[0] || 'Invalid JavaScript syntax';
      } else if (errorOutput.includes('Cannot find module')) {
        summary = 'Import error in test file';
        details = errorOutput.match(/Cannot find module[^\n]*/)?.[0] || 'Module import failed';
      } else if (failedTests > 0 || passedTests > 0) {
        summary = `${failedTests} tests failed, ${passedTests} tests passed`;
        details = errorOutput.substring(0, 500);
      } else {
        summary = 'Test execution failed';
        details = 'Jest failed to run tests properly. Check test file syntax.';
      }
      
      return { 
        success: false, 
        error: error.message,
        output: errorOutput,
        summary: summary,
        details: details
      };
    }
  }

  /**
   * Check if a plugin has been recently attempted
   */
  async hasRecentAttempt(apiName) {
    try {
      const recentAttempts = await PluginDevelopment.find({
        api: apiName,
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
      }).sort({ createdAt: -1 });
      
      if (recentAttempts.length > 0) {
        const lastAttempt = recentAttempts[0];
        logger.info(`Found recent attempt for ${apiName}: ${lastAttempt.status} on ${lastAttempt.createdAt}`);
        
        // If it failed or is in progress, defer it
        if (lastAttempt.status === 'failed' || lastAttempt.status === 'in_progress') {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      logger.error('Error checking recent attempts:', error);
      return false;
    }
  }

  /**
   * Create versioned branch name if needed
   */
  async getVersionedBranchName(baseBranchName, apiName) {
    try {
      // Git is already initialized in constructor
      
      // Check for existing branches
      const branches = await this.git.branch(['-a']);
      const remoteBranches = branches.all.filter(b => b.startsWith('remotes/origin/'));
      
      // Check if base branch already exists
      if (remoteBranches.some(b => b.includes(baseBranchName))) {
        // Find highest version number
        let version = 2;
        const versionPattern = new RegExp(`${baseBranchName}-v(\\d+)`, 'g');
        
        for (const branch of remoteBranches) {
          const match = branch.match(versionPattern);
          if (match) {
            const branchVersion = parseInt(match[1]);
            if (branchVersion >= version) {
              version = branchVersion + 1;
            }
          }
        }
        
        const versionedBranch = `${baseBranchName}-v${version}`;
        logger.info(`Branch ${baseBranchName} exists, using versioned name: ${versionedBranch}`);
        return versionedBranch;
      }
      
      return baseBranchName;
    } catch (error) {
      logger.error('Error getting versioned branch name:', error);
      return baseBranchName;
    }
  }

  /**
   * Create a feature branch for the new plugin
   */
  async createFeatureBranch(branchName) {
    try {
      logger.info(`Creating feature branch: ${branchName} in ${this.developmentPath}`);
      
      // Check if we're in a git repository
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        throw new Error(`${this.developmentPath} is not a git repository`);
      }
      
      // Get current branch to check if we're in the right place
      const currentBranch = await this.git.branch();
      logger.info(`Current git status: branch=${currentBranch.current}, repo=${this.developmentPath}`);
      
      // Ensure we're on main branch
      await this.git.checkout('main');
      logger.info('Switched to main branch');
      
      // Pull latest changes
      await this.git.pull('origin', 'main');
      logger.info('Pulled latest changes from origin/main');
      
      // Check if branch already exists locally or remotely
      const branches = await this.git.branch(['-a']); // Include remote branches
      const remoteBranchName = `remotes/origin/${branchName}`;
      
      // Handle existing remote branch
      if (branches.all.includes(remoteBranchName)) {
        logger.info(`Remote branch ${branchName} already exists, will fetch and checkout`);
        
        // Fetch the latest state of the remote branch
        await this.git.fetch('origin', branchName);
        
        // Delete local branch if it exists
        if (branches.all.includes(branchName)) {
          logger.warn(`Local branch ${branchName} exists, deleting it`);
          await this.git.deleteLocalBranch(branchName, true);
        }
        
        // Checkout from remote
        await this.git.checkout(['-b', branchName, `origin/${branchName}`]);
      } else {
        // No remote branch exists, safe to create new
        
        // Delete local branch if it exists
        if (branches.all.includes(branchName)) {
          logger.warn(`Local branch ${branchName} exists, deleting it`);
          await this.git.deleteLocalBranch(branchName, true);
        }
        
        // Create and checkout new branch
        await this.git.checkoutLocalBranch(branchName);
      }
      
      logger.info(`Successfully created feature branch: ${branchName}`);
    } catch (error) {
      logger.error(`Git branch creation failed:`, error);
      throw new Error(`Failed to create feature branch: ${error.message}`);
    }
  }

  /**
   * Update AI intent detection to recognize new plugin
   * NOTE: This is now deprecated as the system uses dynamic intent detection
   */
  async updateAIIntentDetection(api, fileName) {
    try {
      // The system now uses dynamic intent detection based on enabled plugins
      // Plugins register their intents through their commands array
      // No need to update static intent files anymore
      logger.info(`Skipping static intent file update for ${api.name} - system uses dynamic intent detection`);
      logger.info(`Plugin ${api.name} will register its intents dynamically through its commands array`);
      return;
      
      // Old code below is kept for reference but not executed
      const intentDetectorPath = path.join(this.developmentPath, 'src/core/aiIntentDetector.js');
      
      // Check if file exists
      try {
        await fs.access(intentDetectorPath);
      } catch (accessError) {
        logger.warn(`AI Intent Detector not found at ${intentDetectorPath}, skipping intent update`);
        return;
      }
      
      const content = await fs.readFile(intentDetectorPath, 'utf8');
      
      const pluginName = api.name.toLowerCase().replace(/\s+/g, '');
      
      // Generate a unique intent ID (starting from 1000 for plugin-generated intents)
      const intentId = Math.floor(1000 + Math.random() * 8000);
      
      // Create example use cases
      let examples = [`'use ${pluginName}'`, `'${pluginName} help'`];
      if (api.useCases && Array.isArray(api.useCases)) {
        examples = api.useCases.slice(0, 3).map(uc => `'${uc.toLowerCase()}'`);
      }
      
      // Create intent definition for the new plugin
      const intentDefinition = `
      // ${api.name} plugin (auto-generated ${new Date().toISOString().split('T')[0]})
      ${intentId}: {
        name: '${pluginName}',
        description: '${api.description.replace(/'/g, "\\'").substring(0, 100)}',
        plugin: '${pluginName}',
        action: 'execute',
        examples: [${examples.join(', ')}]
      },`;
      
      // Find where to insert (before the closing brace of the intents object)
      let insertPoint = content.lastIndexOf('// General conversation (fallback)');
      
      if (insertPoint === -1) {
        // Try alternative insertion points
        insertPoint = content.lastIndexOf('9999:');
        if (insertPoint > -1) {
          // Find the end of that intent definition
          const nextComma = content.indexOf('},', insertPoint);
          if (nextComma > -1) {
            insertPoint = nextComma + 2;
          }
        }
      }
      
      if (insertPoint > -1) {
        // Insert the new intent
        const beforeInsert = content.slice(0, insertPoint);
        const afterInsert = content.slice(insertPoint);
        const updatedContent = beforeInsert + intentDefinition + '\n      \n      ' + afterInsert;
        
        // Validate the updated content is still valid JavaScript
        try {
          // Simple syntax check by looking for balanced braces
          const openBraces = (updatedContent.match(/{/g) || []).length;
          const closeBraces = (updatedContent.match(/}/g) || []).length;
          
          if (openBraces !== closeBraces) {
            throw new Error('Unbalanced braces in updated content');
          }
          
          await fs.writeFile(intentDetectorPath, updatedContent);
          logger.info(`Added intent ${intentId} for ${api.name} plugin to AI intent detection`);
        } catch (validationError) {
          logger.error(`Updated content validation failed:`, validationError);
          logger.warn(`Skipping AI intent detection update for ${api.name}`);
        }
      } else {
        logger.warn(`Could not find insertion point for ${api.name} intent in aiIntentDetector.js`);
      }
    } catch (error) {
      logger.error(`Failed to update intent detection for ${api.name}:`, error);
      // Non-critical error, continue with PR
    }
  }

  /**
   * Update documentation with new plugin
   */
  async updateDocumentation(api, fileName) {
    try {
      // Update README.md
      const readmePath = path.join(this.developmentPath, 'README.md');
      const readmeContent = await fs.readFile(readmePath, 'utf8');
      
      // Find the plugin count and increment it
      const pluginCountMatch = readmeContent.match(/(\d+) modular plugins/);
      if (pluginCountMatch) {
        const currentCount = parseInt(pluginCountMatch[1]);
        const newCount = currentCount + 1;
        const updatedReadme = readmeContent.replace(
          `${currentCount} modular plugins`,
          `${newCount} modular plugins`
        );
        
        // Add plugin to latest features if there's a Latest Features section
        const latestFeaturesIndex = updatedReadme.indexOf('### Latest Features');
        if (latestFeaturesIndex > -1) {
          const nextSectionIndex = updatedReadme.indexOf('###', latestFeaturesIndex + 20);
          const beforeSection = updatedReadme.slice(0, nextSectionIndex);
          const afterSection = updatedReadme.slice(nextSectionIndex);
          
          const newFeature = `- 🔌 **${api.name} Integration**: ${api.description}\n`;
          
          const finalReadme = beforeSection + newFeature + afterSection;
          await fs.writeFile(readmePath, finalReadme);
        } else {
          await fs.writeFile(readmePath, updatedReadme);
        }
      }
      
      // Update feature-progress.json
      const featureProgressPath = path.join(this.developmentPath, 'docs/feature-progress.json');
      try {
        const progressContent = await fs.readFile(featureProgressPath, 'utf8');
        const progress = JSON.parse(progressContent);
        
        // Ensure the plugins structure exists without destroying other data
        if (!progress.features) progress.features = {};
        if (!progress.features.plugins) progress.features.plugins = { count: 0, list: [] };
        
        // Update plugin count
        progress.features.plugins.count = (progress.features.plugins.count || 0) + 1;
        if (!progress.features.plugins.list.includes(fileName.replace('.js', ''))) {
          progress.features.plugins.list.push(fileName.replace('.js', ''));
        }
        
        // Update last updated date while preserving all other fields
        progress.lastUpdated = new Date().toISOString();
        
        await fs.writeFile(featureProgressPath, JSON.stringify(progress, null, 2));
      } catch (err) {
        logger.error('Could not update feature-progress.json - PRESERVING EXISTING FILE:', err.message);
        // DO NOT attempt to create a new file or structure
      }
      
      logger.info(`Updated documentation for ${api.name}`);
    } catch (error) {
      logger.error(`Failed to update documentation for ${api.name}:`, error);
      // Non-critical error, continue with PR
    }
  }

  /**
   * Update plugin registry to include new plugin
   */
  async updatePluginRegistry(pluginName, fileName) {
    // This would update any central registry or configuration
    // For now, plugins are auto-discovered, so this is a placeholder
    logger.info(`Plugin ${pluginName} will be auto-discovered from ${fileName}`);
  }

  /**
   * Commit plugin changes
   */
  async commitPluginChanges(api, branchName) {
    try {
      logger.info(`Committing plugin changes for ${api.name}...`);
      
      // Check git status first
      const status = await this.git.status();
      logger.info(`Git status before commit: ${status.files.length} files changed`);
      
      if (status.files.length === 0) {
        logger.warn('No files to commit');
        return;
      }
      
      // Add specific files that we know exist
      const pluginFileName = api.name.toLowerCase().replace(/\s+/g, '');
      const pluginFilePath = `src/api/plugins/${pluginFileName}.js`;
      const testFilePath = `tests/plugins/${pluginFileName}.test.js`;
      
      // CRITICAL: Ensure the main plugin file exists before proceeding
      try {
        await fs.access(path.join(this.developmentPath, pluginFilePath));
        logger.info(`Verified plugin file exists: ${pluginFilePath}`);
      } catch (error) {
        logger.error(`CRITICAL: Plugin file does not exist: ${pluginFilePath}`);
        throw new Error(`Cannot create PR - main plugin file is missing: ${pluginFilePath}`);
      }
      
      const filesToAdd = [
        pluginFilePath,
        testFilePath  // Fixed: correct test file name
      ];
      
      // Add each file individually with error handling
      let pluginFileAdded = false;
      for (const file of filesToAdd) {
        try {
          await this.git.add(file);
          logger.info(`Added ${file}`);
          if (file === pluginFilePath) {
            pluginFileAdded = true;
          }
        } catch (addError) {
          logger.warn(`Could not add ${file}: ${addError.message}`);
        }
      }
      
      // Ensure the plugin file was successfully added to git
      if (!pluginFileAdded) {
        throw new Error('Failed to add plugin file to git - cannot create PR without it');
      }
      
      // Try to add other optional files
      // NOTE: Removed aiIntentDetector.js - system uses dynamic intent detection
      
      try {
        await this.git.add('README.md');
        logger.info('Added README.md');
      } catch (e) { logger.warn('Could not add README.md:', e.message); }
      
      try {
        await this.git.add('docs/feature-progress.json');
        logger.info('Added feature-progress.json');
      } catch (e) { logger.warn('Could not add feature-progress.json:', e.message); }
      
      // Check what's staged
      const stagedStatus = await this.git.status();
      if (stagedStatus.staged.length === 0) {
        throw new Error('No files were successfully staged for commit');
      }
      
      logger.info(`Staged ${stagedStatus.staged.length} files for commit`);
      
      // Clean API name for commit message
      const cleanApiName = api.name
        .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
        .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters but keep spaces
        .trim();
      
      // Create commit message
      const commitMessage = `feat: Add ${cleanApiName} API plugin

- Integrate with ${cleanApiName} ${api.category || api.focusArea} service
- Add support for ${api.endpoints ? api.endpoints.length : 'multiple'} endpoints
- Include comprehensive error handling
- Add unit tests for plugin functionality
- Enable natural language support through dynamic intent detection
- Update documentation and feature tracking

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>`;

      await this.git.commit(commitMessage);
      logger.info('Successfully committed changes');
      
      // Push to remote with error handling
      try {
        // Check if this branch has upstream tracking
        const status = await this.git.status();
        
        if (!status.tracking) {
          // First push - set upstream
          logger.info('Setting upstream and pushing new branch');
          await this.git.push(['--set-upstream', 'origin', branchName]);
        } else {
          // Regular push
          logger.info('Pushing to existing upstream branch');
          await this.git.push('origin', branchName);
        }
        
        logger.info(`Successfully pushed branch ${branchName} to origin`);
      } catch (pushError) {
        logger.error(`Failed to push to origin: ${pushError.message}`);
        
        // Check if it's a non-fast-forward error
        if (pushError.message.includes('non-fast-forward') || pushError.message.includes('rejected')) {
          logger.warn('Push rejected due to non-fast-forward. Attempting to pull and merge...');
          
          try {
            // Pull with rebase to get remote changes
            await this.git.pull('origin', branchName, { '--rebase': 'true' });
            logger.info('Successfully pulled and rebased remote changes');
            
            // Try pushing again
            await this.git.push('origin', branchName);
            logger.info('Successfully pushed after rebase');
          } catch (rebaseError) {
            logger.error('Failed to pull and rebase:', rebaseError);
            
            // As a last resort, force push with lease for safety
            logger.warn('Attempting force push with lease...');
            try {
              await this.git.push(['--force-with-lease', 'origin', branchName]);
              logger.info('Successfully force pushed with lease');
            } catch (forceError) {
              throw new Error(`All push attempts failed: ${forceError.message}`);
            }
          }
        } else {
          // Other push errors
          throw new Error(`Commit successful but push failed: ${pushError.message}`);
        }
      }
      
      logger.info(`Successfully committed and pushed plugin changes for ${api.name}`);
    } catch (error) {
      logger.error(`Git commit failed:`, error);
      throw new Error(`Failed to commit changes: ${error.message}`);
    }
  }

  /**
   * Get PR comments to understand rejection reasons
   */
  async getPRComments(prNumber) {
    try {
      const { execSync } = await import('child_process');
      
      // Get PR comments
      const comments = execSync(
        `cd ${this.developmentPath} && gh pr view ${prNumber} --json comments --jq '.comments[] | {author: .author.login, body: .body, createdAt: .createdAt}'`,
        { encoding: 'utf8' }
      );
      
      // Parse comments
      const commentLines = comments.trim().split('\n');
      const parsedComments = [];
      
      for (let i = 0; i < commentLines.length; i += 3) {
        if (commentLines[i]) {
          try {
            parsedComments.push({
              author: JSON.parse(commentLines[i]).author || '',
              body: JSON.parse(commentLines[i + 1]).body || '',
              createdAt: JSON.parse(commentLines[i + 2]).createdAt || ''
            });
          } catch (e) {
            // Skip malformed comment
          }
        }
      }
      
      return parsedComments;
    } catch (error) {
      logger.error(`Failed to get PR comments:`, error);
      return [];
    }
  }
  
  /**
   * Extract rejection feedback from PR closure
   */
  async getRejectionFeedback(apiName) {
    try {
      const existingPRs = await this.checkForExistingPRs(apiName);
      const closedPRs = existingPRs.filter(pr => pr.state === 'CLOSED');
      
      if (closedPRs.length === 0) {
        return null;
      }
      
      // Get the most recent closed PR
      const latestClosedPR = closedPRs[0];
      logger.info(`Checking rejection feedback for PR #${latestClosedPR.number}`);
      
      // Get PR body and closing comment
      const { execSync } = await import('child_process');
      const prDetails = execSync(
        `cd ${this.developmentPath} && gh pr view ${latestClosedPR.number} --json body,closedAt,comments`,
        { encoding: 'utf8' }
      );
      
      const details = JSON.parse(prDetails);
      
      // Extract meaningful feedback from comments
      const feedback = {
        prNumber: latestClosedPR.number,
        closedAt: details.closedAt,
        rejectionReasons: [],
        suggestions: []
      };
      
      // Look for closing comments (usually contain rejection reasons)
      if (details.comments && details.comments.length > 0) {
        // Focus on comments near the closing time
        const closingTime = new Date(details.closedAt);
        const relevantComments = details.comments.filter(comment => {
          const commentTime = new Date(comment.createdAt);
          const timeDiff = Math.abs(closingTime - commentTime) / 1000 / 60; // minutes
          return timeDiff < 60; // Comments within 1 hour of closing
        });
        
        relevantComments.forEach(comment => {
          const body = comment.body.toLowerCase();
          
          // Extract rejection reasons
          if (body.includes('reject') || body.includes('closing') || body.includes('not') || body.includes('issue')) {
            feedback.rejectionReasons.push(comment.body);
          }
          
          // Extract suggestions
          if (body.includes('should') || body.includes('could') || body.includes('need') || body.includes('instead')) {
            feedback.suggestions.push(comment.body);
          }
        });
      }
      
      return feedback;
    } catch (error) {
      logger.error('Failed to get rejection feedback:', error);
      return null;
    }
  }
  
  /**
   * Check for existing PRs with similar names
   */
  async checkForExistingPRs(apiName) {
    try {
      const { execSync } = await import('child_process');
      
      // Clean API name for comparison
      const cleanApiName = apiName
        .replace(/^\d+\.\s*/, '')
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim()
        .toLowerCase();
      
      // Get all PRs (open and closed)
      const allPRs = execSync(
        `cd ${this.developmentPath} && gh pr list --limit 100 --state all --json title,state,number,url,closedAt`,
        { encoding: 'utf8' }
      );
      
      const prs = JSON.parse(allPRs);
      
      // Check for similar PRs
      const similarPRs = prs.filter(pr => {
        const prTitleLower = pr.title.toLowerCase();
        return prTitleLower.includes(cleanApiName) || 
               prTitleLower.includes(apiName.toLowerCase());
      });
      
      if (similarPRs.length > 0) {
        logger.info(`Found ${similarPRs.length} similar PRs for ${apiName}:`);
        similarPRs.forEach(pr => {
          logger.info(`  - #${pr.number}: ${pr.title} (${pr.state})`);
        });
        return similarPRs;
      }
      
      return [];
    } catch (error) {
      logger.warn('Failed to check for existing PRs:', error.message);
      return [];
    }
  }

  /**
   * Create pull request for the new plugin
   */
  async createPluginPullRequest(api, branchName, testResults) {
    try {
      const { execSync } = await import('child_process');
      
      // Final quality check before creating PR
      logger.info(`Performing final quality check before creating PR for ${api.name}`);
      
      // Read the generated plugin file for final validation
      const cleanFileName = api.name
        .toLowerCase()
        .replace(/^\d+\.\s*/, '')
        .replace(/[^a-z0-9]+/g, '')
        .replace(/api$/i, '');
      
      const pluginPath = path.join(this.developmentPath, 'src/api/plugins', `${cleanFileName}.js`);
      const pluginContent = await fs.readFile(pluginPath, 'utf8');
      
      // Validate one more time before creating PR
      const finalValidation = this.validatePluginCode(pluginContent, api);
      if (!finalValidation.valid) {
        logger.error(`Final validation failed for ${api.name}: ${finalValidation.reasons.join(', ')}`);
        throw new Error(`Plugin validation failed: ${finalValidation.reasons.join(', ')}`);
      }
      
      // Check for existing PRs first
      const existingPRs = await this.checkForExistingPRs(api.name);
      if (existingPRs.length > 0) {
        const openPRs = existingPRs.filter(pr => pr.state === 'OPEN');
        if (openPRs.length > 0) {
          logger.warn(`Skipping PR creation - found ${openPRs.length} open PRs for ${api.name}`);
          return openPRs[0].url;
        }
      }
      
      // Clean API name for PR title
      const cleanApiName = api.name
        .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
        .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters but keep spaces
        .trim();
      
      const prTitle = `feat: Add ${cleanApiName} API plugin`;
      
      // Build test status section
      let testSection = '';
      if (testResults) {
        if (testResults.success) {
          testSection = `## Test Results ✅
- **Status**: All tests passed
- **Summary**: ${testResults.summary}
- Tests were automatically executed and passed successfully`;
        } else {
          testSection = `## Test Results ⚠️
- **Status**: Tests failed (non-blocking)
- **Summary**: ${testResults.summary}
- **Details**: Tests were executed but failed. Please review and fix:
\`\`\`
${testResults.details || testResults.error}
\`\`\``;
        }
      } else if (this.config.requireTests === false) {
        testSection = `## Test Results
- Tests were not executed (disabled in configuration)`;
      }
      
      const prBody = `## Summary
This PR adds a new plugin for integrating with the ${cleanApiName} API.

## Features
- 🔌 Full ${cleanApiName} API integration
- 📚 Support for ${api.endpoints ? api.endpoints.length : 'core'} endpoints
- 🔐 ${api.authType || 'API key'} authentication
- ⚡ Comprehensive error handling
- ✅ Unit tests included

## API Category
${api.category}

## Use Cases
${api.useCases ? api.useCases.map(uc => `- ${uc}`).join('\n') : '- Various automation scenarios'}

${testSection}

## Testing Checklist
- [${testResults && testResults.success ? 'x' : ' '}] Unit tests pass
- [ ] Manual testing completed
- [ ] API key configured via Settings > Plugins > Credentials

## Documentation
Plugin includes inline documentation and usage examples.

---
🤖 *This PR was automatically generated by the Plugin Development Service*`;

      const result = execSync(
        `cd ${this.developmentPath} && gh pr create --title "${prTitle}" --body "${prBody}" --base main --head ${branchName}`,
        { encoding: 'utf8' }
      );
      
      // Extract PR URL from output
      const prUrlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
      return prUrlMatch ? prUrlMatch[0] : 'PR created successfully';
      
    } catch (error) {
      logger.error('Failed to create PR:', error);
      throw new Error(`Failed to create pull request: ${error.message}`);
    }
  }

  /**
   * Get service status
   */
  async getStatus() {
    // Refresh development queue from database to ensure it's up to date
    await this.loadDevelopmentHistory();
    
    // Get actual counts from database
    let dbStats = {
      totalDeveloped: 0,
      totalFailed: 0,
      todayCount: 0
    };

    try {
      if (this.db && PluginDevelopment) {
        // Get total count of completed plugins
        dbStats.totalDeveloped = await PluginDevelopment.countDocuments({ status: 'completed' });
        
        // Get total count of failed plugins
        dbStats.totalFailed = await PluginDevelopment.countDocuments({ status: 'failed' });
        
        // Get today's completed count
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        dbStats.todayCount = await PluginDevelopment.countDocuments({
          status: 'completed',
          createdAt: { $gte: today, $lt: tomorrow }
        });
      }
    } catch (error) {
      logger.warn('Failed to get database stats for plugin development:', error.message);
      // Fall back to memory stats
      dbStats = {
        totalDeveloped: this.developmentQueue.filter(d => d.status === 'completed').length,
        totalFailed: this.developmentQueue.filter(d => d.status === 'failed').length,
        todayCount: this.developmentQueue.filter(d => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const itemDate = new Date(d.createdAt);
          itemDate.setHours(0, 0, 0, 0);
          return itemDate.getTime() === today.getTime() && d.status === 'completed';
        }).length
      };
    }

    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      lastCheckTime: this.lastCheckTime,
      nextCheckTime: this.nextCheckTime,
      config: this.config,
      developmentQueue: this.developmentQueue.slice(-20).reverse(), // Last 20 items, newest first
      stats: {
        totalDeveloped: dbStats.totalDeveloped,
        totalFailed: dbStats.totalFailed,
        today: dbStats.todayCount
      }
    };
  }

  /**
   * Load configuration from database
   */
  async loadConfig() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      
      if (agent && agent.serviceConfigs && agent.serviceConfigs.pluginDevelopment) {
        const savedConfig = agent.serviceConfigs.pluginDevelopment;
        
        // Merge saved config with defaults, preserving structure
        this.config = {
          ...this.config,
          enabled: savedConfig.enabled !== undefined ? savedConfig.enabled : this.config.enabled,
          checkIntervalHours: savedConfig.checkIntervalHours !== undefined ? savedConfig.checkIntervalHours : this.config.checkIntervalHours,
          maxPluginsPerDay: savedConfig.maxPluginsPerDay !== undefined ? savedConfig.maxPluginsPerDay : this.config.maxPluginsPerDay,
          focusAreas: savedConfig.focusAreas && savedConfig.focusAreas.length > 0 ? savedConfig.focusAreas : this.config.focusAreas,
          excludeAPIs: savedConfig.excludeAPIs || this.config.excludeAPIs,
          requireTests: savedConfig.requireTests !== undefined ? savedConfig.requireTests : this.config.requireTests,
          createPR: savedConfig.createPR !== undefined ? savedConfig.createPR : this.config.createPR
        };
        
        // Load lastCheckTime if available
        if (savedConfig.lastCheckTime) {
          this.lastCheckTime = new Date(savedConfig.lastCheckTime);
        }
        
        logger.info('Plugin development configuration loaded from database');
      } else {
        logger.info('No saved plugin development configuration found, using defaults');
      }
    } catch (error) {
      logger.warn('Failed to load plugin development configuration from database:', error.message);
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
        
        agent.serviceConfigs.pluginDevelopment = {
          enabled: this.config.enabled,
          checkIntervalHours: this.config.checkIntervalHours,
          maxPluginsPerDay: this.config.maxPluginsPerDay,
          focusAreas: this.config.focusAreas,
          excludeAPIs: this.config.excludeAPIs,
          requireTests: this.config.requireTests,
          createPR: this.config.createPR,
          lastCheckTime: this.lastCheckTime
        };
        
        agent.markModified('serviceConfigs');
        await agent.save();
        
        logger.info('Plugin development configuration saved to database');
      }
    } catch (error) {
      logger.error('Failed to save plugin development configuration to database:', error);
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
        if (!agent.serviceConfigs.pluginDevelopment) {
          agent.serviceConfigs.pluginDevelopment = {};
        }
        
        agent.serviceConfigs.pluginDevelopment.lastCheckTime = this.lastCheckTime;
        agent.markModified('serviceConfigs');
        await agent.save();
        logger.info('Plugin development lastCheckTime saved to database');
      }
    } catch (error) {
      logger.error('Failed to save plugin development lastCheckTime to database:', error);
      // Don't throw - this shouldn't stop plugin development from running
    }
  }

  /**
   * Clean up stale in-progress plugins
   */
  async cleanupStaleInProgressPlugins() {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      
      // Find stale in-progress plugins
      const stalePlugins = await PluginDevelopment.find({
        status: 'in_progress',
        createdAt: { $lt: twoHoursAgo }
      });
      
      if (stalePlugins.length > 0) {
        logger.info(`Found ${stalePlugins.length} stale in-progress plugins, marking as failed...`);
        
        for (const plugin of stalePlugins) {
          plugin.status = 'failed';
          plugin.error = 'Development timed out - marked as stale';
          await plugin.save();
          logger.info(`Marked ${plugin.api} as failed due to timeout`);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup stale in-progress plugins:', error);
    }
  }

  // escapeMarkdown function removed - now using utility from utils/markdown.js

  /**
   * Send Telegram notification about plugin development
   */
  async sendTelegramNotification(data) {
    try {
      // Only handle success notifications
      if (data.type !== 'success') {
        return;
      }

      // Log the notification for visibility
      logger.info(`NOTIFICATION: Plugin Development Complete - ${data.api.name} (${data.prUrl})`);

      const message = `🔌 **Plugin Development Complete**\n\n` +
                `✅ Successfully created ${escapeMarkdown(data.api.name)} plugin\n` +
                `📂 Category: ${escapeMarkdown(data.api.category || data.api.focusArea)}\n` +
                `🌐 Branch: \`${data.branchName}\`\n` +
                `🔗 Pull Request: ${data.prUrl}\n\n` +
                `Description: ${escapeMarkdown(data.api.description)}\n\n` +
                `🤖 Ready for review and testing!`;

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
      logger.error('Failed to send Telegram notification:', error);
      // Non-critical error, don't throw
    }
  }

  /**
   * Update service configuration
   */
  async updateConfig(updates) {
    Object.assign(this.config, updates);
    logger.info('Plugin development service configuration updated');
    
    // Save to database
    await this.saveConfig();
    
    // Restart cycle if interval changed
    if (updates.checkIntervalHours && this.enabled) {
      if (this.checkTimer) {
        clearTimeout(this.checkTimer);
      }
      this.scheduleNextCheck();
    }
  }

  /**
   * Load deduplication data from MongoDB
   */
  async loadDeduplicationData() {
    try {
      if (!this.dedupeCollection) {
        logger.warn('MongoDB not initialized for plugin development, using defaults');
        return {
          completed_apis: [],
          attempted_apis: [],
          excluded_apis: this.config.excludeAPIs || []
        };
      }

      // Get all dedupe records
      const completedAPIs = await this.dedupeCollection.find({ type: 'completed' }).toArray();
      const attemptedAPIs = await this.dedupeCollection.find({ type: 'attempted' }).toArray();
      
      return {
        completed_apis: completedAPIs.map(doc => ({
          name: doc.name,
          category: doc.category,
          url: doc.url,
          prUrl: doc.prUrl,
          branchName: doc.branchName,
          completedAt: doc.completedAt
        })),
        attempted_apis: attemptedAPIs.map(doc => ({
          name: doc.name,
          category: doc.category,
          url: doc.url,
          reason: doc.reason,
          attemptedAt: doc.attemptedAt
        })),
        excluded_apis: this.config.excludeAPIs || []
      };
    } catch (error) {
      logger.error('Failed to load deduplication data from MongoDB:', error);
      return {
        completed_apis: [],
        attempted_apis: [],
        excluded_apis: this.config.excludeAPIs || []
      };
    }
  }

  /**
   * Save deduplication data to MongoDB (no longer needed - we update directly)
   */
  async saveDeduplicationData(data) {
    // This method is no longer needed as we update MongoDB directly
    // Keeping it for compatibility but it does nothing
    logger.debug('saveDeduplicationData called but using direct MongoDB updates');
  }

  /**
   * Record an attempted API that failed
   */
  async recordAttemptedAPI(attemptData) {
    try {
      if (!this.dedupeCollection) {
        logger.warn('MongoDB not initialized, skipping attempted API record');
        return;
      }

      // Remove old attempts for this API
      await this.dedupeCollection.deleteMany({
        type: 'attempted',
        name: attemptData.name
      });

      // Insert new attempt
      await this.dedupeCollection.insertOne({
        type: 'attempted',
        ...attemptData,
        attemptedAt: new Date().toISOString(),
        createdAt: new Date()
      });

      // Clean up old attempts (older than 30 days)
      const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));
      await this.dedupeCollection.deleteMany({
        type: 'attempted',
        createdAt: { $lt: thirtyDaysAgo }
      });

      logger.info(`Recorded attempted API in MongoDB: ${attemptData.name}`);
    } catch (error) {
      logger.error('Failed to record attempted API:', error);
    }
  }

  /**
   * Record a successfully completed API
   */
  async recordCompletedAPI(apiData) {
    try {
      if (!this.dedupeCollection) {
        logger.warn('MongoDB not initialized, skipping completed API record');
        return;
      }

      // Remove from attempted if it was there
      await this.dedupeCollection.deleteMany({
        type: 'attempted',
        name: apiData.name
      });

      // Check if already exists
      const existing = await this.dedupeCollection.findOne({
        type: 'completed',
        name: apiData.name
      });

      if (existing) {
        logger.info(`API ${apiData.name} already marked as completed`);
        return;
      }

      // Insert completed API
      await this.dedupeCollection.insertOne({
        type: 'completed',
        ...apiData,
        completedAt: new Date().toISOString(),
        createdAt: new Date()
      });

      logger.info(`Recorded completed API in MongoDB: ${apiData.name}`);
      
      // Clean up references if this plugin came from a feature request or discovered feature
      if (apiData.featureRequestId) {
        try {
          logger.info(`Cleaning up GitHub references for completed plugin ${apiData.name}`);
          
          const featureRequest = await FeatureRequest.findById(apiData.featureRequestId);
          if (featureRequest) {
            // Update status to completed
            featureRequest.status = 'completed';
            featureRequest.completedAt = new Date();
            
            // Clear GitHub references to save disk space
            if (featureRequest.githubReferences && featureRequest.githubReferences.length > 0) {
              logger.info(`Removing ${featureRequest.githubReferences.length} GitHub references from feature request`);
              featureRequest.githubReferences = [];
            }
            
            if (featureRequest.implementationExamples && featureRequest.implementationExamples.length > 0) {
              logger.info(`Removing ${featureRequest.implementationExamples.length} implementation examples from feature request`);
              featureRequest.implementationExamples = [];
            }
            
            await featureRequest.save();
            logger.info(`Successfully cleaned up GitHub references for plugin ${apiData.name}`);
          }
        } catch (error) {
          logger.error(`Failed to cleanup GitHub references for plugin ${apiData.name}:`, error);
          // Don't throw - this is just cleanup, not critical
        }
      } else if (apiData.discoveredFeatureId) {
        try {
          logger.info(`Cleaning up discovered feature for completed plugin ${apiData.name}`);
          
          const discoveredFeature = await DiscoveredFeature.findById(apiData.discoveredFeatureId);
          if (discoveredFeature) {
            // Mark as implemented
            await discoveredFeature.markAsImplemented(apiData.branchName, 'plugin-development');
            logger.info(`Successfully marked discovered feature as implemented for plugin ${apiData.name}`);
          }
        } catch (error) {
          logger.error(`Failed to cleanup discovered feature for plugin ${apiData.name}:`, error);
          // Don't throw - this is just cleanup, not critical
        }
      }
    } catch (error) {
      logger.error('Failed to record completed API:', error);
    }
  }

  /**
   * Perform targeted implementation research for the selected API
   */
  async performImplementationResearch(api) {
    try {
      logger.info(`Researching implementation details for ${api.name}`);
      
      let researchContext = '';
      
      // 1. Check if this API was from a feature request with GitHub references
      if (api.featureRequestId) {
        try {
          const featureRequest = await FeatureRequest.findById(api.featureRequestId);
          if (featureRequest && featureRequest.githubReferences && featureRequest.githubReferences.length > 0) {
            logger.info(`Found ${featureRequest.githubReferences.length} GitHub references for ${api.name}`);
            
            researchContext += '=== GitHub Implementation References ===\n\n';
            
            for (const ref of featureRequest.githubReferences) {
              researchContext += `Repository: ${ref.repository}\n`;
              researchContext += `File: ${ref.filePath}\n`;
              researchContext += `URL: ${ref.url}\n`;
              if (ref.contextNotes) {
                researchContext += `Context: ${ref.contextNotes}\n`;
              }
              if (ref.codeSnippet) {
                researchContext += `\nCode Snippet:\n\`\`\`${ref.language || 'javascript'}\n${ref.codeSnippet}\n\`\`\`\n`;
              }
              researchContext += '\n---\n\n';
            }
            
            // Also add implementation examples if available
            if (featureRequest.implementationExamples && featureRequest.implementationExamples.length > 0) {
              researchContext += '=== Implementation Examples ===\n\n';
              
              for (const example of featureRequest.implementationExamples) {
                researchContext += `Source: ${example.source}\n`;
                researchContext += `Description: ${example.description}\n`;
                if (example.code) {
                  researchContext += `\nCode:\n\`\`\`${example.language || 'javascript'}\n${example.code}\n\`\`\`\n`;
                }
                researchContext += '\n---\n\n';
              }
            }
          }
        } catch (error) {
          logger.warn(`Could not fetch feature request references: ${error.message}`);
        }
      } else if (api.discoveredFeatureId) {
        // Check if this API was from a discovered feature with code snippets
        try {
          const discoveredFeature = await DiscoveredFeature.findById(api.discoveredFeatureId);
          if (discoveredFeature && discoveredFeature.codeSnippets && discoveredFeature.codeSnippets.length > 0) {
            logger.info(`Found ${discoveredFeature.codeSnippets.length} code snippets for ${api.name}`);
            
            researchContext += '=== GitHub Code Snippets ===\n\n';
            researchContext += `Repository: ${discoveredFeature.source.repository}\n\n`;
            
            for (const snippet of discoveredFeature.codeSnippets) {
              if (snippet.filePath) {
                researchContext += `File: ${snippet.filePath}\n`;
              }
              if (snippet.contextNotes) {
                researchContext += `Context: ${snippet.contextNotes}\n`;
              }
              if (snippet.code) {
                researchContext += `\nCode:\n\`\`\`${snippet.language || 'javascript'}\n${snippet.code}\n\`\`\`\n`;
              }
              researchContext += '\n---\n\n';
            }
            
            // Add implementation suggestion if available
            if (discoveredFeature.implementation?.suggestion) {
              researchContext += '=== Implementation Suggestion ===\n\n';
              researchContext += discoveredFeature.implementation.suggestion + '\n\n';
            }
          }
        } catch (error) {
          logger.warn(`Could not fetch discovered feature snippets: ${error.message}`);
        }
      }
      
      // 2. Perform web searches for additional implementation details
      const implementationQueries = [
        `${api.name} REST API Node.js tutorial integration`,
        `${api.name} JavaScript SDK documentation examples`,
        `how to integrate ${api.name} API with Node.js Express`,
        `${api.name} API authentication Node.js example code`
      ];
      
      const researchResults = [];
      
      // Perform searches for implementation details
      for (const query of implementationQueries) {
        try {
          logger.info(`Implementation research query: "${query}"`);
          const searchResults = await this.performWebSearch(query, api.category);
          
          if (searchResults && searchResults.length > 0) {
            researchResults.push({
              query: query,
              results: searchResults.slice(0, 3) // Top 3 results per query
            });
          }
        } catch (error) {
          logger.warn(`Implementation research query failed: ${query}`, error.message);
        }
      }
      
      // Add web search results to context
      if (researchResults.length > 0) {
        if (researchContext) researchContext += '\n\n';
        researchContext += '=== Web Search Implementation Research ===\n\n';
        
        researchContext += researchResults.map(result => {
          const formattedResults = result.results.map(r => 
            `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`
          ).join('\n\n');
          
          return `Query: ${result.query}\n\n${formattedResults}`;
        }).join('\n\n---\n\n');
      }
      
      if (!researchContext) {
        logger.warn(`No implementation research results found for ${api.name}`);
        return null;
      }
      
      logger.info(`Implementation research completed for ${api.name}`);
      return researchContext;
      
    } catch (error) {
      logger.error(`Failed to perform implementation research for ${api.name}:`, error);
      return null;
    }
  }

  /**
   * Scan documentation files and update them appropriately
   */
  async scanAndUpdateDocumentation(api, pluginFileName) {
    try {
      logger.info(`Scanning and updating documentation for ${api.name}`);
      
      // Update the three key documentation files
      await Promise.all([
        this.updateREADME(api, pluginFileName),
        this.updateAPIREADME(api, pluginFileName),
        this.updateFeatureProgress(api, pluginFileName)
      ]);
      
      logger.info(`Documentation updated successfully for ${api.name}`);
    } catch (error) {
      logger.error(`Failed to update documentation for ${api.name}:`, error);
    }
  }

  /**
   * Update main README.md file
   */
  async updateREADME(api, fileName) {
    try {
      const readmePath = path.join(this.developmentPath, 'README.md');
      const content = await fs.readFile(readmePath, 'utf8');
      
      // Find and increment plugin count
      let updatedContent = content;
      const pluginCountMatch = content.match(/(\d+) modular plugins/);
      if (pluginCountMatch) {
        const currentCount = parseInt(pluginCountMatch[1]);
        const newCount = currentCount + 1;
        updatedContent = updatedContent.replace(
          `${currentCount} modular plugins`,
          `${newCount} modular plugins`
        );
      }
      
      // Add to latest features if section exists
      const latestFeaturesMatch = updatedContent.match(/(### Latest Features[\s\S]*?)(?=###|$)/);
      if (latestFeaturesMatch) {
        const featuresSection = latestFeaturesMatch[1];
        const newFeature = `- 🔌 **${api.name} Integration**: ${api.description}\n`;
        
        // Insert after the "### Latest Features" line
        const insertIndex = updatedContent.indexOf('### Latest Features') + '### Latest Features'.length;
        const beforeInsert = updatedContent.slice(0, insertIndex);
        const afterInsert = updatedContent.slice(insertIndex);
        
        // Find first bullet point and insert before it
        const firstBulletIndex = afterInsert.search(/\n- /);
        if (firstBulletIndex > -1) {
          const beforeBullet = afterInsert.slice(0, firstBulletIndex + 1);
          const afterBullet = afterInsert.slice(firstBulletIndex + 1);
          updatedContent = beforeInsert + beforeBullet + newFeature + afterBullet;
        }
      }
      
      await fs.writeFile(readmePath, updatedContent);
      logger.info('README.md updated successfully');
    } catch (error) {
      logger.warn('Failed to update README.md:', error.message);
    }
  }

  /**
   * Update API documentation file
   */
  async updateAPIREADME(api, fileName) {
    try {
      const apiReadmePath = path.join(this.developmentPath, 'docs/api/API_README.md');
      
      // Check if file exists
      try {
        await fs.access(apiReadmePath);
      } catch {
        logger.warn('API_README.md not found, skipping update');
        return;
      }
      
      const content = await fs.readFile(apiReadmePath, 'utf8');
      
      // Find plugins section and add new plugin
      const pluginSectionMatch = content.match(/(## Available Plugins[\s\S]*?)(?=##|$)/);
      if (pluginSectionMatch) {
        const pluginName = fileName.replace('.js', '');
        const newPluginEntry = `\n### ${api.name}\n- **File**: \`${fileName}\`\n- **Description**: ${api.description}\n- **Category**: ${api.category}\n- **URL**: ${api.url}\n`;
        
        const insertIndex = content.indexOf('## Available Plugins') + pluginSectionMatch[1].length;
        const beforeInsert = content.slice(0, insertIndex);
        const afterInsert = content.slice(insertIndex);
        
        const updatedContent = beforeInsert + newPluginEntry + afterInsert;
        await fs.writeFile(apiReadmePath, updatedContent);
        logger.info('API_README.md updated successfully');
      }
    } catch (error) {
      logger.warn('Failed to update API_README.md:', error.message);
    }
  }

  /**
   * Update feature progress tracking file
   */
  async updateFeatureProgress(api, fileName) {
    try {
      const featureProgressPath = path.join(this.developmentPath, 'docs/feature-progress.json');
      
      let progressData = {};
      try {
        const content = await fs.readFile(featureProgressPath, 'utf8');
        progressData = JSON.parse(content);
      } catch (error) {
        logger.error('Failed to read feature-progress.json:', error.message || error);
        // DO NOT create a new structure - this would destroy existing data
        // Just log the error and return
        return;
      }
      
      // Update plugin information
      if (!progressData.features) progressData.features = {};
      if (!progressData.features.plugins) progressData.features.plugins = { count: 0, list: [] };
      
      progressData.features.plugins.count = (progressData.features.plugins.count || 0) + 1;
      progressData.features.plugins.list.push({
        name: api.name,
        file: fileName,
        category: api.category,
        addedAt: new Date().toISOString()
      });
      
      progressData.lastUpdated = new Date().toISOString();
      
      await fs.writeFile(featureProgressPath, JSON.stringify(progressData, null, 2));
      logger.info('feature-progress.json updated successfully');
    } catch (error) {
      logger.warn('Failed to update feature-progress.json:', error.message);
    }
  }
  
  /**
   * Get stored GitHub plugin ideas from database
   */
  async getStoredGitHubPluginIdeas() {
    const pluginIdeas = [];
    
    try {
      // Query for GitHub-discovered plugin features from new DiscoveredFeature collection
      const pluginFeatures = await DiscoveredFeature.find({
        $or: [
          { type: 'readme_feature' }, // Current migrated features
          { type: { $in: ['plugin_idea', 'integration', 'api_feature'] } }, // Future features
          { title: { $regex: /plugin|integration|api|sdk/i } }, // Title-based matching
          { description: { $regex: /plugin|integration|api|sdk/i } } // Description-based matching
        ],
        status: { $in: ['discovered', 'analyzing'] }
      }).sort({ priority: -1, createdAt: -1 }).limit(20);
      
      logger.info(`Found ${pluginFeatures.length} plugin ideas from stored GitHub discoveries`);
      
      // Convert to plugin candidate format
      for (const feature of pluginFeatures) {
        // Extract plugin name from title
        let pluginName = feature.title;
        
        // Clean up common patterns
        pluginName = pluginName.replace(/plugin.*$/i, '')
          .replace(/integration.*$/i, '')
          .replace(/api.*$/i, '')
          .replace(/\(.*\)/, '')
          .trim();
        
        // Skip if we already have this plugin
        if (this.config.excludeAPIs.some(api => pluginName.toLowerCase().includes(api))) {
          continue;
        }
        
        // Check if plugin was recently attempted
        if (await this.hasRecentAttempt(pluginName)) {
          continue;
        }
        
        pluginIdeas.push({
          name: pluginName,
          description: feature.description,
          category: this.guessCategory(pluginName),
          documentation: feature.source?.url || '',
          features: [feature.title],
          source: 'github_discovery',
          confidence: feature.implementation?.confidence || 'medium',
          discoveredFeatureId: feature._id,
          hasCodeSnippets: feature.codeSnippets && feature.codeSnippets.length > 0,
          repository: feature.source?.repository
        });
        
        // Update feature status to indicate it's being considered
        feature.status = 'analyzing';
        await feature.save();
      }
      
    } catch (error) {
      logger.error('Failed to get stored GitHub plugin ideas:', error);
    }
    
    return pluginIdeas;
  }
  
  /**
   * Extract plugin ideas from a GitHub repository
   */
  async extractPluginsFromRepo(repo, existingKeywords) {
    const plugins = [];
    
    try {
      // Look for plugins directory
      const pluginDirs = ['plugins', 'extensions', 'modules', 'integrations'];
      
      for (const dir of pluginDirs) {
        try {
          const contents = await this.makeGitHubRequest(`/repos/${repo.full_name}/contents/${dir}`);
          
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.type === 'file' && (item.name.endsWith('.js') || item.name.endsWith('.ts'))) {
                const pluginName = item.name.replace(/\.(js|ts)$/, '').replace(/[-_]/g, ' ');
                
                if (!this.isExistingPlugin(pluginName, existingKeywords)) {
                  plugins.push({
                    name: this.formatPluginName(pluginName),
                    description: `Plugin idea from ${repo.name}: ${pluginName}`,
                    category: this.guessCategory(pluginName),
                    documentation: item.html_url,
                    features: [`Based on ${repo.name} implementation`],
                    source: 'github',
                    sourceRepo: repo.full_name,
                    confidence: 'medium'
                  });
                }
              }
            }
          }
        } catch (e) {
          // Directory doesn't exist, continue
        }
      }
    } catch (error) {
      logger.debug(`Failed to extract plugins from ${repo.full_name}`);
    }
    
    return plugins;
  }
  
  /**
   * Check if plugin already exists
   */
  isExistingPlugin(name, existingKeywords) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return existingKeywords.has(normalized) || 
           existingKeywords.has(name.toLowerCase());
  }
  
  /**
   * Format plugin name
   */
  formatPluginName(name) {
    return name
      .split(/[-_\s]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  
  /**
   * Guess category from plugin name
   */
  guessCategory(name) {
    const nameLower = name.toLowerCase();
    
    if (nameLower.includes('chat') || nameLower.includes('message')) return 'communication';
    if (nameLower.includes('task') || nameLower.includes('todo')) return 'productivity';
    if (nameLower.includes('weather') || nameLower.includes('forecast')) return 'data';
    if (nameLower.includes('music') || nameLower.includes('spotify')) return 'entertainment';
    if (nameLower.includes('home') || nameLower.includes('iot')) return 'iot';
    if (nameLower.includes('finance') || nameLower.includes('crypto')) return 'finance';
    if (nameLower.includes('ai') || nameLower.includes('ml')) return 'ai';
    
    return 'productivity'; // Default
  }
  
  /**
   * Make GitHub API request
   */
  async makeGitHubRequest(endpoint, params = {}) {
    try {
      const axios = await import('axios');
      const url = new URL(`https://api.github.com${endpoint}`);
      
      Object.keys(params).forEach(key => 
        url.searchParams.append(key, params[key])
      );
      
      const response = await axios.default.get(url.toString(), {
        headers: {
          'Authorization': `token ${this.config.gitToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'LANAgent/1.0'
        },
        timeout: 10000
      });
      
      return response.data;
      
    } catch (error) {
      if (error.response?.status === 403) {
        logger.warn('GitHub API rate limit reached');
      }
      throw error;
    }
  }
}