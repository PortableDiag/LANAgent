import { EventEmitter } from "events";
import { connectDatabase } from "../utils/database.js";
import { logger } from "../utils/logger.js";
import { safeJsonStringify } from "../utils/jsonUtils.js";
import { ProviderManager } from "./providerManager.js";
import { CommandParser } from "./commandParser.js";
import { MemoryManager } from "./memoryManager.js";
import { SystemExecutor } from "../services/executor/index.js";
import { TelegramDashboard } from "../interfaces/telegram/telegramDashboard.js";
import { WebInterface } from "../interfaces/web/webInterface.js";
import { SSHInterface } from "../interfaces/ssh/sshInterface.js";
import { Agent as AgentModel } from "../models/Agent.js";
import { APIManager } from "../api/core/apiManager.js";
import { IntentDetector } from "./intentDetector.js";
import { AIIntentDetector } from "./aiIntentDetector.js";
import { vectorIntentDetector } from "./vectorIntentDetector.js";
import { PluginChainProcessor } from "./pluginChainProcessor.js";
// EmailAutoReply functionality moved to background tasks
import { SelfModificationService } from '../services/selfModification.js';
import { TaskReminderService } from '../services/taskReminders.js';
import { OperationLogger } from '../services/operationLogger.js';
import { intentIndexer } from '../utils/intentIndexer.js';
import EnhancedSelfDiagnosticsService from '../services/selfDiagnosticsEnhanced.js';
import SelfHealingService from '../services/selfHealingService.js';
import { errorLogScanner } from '../services/errorLogScanner.js';
import { metricsUpdater } from '../services/metricsUpdater.js';
import { TTSService } from '../services/tts.js';
import { VoiceInteractionService } from '../services/voiceInteraction.js';
import { WakeWordTrainingService } from '../services/wakeWordTraining.js';
import { vectorStore } from '../services/vectorStore.js';
import { embeddingService } from '../services/embeddingService.js';
import { ProcessManager } from '../services/processManager.js';
import TaskScheduler from '../services/scheduler.js';
import mqttService from '../services/mqtt/mqttService.js';
import eventEngine from '../services/mqtt/eventEngine.js';
import { ReActAgent, PlanExecuteAgent, ThoughtStore } from '../services/reasoning/index.js';
import { setGlobalAgent } from './agentAccessor.js';
import { getServerHost } from '../utils/paths.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
let packageVersion = '1.0.0';
try {
  const packageJsonPath = path.join(__dirname, '../../package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageVersion = packageJson.version;
} catch (error) {
  logger.warn('Could not read package.json version:', error.message);
}

export class Agent extends EventEmitter {
  constructor() {
    super();
    this.config = this.loadConfig();
    this.services = new Map();
    this.interfaces = new Map();
    this.isRunning = false;
    this.startupTime = null;
    this.startTime = Date.now();
    this.version = packageVersion;
    
    // Core components
    this.providerManager = new ProviderManager();
    this.commandParser = new CommandParser();
    this.memoryManager = new MemoryManager(this);
    this.systemExecutor = new SystemExecutor(this);
    this.apiManager = new APIManager(this);
    this.intentDetector = new IntentDetector();
    this.operationLogger = new OperationLogger();
    this.pluginChainProcessor = new PluginChainProcessor(this);
    this.ttsService = new TTSService(this);
    this.voiceInteraction = new VoiceInteractionService(this);
    this.wakeWordTraining = new WakeWordTrainingService(this);

    // AI-based intent detector (initialized after providers are ready)
    this.aiIntentDetector = null;
    this.vectorIntentDetector = null;

    // Reasoning agents (initialized after services are ready)
    this.reactAgent = null;
    this.planExecuteAgent = null;
    this.thoughtStore = null;

    // Agent model in database
    this.agentModel = null;

    // Store system prompt
    this.systemPrompt = null;
  }
  
  loadConfig() {
    return {
      name: process.env.AGENT_NAME || "LANAgent",
      port: process.env.AGENT_PORT || 80,
      sshPort: process.env.AGENT_SSH_PORT || 2222,
    };
  }
  
  async initialize() {
    logger.info(`Initializing ${this.config.name}...`);
    
    // Connect to database
    await connectDatabase();

    // Register global agent accessor (used by services without direct agent reference)
    setGlobalAgent(this);

    // Start periodic Skynet context cache refresh (bounties, proposals in system prompt)
    this._skynetContextCache = '';
    this._refreshSkynetContext();
    setInterval(() => this._refreshSkynetContext(), 5 * 60 * 1000); // Every 5 min

    // Load or create agent model
    await this.loadAgentModel();
    
    // Initialize core components
    await this.providerManager.initialize();
    await this.memoryManager.initialize();
    await this.apiManager.initialize();
    await this.ttsService.initialize();
    await this.voiceInteraction.initialize();

    // Store reference to agent doc for persistence (used by webInterface)
    this.agentDoc = this.agentModel;

    // Check if voice interaction should auto-start based on persisted state
    await this.checkVoiceInteractionAutoStart();

    // Initialize process manager
    this.processManager = new ProcessManager(this);
    await this.processManager.initialize();
    
    // Setup API Manager event listeners for logging
    this.apiManager.on('plugin:executed', (data) => {
      this.operationLogger.logOperation({
        type: 'plugin',
        action: `${data.name}.${data.method}`,
        plugin: data.name,
        method: data.method,
        status: 'success',
        timestamp: new Date()
      });
    });
    
    this.apiManager.on('plugin:error', (data) => {
      this.operationLogger.logOperation({
        type: 'plugin',
        action: `${data.name}.${data.method}`,
        plugin: data.name,
        method: data.method,
        status: 'error',
        error: data.error.message,
        timestamp: new Date()
      });
    });
    
    // Load saved plugin states from database
    await this.loadPluginStates();
    
    // Initialize AI-based intent detector after providers are ready
    this.aiIntentDetector = new AIIntentDetector(this);
    logger.info('AI intent detector initialized');
    
    // Initialize vector intent detector if enabled
    if (process.env.ENABLE_VECTOR_INTENT === 'true') {
      this.vectorIntentDetector = vectorIntentDetector;
      this.vectorIntentDetector.agent = this;
      await this.vectorIntentDetector.initialize();
      logger.info('Vector intent detector status:', this.vectorIntentDetector.getStats());
      
      // Setup automatic intent indexing for plugin events
      this.apiManager.on('plugin:loaded', async (pluginName) => {
        try {
          logger.info(`Auto-indexing intents for newly loaded plugin: ${pluginName}`);
          await intentIndexer.updatePluginIntents(this, pluginName);
        } catch (error) {
          logger.error(`Failed to auto-index intents for plugin ${pluginName}:`, error);
        }
      });
      
      this.apiManager.on('plugin:enabled', async (pluginName) => {
        try {
          logger.info(`Auto-indexing intents for enabled plugin: ${pluginName}`);
          await intentIndexer.updatePluginIntents(this, pluginName);
        } catch (error) {
          logger.error(`Failed to auto-index intents for plugin ${pluginName}:`, error);
        }
      });
      
      this.apiManager.on('plugin:disabled', async (pluginName) => {
        try {
          logger.info(`Removing intents for disabled plugin: ${pluginName}`);
          await intentIndexer.removePluginIntents(pluginName);
        } catch (error) {
          logger.error(`Failed to remove intents for plugin ${pluginName}:`, error);
        }
      });
      
      this.apiManager.on('plugin:unloaded', async (pluginName) => {
        try {
          logger.info(`Removing intents for unloaded plugin: ${pluginName}`);
          await intentIndexer.removePluginIntents(pluginName);
        } catch (error) {
          logger.error(`Failed to remove intents for plugin ${pluginName}:`, error);
        }
      });
      
    }
    
    // Email checking is now handled by background task manager
    
    // Initialize self-modification service
    this.selfModification = new SelfModificationService(this);
    await this.selfModification.initialize();
    this.services.set('selfModification', this.selfModification);
    logger.info(`Self-modification service initialized (${this.selfModification.enabled ? 'ENABLED' : 'DISABLED'}, analysisOnly: ${this.selfModification.analysisOnly})`);
    
    // Initialize plugin development service (ENABLED by default)
    const { PluginDevelopmentService } = await import('../services/pluginDevelopment.js');
    this.pluginDevelopment = new PluginDevelopmentService(this);
    this.services.set('pluginDevelopment', this.pluginDevelopment);
    // Logger message already in the service constructor
    
    // Initialize bug fixing service (ENABLED by default)
    const { BugFixingService } = await import('../services/bugFixing.js');
    this.bugFixing = new BugFixingService(this);
    this.services.set('bugFixingService', this.bugFixing);
    // Logger message already in the service constructor

    // Initialize task reminder service
    this.taskReminders = new TaskReminderService(this);
    await this.taskReminders.initialize();
    this.services.set('taskReminders', this.taskReminders);
    logger.info('Task reminder service initialized');

    // Initialize task scheduler (Agenda) - handles all background tasks
    // NOTE: Must be initialized BEFORE SubAgentOrchestrator so agents can schedule jobs
    try {
      const { default: TaskScheduler } = await import('../services/scheduler.js');
      this.scheduler = new TaskScheduler();
      await this.scheduler.initialize(this);
      this.services.set('taskScheduler', this.scheduler);
      logger.info('Task scheduler (Agenda) initialized');

      // Plugin scheduler-job registration hook. Plugins load before the
      // scheduler exists (apiManager.initialize runs at the top of this
      // bootstrap, scheduler is constructed here), so any agenda.define /
      // agenda.every calls in plugin.initialize() silently bail on the
      // `if (!this.agent.scheduler)` guard. Give each plugin a second pass
      // now that agenda is up. Plugins implement defineSchedulerJobs() to
      // opt in.
      if (this.apiManager?.apis) {
        for (const [name, entry] of this.apiManager.apis.entries()) {
          const plugin = entry?.instance || entry;
          if (typeof plugin?.defineSchedulerJobs === 'function') {
            try {
              await plugin.defineSchedulerJobs();
            } catch (hookErr) {
              logger.warn(`[scheduler] defineSchedulerJobs failed for plugin '${name}': ${hookErr.message}`);
            }
          }
        }
      }
    } catch (error) {
      logger.warn('Task scheduler not available:', error.message);
    }

    // Initialize SubAgent Orchestrator (manages domain/project/task agents)
    // NOTE: Must be initialized AFTER scheduler so agents can schedule their jobs
    try {
      const { SubAgentOrchestrator, CryptoStrategyAgent, ServerMaintenanceAgent } = await import('../services/subagents/index.js');
      this.subAgentOrchestrator = new SubAgentOrchestrator(this);

      // Register domain agent handlers
      this.subAgentOrchestrator.registerDomainHandler('crypto', CryptoStrategyAgent);
      this.subAgentOrchestrator.registerDomainHandler('maintenance', ServerMaintenanceAgent);

      await this.subAgentOrchestrator.initialize();
      this.services.set('subAgentOrchestrator', this.subAgentOrchestrator);
      logger.info('SubAgent Orchestrator initialized');
    } catch (error) {
      logger.warn('SubAgent Orchestrator not available:', error.message);
      logger.debug('SubAgent error details:', error.stack);
    }

    // Connect crypto API to SubAgent (consolidated from legacy cryptoStrategyService)
    try {
      const { setCryptoAgent } = await import('../api/crypto.js');
      setCryptoAgent(this);
      logger.info('Crypto API connected to SubAgent');
    } catch (error) {
      logger.warn('Failed to connect crypto API:', error.message);
    }

    // Initialize reasoning agents
    await this.initializeReasoningAgents();

    // Initialize interfaces
    await this.initializeInterfaces();
    
    // Initialize services
    await this.initializeServices();
    
    logger.info("Agent initialized successfully");
  }
  
  async loadAgentModel() {
    try {
      // Per-instance record. AGENT_NAME identifies this instance (ALICE, BETA,
      // etc); falling back to the framework default keeps single-instance
      // installs working. Earlier code hardcoded "LANAgent" here while the
      // rest of the codebase wrote to AGENT_NAME — that produced two records
      // per instance and split-brain reads of aiProviders/mediaGeneration/
      // erc8004/serviceConfigs.
      const agentName = process.env.AGENT_NAME || "LANAgent";
      this.agentModel = await AgentModel.findOne({ name: agentName });

      if (!this.agentModel) {
        this.agentModel = new AgentModel({
          name: agentName,
          personality: "I am a helpful, proactive, technical, and friendly AI assistant ready to manage your home server!",
          security: {
            authorizedUsers: [{
              userId: process.env.TELEGRAM_USER_ID || "default_user",
              name: "Admin",
              role: "admin",
              permissions: ["all"]
            }]
          },
          state: {
            status: "initializing",
            health: "healthy",
            version: {
              current: "1.0.0"
            }
          },
          aiProviders: {
            current: process.env.DEFAULT_AI_PROVIDER || "openai"
          }
        });
        
        await this.agentModel.save();
        logger.info("Created new agent model in database");
      }
      
      // Auto-setup avatar if not already configured
      if (!this.agentModel.avatarPath) {
        const projectRoot = path.join(__dirname, '../..');
        // Check if avatar already exists in data/agent/
        const existingAvatars = ['data/agent/avatar.png', 'data/agent/avatar.jpg'];
        let found = false;
        for (const relPath of existingAvatars) {
          if (existsSync(path.join(projectRoot, relPath))) {
            this.agentModel.avatarPath = relPath;
            this.agentModel.avatar = '/api/agent/avatar';
            await this.agentModel.save();
            logger.info(`Auto-configured avatar from existing ${relPath}`);
            found = true;
            break;
          }
        }
        // Otherwise copy from project root
        if (!found) {
          const candidates = ['alice.png', 'alice.jpg'];
          for (const filename of candidates) {
            const srcPath = path.join(projectRoot, filename);
            if (existsSync(srcPath)) {
              const ext = path.extname(filename);
              const destDir = path.join(projectRoot, 'data', 'agent');
              const destPath = path.join(destDir, `avatar${ext}`);
              try {
                mkdirSync(destDir, { recursive: true });
                copyFileSync(srcPath, destPath);
                this.agentModel.avatarPath = `data/agent/avatar${ext}`;
                this.agentModel.avatar = '/api/agent/avatar';
                await this.agentModel.save();
                logger.info(`Auto-configured avatar from ${filename}`);
              } catch (copyErr) {
                logger.warn('Failed to auto-copy avatar:', copyErr.message);
              }
              break;
            }
          }
        }
      }

      // Update heartbeat to indicate startup
      await this.agentModel.updateHeartbeat();

    } catch (error) {
      logger.error("Failed to load agent model:", error);
      throw error;
    }
  }

  /**
   * Check if voice interaction should auto-start based on persisted state
   * Priority: 1. Database persisted state, 2. VOICE_AUTOSTART env var
   */
  async checkVoiceInteractionAutoStart() {
    try {
      // Check database persisted state first (overrides env var)
      const voiceSettings = this.agentModel?.voice || {};
      const persistedEnabled = voiceSettings.voiceInteractionEnabled;

      if (persistedEnabled === true) {
        logger.info('[VoiceInteraction] Auto-starting based on persisted database setting');
        await this.voiceInteraction.start();
        return;
      }

      // If explicitly disabled in DB, don't start even if env var says to
      if (persistedEnabled === false) {
        logger.info('[VoiceInteraction] Disabled in persisted settings, not auto-starting');
        return;
      }

      // No persisted state (undefined), fall back to VOICE_AUTOSTART env var
      const envAutostart = process.env.VOICE_AUTOSTART === 'true' || process.env.VOICE_AUTOSTART === '1';
      if (envAutostart) {
        logger.info('[VoiceInteraction] Auto-starting based on VOICE_AUTOSTART env var');
        await this.voiceInteraction.start();
      } else {
        logger.debug('[VoiceInteraction] No auto-start configured');
      }
    } catch (error) {
      logger.warn('[VoiceInteraction] Failed to check auto-start state:', error.message);
    }
  }

  async initializeInterfaces() {
    // Initialize Web interface first — starts instantly, no reason to wait behind Telegram
    const web = new WebInterface(this);
    await web.initialize();
    this.interfaces.set("web", web);

    // Initialize SSH interface
    const ssh = new SSHInterface(this);
    await ssh.initialize();
    this.interfaces.set("ssh", ssh);

    // Initialize Telegram last — has a 120s timeout that would block other interfaces
    if (process.env.TELEGRAM_ENABLED !== 'false' && process.env.TELEGRAM_BOT_TOKEN) {
      const telegram = new TelegramDashboard(this);
      await telegram.initialize();
      this.interfaces.set("telegram", telegram);
    } else {
      logger.info('Telegram interface disabled (no token or TELEGRAM_ENABLED=false)');
    }
  }
  
  async initializeReasoningAgents() {
    try {
      logger.info('Initializing reasoning agents...');

      // Get reasoning config from agent model
      const reasoningConfig = this.agentModel?.serviceConfigs?.reasoning || {
        enabled: true,
        mode: 'auto',
        maxIterations: 10,
        enableReplanning: true,
        showThoughts: false,
        thoughtPersistence: true
      };

      if (!reasoningConfig.enabled) {
        logger.info('Reasoning agents disabled in configuration');
        return;
      }

      // Initialize thought store for persisting reasoning traces
      if (reasoningConfig.thoughtPersistence) {
        this.thoughtStore = new ThoughtStore({
          memoryManager: this.memoryManager,
          embeddingProvider: {
            generateEmbedding: async (text) => this.providerManager.generateEmbedding(text)
          }
        });
        await this.thoughtStore.initialize();
        this.services.set('thoughtStore', this.thoughtStore);
        logger.info('✓ Thought store initialized');
      }

      // Initialize ReAct agent
      this.reactAgent = new ReActAgent(this, {
        maxIterations: reasoningConfig.maxIterations,
        showThoughts: reasoningConfig.showThoughts,
        thoughtStore: this.thoughtStore
      });
      await this.reactAgent.initialize();
      this.services.set('reactAgent', this.reactAgent);
      logger.info('✓ ReAct agent initialized');

      // Initialize Plan-Execute agent
      this.planExecuteAgent = new PlanExecuteAgent(this, {
        enableReplanning: reasoningConfig.enableReplanning,
        showProgress: reasoningConfig.showThoughts,
        thoughtStore: this.thoughtStore
      });
      await this.planExecuteAgent.initialize();
      this.services.set('planExecuteAgent', this.planExecuteAgent);
      logger.info('✓ Plan-Execute agent initialized');

      // Store reasoning mode preference
      this.reasoningMode = reasoningConfig.mode; // 'react', 'plan-execute', or 'auto'

      logger.info(`Reasoning agents initialized (mode: ${this.reasoningMode})`);
    } catch (error) {
      logger.error('Failed to initialize reasoning agents:', error);
      // Non-critical - agent can still function without reasoning
    }
  }

  async initializeServices() {
    try {
      logger.info('Initializing background services...');
      
      // Initialize task reminder service
      if (this.apiManager && this.apiManager.hasPlugin('tasks')) {
        logger.info('✓ Task management service available');
      }
      
      // Self-modification service is already initialized as this.selfModification above
      // Remove duplicate instantiation to prevent config loading issues
      logger.info('✓ Self-modification service already initialized');
      
      // Initialize task reminder service
      this.taskReminderService = new TaskReminderService(this);
      if (typeof this.taskReminderService.initialize === 'function') {
        await this.taskReminderService.initialize();
        logger.info('✓ Task reminder service initialized');
      } else {
        logger.info('✓ Task reminder service created');
      }
      
      // Initialize enhanced self-diagnostics service
      this.selfDiagnosticsService = new EnhancedSelfDiagnosticsService(this);
      await this.selfDiagnosticsService.initialize();
      this.services.set('selfDiagnostics', this.selfDiagnosticsService);
      logger.info('✓ Enhanced self-diagnostics service initialized');

      // Initialize self-healing service (auto-remediation)
      this.selfHealingService = new SelfHealingService(this);
      await this.selfHealingService.initialize();
      this.services.set('selfHealing', this.selfHealingService);
      logger.info('✓ Self-healing service initialized');

      // Initialize error log scanner service
      this.errorLogScanner = errorLogScanner;
      this.errorLogScanner.setAgent(this);
      await this.errorLogScanner.initialize();
      this.services.set('errorLogScanner', this.errorLogScanner);
      logger.info('✓ Error log scanner service initialized');
      
      // Initialize vector store and embedding services
      if (process.env.ENABLE_VECTOR_INTENT === 'true') {
        try {
          await embeddingService.initialize();
          await vectorStore.initialize();
          this.services.set('vectorStore', vectorStore);
          this.services.set('embeddingService', embeddingService);
          logger.info('✓ Vector store and embedding services initialized');
          
          // Perform initial intent indexing now that vector store is ready
          if (this.vectorIntentDetector && this.vectorIntentDetector.initialized) {
            try {
              logger.info('Performing initial intent indexing for all plugins...');
              await intentIndexer.indexAllIntents(this);
              logger.info('Initial intent indexing completed');
            } catch (error) {
              logger.error('Failed to perform initial intent indexing:', error);
            }
          }
        } catch (error) {
          logger.error('Failed to initialize vector services:', error);
          // Non-critical, continue without vector search
        }
      }
      
      // Initialize metrics updater service
      try {
        this.metricsUpdater = metricsUpdater;
        await this.metricsUpdater.initialize();
        this.services.set('metricsUpdater', this.metricsUpdater);
        logger.info('✓ Metrics updater service initialized');
      } catch (error) {
        logger.error('Failed to initialize metrics updater:', error);
        // Non-critical, continue without metrics updater
      }

      // Initialize MQTT service and Event Engine
      if (process.env.ENABLE_MQTT !== 'false') {
        try {
          await mqttService.initialize();
          this.services.set('mqttService', mqttService);
          logger.info('✓ MQTT service initialized');

          // Initialize Event Engine with Agenda scheduler reference
          const agenda = this.taskScheduler?.getAgenda?.() || null;
          await eventEngine.initialize(agenda);
          this.services.set('eventEngine', eventEngine);
          logger.info('✓ Event Engine initialized');
        } catch (error) {
          logger.error('Failed to initialize MQTT services:', error);
          // Non-critical, continue without MQTT
        }
      }

      // Initialize UPS monitoring service
      if (process.env.ENABLE_UPS !== 'false') {
        try {
          const { upsService } = await import('../services/ups/upsService.js');
          const initialized = await upsService.initialize(this);
          if (initialized) {
            this.services.set('upsService', upsService);
            await upsService.start();
            logger.info('✓ UPS monitoring service initialized');
          } else {
            logger.info('UPS monitoring service not available (NUT not installed)');
          }
        } catch (error) {
          logger.warn('UPS monitoring service not available:', error.message);
          // Non-critical, continue without UPS monitoring
        }
      }

      // Initialize P2P Federation service (opt-in via SystemSettings or env var)
      {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const p2pEnabled = await SystemSettings.getSetting('p2p_enabled', process.env.P2P_ENABLED !== 'false');
        if (p2pEnabled) {
          try {
            const { P2PService } = await import('../services/p2p/p2pService.js');
            this.p2pService = new P2PService(this);
            await this.p2pService.initialize();
            this.services.set('p2pFederation', this.p2pService);
            logger.info('✓ P2P Federation service initialized');
          } catch (error) {
            logger.error('Failed to initialize P2P Federation:', error);
            // Non-critical, continue without P2P
          }
        }
      }

      logger.info('All background services initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize services:', error);
      // Don't throw - allow agent to continue running with core functionality
    }
  }
  
  async start() {
    if (this.isRunning) {
      logger.warn("Agent is already running");
      return;
    }
    
    this.isRunning = true;
    this.startupTime = Date.now();
    logger.info(`${this.config.name} is starting... (startupTime: ${this.startupTime})`);
    
    // Update agent model startup time
    if (this.agentModel) {
      this.agentModel.stats.lastStartup = this.startupTime;
      await this.agentModel.save();
      logger.info(`Agent model updated with startup time: ${this.startupTime}`);
    }
    
    // Start all services
    for (const [name, service] of this.services) {
      if (service && typeof service.start === 'function') {
        logger.info(`Starting service: ${name}`);
        await service.start();
      } else {
        logger.info(`Service ${name} does not have a start method, skipping`);
      }
    }
    
    // Start all interfaces
    for (const [name, interface_] of this.interfaces) {
      logger.info(`Starting interface: ${name}`);
      try {
        // Add timeout for interface startup
        const startTimeout = name === 'telegram' ? 120000 : 30000; // 2 minutes for Telegram, 30s for others
        await Promise.race([
          interface_.start(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`${name} interface startup timeout`)), startTimeout)
          )
        ]);
      } catch (error) {
        logger.error(`Failed to start ${name} interface:`, error.message);
        
        // For non-critical interfaces like Telegram, continue startup
        if (name === 'telegram') {
          logger.warn(`Telegram interface startup timeout - it may still initialize later`);
          // Don't remove it - Telegram often starts successfully after timeout
          // The isRunning flag will indicate if it's actually available
        } else {
          // For critical interfaces, re-throw
          throw error;
        }
      }
    }
    
    // Update agent stats
    this.agentModel.stats.totalStartups++;
    await this.agentModel.save();
    
    this.emit("started");
  }
  
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    logger.info("Stopping agent...");

    // Shutdown MQTT services first (they have shutdown() method)
    if (this.services.has('eventEngine')) {
      logger.info('Shutting down Event Engine...');
      await eventEngine.shutdown();
    }
    if (this.services.has('mqttService')) {
      logger.info('Shutting down MQTT service...');
      await mqttService.shutdown();
    }

    // Shutdown UPS monitoring service
    if (this.services.has('upsService')) {
      logger.info('Shutting down UPS monitoring service...');
      const upsService = this.services.get('upsService');
      await upsService.shutdown();
    }

    // Shutdown P2P Federation service
    if (this.p2pService) {
      logger.info('Shutting down P2P Federation service...');
      await this.p2pService.shutdown();
    }

    // Stop all interfaces
    for (const [name, interface_] of this.interfaces) {
      logger.info(`Stopping interface: ${name}`);
      await interface_.stop();
    }

    // Stop all services
    for (const [name, service] of this.services) {
      if (service && typeof service.stop === 'function') {
        logger.info(`Stopping service: ${name}`);
        await service.stop();
      } else {
        logger.info(`Service ${name} does not have a stop method, skipping`);
      }
    }
    
    this.isRunning = false;
    this.emit("stopped");
  }
  
  // AI Provider methods
  async switchAIProvider(providerName) {
    return await this.providerManager.switchProvider(providerName);
  }
  
  getCurrentAIProvider() {
    const provider = this.providerManager.activeProvider;
    const providerKey = Array.from(this.providerManager.providers.entries())
      .find(([key, prov]) => prov === provider)?.[0] || 'none';
    
    logger.info(`getCurrentAIProvider: active provider = ${provider?.name}, key = ${providerKey}`);
    
    return {
      name: provider?.name || "none",
      key: providerKey,
      metrics: provider?.getMetrics() || {}
    };
  }
  
  // Check if input requires complex reasoning
  async needsComplexReasoning(input, context = {}) {
    // Skip reasoning for simple queries
    if (input.length < 20) return false;

    // Patterns that indicate complex reasoning might be needed
    const complexPatterns = [
      // Multi-step tasks
      /\b(and then|after that|once done|when complete)\b/i,
      // Conditional logic
      /\b(if|when|unless|depending on|based on the result)\b/i,
      // Verification/checking
      /\b(check|verify|confirm|ensure|make sure|validate)\b/i,
      // Analysis/comparison
      /\b(compare|analyze|evaluate|assess|determine)\b/i,
      // Multi-source queries
      /\b(search.+and|find.+then|get.+and also)\b/i,
      // Complex searches
      /\b(find all|search everywhere|look for.+across)\b/i,
      // Error handling requests
      /\b(fix|debug|troubleshoot|diagnose|investigate)\b/i,
      // Multiple criteria
      /\b(multiple|several|various|different|all)\b.*\b(check|find|search|do)\b/i
    ];

    for (const pattern of complexPatterns) {
      if (pattern.test(input)) {
        return true;
      }
    }

    // Check if ReAct agent thinks it needs reasoning
    if (this.reactAgent && typeof this.reactAgent.needsReasoning === 'function') {
      return await this.reactAgent.needsReasoning(input, context);
    }

    return false;
  }

  // Natural language processing
  async processNaturalLanguage(input, context = {}) {
    try {
      // Validate input at entry point
      if (input === undefined || input === null || input === '') {
        logger.warn('processNaturalLanguage called with empty/undefined input');
        return {
          type: 'text',
          content: "I didn't receive any input. Please provide a command or question."
        };
      }

      // Ensure input is a string
      const inputStr = typeof input === 'string' ? input : String(input);

      // Use inputStr throughout the function
      input = inputStr;

      // Check if this is a personal question that memory can answer BEFORE intent detection.
      // Without this, "what is my name?" routes to song-ID, "favorite color" to smart home, etc.
      const personalQuestionPattern = /\b(what(?:'s| is| are) my |do (?:i|you) (?:know|remember)|what do i (?:like|love|hate|prefer|enjoy)|who am i|tell me about (?:me|myself)|my (?:name|favorite|fav|preference))\b/i;
      if (personalQuestionPattern.test(input) && this.memoryManager) {
        try {
          const personalMemories = await this.memoryManager.recall(input, {
            limit: 5,
            type: 'knowledge',
            minSimilarity: 0.4
          });
          if (personalMemories && personalMemories.length > 0) {
            let memoryContext = 'Relevant knowledge from memory:\n';
            for (const mem of personalMemories) {
              memoryContext += `- ${mem.content}\n`;
            }
            const contextualInput = `${memoryContext}\nUser's question: ${input}`;
            const response = await this.providerManager.generateResponse(contextualInput, {
              maxTokens: 300,
              temperature: 0.7
            });
            await this.memoryManager.storeConversation(context.userId, input, response, context);
            return { type: 'text', content: response };
          }
        } catch (err) {
          logger.debug('Personal question memory check failed, continuing to intent detection:', err.message);
        }
      }

      // ─── Conversational context check ─────────────────────────────────
      // Before intent detection, check if this is a follow-up to the previous exchange.
      // Uses an in-memory conversation buffer (not DB — raw conversations aren't persisted).
      const userId = context.userId || 'default';
      const userBuffer = this.memoryManager?._conversationBuffer?.get(userId) || [];

      if (this.providerManager && userBuffer.length >= 2) {
        try {
          const isShort = input.trim().split(/\s+/).length <= 10;
          const hasFollowUpSignals = /\b(that|it|this|those|these|what|why|how|really|huh|wtf|hmm|ok|yes|no|yeah|nah|sure|exactly|right|is it|was it|did it|can you|could you|about|more|else|also|too|again|same)\b/i.test(input);
          const isQuestion = /\?$/.test(input.trim());
          const noStrongIntent = !/\b(post|search|send|create|get me|show me|turn|set|check my|configure|login|register|deploy|scan|generate|download|upload|play)\b/i.test(input);
          const looksLikeFollowUp = isShort && (hasFollowUpSignals || isQuestion) && noStrongIntent;

          if (looksLikeFollowUp) {
            // Build context from recent buffer (last 3 exchanges max)
            const recentPairs = userBuffer.slice(-6); // last 3 user+agent pairs
            let conversationCtx = '';
            for (const msg of recentPairs) {
              conversationCtx += `${msg.role === 'user' ? 'User' : 'You'}: ${msg.content.substring(0, 500)}\n`;
            }

            const agentName = this.config?.name || process.env.AGENT_NAME || 'LANAgent';
            const followUpPrompt = `You are ${agentName}, an autonomous AI agent. The user is continuing a conversation with you. Respond naturally based on context.

Recent conversation:
${conversationCtx}
User: ${input}

Respond conversationally — elaborate, clarify, or answer based on what was just discussed. Be natural, not robotic. Keep it concise.`;

            const response = await this.providerManager.generateResponse(followUpPrompt, {
              maxTokens: 400, temperature: 0.7
            });
            const content = (response?.content || response?.text || '').toString().trim();
            if (content && content.length > 5) {
              await this.memoryManager.storeConversation(userId, input, content, context);
              logger.info('Handled as conversational follow-up');
              return { type: 'text', content };
            }
          }
        } catch (err) {
          logger.debug('Conversation context check failed:', err.message);
        }
      }

      // Try vector intent detection FIRST — it's fast and catches known intents
      // before the chain processor tries to split them into multi-step tasks
      let intentResult;

      if (this.vectorIntentDetector && this.vectorIntentDetector.enabled) {
        try {
          const vectorResult = await this.vectorIntentDetector.detectIntent(input, context);
          if (vectorResult) {
            logger.info('Vector intent detector found a match');
            intentResult = vectorResult;

            // Override: If vector matched a non-schedule Govee intent but input contains
            // schedule-related temporal phrases, fall through to the AI two-step classifier
            // which has better contextual understanding of schedule vs. immediate commands.
            // e.g. "instead of blue I want my toilet light to be red at night" should route
            // to schedules, not color, despite containing color words.
            if (intentResult.plugin === 'govee' && intentResult.action !== 'schedules') {
              const schedulePattern = /\b(at night|at midnight|at noon|at dawn|at dusk|in the morning|in the evening|at \d{1,2}\s*(:\d{2})?\s*(am|pm)|every\s*(day|night|morning|evening)|daily|weekday|weekends?|schedule|instead of .+\b(at|every)\b)/i;
              if (schedulePattern.test(input)) {
                logger.info(`Schedule-related phrase detected in input, overriding vector match (${intentResult.action}) to use Govee two-step classifier directly`);
                // Call the Govee two-step classifier directly instead of the general AI classifier,
                // because the general classifier may not recognize indirect schedule phrases
                if (this.aiIntentDetector && this.aiIntentDetector.detectGoveeSpecificIntent) {
                  try {
                    intentResult = await this.aiIntentDetector.detectGoveeSpecificIntent(input, context.conversationContext || '');
                    logger.info(`Govee two-step classifier result: ${intentResult?.action}`);
                  } catch (goveeError) {
                    logger.warn('Govee two-step classifier failed, clearing for general fallback:', goveeError.message);
                    intentResult = null;
                  }
                } else {
                  intentResult = null;
                }
              }
            }
          }
        } catch (error) {
          logger.warn('Vector intent detection error:', error);
        }
      }
      
      // If vector detection didn't match, try multi-step chain analysis
      // This runs AFTER vector detection so known single intents aren't split into chains
      if (!intentResult && this.pluginChainProcessor && this.aiIntentDetector) {
        try {
          const complexAnalysis = await this.pluginChainProcessor.analyzeComplexTask(input, context);

          if (complexAnalysis.isMultiStep && complexAnalysis.steps && complexAnalysis.steps.length > 1) {
            logger.info(`Multi-step task detected with ${complexAnalysis.steps.length} steps`);

            if (context.showThinking) {
              await context.showThinking("🔄 Processing multi-step task...");
            }

            const chainResult = await this.pluginChainProcessor.executeChain(complexAnalysis.steps, context);

            await this.memoryManager.storeConversation(
              context.userId,
              input,
              chainResult.summary,
              { ...context, multiStep: true, stepsCompleted: chainResult.completedSteps }
            );

            return {
              type: 'text',
              content: chainResult.summary,
              multiStep: true,
              success: chainResult.success,
              totalSteps: chainResult.totalSteps,
              completedSteps: chainResult.completedSteps
            };
          }
        } catch (chainError) {
          logger.warn('Plugin chain analysis failed, continuing with single intent:', chainError.message);
        }
      }

      if (!intentResult && this.aiIntentDetector) {
        try {
          intentResult = await this.aiIntentDetector.detect(input, context);
          logger.info('Using AI intent detection');
        } catch (error) {
          logger.warn('AI intent detection failed, falling back to regex:', error.message);
          intentResult = await this.intentDetector.detect(input);
        }
      } else if (!intentResult) {
        logger.info('AI intent detector not available, using regex detection');
        intentResult = await this.intentDetector.detect(input);
      }
      
      if (intentResult.detected) {
        // Show thinking message if interface supports it
        if (context.showThinking) {
          await context.showThinking("🤔 Thinking...");
        }
        
        logger.info(`Intent detected: ${intentResult.intent}`, {
          intent: intentResult.intent,
          plugin: intentResult.plugin,
          action: intentResult.action,
          params: intentResult.parameters || intentResult.params
        });
        
        // Handle sub-agent intents (e.g., ServerMaintenanceAgent)
        if (intentResult.plugin === '_subagent') {
          try {
            const orchestrator = this.subAgentOrchestrator;
            if (orchestrator) {
              // Find the handler that owns this action, matching by unique intent ID
              const intentId = (intentResult.intentId || '').replace(/^subagent_/, '');
              for (const [, handler] of orchestrator.agentHandlers || new Map()) {
                if (typeof handler.handleCommand === 'function' && typeof handler.getIntents === 'function') {
                  const intents = handler.getIntents();
                  // Match by unique ID first, fall back to action (for intents without per-item params)
                  const matched = (intentId && intents.find(i => i.id === intentId)) || intents.find(i => i.action === intentResult.action && !i.params?.appName);
                  if (matched) {
                    const params = { ...matched.params, ...(intentResult.params || intentResult.parameters || {}) };
                    logger.info(`Delegating to sub-agent: ${intentResult.action}`, params);
                    const result = await handler.handleCommand(intentResult.action, params);
                    const content = result.message || (result.success ? 'Done' : 'Failed');
                    await this.memoryManager.storeConversation(context.userId, input, content, context);
                    return { type: 'text', content };
                  }
                }
              }
            }
            logger.warn(`No sub-agent handler found for action: ${intentResult.action}`);
          } catch (subErr) {
            logger.error('Sub-agent intent handling error:', subErr);
            return { type: 'text', content: `Sub-agent error: ${subErr.message}` };
          }
        }

        // Handle system intents
        if (intentResult.plugin === '_system') {
          switch (intentResult.action) {
            case 'listPlugins':
              const response = await this.handleAPICommand({
                category: 'api',
                action: 'list'
              });
              // Ensure content is a string for memory storage
              const respContent = typeof response.content === 'string'
                ? response.content
                : JSON.stringify(response.content || response);
              await this.memoryManager.storeConversation(
                context.userId,
                input,
                respContent,
                context
              );
              return response;
              
            case 'clarify':
              const clarifyResponse = { 
                type: 'text', 
                content: "I need more information to help you. Could you please clarify what you'd like me to do? For example:\n" +
                        "- Are you asking about system information? (disk space, memory, etc.)\n" +
                        "- Do you want me to install or manage software?\n" +
                        "- Are you setting up a reminder?\n" +
                        "- Do you need a web search?\n" +
                        "- Or something else entirely?" 
              };
              await this.memoryManager.storeConversation(context.userId, input, clarifyResponse.content, context);
              return clarifyResponse;
              
            case 'query':
              // Process as general AI query using the active AI provider
              // Recall relevant knowledge memories for context
              let queryMemoryContext = '';
              try {
                const queryMemories = await this.memoryManager.recall(input, {
                  userId: context.userId,
                  limit: 5,
                  type: 'knowledge'
                });
                if (queryMemories && queryMemories.length > 0) {
                  queryMemoryContext = '\nRelevant knowledge from memory:\n';
                  for (const mem of queryMemories) {
                    queryMemoryContext += `- ${mem.content}\n`;
                  }
                }
              } catch (err) {
                logger.debug('Memory recall for query failed:', err.message);
              }

              // Include memory context in the AI query
              const contextualInput = queryMemoryContext ?
                `${queryMemoryContext}\nUser's question: ${input}` :
                input;

              let queryResponse;
              if (context.onStreamChunk) {
                queryResponse = await this.providerManager.generateStreamingResponse(
                  contextualInput,
                  { maxTokens: 500, temperature: 0.7 },
                  context.onStreamChunk
                );
              } else {
                queryResponse = await this.providerManager.generateResponse(contextualInput, {
                  maxTokens: 500,
                  temperature: 0.7
                });
              }
              const response_content = { type: 'text', content: queryResponse.content };
              await this.memoryManager.storeConversation(context.userId, input, queryResponse.content, context);
              return response_content;
              
            case 'musicLibrary': {
              const { SystemSettings } = await import('../models/SystemSettings.js');
              const musicPath = await SystemSettings.getSetting('music-library.sourcePath', '');
              let mlContent;

              // 1. Set path: "set my music directory to /path"
              const setMatch = input.match(/(?:set|change|configure|update)\s+(?:my\s+)?(?:music|song)\s+(?:directory|folder|path|source|library)\s+(?:to\s+)?(.+)/i);
              if (setMatch) {
                const newPath = setMatch[1].trim().replace(/^["']|["']$/g, '');
                await SystemSettings.setSetting('music-library.sourcePath', newPath);
                mlContent = `Done! Music library path set to: \`${newPath}\``;
              }
              // 2. Save/download: "save this song to my music" or "download X to my library"
              else if (/\b(save|download|add|get)\b.*\b(to\s+)?(my\s+)?(music|library|collection)\b/i.test(input) || /\b(save|download)\b.*\b(song|track|music)\b/i.test(input)) {
                if (!musicPath) { mlContent = "Set up a music library path first (Settings → Music page)."; }
                else {
                  // Extract URL or search query
                  const urlMatch = input.match(/(https?:\/\/[^\s]+)/i);
                  const songMatch = input.match(/(?:save|download|add|get)\s+(?:the\s+)?(?:song\s+)?["']?(.+?)["']?\s+(?:to|into|in)\s+(?:my\s+)?(?:music|library|collection)/i)
                    || input.match(/(?:save|download)\s+["']?(.+?)["']?\s*$/i);
                  const ytdlp = this.apiManager?.apis?.get('ytdlp')?.instance;
                  if (!ytdlp) { mlContent = "The download plugin isn't available right now."; }
                  else {
                    try {
                      const result = await ytdlp.execute({
                        action: 'audio',
                        url: urlMatch?.[1] || undefined,
                        query: !urlMatch && songMatch?.[1] ? songMatch[1] : undefined
                      });
                      if (result.success) {
                        const dlPath = result.path || result.data?.path;
                        const fname = result.filename || result.data?.filename || 'audio file';
                        if (dlPath) {
                          try {
                            const fsMod = await import('fs');
                            const pathMod = await import('path');
                            const dest = pathMod.default.join(musicPath, pathMod.default.basename(dlPath));
                            await fsMod.promises.copyFile(dlPath, dest);
                            await fsMod.promises.unlink(dlPath).catch(() => {});
                            mlContent = `Saved to your music library: **${fname}**`;
                          } catch (mvErr) {
                            mlContent = `Downloaded **${fname}** but couldn't move to library: ${mvErr.message}`;
                          }
                        } else {
                          mlContent = `Downloaded: **${fname}**`;
                        }
                      } else {
                        mlContent = `Download failed: ${result.error || 'unknown error'}`;
                      }
                    } catch (e) { mlContent = `Download error: ${e.message}`; }
                  }
                }
              }
              // 3. Search: "do I have X in my music" / "find X in my library"
              else if (/\b(have|find|search|got|any|look\s*for)\b.*\b(music|library|collection|songs?)\b/i.test(input) || /\b(music|library|collection)\b.*\b(have|find|search|contain)\b/i.test(input)) {
                if (!musicPath) { mlContent = "No music library configured. Set one up in Settings → Music."; }
                else {
                  // Extract the search query
                  const searchMatch = input.match(/(?:have|find|search|got|any|look\s*for)\s+(?:any\s+)?(?:songs?\s+(?:by|from|called|named)\s+)?["']?(.+?)["']?\s+(?:in|on)\s+(?:my\s+)?(?:music|library|collection)/i)
                    || input.match(/(?:do\s+i\s+have|find|search\s+for|look\s*for)\s+["']?(.+?)["']?\s*(?:in\s+my)?/i);
                  const q = searchMatch?.[1]?.trim()
                    ?.replace(/\b(songs?|tracks?|albums?|music|by|from|of)\s*$/i, '').trim();
                  if (!q) { mlContent = "What would you like me to search for? Try: *Do I have any Daft Punk in my music?*"; }
                  else {
                    try {
                      const { exec: execCb } = await import('child_process');
                      const { promisify } = await import('util');
                      const execAsync = promisify(execCb);
                      const safeQ = q.replace(/['"\\]/g, '');
                      const exts = ['.mp3','.flac','.ogg','.wav','.m4a','.aac','.opus','.wma'];
                      const pattern = exts.map(e => `-iname '*${e}'`).join(' -o ');
                      const cmd = `find "${musicPath}" -maxdepth 3 \\( ${pattern} \\) 2>/dev/null | grep -i '${safeQ}' | head -20`;
                      const { stdout: output } = await execAsync(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 });
                      if (!output) {
                        mlContent = `No matches found for **"${q}"** in your music library.`;
                      } else {
                        const pathMod = await import('path');
                        const files = output.split('\n').filter(Boolean).map(f => pathMod.default.basename(f).replace(/\.[^.]+$/, ''));
                        mlContent = `Found **${files.length}** match${files.length > 1 ? 'es' : ''} for **"${q}"**:\n\n`;
                        mlContent += files.slice(0, 15).map((f, i) => `${i + 1}. ${f}`).join('\n');
                        if (files.length > 15) mlContent += `\n... and ${files.length - 15} more`;
                      }
                    } catch (e) { mlContent = `Search error: ${e.message}`; }
                  }
                }
              }
              // 4. General info: "show me my music" / "where is my music"
              else {
                if (!musicPath) {
                  mlContent = "No music library configured. Set one in **Settings → Music**, or tell me: *set my music directory to /path*";
                } else {
                  try {
                    const fsMod = await import('fs');
                    const entries = await fsMod.promises.readdir(musicPath, { withFileTypes: true });
                    const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).length;
                    const audioExts = new Set(['.mp3','.flac','.ogg','.wav','.m4a','.aac','.opus','.wma']);
                    const pathMod = await import('path');
                    const files = entries.filter(e => e.isFile() && audioExts.has(pathMod.default.extname(e.name).toLowerCase())).length;
                    mlContent = `Your music library: \`${musicPath}\`\n**${files}** audio files in root, **${folders}** subfolder(s).\n\nYou can ask me to search it (*"do I have any Beatles?"*), download to it (*"save Bohemian Rhapsody to my music"*), or play from it in the **Music** tab or **Playground**.`;
                  } catch (e) { mlContent = `Music library at \`${musicPath}\` — couldn't read: ${e.message}`; }
                }
              }
              const mlResponse = { type: 'text', content: mlContent };
              await this.memoryManager.storeConversation(context.userId, input, mlContent, context);
              return mlResponse;
            }

            case 'examineCode':
              const examineResult = await this.examineCode(intentResult.params);
              const examineResponse = { type: 'text', content: examineResult };
              await this.memoryManager.storeConversation(context.userId, input, examineResult, context);
              return examineResponse;
              
            case 'suggestImprovements':
              const suggestResult = await this.suggestImprovements(intentResult.params);
              const suggestResponse = { type: 'text', content: suggestResult };
              await this.memoryManager.storeConversation(context.userId, input, suggestResult, context);
              return suggestResponse;
              
            case 'listPlannedImprovements':
              const plannedResult = await this.listPlannedImprovements();
              const plannedResponse = { type: 'text', content: plannedResult };
              await this.memoryManager.storeConversation(context.userId, input, plannedResult, context);
              return plannedResponse;
              
            case 'considerFeature':
              const featureResult = await this.considerFeature(intentResult.params);
              const featureResponse = { type: 'text', content: featureResult };
              await this.memoryManager.storeConversation(context.userId, input, featureResult, context);
              return featureResponse;
              
            case 'remember':
              const rememberResult = await this.rememberInformation(input, context);
              const rememberResponse = { type: 'text', content: rememberResult };
              await this.memoryManager.storeConversation(context.userId, input, rememberResult, context);
              return rememberResponse;
              
            case 'recall':
              const recallResult = await this.recallInformation(input, context);
              const recallResponse = { type: 'text', content: recallResult };
              await this.memoryManager.storeConversation(context.userId, input, recallResult, context);
              return recallResponse;
              
            case 'getRecentChanges':
              const changesResult = await this.getRecentChanges(intentResult.parameters || intentResult.params, context.onStreamChunk || null);
              const changesResponse = { type: 'text', content: changesResult };
              await this.memoryManager.storeConversation(context.userId, input, changesResult, context);
              return changesResponse;
              
            case 'aboutMe':
              const aboutResult = await this.getAboutMe();
              const aboutResponse = { type: 'text', content: aboutResult };
              await this.memoryManager.storeConversation(context.userId, input, aboutResult, context);
              return aboutResponse;
              
            case 'getProjectInfo':
              const projectResult = await this.getProjectInfo();
              const projectResponse = { type: 'text', content: projectResult };
              await this.memoryManager.storeConversation(context.userId, input, projectResult, context);
              return projectResponse;
              
            case 'listAllFeatures':
              const featuresResult = await this.listAllFeatures();
              const featuresResponse = { type: 'text', content: featuresResult };
              await this.memoryManager.storeConversation(context.userId, input, featuresResult, context);
              return featuresResponse;
              
            // Crypto Wallet Operations
            case 'checkWallet':
              const walletResult = await this.checkWalletStatus();
              const walletResponse = { type: 'text', content: walletResult };
              await this.memoryManager.storeConversation(context.userId, input, walletResult, context);
              return walletResponse;
              
            case 'generateWallet':
              const genResult = await this.generateNewWallet();
              const genResponse = { type: 'text', content: genResult };
              await this.memoryManager.storeConversation(context.userId, input, genResult, context);
              return genResponse;
              
            case 'checkBalance':
              const balanceResult = await this.checkCryptoBalances(intentResult.params);
              const balanceResponse = { type: 'text', content: balanceResult };
              await this.memoryManager.storeConversation(context.userId, input, balanceResult, context);
              return balanceResponse;
              
            case 'sendCrypto':
              const sendResult = await this.sendCryptocurrency(intentResult.params);
              const sendResponse = { type: 'text', content: sendResult };
              await this.memoryManager.storeConversation(context.userId, input, sendResult, context);
              return sendResponse;
              
            case 'signMessage':
              const signResult = await this.signMessageWithWallet(intentResult.params);
              const signResponse = { type: 'text', content: signResult };
              await this.memoryManager.storeConversation(context.userId, input, signResult, context);
              return signResponse;

            case 'nanoReceive':
              const nanoRecvResult = await this.receiveNano();
              const nanoRecvResponse = { type: 'text', content: nanoRecvResult };
              await this.memoryManager.storeConversation(context.userId, input, nanoRecvResult, context);
              return nanoRecvResponse;

            case 'nanoFaucet':
              const nanoFaucetResult = await this.claimNanoFaucet();
              const nanoFaucetResponse = { type: 'text', content: nanoFaucetResult };
              await this.memoryManager.storeConversation(context.userId, input, nanoFaucetResult, context);
              return nanoFaucetResponse;

            // Smart Contract Operations
            case 'readContract':
              const readResult = await this.readSmartContract(intentResult.params);
              const readResponse = { type: 'text', content: readResult };
              await this.memoryManager.storeConversation(context.userId, input, readResult, context);
              return readResponse;
              
            case 'writeContract':
              const writeResult = await this.writeToSmartContract(intentResult.params);
              const writeResponse = { type: 'text', content: writeResult };
              await this.memoryManager.storeConversation(context.userId, input, writeResult, context);
              return writeResponse;
              
            case 'deployContract':
              const deployResult = await this.deploySmartContract(intentResult.params);
              const deployResponse = { type: 'text', content: deployResult };
              await this.memoryManager.storeConversation(context.userId, input, deployResult, context);
              return deployResponse;
              
            case 'monitorEvents':
              const monitorResult = await this.monitorContractEvents(intentResult.params);
              const monitorResponse = { type: 'text', content: monitorResult };
              await this.memoryManager.storeConversation(context.userId, input, monitorResult, context);
              return monitorResponse;
              
            // Development Operations
            case 'createProject':
              const createResult = await this.createBlockchainProject(intentResult.params);
              const createResponse = { type: 'text', content: createResult };
              await this.memoryManager.storeConversation(context.userId, input, createResult, context);
              return createResponse;
              
            case 'compileContracts':
              const compileResult = await this.compileSmartContracts(intentResult.params);
              const compileResponse = { type: 'text', content: compileResult };
              await this.memoryManager.storeConversation(context.userId, input, compileResult, context);
              return compileResponse;
              
            case 'testContracts':
              const testResult = await this.testSmartContracts(intentResult.params);
              const testResponse = { type: 'text', content: testResult };
              await this.memoryManager.storeConversation(context.userId, input, testResult, context);
              return testResponse;
              
            // Token Operations
            case 'checkTokenBalance':
              const tokenBalResult = await this.checkTokenBalance(intentResult.params);
              const tokenBalResponse = { type: 'text', content: tokenBalResult };
              await this.memoryManager.storeConversation(context.userId, input, tokenBalResult, context);
              return tokenBalResponse;
              
            case 'transferTokens':
              const transferResult = await this.transferTokens(intentResult.params);
              const transferResponse = { type: 'text', content: transferResult };
              await this.memoryManager.storeConversation(context.userId, input, transferResult, context);
              return transferResponse;
              
            case 'approveTokens':
              const approveResult = await this.approveTokenSpending(intentResult.params);
              const approveResponse = { type: 'text', content: approveResult };
              await this.memoryManager.storeConversation(context.userId, input, approveResult, context);
              return approveResponse;
              
            // Network Operations
            case 'switchNetwork':
              const switchResult = await this.switchBlockchainNetwork(intentResult.params);
              const switchResponse = { type: 'text', content: switchResult };
              await this.memoryManager.storeConversation(context.userId, input, switchResult, context);
              return switchResponse;
              
            case 'getNetworkInfo':
              const networkResult = await this.getNetworkInformation();
              const networkResponse = { type: 'text', content: networkResult };
              await this.memoryManager.storeConversation(context.userId, input, networkResult, context);
              return networkResponse;
              
            // Faucet Operations
            case 'claimFaucet':
              const faucetResult = await this.claimTestnetTokens(intentResult.params);
              const faucetResponse = { type: 'text', content: faucetResult };
              await this.memoryManager.storeConversation(context.userId, input, faucetResult, context);
              return faucetResponse;
              
            // Transaction Management
            case 'estimateGas':
              const gasResult = await this.estimateTransactionGas(intentResult.params);
              const gasResponse = { type: 'text', content: gasResult };
              await this.memoryManager.storeConversation(context.userId, input, gasResult, context);
              return gasResponse;
              
            case 'getTransactionHistory':
              const historyResult = await this.getTransactionHistory(intentResult.params);
              const historyResponse = { type: 'text', content: historyResult };
              await this.memoryManager.storeConversation(context.userId, input, historyResult, context);
              return historyResponse;

            // ======= CRYPTO TRADING =======
            case 'cryptoTradingStatus': {
              const tradingStatusResult = await this.getCryptoTradingStatus();
              const tradingStatusResponse = { type: 'text', content: tradingStatusResult };
              await this.memoryManager.storeConversation(context.userId, input, tradingStatusResult, context);
              return tradingStatusResponse;
            }

            case 'cryptoPositions': {
              const positionsResult = await this.getCryptoPositions();
              const positionsResponse = { type: 'text', content: positionsResult };
              await this.memoryManager.storeConversation(context.userId, input, positionsResult, context);
              return positionsResponse;
            }

            case 'cryptoTradeHistory': {
              const tradeHistResult = await this.getCryptoTradeHistory();
              const tradeHistResponse = { type: 'text', content: tradeHistResult };
              await this.memoryManager.storeConversation(context.userId, input, tradeHistResult, context);
              return tradeHistResponse;
            }

            case 'swapCrypto': {
              const swapResult = await this.handleCryptoSwapRequest(input, intentResult.params);
              const swapResponse = { type: 'text', content: swapResult };
              await this.memoryManager.storeConversation(context.userId, input, swapResult, context);
              return swapResponse;
            }

            // ======= AGENT AVATAR =======
            case 'setAvatar': {
              // When triggered via NLP, the user is telling the agent to set an avatar
              // If they sent an image attachment, context will have it; otherwise guide them
              const avatarMsg = 'To set my avatar, please go to **Settings > Agent Avatar** in the web UI and upload an image there. You can also send me an image file and I\'ll save it as my avatar.';
              await this.memoryManager.storeConversation(context.userId, input, avatarMsg, context);
              return { type: 'text', content: avatarMsg };
            }

            case 'syncAvatar': {
              try {
                const avatarPath = this.agentModel?.avatarPath;
                if (!avatarPath) {
                  const noAvatarMsg = 'I don\'t have an avatar set yet. Upload one in Settings > Agent Avatar first, then I can sync it to Gravatar.';
                  await this.memoryManager.storeConversation(context.userId, input, noAvatarMsg, context);
                  return { type: 'text', content: noAvatarMsg };
                }

                const path = await import('path');
                const { fileURLToPath } = await import('url');
                const projectRoot = path.default.join(path.default.dirname(fileURLToPath(import.meta.url)), '../..');
                const fullPath = path.default.join(projectRoot, avatarPath);

                const { uploadAvatarToGravatar } = await import('../utils/gravatarHelper.js');
                const agentEmail = process.env.EMAIL_USER || process.env.GMAIL_USER;
                const result = await uploadAvatarToGravatar(fullPath, agentEmail);

                const syncMsg = result.success
                  ? `Avatar synced to Gravatar successfully! (Image ID: ${result.imageId})`
                  : `Avatar sync failed: ${result.error}`;
                await this.memoryManager.storeConversation(context.userId, input, syncMsg, context);
                return { type: 'text', content: syncMsg };
              } catch (error) {
                logger.error('Avatar sync via NLP failed:', error);
                const errMsg = `Failed to sync avatar: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'getAvatar': {
              const avatarPath = this.agentModel?.avatarPath;
              if (!avatarPath) {
                const noAvatarMsg = 'I don\'t have an avatar set yet. You can upload one in Settings > Agent Avatar.';
                await this.memoryManager.storeConversation(context.userId, input, noAvatarMsg, context);
                return { type: 'text', content: noAvatarMsg };
              }

              try {
                const path = await import('path');
                const fsAvatar = await import('fs');
                const { fileURLToPath } = await import('url');
                const projectRoot = path.default.join(path.default.dirname(fileURLToPath(import.meta.url)), '../..');
                const fullPath = path.default.join(projectRoot, avatarPath);

                if (fsAvatar.default.existsSync(fullPath)) {
                  const desc = this.agentModel.avatarDescription || '';
                  const caption = desc ? `Here\'s my avatar! ${desc}` : 'Here\'s my current avatar!';
                  await this.memoryManager.storeConversation(context.userId, input, caption, context);
                  return { type: 'photo', path: fullPath, caption };
                } else {
                  const serverHost = getServerHost();
                  const port = process.env.AGENT_PORT || 443;
                  const protocol = String(port) === '443' ? 'https' : 'http';
                  const avatarUrl = `${protocol}://${serverHost}/api/agent/avatar`;
                  const urlMsg = `You can view my avatar at: ${avatarUrl}`;
                  await this.memoryManager.storeConversation(context.userId, input, urlMsg, context);
                  return { type: 'text', content: urlMsg };
                }
              } catch (error) {
                const serverHost = getServerHost();
                const port = process.env.AGENT_PORT || 443;
                const protocol = String(port) === '443' ? 'https' : 'http';
                const avatarUrl = `${protocol}://${serverHost}/api/agent/avatar`;
                const urlMsg = `You can view my avatar at: ${avatarUrl}`;
                await this.memoryManager.storeConversation(context.userId, input, urlMsg, context);
                return { type: 'text', content: urlMsg };
              }
            }

            // ======= ERC-8004 IDENTITY =======
            case 'getAgentNFT': {
              try {
                const identityService = (await import('../services/crypto/agentIdentityService.js')).default;
                const status = await identityService.getIdentityStatus();

                if (status.status === 'minted' || status.status === 'active') {
                  const chain = (status.chain || 'bsc').toUpperCase();
                  const lines = [
                    `🪪 Agent Identity #${status.agentId}`,
                    `Chain: ${chain}`,
                    `Status: ${status.status}`,
                    status.mintedAt ? `Minted: ${new Date(status.mintedAt).toLocaleDateString()}` : null,
                    status.nftUrl ? `NFT: ${status.nftUrl}` : null,
                    status.ipfs?.avatarCID ? `Avatar IPFS: https://gateway.pinata.cloud/ipfs/${status.ipfs.avatarCID}` : null,
                    status.ipfs?.registrationCID ? `Registration: https://gateway.pinata.cloud/ipfs/${status.ipfs.registrationCID}` : null,
                    status.isStale ? '\n⚠️ On-chain registration is stale — capabilities have changed.' : null
                  ].filter(Boolean).join('\n');

                  // Try to send avatar photo with caption
                  const avatarPath = this.agentModel?.avatarPath;
                  if (avatarPath) {
                    const path = await import('path');
                    const fsCheck = await import('fs');
                    const { fileURLToPath } = await import('url');
                    const projectRoot = path.default.join(path.default.dirname(fileURLToPath(import.meta.url)), '../..');
                    const fullPath = path.default.join(projectRoot, avatarPath);
                    if (fsCheck.default.existsSync(fullPath)) {
                      await this.memoryManager.storeConversation(context.userId, input, lines, context);
                      return { type: 'photo', path: fullPath, caption: lines };
                    }
                  }

                  await this.memoryManager.storeConversation(context.userId, input, lines, context);
                  return { type: 'text', content: lines };
                } else {
                  const msg = 'I don\'t have an on-chain identity yet. My ERC-8004 agent identity NFT hasn\'t been minted. You can mint it from the Web UI under Crypto > ERC-8004.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }
              } catch (error) {
                logger.error('getAgentNFT failed:', error);
                const errMsg = `Failed to fetch identity status: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= EXTERNAL SERVICE STATS =======
            case 'getExternalServiceStats': {
              try {
                const ExternalServiceConfig = (await import('../models/ExternalServiceConfig.js')).default;
                const ExternalPayment = (await import('../models/ExternalPayment.js')).default;
                const ExternalAuditLog = (await import('../models/ExternalAuditLog.js')).default;

                const [services, totalPayments, revenueAgg, recentPayments, recentRequests] = await Promise.all([
                  ExternalServiceConfig.find().lean(),
                  ExternalPayment.countDocuments(),
                  ExternalPayment.aggregate([
                    { $group: { _id: null, total: { $sum: { $toDouble: '$amount' } } } }
                  ]),
                  ExternalPayment.find().sort({ createdAt: -1 }).limit(5).lean(),
                  ExternalAuditLog.countDocuments()
                ]);

                const totalRevenue = revenueAgg[0]?.total || 0;
                const enabledServices = services.filter(s => s.enabled !== false);

                let msg = `🌐 **External Service Gateway Stats**\n\n`;
                msg += `**Agent:** #2930 on BSC | **Endpoint:** https://api.lanagent.net/agents/2930\n\n`;
                msg += `**Revenue:** ${totalRevenue.toFixed(6)} BNB (${totalPayments} payments)\n`;
                msg += `**Total Requests:** ${recentRequests} audited\n\n`;

                msg += `**Services (${enabledServices.length} active / ${services.length} total):**\n`;
                for (const s of services) {
                  const status = s.enabled !== false ? '✅' : '❌';
                  const reqs = s.totalRequests || 0;
                  msg += `${status} **${s.name}** — ${s.price} BNB (${reqs} requests)\n`;
                }

                if (recentPayments.length > 0) {
                  msg += `\n**Recent Payments:**\n`;
                  for (const p of recentPayments) {
                    const date = new Date(p.createdAt).toLocaleDateString();
                    msg += `• ${p.amount} BNB from agent ${p.callerAgentId} for ${p.serviceId} (${date})\n`;
                  }
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('External service stats failed:', error);
                const errMsg = `Failed to fetch external service stats: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= SERVICE CATALOG & PRICING =======
            case 'listMyServices': {
              try {
                const ExternalServiceConfig = (await import('../models/ExternalServiceConfig.js')).default;
                const SkynetServiceConfig = (await import('../models/SkynetServiceConfig.js')).default;

                const [externalServices, skynetCatalog] = await Promise.all([
                  ExternalServiceConfig.find().lean(),
                  SkynetServiceConfig.getCatalog()
                ]);

                let msg = `📋 **ALICE Service Catalog**\n\n`;

                // ERC-8004 External Services
                const enabledExternal = externalServices.filter(s => s.enabled !== false);
                msg += `### ERC-8004 External Services\n`;
                msg += `*Paid in BNB by external AI agents via the ERC-8004 protocol*\n\n`;

                if (externalServices.length > 0) {
                  for (const s of externalServices) {
                    const status = s.enabled !== false ? '✅' : '❌';
                    msg += `${status} **${s.name}** — ${s.price} ${s.currency || 'BNB'}`;
                    if (s.estimatedTime) msg += ` (~${s.estimatedTime})`;
                    msg += `\n`;
                    if (s.description) msg += `   ${s.description}\n`;
                  }
                  msg += `\n${enabledExternal.length} active / ${externalServices.length} total\n`;
                } else {
                  msg += `No ERC-8004 services configured yet.\n`;
                }

                // Skynet P2P Services
                msg += `\n### Skynet P2P Services\n`;
                msg += `*Paid in SKYNET tokens by peer agents on the Skynet P2P network*\n\n`;

                if (skynetCatalog.length > 0) {
                  for (const s of skynetCatalog) {
                    const priceLabel = s.price > 0 ? `${s.price} SKYNET` : 'Free';
                    msg += `✅ **${s.name}** — ${priceLabel}`;
                    if (s.category && s.category !== 'general') msg += ` [${s.category}]`;
                    msg += `\n`;
                    if (s.description) msg += `   ${s.description}\n`;
                  }
                  msg += `\n${skynetCatalog.length} services published\n`;
                } else {
                  msg += `No Skynet P2P services published yet.\n`;
                }

                // Explanation
                msg += `\n---\n`;
                msg += `**ERC-8004** services are on-chain (BSC) — external AI agents pay BNB to call them via the standardized agent services protocol.\n`;
                msg += `**Skynet P2P** services use the off-chain peer-to-peer network — peers pay SKYNET tokens directly.\n`;
                msg += `\n**Agent:** #2930 on BSC | **Endpoint:** https://api.lanagent.net/agents/2930`;

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('listMyServices failed:', error);
                const errMsg = `Failed to fetch service catalog: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= SKYNET P2P NETWORK =======
            case 'skynetNetworkStatus': {
              try {
                const { P2PPeer } = await import('../models/P2PPeer.js');
                const SkynetServiceConfig = (await import('../models/SkynetServiceConfig.js')).default;
                const SkynetBounty = (await import('../models/SkynetBounty.js')).default;
                const SkynetGovernance = (await import('../models/SkynetGovernance.js')).default;

                const [totalPeers, trustedPeers, onlinePeers, catalog, openBounties, activeProposals] = await Promise.all([
                  P2PPeer.countDocuments(),
                  P2PPeer.getTrustedPeers(),
                  P2PPeer.getOnlinePeers(),
                  SkynetServiceConfig.getCatalog(),
                  SkynetBounty.getOpenBounties(),
                  SkynetGovernance.getActiveProposals()
                ]);

                let msg = `🌐 **Skynet P2P Network Status**\n\n`;
                msg += `**Peers:** ${totalPeers} total, ${onlinePeers.length} online, ${trustedPeers.length} trusted\n`;
                msg += `**Services:** ${catalog.length} published in catalog\n`;
                msg += `**Bounties:** ${openBounties.length} open\n`;
                msg += `**Governance:** ${activeProposals.length} active proposals\n`;

                if (onlinePeers.length > 0) {
                  msg += `\n**Online Peers:**\n`;
                  for (const peer of onlinePeers.slice(0, 10)) {
                    const name = peer.displayName || peer.fingerprint.substring(0, 8);
                    const trust = peer.trustScore || 0;
                    msg += `• ${name} — trust: ${trust}/100${peer.erc8004?.verified ? ' ✓ERC-8004' : ''}\n`;
                  }
                  if (onlinePeers.length > 10) msg += `  ...and ${onlinePeers.length - 10} more\n`;
                }

                if (openBounties.length > 0) {
                  msg += `\n**Open Bounties:**\n`;
                  for (const b of openBounties.slice(0, 5)) {
                    msg += `• ${b.title} — ${b.reward} SKYNET\n`;
                  }
                  if (openBounties.length > 5) msg += `  ...and ${openBounties.length - 5} more\n`;
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Skynet network status failed:', error);
                const errMsg = `Failed to fetch Skynet network status: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'skynetTokenInfo': {
              try {
                const SkynetTokenLedger = (await import('../models/SkynetTokenLedger.js')).default;
                const SkynetPayment = (await import('../models/SkynetPayment.js')).default;

                const [summary, totalPayments, recentPayments] = await Promise.all([
                  SkynetTokenLedger.getSummary(),
                  SkynetPayment.countDocuments(),
                  SkynetPayment.find().sort({ createdAt: -1 }).limit(5).lean()
                ]);

                let msg = `🪙 **SKYNET Token Info**\n\n`;
                msg += `**Contract:** \`0x8Ef02e4a3203E845CC5FA08B81e4C109ceDCb04F\` (BEP-20, BSC)\n`;
                msg += `**Total Supply:** 100,000,000 SKYNET (fixed, no mint)\n`;
                msg += `**LP Pair:** PancakeSwap V2 \`0xF3dE...94A\`\n\n`;

                msg += `**Allocation Ledger:**\n`;
                if (summary?.entries?.length > 0) {
                  for (const entry of summary.entries) {
                    msg += `• **${entry.category}**: ${Number(entry.amount).toLocaleString()} SKYNET\n`;
                  }
                  msg += `\nTotal Minted: ${Number(summary.totalMinted).toLocaleString()} | Bought: ${Number(summary.totalBought).toLocaleString()} | Tradeable: ${Number(summary.totalTradeable).toLocaleString()}\n`;
                } else {
                  msg += `• LP: 50,000,000 | Staking: 20,000,000 | Bounty: 10,000,000 | Treasury: 10,000,000 | Reserve: 10,000,000\n`;
                }

                msg += `\n**Payments:** ${totalPayments} total on-chain payments\n`;
                if (recentPayments.length > 0) {
                  msg += `\n**Recent Payments:**\n`;
                  for (const p of recentPayments) {
                    const date = new Date(p.createdAt).toLocaleDateString();
                    msg += `• ${p.amount} SKYNET for ${p.serviceId} (${date})\n`;
                  }
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Skynet token info failed:', error);
                const errMsg = `Failed to fetch SKYNET token info: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'skynetEconomyLive': {
              try {
                const DataListing = (await import('../models/DataListing.js')).default;
                const ArbSignal = (await import('../models/ArbSignal.js')).default;
                const SkynetReferral = (await import('../models/SkynetReferral.js')).default;
                const ComputeJob = (await import('../models/ComputeJob.js')).default;

                const [listings, arbSignals, referrals, computeJobs] = await Promise.all([
                  DataListing.find({ status: 'active' }).sort({ createdAt: -1 }).limit(10).lean(),
                  ArbSignal.find().sort({ createdAt: -1 }).limit(10).lean(),
                  SkynetReferral.find().sort({ createdAt: -1 }).limit(10).lean(),
                  ComputeJob.find().sort({ createdAt: -1 }).limit(10).lean()
                ]);

                let msg = `📊 **Skynet Economy — Live Data**\n\n`;

                // Data Marketplace
                msg += `**🛒 Data Marketplace** (${listings.length} active listing${listings.length !== 1 ? 's' : ''})\n`;
                if (listings.length > 0) {
                  for (const l of listings) {
                    msg += `• **${l.title || l.dataType}** — ${l.price} ${l.currency || 'SKYNET'} (${l.format || 'raw'})\n`;
                  }
                } else {
                  msg += `• No active listings\n`;
                }

                // Arb Signals
                msg += `\n**📡 Arbitrage Signals** (${arbSignals.length} recent)\n`;
                if (arbSignals.length > 0) {
                  for (const s of arbSignals) {
                    const date = new Date(s.createdAt).toLocaleDateString();
                    msg += `• **${s.token || s.pair}** — ${s.spreadPercent ? s.spreadPercent.toFixed(2) + '% spread' : s.type} (${date})\n`;
                  }
                } else {
                  msg += `• No recent arb signals\n`;
                }

                // Referrals
                msg += `\n**🤝 Referral Rewards** (${referrals.length} recent)\n`;
                if (referrals.length > 0) {
                  for (const r of referrals) {
                    const date = new Date(r.createdAt).toLocaleDateString();
                    msg += `• ${r.reward || 0} SKYNET — ${r.type || 'referral'} (${date})\n`;
                  }
                } else {
                  msg += `• No referral rewards yet\n`;
                }

                // Compute Jobs
                msg += `\n**🖥️ Compute Jobs** (${computeJobs.length} recent)\n`;
                if (computeJobs.length > 0) {
                  for (const j of computeJobs) {
                    const date = new Date(j.createdAt).toLocaleDateString();
                    msg += `• **${j.type}** — ${j.status} — ${j.totalPrice || 0} SKYNET (${date})\n`;
                  }
                } else {
                  msg += `• No compute jobs\n`;
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Skynet economy live data failed:', error);
                const errMsg = `Failed to fetch Skynet economy data: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= SKYNET STAKING OPERATIONS =======
            case 'stakingStatus': {
              try {
                const skynetStakingService = (await import('../services/crypto/skynetStakingService.js')).default;
                await skynetStakingService.initialize();

                if (!skynetStakingService.isAvailable()) {
                  const errMsg = 'Staking contract is not configured. Set the staking address in Settings or via /api/settings/skynet-staking-address.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                const info = await skynetStakingService.getFullStakeInfo();
                let msg = `📊 **SKYNET Staking Status**\n\n`;
                msg += `**Your Position:**\n`;
                msg += `• Staked: ${info.stakedAmount.toLocaleString()} SKYNET\n`;
                msg += `• Pending Rewards: ${info.pendingRewards.toLocaleString(undefined, { maximumFractionDigits: 4 })} SKYNET\n`;
                msg += `• Wallet Balance: ${info.walletBalance.toLocaleString()} SKYNET\n`;

                msg += `\n**Contract Stats:**\n`;
                msg += `• Total Staked: ${info.totalStaked.toLocaleString()} SKYNET\n`;
                msg += `• APY: ~${info.apy.toLocaleString()}%\n`;
                msg += `• Reward Rate: ${info.rewardRate.toFixed(4)} SKYNET/sec\n`;
                if (info.periodFinish) {
                  msg += `• Reward Epoch Ends: ${info.periodFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}\n`;
                }
                if (info.timeUntilEnd > 0) {
                  const days = Math.floor(info.timeUntilEnd / 86400);
                  const hours = Math.floor((info.timeUntilEnd % 86400) / 3600);
                  msg += `• Time Remaining: ${days}d ${hours}h\n`;
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Staking status check failed:', error);
                const errMsg = `Failed to check staking status: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'stakingStake': {
              try {
                const skynetStakingService = (await import('../services/crypto/skynetStakingService.js')).default;
                await skynetStakingService.initialize();

                if (!skynetStakingService.isAvailable()) {
                  const errMsg = 'Staking contract is not configured. Set the staking address in Settings or via /api/settings/skynet-staking-address.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                let amount = intentResult.params?.amount;

                // If no amount specified, ask the user
                if (amount === null || amount === undefined) {
                  const info = await skynetStakingService.getFullStakeInfo();
                  const msg = `How many SKYNET tokens would you like to stake? You have **${info.walletBalance.toLocaleString()}** SKYNET available in your wallet.`;
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                // If "all", get full wallet balance
                if (amount === 'all') {
                  const info = await skynetStakingService.getFullStakeInfo();
                  amount = info.walletBalance;
                  if (amount <= 0) {
                    const msg = 'You don\'t have any SKYNET tokens in your wallet to stake.';
                    await this.memoryManager.storeConversation(context.userId, input, msg, context);
                    return { type: 'text', content: msg };
                  }
                }

                const result = await skynetStakingService.stake(amount);
                let msg = `✅ **Staked ${Number(amount).toLocaleString()} SKYNET**\n\n`;
                msg += `• Tx: \`${result.txHash}\`\n`;

                // Show updated position
                const updated = await skynetStakingService.getFullStakeInfo();
                msg += `\n**Updated Position:**\n`;
                msg += `• Staked: ${updated.stakedAmount.toLocaleString()} SKYNET\n`;
                msg += `• Wallet Balance: ${updated.walletBalance.toLocaleString()} SKYNET\n`;

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Staking operation failed:', error);
                const errMsg = `Failed to stake SKYNET: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'stakingUnstake': {
              try {
                const skynetStakingService = (await import('../services/crypto/skynetStakingService.js')).default;
                await skynetStakingService.initialize();

                if (!skynetStakingService.isAvailable()) {
                  const errMsg = 'Staking contract is not configured. Set the staking address in Settings or via /api/settings/skynet-staking-address.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                let amount = intentResult.params?.amount;

                // If no amount specified, ask the user
                if (amount === null || amount === undefined) {
                  const info = await skynetStakingService.getFullStakeInfo();
                  const msg = `How many SKYNET tokens would you like to unstake? You currently have **${info.stakedAmount.toLocaleString()}** SKYNET staked.`;
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                // If "all", get full staked amount
                if (amount === 'all') {
                  const info = await skynetStakingService.getFullStakeInfo();
                  amount = info.stakedAmount;
                  if (amount <= 0) {
                    const msg = 'You don\'t have any SKYNET tokens staked to unstake.';
                    await this.memoryManager.storeConversation(context.userId, input, msg, context);
                    return { type: 'text', content: msg };
                  }
                }

                const result = await skynetStakingService.unstake(amount);
                let msg = `✅ **Unstaked ${Number(amount).toLocaleString()} SKYNET**\n\n`;
                msg += `• Tx: \`${result.txHash}\`\n`;
                msg += `_Note: Unstaking auto-claims any pending rewards._\n`;

                // Show updated position
                const updated = await skynetStakingService.getFullStakeInfo();
                msg += `\n**Updated Position:**\n`;
                msg += `• Staked: ${updated.stakedAmount.toLocaleString()} SKYNET\n`;
                msg += `• Wallet Balance: ${updated.walletBalance.toLocaleString()} SKYNET\n`;

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Unstaking operation failed:', error);
                const errMsg = `Failed to unstake SKYNET: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'stakingClaim': {
              try {
                const skynetStakingService = (await import('../services/crypto/skynetStakingService.js')).default;
                await skynetStakingService.initialize();

                if (!skynetStakingService.isAvailable()) {
                  const errMsg = 'Staking contract is not configured. Set the staking address in Settings or via /api/settings/skynet-staking-address.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                // Check pending rewards first
                const info = await skynetStakingService.getFullStakeInfo();
                if (info.pendingRewards <= 0) {
                  const msg = 'You don\'t have any pending staking rewards to claim.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                const pendingAmount = info.pendingRewards;
                const result = await skynetStakingService.claimRewards();
                let msg = `✅ **Claimed ${pendingAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} SKYNET** staking rewards\n\n`;
                msg += `• Tx: \`${result.txHash}\`\n`;

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Staking claim failed:', error);
                const errMsg = `Failed to claim staking rewards: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= ENS NAME SERVICE =======
            case 'ensStatus': {
              try {
                const ensService = (await import('../services/crypto/ensService.js')).default;
                if (!ensService.isAvailable()) await ensService.initialize();

                if (!ensService.isAvailable()) {
                  // Check if this fork has a subname
                  const { SystemSettings } = await import('../models/SystemSettings.js');
                  const mySubname = await SystemSettings.getSetting('ens.mySubname', null);
                  if (mySubname) {
                    const msg = `**My ENS Name:** ${mySubname.name}\n• Owner: \`${mySubname.owner}\`\n• Granted by peer: \`${mySubname.grantedBy?.slice(0, 8)}...\`\n• Date: ${mySubname.grantedAt}`;
                    await this.memoryManager.storeConversation(context.userId, input, msg, context);
                    return { type: 'text', content: msg };
                  }
                  const msg = 'No ENS name is configured for this instance. You can request a subname from the genesis peer — just say "get me an ENS subname".';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                const status = await ensService.getStatus();
                let msg = '**ENS Name Status**\n\n';
                if (status.configured) {
                  msg += `• **Base Name:** ${status.baseName}\n`;
                  msg += `• **Resolved Address:** \`${status.resolvedAddress}\`\n`;
                  msg += `• **Expiry:** ${status.expiry ? new Date(status.expiry).toLocaleDateString() : 'unknown'} (${status.daysUntilExpiry} days)\n`;
                  msg += `• **Auto-Renew:** ${status.autoRenew ? 'enabled' : 'disabled'}\n`;
                  if (status.subnames?.length > 0) {
                    msg += `\n**Subnames:**\n`;
                    for (const sub of status.subnames) {
                      msg += `• ${sub.fullName}\n`;
                    }
                  }
                } else {
                  msg += 'No ENS name is registered for this instance.';
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('ENS status check failed:', error);
                const errMsg = `Failed to check ENS status: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'ensRequestSubname': {
              try {
                const { SystemSettings } = await import('../models/SystemSettings.js');

                // Already have a subname?
                const existing = await SystemSettings.getSetting('ens.mySubname', null);
                if (existing) {
                  const msg = `You already have an ENS subname: **${existing.name}**\n\nIf you want a different one, contact the genesis operator or use the API endpoint \`POST /api/ens/request-subname\` with \`{ "label": "newname" }\`.`;
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                const ensService = (await import('../services/crypto/ensService.js')).default;
                if (!ensService.isAvailable()) await ensService.initialize();

                // Check if this is the genesis instance (it creates subnames, doesn't request them)
                if (ensService.isGenesisENS()) {
                  const msg = 'This is the genesis ENS instance — you manage the base name. Use "create subname" via the API or say "what is my ENS status" to see current subnames.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                // Find genesis peer
                const genesisPeer = await ensService.findGenesisENSProvider(null);
                if (!genesisPeer) {
                  const msg = 'No ENS provider peer is online right now. Make sure the P2P network is connected and the genesis instance is running. I\'ll retry automatically on the next daily check.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                // Get label from params or default to agent name
                let label = intentResult.params?.label;
                if (!label) {
                  label = (process.env.AGENT_NAME || 'agent').toLowerCase().replace(/[^a-z0-9-]/g, '');
                }

                // Get wallet address
                const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
                const signer = await contractService.getSigner('ethereum');
                const ownerAddress = await signer.getAddress();

                // Get P2P service and send request
                const p2pService = this.services?.get('p2pFederation') || this.services?.get('p2p');
                if (!p2pService) {
                  const msg = 'P2P network is not connected. Enable P2P in settings and try again.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                await ensService.requestSubnameFromGenesis(p2pService, genesisPeer.fingerprint, label, ownerAddress);

                const msg = `ENS subname **${label}** requested from genesis peer \`${genesisPeer.fingerprint.slice(0, 8)}...\`\n\nThe genesis instance will process this shortly. If the name is taken, I'll automatically try **${label}-${(await import('../services/p2p/cryptoManager.js')).cryptoManager.getPublicKeys()?.fingerprint?.slice(0, 8) || 'fallback'}** as a backup. Check back with "what is my ENS status" in a minute.`;
                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('ENS subname request failed:', error);
                const errMsg = `Failed to request ENS subname: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= EMAIL LEASING =======
            case 'emailLeaseRequest': {
              try {
                const emailLeaseService = (await import('../services/email/emailLeaseService.js')).default;
                if (!emailLeaseService.initialized) await emailLeaseService.initialize();

                // Already have a leased email?
                const { SystemSettings } = await import('../models/SystemSettings.js');
                const existingLease = await SystemSettings.getSetting('email.myLease', null);
                if (existingLease && existingLease.status === 'active') {
                  const expiry = existingLease.expiresAt ? new Date(existingLease.expiresAt).toLocaleDateString() : 'unknown';
                  const msg = `You already have a leased email: **${existingLease.email}**\n\n` +
                    `Expires: ${expiry}\n` +
                    `IMAP: ${existingLease.imap?.host || 'mail.lanagent.net'}:993 (TLS)\n` +
                    `SMTP: ${existingLease.smtp?.host || 'mail.lanagent.net'}:587 (STARTTLS)\n\n` +
                    `To renew, say "renew my email lease".`;
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                // Check if this is the genesis instance
                if (emailLeaseService.isGenesisEmailProvider()) {
                  const msg = 'This is the genesis email provider instance — you manage the mail server. Other agents lease emails from you via the P2P network.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                // Find genesis peer with email_provider capability
                const provider = await emailLeaseService.findEmailProvider();
                if (!provider) {
                  const msg = 'No email provider peer is online right now. Make sure the P2P network is connected and the genesis instance is running.\n\n' +
                    '**To get a @lanagent.net email, you need:**\n' +
                    '1. A connected P2P peer that provides email leasing\n' +
                    '2. SKYNET tokens on BSC (BNB Chain) for the lease fee\n' +
                    `3. SKYNET token address: \`0x8Ef0ecE5687417a8037F787b39417eB16972b04F\`\n` +
                    '4. Buy SKYNET on PancakeSwap or receive from staking rewards\n\n' +
                    'Retry when the genesis peer is online.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                // Get desired username from params or default to agent name
                let desiredUsername = intentResult.params?.username || intentResult.params?.label;
                if (!desiredUsername) {
                  desiredUsername = (process.env.AGENT_NAME || 'agent').toLowerCase().replace(/[^a-z0-9.-]/g, '');
                }

                // Get wallet address for payment identity
                let wallet = null;
                try {
                  const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
                  const signer = await contractService.getSigner('bsc');
                  wallet = await signer.getAddress();
                } catch {}

                // Send P2P lease request
                const p2pService = this.services?.get('p2pFederation') || this.services?.get('p2p');
                if (!p2pService) {
                  const msg = 'P2P network is not connected. Enable P2P in settings and try again.';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                await emailLeaseService.requestLease(p2pService, provider.fingerprint, desiredUsername, wallet);

                const price = await emailLeaseService.getLeasePrice();
                const msg = `Email lease requested: **${desiredUsername}@lanagent.net** from peer \`${provider.fingerprint.slice(0, 8)}...\`\n\n` +
                  `The genesis instance will process this shortly.\n` +
                  (price > 0 ? `**Cost:** ${price} SKYNET tokens (BSC)\n` +
                    `**SKYNET token:** \`0x8Ef0ecE5687417a8037F787b39417eB16972b04F\`\n` +
                    `If you don't have enough SKYNET, the request will be saved and retried when your balance is sufficient.\n\n` +
                    `**How to get SKYNET:**\n` +
                    `• Stake in the SkynetDiamond contract to earn rewards\n` +
                    `• Buy on PancakeSwap (BSC)\n` +
                    `• Earn from scammer registry reporting bounties\n` : '') +
                  `Check back with "check my email lease" in a minute.`;
                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Email lease request failed:', error);
                const errMsg = `Failed to request email lease: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'emailLeaseStatus': {
              try {
                const { SystemSettings } = await import('../models/SystemSettings.js');
                const lease = await SystemSettings.getSetting('email.myLease', null);

                if (!lease) {
                  const msg = 'You don\'t have a leased email yet. Say "get me an email address" to request one from the genesis peer.\n\n' +
                    '**Requirements:**\n' +
                    '• Active P2P connection to the genesis instance\n' +
                    '• SKYNET tokens on BSC for the lease fee\n' +
                    `• SKYNET token: \`0x8Ef0ecE5687417a8037F787b39417eB16972b04F\`\n` +
                    `• SkynetDiamond (staking): \`0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7\``;
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                const expiry = lease.expiresAt ? new Date(lease.expiresAt) : null;
                const daysLeft = expiry ? Math.ceil((expiry - Date.now()) / (1000 * 60 * 60 * 24)) : 'unknown';
                const status = lease.status || 'unknown';

                let msg = `**Email Lease Status**\n\n`;
                msg += `📧 **Email:** ${lease.email}\n`;
                msg += `📌 **Status:** ${status}\n`;
                msg += `📅 **Expires:** ${expiry ? expiry.toLocaleDateString() : 'unknown'} (${daysLeft} days)\n`;
                msg += `💾 **Quota:** ${lease.quotaMB || 500} MB\n`;
                if (lease.imap) msg += `📥 **IMAP:** ${lease.imap.host}:${lease.imap.port}\n`;
                if (lease.smtp) msg += `📤 **SMTP:** ${lease.smtp.host}:${lease.smtp.port}\n`;

                if (daysLeft !== 'unknown' && daysLeft < 30) {
                  msg += `\n⚠️ Lease expires soon! Say "renew my email lease" to extend.`;
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Email lease status failed:', error);
                const errMsg = `Failed to check email lease: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= SCAMMER REGISTRY =======
            case 'scammerReport': {
              try {
                const scammerService = (await import('../services/crypto/scammerRegistryService.js')).default;
                await scammerService.initialize();

                if (!scammerService.isAvailable()) {
                  const errMsg = 'Scammer registry is not configured.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                const sp = intentResult.parameters || intentResult.params || {};
                // Fallback: extract params from input if vector detector didn't provide them
                const addrMatch = input.match(/\b(0x[a-fA-F0-9]{40})\b/);
                const address = sp.address || (addrMatch ? addrMatch[1] : null);
                if (!address) {
                  const msg = 'Please provide the scammer address. Example: "report 0x1234...abcd as scammer - address poisoning"';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                const categoryMap = { 'poison': 1, 'phish': 2, 'honeypot': 3, 'rug': 4, 'fake': 5, 'dust': 6 };
                let category = sp.category || 7;
                if (category === 7) {
                  const lower = input.toLowerCase();
                  for (const [kw, cat] of Object.entries(categoryMap)) {
                    if (lower.includes(kw)) { category = cat; break; }
                  }
                }
                const txMatches = input.match(/\b(0x[a-fA-F0-9]{64})\b/);
                const evidence = sp.evidenceTxHash || (txMatches ? txMatches[1] : null);
                const reasonMatch = input.match(/(?:reason:|because|for)\s+["']?([^"'\n]{1,31})/i);
                const reason = sp.reason || (reasonMatch ? reasonMatch[1].trim() : null) || scammerService.getCategoryName(category);

                const result = await scammerService.reportScammer(address, category, evidence, reason);
                let msg = `**Scammer Reported**\n\n`;
                msg += `Address: \`${address}\`\n`;
                msg += `Category: ${result.categoryName}\n`;
                msg += `Tx: \`${result.txHash}\`\n`;
                msg += `\nSCAMMER soulbound token minted to target. SENTINEL token minted to you.`;

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Scammer report failed:', error);
                const errMsg = `Failed to report scammer: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'scammerCheck': {
              try {
                const scammerService = (await import('../services/crypto/scammerRegistryService.js')).default;
                await scammerService.initialize();

                if (!scammerService.isAvailable()) {
                  const errMsg = 'Scammer registry is not configured.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                const sp2 = intentResult.parameters || intentResult.params || {};
                const addrMatch2 = input.match(/\b(0x[a-fA-F0-9]{40})\b/);
                const address = sp2.address || (addrMatch2 ? addrMatch2[1] : null);
                if (!address) {
                  const msg = 'Please provide the address to check. Example: "is 0x1234...abcd a scammer?"';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                const flagged = await scammerService.isScammer(address);
                let msg;
                if (flagged) {
                  const report = await scammerService.getReport(address);
                  msg = `**FLAGGED as scammer**\n\n`;
                  msg += `Address: \`${address}\`\n`;
                  msg += `Category: ${report.categoryName}\n`;
                  msg += `Reason: ${report.reason || 'N/A'}\n`;
                  msg += `Reported by: \`${report.reporter}\`\n`;
                  msg += `Date: ${report.date}\n`;
                  if (report.evidenceTxHash) msg += `Evidence: \`${report.evidenceTxHash}\`\n`;
                } else {
                  const immune = await scammerService.checkImmunity(address);
                  msg = `**Not flagged** in scammer registry.\n`;
                  msg += `Address: \`${address}\`\n`;
                  if (immune) msg += `This address has immunity (2/3 on-chain trust factors).`;
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Scammer check failed:', error);
                const errMsg = `Failed to check address: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'scammerList': {
              try {
                const scammerService = (await import('../services/crypto/scammerRegistryService.js')).default;
                await scammerService.initialize();

                if (!scammerService.isAvailable()) {
                  const errMsg = 'Scammer registry is not configured.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                const stats = await scammerService.getStats();
                let msg = `**Scammer Registry Stats**\n\n`;
                msg += `Flagged addresses: ${stats.scammerCount}\n`;
                msg += `Report fee: ${Number(stats.reportFee).toLocaleString()} SKYNET\n`;
                msg += `Immunity threshold: ${Number(stats.immunityThreshold).toLocaleString()} SKYNET\n`;
                msg += `Registry: \`${stats.registryAddress}\`\n`;

                if (stats.scammerCount > 0) {
                  const list = await scammerService.listScammers(10);
                  msg += `\n**Flagged Addresses** (showing ${list.addresses.length} of ${list.total}):\n`;
                  for (const addr of list.addresses) {
                    msg += `• \`${addr}\`\n`;
                  }
                }

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Scammer list failed:', error);
                const errMsg = `Failed to get registry info: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            case 'scammerRemove': {
              try {
                const scammerService = (await import('../services/crypto/scammerRegistryService.js')).default;
                await scammerService.initialize();

                if (!scammerService.isAvailable()) {
                  const errMsg = 'Scammer registry is not configured.';
                  await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                  return { type: 'text', content: errMsg };
                }

                const sp3 = intentResult.parameters || intentResult.params || {};
                const addrMatch3 = input.match(/\b(0x[a-fA-F0-9]{40})\b/);
                const address = sp3.address || (addrMatch3 ? addrMatch3[1] : null);
                if (!address) {
                  const msg = 'Please provide the address to remove. Example: "remove 0x1234...abcd from scammer registry"';
                  await this.memoryManager.storeConversation(context.userId, input, msg, context);
                  return { type: 'text', content: msg };
                }

                const result = await scammerService.removeScammer(address);
                const msg = `**Scammer flag removed**\n\nAddress: \`${address}\`\nTx: \`${result.txHash}\`\n\nSCAMMER and SENTINEL tokens burned.`;

                await this.memoryManager.storeConversation(context.userId, input, msg, context);
                return { type: 'text', content: msg };
              } catch (error) {
                logger.error('Scammer removal failed:', error);
                const errMsg = `Failed to remove scammer: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errMsg, context);
                return { type: 'text', content: errMsg };
              }
            }

            // ======= MEDIA GENERATION =======
            case 'generateImage': {
              try {
                const imageService = (await import('../services/media/imageGenerationService.js')).default;
                await imageService.initialize(this.providerManager);

                // Extract the actual image prompt from the user's input
                const imagePrompt = this.extractMediaPrompt(input, 'image');
                const imageResult = await imageService.generate(imagePrompt);

                if (imageResult.success && imageResult.images?.length > 0) {
                  const os = await import('os');
                  const fs = await import('fs/promises');
                  const path = await import('path');

                  const tmpPath = path.default.join(os.default.tmpdir(), `lanagent_img_${Date.now()}.png`);
                  await fs.default.writeFile(tmpPath, imageResult.images[0].buffer);

                  const caption = `Generated: ${imagePrompt.substring(0, 100)}${imagePrompt.length > 100 ? '...' : ''}`;
                  await this.memoryManager.storeConversation(context.userId, input, caption, context);

                  return {
                    type: 'photo',
                    path: tmpPath,
                    caption,
                    cleanup: true
                  };
                } else {
                  throw new Error('No image was generated');
                }
              } catch (error) {
                logger.error('Image generation failed:', error);
                const errorMsg = `Failed to generate image: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errorMsg, context);
                return { type: 'text', content: errorMsg };
              }
            }

            case 'generateVideo': {
              try {
                const videoService = (await import('../services/media/videoGenerationService.js')).default;
                await videoService.initialize(this.providerManager);

                // Extract the actual video prompt from the user's input
                const videoPrompt = this.extractMediaPrompt(input, 'video');
                const provider = videoService.getSettings()?.provider;

                // ModelsLab takes 2-5 min — run in background to avoid Telegram timeout
                if (provider === 'modelslab') {
                  const waitMsg = `Video generation started with ModelsLab (no content moderation). This takes 2-5 minutes — I'll send the video when it's ready.`;
                  await this.memoryManager.storeConversation(context.userId, input, waitMsg, context);

                  // Generate in background and deliver via Telegram
                  this.generateVideoInBackground(videoService, videoPrompt, context)
                    .catch(err => logger.error(`Background video generation error:`, err));

                  return { type: 'text', content: waitMsg };
                }

                const videoResult = await videoService.generate(videoPrompt);

                if (videoResult.success) {
                  if (videoResult.video?.buffer) {
                    // Direct result (HuggingFace)
                    const os = await import('os');
                    const fs = await import('fs/promises');
                    const path = await import('path');

                    const tmpPath = path.default.join(os.default.tmpdir(), `lanagent_vid_${Date.now()}.mp4`);
                    await fs.default.writeFile(tmpPath, videoResult.video.buffer);

                    const caption = `Generated: ${videoPrompt.substring(0, 100)}${videoPrompt.length > 100 ? '...' : ''}`;
                    await this.memoryManager.storeConversation(context.userId, input, caption, context);

                    return {
                      type: 'video',
                      path: tmpPath,
                      caption,
                      cleanup: true,
                      supports_streaming: true
                    };
                  } else if (videoResult.jobId) {
                    // Async job (OpenAI) - start background polling
                    const jobMsg = `Video generation started (Job: ${videoResult.jobId}). I'll notify you when it's ready. This may take a few minutes.`;
                    await this.memoryManager.storeConversation(context.userId, input, jobMsg, context);

                    // Start background polling (non-blocking, with catch to prevent unhandled rejection)
                    this.pollVideoJobAndNotify(videoResult.jobId, videoPrompt, context)
                      .catch(err => logger.error(`Unhandled video poll error for job ${videoResult.jobId}:`, err));

                    return { type: 'text', content: jobMsg };
                  }
                }
                throw new Error('No video was generated');
              } catch (error) {
                logger.error('Video generation failed:', error);
                const errorMsg = `Failed to generate video: ${error.message}`;
                await this.memoryManager.storeConversation(context.userId, input, errorMsg, context);
                return { type: 'text', content: errorMsg };
              }
            }
          }
        }

        // Validate plugin name before execution
        // '_fallback' is used for general/contextQuery intents that should trigger natural language handling
        const invalidPlugins = ['none', 'null', '_fallback', 'undefined_plugin'];
        if (!intentResult.plugin || invalidPlugins.includes(intentResult.plugin)) {
          logger.info('Fallback intent detected, using natural language handling:', {
            plugin: intentResult.plugin,
            intent: intentResult.intent,
            name: intentResult.metadata?.name
          });
          // Go directly to natural language handling - don't fall through to command parser
          // which can false-positive match words like "explain" as commands
          const nlResponse = await this.handleNaturalQuery(input, context);
          const nlContent = typeof nlResponse === 'string' ? nlResponse : (nlResponse.content || JSON.stringify(nlResponse));
          await this.memoryManager.storeConversation(context.userId, input, nlContent, context);
          return typeof nlResponse === 'string' ? { type: 'text', content: nlResponse } : nlResponse;
        } else {

        // Execute plugin command with logging
        try {
          // Check if we need AI parameter extraction
          let finalParams = intentResult.parameters || intentResult.params || {};

          // Preserve the fromAI flag if it exists
          if (intentResult.parameters && intentResult.parameters.fromAI) {
            finalParams.fromAI = true;
          }

          // If parameter extraction failed, return the error to the user
          // instead of executing with empty params (which causes confusing validation errors)
          const realParamKeys = Object.keys(finalParams).filter(k => k !== 'fromAI');
          if (intentResult.paramError && realParamKeys.length === 0) {
            logger.warn(`Returning paramError to user: ${intentResult.paramError}`);
            const errorContent = `⚠️ ${intentResult.paramError}`;
            await this.memoryManager.storeConversation(context.userId, input, errorContent, context);
            return { type: 'text', content: errorContent };
          }

          if (intentResult.needsParameterExtraction && this.providerManager) {
            try {
              logger.info('Using AI to extract parameters for action:', intentResult.action);
              
              // Get plugin info for context
              const plugin = this.apiManager.getPlugin(intentResult.plugin);
              const actionInfo = plugin?.commands?.find(cmd => 
                cmd.command === intentResult.action || 
                cmd.action === intentResult.action
              );
              
              // Build prompt for parameter extraction
              const extractionPrompt = `Extract the parameters from this natural language request.

User request: "${input}"

The user wants to perform the action: ${intentResult.action} (${intentResult.metadata?.description || ''})
Plugin: ${intentResult.plugin}

Expected parameters:
${actionInfo ? JSON.stringify(actionInfo.params || actionInfo.parameters, null, 2) : 'Unknown - extract based on the action type'}

Examples of this action:
${intentResult.metadata?.intentExamples ? JSON.stringify(intentResult.metadata.intentExamples) : 'None available'}

Extract the parameters as a JSON object. Be smart about understanding natural language:
- For email: extract 'to' (recipient name/email), 'subject', and 'text' (body)
- For device control: extract the FULL 'device' name (e.g. "master toilet light" not just "light"), 'state', color, brightness, or other parameters
- Device names often include room/location (e.g. "living room light", "bedroom fan", "kitchen light 1/4")
- Color commands: extract color names (red, green, blue, etc.) as 'color' parameter
- For video/audio downloads: extract 'url' (the full URL including https://), and 'format' if specified (mp3, mp4, etc.)
- For video/audio search: extract 'query' (the song name, artist, or search terms — strip command words like "find me", "search for")
- Look for the complete device name before any action words or parameters
- Use the full context to understand what the user means
- For schedule management: extract 'operation' (create/update/delete/list), 'device' (full name), 'time' (HH:MM 24hr format), 'deviceAction' (on/off/color/brightness/scene), 'value' (color name or brightness level), 'repeat' (daily/weekdays/weekends/once)
- Convert time expressions: "7 PM" = "19:00", "midnight" = "00:00", "noon" = "12:00", "6:30 AM" = "06:30"
- For "instead of X use Y" or "change to Y", the operation is "update"
- For *arr plugins (radarr/sonarr/lidarr/readarr/prowlarr): extract 'name' (movie/show/artist/author/book title), 'query' (search terms). Strip the plugin name and action words, keep only the content name. E.g. "add Andy Weir to readarr" → {"name": "Andy Weir"}, "search sonarr for Breaking Bad" → {"query": "Breaking Bad"}

Return ONLY a valid JSON object with the extracted parameters, nothing else.`;

              const aiResponse = await this.providerManager.generateResponse(extractionPrompt, {
                temperature: 0.3,
                maxTokens: 200
              });
              
              // Parse the AI response
              const cleanedResponse = aiResponse.content.trim()
                .replace(/^```json\s*/, '')
                .replace(/\s*```$/, '')
                .replace(/^```\s*/, '');
                
              const aiParams = JSON.parse(cleanedResponse);
              logger.info('AI extracted parameters:', aiParams);

              // Merge AI params with any pre-set params (e.g. from vector detector)
              // Pre-set params take priority for fields they already have
              finalParams = { ...aiParams, ...finalParams, ...aiParams };
              // But keep pre-set values for key fields that AI might have gotten wrong
              const presetParams = intentResult.parameters || {};
              for (const key of Object.keys(presetParams)) {
                if (presetParams[key] && key !== 'fromAI') {
                  finalParams[key] = presetParams[key];
                }
              }

              // Always ensure fromAI is set for AI-detected intents
              finalParams.fromAI = true;
              
            } catch (error) {
              logger.warn('AI parameter extraction failed:', error.message);
              // Fall back to any parameters we might have
            }
          }
          
          // Ensure fromAI is set for all AI-detected intents
          finalParams.fromAI = true;

          // Guard: if after all extraction attempts we still only have fromAI,
          // the plugin will get no real params and likely fail with validation errors.
          // For plugins that require params, return a friendly prompt instead.
          const realParamKeysPostExtract = Object.keys(finalParams).filter(k => k !== 'fromAI');
          if (realParamKeysPostExtract.length === 0 && intentResult.plugin) {
            const pluginRequiresParams = ['tasks', 'websearch'].includes(intentResult.plugin);
            if (pluginRequiresParams) {
              logger.warn(`No real parameters extracted for ${intentResult.plugin}.${intentResult.action}, asking user to clarify`);
              const clarifyMsg = `I understood you want to use **${intentResult.action}**, but I couldn't extract the required details from your message. Could you rephrase with more specifics?`;
              await this.memoryManager.storeConversation(context.userId, input, clarifyMsg, context);
              return { type: 'text', content: clarifyMsg };
            }
          }

          // Attach context (file, original input) for plugins
          if (!finalParams._context) finalParams._context = {};
          finalParams._context.originalInput = input;
          if (context.attachedFile) {
            finalParams._context.attachedFile = context.attachedFile;
          }

          // Log what we're about to execute for debugging
          logger.info('Executing plugin from intent:', {
            plugin: intentResult.plugin,
            action: intentResult.action,
            actionType: typeof intentResult.action,
            params: finalParams,
            paramsKeys: Object.keys(finalParams)
          });
          
          // Special handling for git.createIssue - pass original input as message for natural language processing
          if (intentResult.plugin === 'git' && intentResult.action === 'createIssue') {
            // If we don't have both title and body, use natural language processing
            if (!finalParams.title || !finalParams.body) {
              finalParams = {
                ...finalParams,
                message: input // Pass original input for natural language processing
              };
              logger.info('Using natural language processing for git.createIssue');
            }
          }

          // Special handling for email - if it's a send action and has a prompt-like text, use sendWithAI
          let finalAction = intentResult.action;
          if (intentResult.plugin === 'email' && intentResult.action === 'send') {
            // Check if the text looks like a prompt for AI generation
            const text = finalParams.text || '';
            const looksLikePrompt = text.length < 100 && !text.includes('\n\n') && 
              (text.includes('about') || text.includes('regarding') || text.includes('that') || 
               text.includes('saying') || text.includes('telling') || text.includes('explaining'));
            
            if (looksLikePrompt || finalParams.useAI) {
              // Convert to sendWithAI format
              finalAction = 'sendWithAI';
              finalParams = {
                to: finalParams.to,
                prompt: finalParams.text || input,
                subject: finalParams.subject,
                context: `User's original request: ${input}`
              };
              logger.info('Converting email send to sendWithAI for better content generation');
            }
          }
          
          const result = await this.executePluginWithLogging(
            intentResult.plugin,
            finalAction,
            finalParams,
            context
          );
          
          let response;
          // Debug: log what we got from the plugin
          logger.info(`Plugin result keys: ${Object.keys(result || {}).join(', ')}, hasFile: ${!!result?.file}, filePath: ${result?.file?.path || 'none'}`);

          // Format response based on action type
          if (typeof result === 'string') {
            response = { type: 'text', content: result };
          } else if (result.success && result.file && result.file.path) {
            // Handle files already on disk (e.g., from ytdlp downloads) - check BEFORE generic text handler
            const path = await import('path');
            const filePath = result.file.path;
            const filename = result.file.filename || path.basename(filePath);
            const ext = path.extname(filename).toLowerCase().slice(1);

            // Determine type based on extension
            const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
            const videoExts = ['mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv'];
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

            let type = 'document';
            if (audioExts.includes(ext)) {
              type = 'audio';
            } else if (videoExts.includes(ext)) {
              type = 'video';
            } else if (imageExts.includes(ext)) {
              type = 'photo';
            }

            response = {
              type: type,
              path: filePath,
              caption: result.result || `📁 ${filename}`,
              filename: filename
            };

            logger.info(`Returning downloaded file: ${filePath} as ${type}`);
          } else if (result.success && result.result) {
            // For successful plugin results, return the actual result content
            response = {
              type: 'text',
              content: result.result
            };
            // Propagate session mode flags (e.g., journal mode enter/exit)
            if (result.enterMode) {
              response.metadata = { enterJournalMode: true, journalId: result.journalId };
            }
            if (result.exitMode) {
              response.metadata = { ...(response.metadata || {}), exitJournalMode: true };
            }
            if (result.metadata) {
              response.metadata = { ...(response.metadata || {}), ...result.metadata };
            }
          } else if (result.needsConfirmation) {
            // Handle confirmation requests (like email recipient confirmation)
            if (result.type === 'email_recipient_confirmation') {
              response = {
                type: 'confirmation',
                content: `⚠️ **Email Recipient Confirmation**\n\n` +
                        `I found "${result.matchedContact.name}" (${result.matchedContact.email}) ` +
                        `with ${result.confidence}% confidence.\n\n` +
                        `**Subject:** ${result.emailData?.subject || 'No subject'}\n` +
                        `**Preview:** ${result.emailData?.preview || '...'}\n\n` +
                        `Is this the correct recipient? Reply "yes" to send or "no" to cancel.`,
                data: result
              };
            } else if (result.type === 'did_you_mean') {
              let content = `❓ **Did you mean one of these contacts?**\n\n`;
              result.suggestions.forEach((s, i) => {
                content += `${i + 1}. **${s.name}** <${s.email}> (${s.confidence}% match)\n`;
              });
              content += `\nPlease specify the full name or email address.`;
              response = { type: 'text', content };
            } else {
              response = { type: 'text', content: result.message || 'Confirmation required' };
            }
          } else if (result.success) {
            // Handle various media results from plugins
            if (result.pdf && result.format === 'buffer') {
              // Handle PDF results
              const fs = await import('fs').then(m => m.promises);
              const path = await import('path');
              const os = await import('os');
              const tmpDir = os.tmpdir();
              const filename = result.filename || `document_${Date.now()}.pdf`;
              const filePath = path.join(tmpDir, filename);
              
              await fs.writeFile(filePath, result.pdf);
              
              response = {
                type: 'document',
                path: filePath,
                caption: `📄 PDF generated from: ${result.url}`,
                cleanup: true // Flag to delete after sending
              };
              
              // Clean up temp file after 1 minute
              setTimeout(() => fs.unlink(filePath).catch(() => {}), 60000);
            }
            // Handle image/photo results
            else if ((result.image || result.photo) && result.format === 'buffer') {
              const fs = await import('fs').then(m => m.promises);
              const path = await import('path');
              const os = await import('os');
              const tmpDir = os.tmpdir();
              const ext = result.mimetype?.split('/')[1] || 'jpg';
              const filename = result.filename || `image_${Date.now()}.${ext}`;
              const filePath = path.join(tmpDir, filename);
              
              await fs.writeFile(filePath, result.image || result.photo);
              
              response = {
                type: 'photo',
                path: filePath,
                caption: result.caption || '',
                cleanup: true
              };
              
              setTimeout(() => fs.unlink(filePath).catch(() => {}), 60000);
            }
            // Handle video results
            else if (result.video && result.format === 'buffer') {
              const fs = await import('fs').then(m => m.promises);
              const path = await import('path');
              const os = await import('os');
              const tmpDir = os.tmpdir();
              const ext = result.mimetype?.split('/')[1] || 'mp4';
              const filename = result.filename || `video_${Date.now()}.${ext}`;
              const filePath = path.join(tmpDir, filename);
              
              await fs.writeFile(filePath, result.video);
              
              response = {
                type: 'video',
                path: filePath,
                caption: result.caption || '',
                duration: result.duration,
                width: result.width,
                height: result.height,
                supports_streaming: true,
                cleanup: true
              };
              
              setTimeout(() => fs.unlink(filePath).catch(() => {}), 60000);
            }
            // Handle animation/GIF results
            else if ((result.animation || result.gif) && result.format === 'buffer') {
              const fs = await import('fs').then(m => m.promises);
              const path = await import('path');
              const os = await import('os');
              const tmpDir = os.tmpdir();
              const filename = result.filename || `animation_${Date.now()}.gif`;
              const filePath = path.join(tmpDir, filename);
              
              await fs.writeFile(filePath, result.animation || result.gif);
              
              response = {
                type: 'animation',
                path: filePath,
                caption: result.caption || '',
                cleanup: true
              };
              
              setTimeout(() => fs.unlink(filePath).catch(() => {}), 60000);
            }
            // Handle audio results
            else if (result.audio && result.format === 'buffer') {
              const fs = await import('fs').then(m => m.promises);
              const path = await import('path');
              const os = await import('os');
              const tmpDir = os.tmpdir();
              const ext = result.mimetype?.split('/')[1] || 'mp3';
              const filename = result.filename || `audio_${Date.now()}.${ext}`;
              const filePath = path.join(tmpDir, filename);
              
              await fs.writeFile(filePath, result.audio);
              
              response = {
                type: 'audio',
                path: filePath,
                caption: result.caption || '',
                duration: result.duration,
                performer: result.performer,
                title: result.title,
                cleanup: true
              };
              
              setTimeout(() => fs.unlink(filePath).catch(() => {}), 60000);
            }
            // Handle general file results
            else if (result.file && result.format === 'buffer') {
              const fs = await import('fs').then(m => m.promises);
              const path = await import('path');
              const os = await import('os');
              const tmpDir = os.tmpdir();
              const filename = result.filename || `file_${Date.now()}.bin`;
              const filePath = path.join(tmpDir, filename);
              
              await fs.writeFile(filePath, result.file);
              
              response = {
                type: 'document',
                path: filePath,
                caption: result.caption || '',
                filename: filename,
                cleanup: true
              };
              
              setTimeout(() => fs.unlink(filePath).catch(() => {}), 60000);
            }
            // Handle files already on disk (e.g., from ytdlp downloads)
            logger.info(`Checking for file result: hasFile=${!!result.file}, hasPath=${!!(result.file && result.file.path)}`);
            if (result.file && result.file.path) {
              const path = await import('path');
              const filePath = result.file.path;
              const filename = result.file.filename || path.basename(filePath);
              const ext = path.extname(filename).toLowerCase().slice(1);

              // Determine type based on extension
              const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
              const videoExts = ['mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv'];
              const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

              let type = 'document';
              if (audioExts.includes(ext)) {
                type = 'audio';
              } else if (videoExts.includes(ext)) {
                type = 'video';
              } else if (imageExts.includes(ext)) {
                type = 'photo';
              }

              response = {
                type: type,
                path: filePath,
                caption: result.result || `📁 ${filename}`,
                filename: filename
              };

              logger.info(`Returning downloaded file: ${filePath} as ${type}`);
            }
            // Handle location results
            else if (result.location && result.location.latitude && result.location.longitude) {
              response = {
                type: 'location',
                latitude: result.location.latitude,
                longitude: result.location.longitude
              };
            }
            // Handle media group (multiple photos/videos)
            else if (result.mediaGroup && Array.isArray(result.mediaGroup)) {
              response = {
                type: 'media_group',
                media: result.mediaGroup
              };
            }
            // Handle specific action formatting
            else if (intentResult.action === 'listContacts' && result.contacts) {
              // Format contact list response
              let content = '';
              if (result.count === 0) {
                content = '📋 No contacts found';
              } else {
                // Limit display to prevent message size issues
                const maxDisplay = 20;
                const displayCount = Math.min(result.contacts.length, maxDisplay);
                const hasMore = result.contacts.length > maxDisplay;
                
                content = `📋 Contacts (${result.count} total${hasMore ? `, showing first ${displayCount}` : ''}):\n\n`;
                
                result.contacts.slice(0, maxDisplay).forEach((contact, index) => {
                  // Handle undefined contact data with fallbacks
                  const name = contact.name || 'Unknown Name';
                  const email = contact.email || 'unknown@email.com';
                  
                  content += `${index + 1}. **${name}** <${email}>\n`;
                  if (contact.aliases && contact.aliases.length > 0) {
                    content += `   Aliases: ${contact.aliases.join(', ')}\n`;
                  }
                  if (contact.phone) {
                    content += `   Phone: ${contact.phone}\n`;
                  }
                  if (contact.telegram) {
                    content += `   Telegram: ${contact.telegram}\n`;
                  }
                  if (contact.relationship && contact.relationship !== 'contact') {
                    content += `   Relationship: ${contact.relationship}\n`;
                  }
                  if (contact.lastContact) {
                    content += `   Last contact: ${new Date(contact.lastContact).toLocaleDateString()}\n`;
                  }
                  content += '\n';
                });
                
                if (hasMore) {
                  content += `... and ${result.contacts.length - maxDisplay} more contacts.\n`;
                  content += `Use "show contacts filter <name>" to search for specific contacts.`;
                }
                
                // Check if Master contact needs completion
                const masterContact = result.contacts.find(c => c.needsCompletion && c.relationship === 'master');
                if (masterContact) {
                  content += `\n⚠️ **Master contact needs your name**: Please tell me your full name to complete your contact information.\n`;
                  content += `Current: **${masterContact.name}** <${masterContact.email}>\n`;
                  content += `Say something like: "My name is John Smith" to update it.`;
                }
              }
              response = { type: 'text', content };
            } else if (intentResult.action === 'addContact' && result.contact) {
              // Format add contact response
              let content = `✅ Contact ${result.message && result.message.includes('updated') ? 'updated' : 'added'}: **${result.contact.name}** <${result.contact.email}>\n`;
              if (result.contact.aliases && result.contact.aliases.length > 0) {
                content += `**Aliases:** ${result.contact.aliases.join(', ')}\n`;
              }
              if (result.contact.phone) {
                content += `**Phone:** ${result.contact.phone}\n`;
              }
              if (result.contact.telegram) {
                content += `**Telegram:** ${result.contact.telegram}\n`;
              }
              if (result.contact.socialMedia && Object.keys(result.contact.socialMedia).length > 0) {
                content += `**Social:** ${Object.entries(result.contact.socialMedia).map(([k,v]) => `${k}: ${v}`).join(', ')}\n`;
              }
              response = { type: 'text', content };
            } else if (intentResult.action === 'deleteContact' && result.success) {
              // Format delete contact response
              response = { type: 'text', content: result.message || '✅ Contact deleted successfully' };
            } else if (intentResult.action === 'getContact' && result.contact) {
              // Format single contact response
              const c = result.contact;
              let content = `📇 Contact Details:\n\n`;
              content += `**Name:** ${c.name}\n`;
              content += `**Email:** ${c.email}\n`;
              if (c.aliases && c.aliases.length > 0) {
                content += `**Aliases:** ${c.aliases.join(', ')}\n`;
              }
              if (c.phone) {
                content += `**Phone:** ${c.phone}\n`;
              }
              if (c.telegram) {
                content += `**Telegram:** ${c.telegram}\n`;
              }
              if (c.socialMedia && Object.keys(c.socialMedia).length > 0) {
                content += `**Social:** ${Object.entries(c.socialMedia).map(([k,v]) => `${k}: ${v}`).join(', ')}\n`;
              }
              if (c.relationship && c.relationship !== 'contact') {
                content += `**Relationship:** ${c.relationship}\n`;
              }
              if (c.firstContact) {
                content += `**First contact:** ${new Date(c.firstContact).toLocaleDateString()}\n`;
              }
              if (c.lastContact) {
                content += `**Last contact:** ${new Date(c.lastContact).toLocaleDateString()}\n`;
              }
              response = { type: 'text', content };
            } else if (intentResult.plugin === 'deviceInfo' && result.message) {
              // Format deviceInfo response
              response = { 
                type: 'text', 
                content: result.message 
              };
            } else {
              // Default success message with result content
              let content = `✅ ${intentResult.action} completed successfully!`;
              
              // If there's additional result data, include it
              if (result && typeof result === 'object') {
                // Check for common result patterns
                if (result.message) {
                  content = result.message;
                } else if (result.data) {
                  content = typeof result.data === 'string' 
                    ? result.data 
                    : safeJsonStringify(result.data, 2);
                } else if (result.output) {
                  content = result.output;
                } else if (result.text) {
                  content = result.text;
                } else if (result.content) {
                  content = result.content;
                } else if (Object.keys(result).length > 0) {
                  // If result has other properties, show them
                  const relevantKeys = Object.keys(result).filter(k => 
                    !['success', 'error', 'status', 'format', 'type'].includes(k)
                  );
                  if (relevantKeys.length > 0) {
                    content = safeJsonStringify(
                      relevantKeys.reduce((obj, key) => {
                        obj[key] = result[key];
                        return obj;
                      }, {}), 
                      null, 
                      2
                    );
                  }
                }
              }
              
              response = { 
                type: 'text', 
                content: content
              };
            }
          } else {
            // Handle failed operations with better messages
            if (result.message) {
              // Use the message provided by the plugin
              let content = result.message;
              
              // Handle suggestions for findContact
              if (result.suggestions && result.suggestions.length > 0) {
                content += '\n\n';
                result.suggestions.forEach((s, i) => {
                  content += `${i + 1}. **${s.name}** <${s.email}> (${s.confidence}% match)\n`;
                });
              }
              
              response = { type: 'text', content };
            } else {
              response = { type: 'text', content: result.error || 'Operation failed' };
            }
          }
          
          // Store in conversation memory with full result content
          let memoryContent = response.content;
          if (!memoryContent) {
            switch(response.type) {
              case 'document':
                memoryContent = response.caption || 'Document sent';
                break;
              case 'photo':
                memoryContent = response.caption || 'Photo sent';
                break;
              case 'video':
                memoryContent = response.caption || 'Video sent';
                break;
              case 'animation':
                memoryContent = response.caption || 'Animation/GIF sent';
                break;
              case 'audio':
                memoryContent = response.caption || `Audio sent${response.title ? ': ' + response.title : ''}`;
                break;
              case 'voice':
                memoryContent = response.caption || 'Voice message sent';
                break;
              case 'location':
                memoryContent = `Location sent: ${response.latitude}, ${response.longitude}`;
                break;
              case 'media_group':
                memoryContent = `Media album sent (${response.media.length} items)`;
                break;
              default:
                memoryContent = safeJsonStringify(response);
            }
          }
          
          // Also store the raw plugin result as metadata for better context
          const conversationMetadata = {
            ...context,
            plugin: intentResult.plugin,
            action: intentResult.action,
            resultSummary: typeof result === 'string' ? result : safeJsonStringify(result),
            resultType: typeof result
          };
          await this.memoryManager.storeConversation(
            context.userId,
            input,
            memoryContent,
            conversationMetadata
          );
          
          // If enabled, provide AI interpretation of technical outputs
          // Skip interpretation for media responses (audio, video, photo, document, etc.) - they should be sent as-is
          const mediaTypes = ['audio', 'video', 'photo', 'document', 'animation', 'voice', 'location', 'media_group'];
          const isMediaResponse = mediaTypes.includes(response?.type);

          if (!isMediaResponse && context.aiInterpretation !== false && this.shouldInterpretOutput(intentResult.plugin, intentResult.action, result)) {
            try {
              const interpretation = await this.interpretCommandOutput(
                input,
                intentResult.plugin,
                intentResult.action,
                result,
                memoryContent
              );

              if (interpretation && interpretation !== memoryContent) {
                // Return both raw output and interpretation, preserving metadata
                const prevMetadata = response.metadata;
                response = {
                  type: 'text',
                  content: `${memoryContent}\n\n💡 **What this means:**\n${interpretation}`,
                  hasInterpretation: true
                };
                if (prevMetadata) {
                  response.metadata = prevMetadata;
                }
              }
            } catch (err) {
              logger.warn('Failed to generate AI interpretation:', err);
            }
          } else if (isMediaResponse) {
            logger.info(`Skipping AI interpretation for media response type: ${response.type}`);
          }
          
          return response;
        } catch (error) {
          logger.error(`Plugin execution error:`, error);
          // Ensure action is a string (fix for object being passed)
          const actionStr = typeof intentResult.action === 'object' 
            ? JSON.stringify(intentResult.action) 
            : String(intentResult.action || 'unknown');
            
          const errorResponse = {
            type: 'text',
            content: `❌ Error executing ${intentResult.plugin}.${actionStr}: ${error.message}`
          };
          
          await this.memoryManager.storeConversation(
            context.userId,
            input,
            errorResponse.content,
            context
          );
          
          return errorResponse;
        }
        } // End of else block for valid plugin check
      }

      // Try complex reasoning if no intent was detected and reasoning is enabled
      // This happens AFTER intent detection so known intents are handled first
      if (this.reasoningMode && this.reasoningMode !== 'disabled') {
        try {
          const needsReasoning = await this.needsComplexReasoning(input, context);

          if (needsReasoning) {
            logger.info(`Complex reasoning required for: ${input.substring(0, 50)}...`);

            if (context.showThinking) {
              await context.showThinking('🧠 Engaging reasoning mode...');
            }

            // Select reasoning agent based on mode
            let reasoningResult;
            if (this.reasoningMode === 'react' && this.reactAgent) {
              reasoningResult = await this.reactAgent.run(input, context);
            } else if (this.reasoningMode === 'plan-execute' && this.planExecuteAgent) {
              reasoningResult = await this.planExecuteAgent.run(input, context);
            } else if (this.reasoningMode === 'auto') {
              // Auto mode: use ReAct for exploratory tasks, Plan-Execute for structured tasks
              const isStructured = /\b(step|sequence|order|first|then|finally)\b/i.test(input);
              if (isStructured && this.planExecuteAgent) {
                reasoningResult = await this.planExecuteAgent.run(input, context);
              } else if (this.reactAgent) {
                reasoningResult = await this.reactAgent.run(input, context);
              }
            }

            if (reasoningResult) {
              const content = reasoningResult.success
                ? reasoningResult.answer || reasoningResult.summary || 'Task completed successfully.'
                : reasoningResult.error || 'Unable to complete the task.';

              // Store in memory
              await this.memoryManager.storeConversation(
                context.userId,
                input,
                content,
                { ...context, reasoning: true, reasoningMode: this.reasoningMode }
              );

              return {
                type: 'text',
                content,
                reasoning: true,
                success: reasoningResult.success,
                iterations: reasoningResult.iterations,
                thoughts: reasoningResult.thoughts
              };
            }
          }
        } catch (reasoningError) {
          logger.warn('Reasoning failed, falling back to command parsing:', reasoningError.message);
        }
      }

      // Fall back to command parsing if no intent detected and reasoning didn't handle it
      // Parse the command
      const parsed = this.commandParser.parse(input, context);
      
      // Store in conversation memory
      await this.memoryManager.storeConversation(
        context.userId,
        input,
        "Processing...",
        context
      );
      
      // Check if it requires approval
      if (parsed.requiresApproval) {
        return {
          type: "text",
          content: `⚠️ This action requires approval:\n\n**Action**: ${parsed.type}.${parsed.action}\n**Parameters**: ${safeJsonStringify(parsed.parameters)}\n\nDo you want to proceed?`,
          actions: [
            { id: "approve", label: "✅ Approve" },
            { id: "cancel", label: "❌ Cancel" }
          ]
        };
      }
      
      // Process based on command type
      let response;
      switch (parsed.type) {
        case "system":
          response = await this.handleSystemCommand(parsed);
          break;
        case "file":
          response = await this.handleFileCommand(parsed);
          break;
        case "network":
          response = await this.handleNetworkCommand(parsed);
          break;
        case "task":
          response = await this.handleTaskCommand(parsed);
          break;
        case "api":
          response = await this.handleAPICommand(parsed);
          break;
        case "git":
          response = await this.handleGitCommand(parsed);
          break;
        case "natural":
        default:
          response = await this.handleNaturalQuery(input, context);
          break;
      }
      
      // Store agent response - ensure we store a string, not an object
      // Handle cases where response.content itself could be an object (e.g., scraped web data)
      let responseContent;
      if (typeof response === 'string') {
        responseContent = response;
      } else if (typeof response.content === 'string') {
        responseContent = response.content;
      } else if (response.content !== undefined) {
        responseContent = JSON.stringify(response.content);
      } else {
        responseContent = JSON.stringify(response);
      }
      await this.memoryManager.storeConversation(
        context.userId,
        input,
        responseContent,
        context
      );
      
      // Update stats
      this.agentModel.stats.totalCommands++;
      await this.agentModel.save();
      
      return response;
    } catch (error) {
      logger.error("Failed to process natural language:", error);
      const errorResponse = {
        type: "text",
        content: `❌ Error: ${error.message}\n\nI've encountered an error and will remember it for debugging. You can ask me to create a bug report for this issue.`
      };
      
      // Store error in conversation memory so we can reference it later
      try {
        await this.memoryManager.storeConversation(
          context.userId,
          input,
          errorResponse.content,
          {
            ...context,
            metadata: {
              isError: true,
              errorType: error.name || 'Error',
              errorStack: error.stack,
              timestamp: Date.now()
            }
          }
        );
      } catch (memoryError) {
        logger.error("Failed to store error in memory:", memoryError);
      }
      
      return errorResponse;
    }
  }
  
  async handleNaturalQuery(query, context) {
    try {
      // Get relevant memories for context
      const memories = await this.memoryManager.recall(query, {
        userId: context.userId,
        limit: 5
      });
      
      // Get recent conversation context
      let conversationContext = '';
      try {
        const recentConversations = await this.memoryManager.getConversationContext(context.userId, 10);
        if (recentConversations && recentConversations.length > 0) {
          conversationContext = '\nRecent conversation:\n';
          for (const conv of recentConversations.reverse()) {
            const role = conv.metadata?.role || 'unknown';
            const message = conv.content.substring(0, 200);
            conversationContext += `${role}: ${message}\n`;
          }
          conversationContext += '\n';
        }
      } catch (err) {
        logger.warn('Failed to get conversation context:', err);
      }
      
      // Get user preferences
      const preferences = await this.memoryManager.getUserPreferences(context.userId);
      
      // Build context for AI
      let systemPrompt = this.getSystemPrompt();
      
      // Add memory context if available
      if (memories.length > 0) {
        systemPrompt += `\n\nRelevant context from memory:\n`;
        memories.forEach(memory => {
          systemPrompt += `- ${memory.content}\n`;
        });
        systemPrompt += "\n";
      }
      
      // Add user preferences if available
      if (Object.keys(preferences).length > 0) {
        systemPrompt += `User preferences: ${safeJsonStringify(preferences)}\n\n`;
      }
      
      // Generate response using AI
      logger.info("Generating AI response for query:", query);
      
      // Include conversation context with the query
      const contextualQuery = conversationContext ? 
        `${conversationContext}Current question: ${query}` : 
        query;
      
      let aiResponse;
      try {
        if (context.onStreamChunk) {
          aiResponse = await this.providerManager.generateStreamingResponse(
            contextualQuery,
            { systemPrompt, temperature: 0.7, maxTokens: 1000 },
            context.onStreamChunk
          );
        } else {
          aiResponse = await this.providerManager.generateResponse(contextualQuery, {
            systemPrompt,
            temperature: 0.7,
            maxTokens: 1000
          });
        }
      } catch (providerError) {
        logger.error("Failed to generate AI response:", providerError);
        return {
          type: "text",
          content: "I'm having trouble connecting to the AI service. Please check that you have a valid AI provider configured (OpenAI, Anthropic, etc.) with proper API keys in the .env file."
        };
      }
      
      logger.info("AI response received:", { 
        hasResponse: !!aiResponse, 
        responseType: typeof aiResponse,
        keys: aiResponse ? Object.keys(aiResponse) : null,
        content: aiResponse?.content ? `${aiResponse.content.substring(0, 50)}...` : 'undefined'
      });
      
      // Ensure we have a valid response
      if (!aiResponse || !aiResponse.content) {
        logger.warn("AI provider returned empty response", { aiResponse });
        return {
          type: "text",
          content: "I received an empty response from the AI provider. Please check your API keys and try again."
        };
      }
      
      return {
        type: "text",
        content: aiResponse.content
      };
    } catch (error) {
      logger.error("Failed to handle natural query:", error);
      return {
        type: "text",
        content: "I encountered an error processing your request. Please try again."
      };
    }
  }
  
  // Placeholder methods for command handling
  async handleSystemCommand(parsed) {
    try {
      let result;
      
      switch (parsed.action) {
        case "status":
          result = await this.getSystemStatus();
          return {
            type: "text",
            content: this.formatSystemStatus(result)
          };
          
        case "update":
          const updateCmd = parsed.parameters.package 
            ? `sudo apt update && sudo apt install -y ${parsed.parameters.package}`
            : "sudo apt update && sudo apt upgrade -y";
          result = await this.systemExecutor.execute(updateCmd);
          
          if (result.requiresApproval) {
            return {
              type: "approval_required",
              content: `⚠️ This command requires approval: ${updateCmd}\n\nReason: ${result.reason}`,
              command: updateCmd
            };
          }
          
          return {
            type: "text",
            content: result.success 
              ? `✅ Update completed successfully\n\`\`\`\n${result.stdout}\n\`\`\``
              : `❌ Update failed\n\`\`\`\n${result.stderr}\n\`\`\``
          };
          
        case "install":
          const installCmd = `sudo apt install -y ${parsed.parameters.package}`;
          result = await this.systemExecutor.execute(installCmd);
          
          if (result.requiresApproval) {
            return {
              type: "approval_required",
              content: `⚠️ Installation requires approval: ${parsed.parameters.package}\n\nCommand: ${installCmd}`,
              command: installCmd
            };
          }
          
          return {
            type: "text",
            content: result.success 
              ? `✅ Installed ${parsed.parameters.package} successfully`
              : `❌ Failed to install ${parsed.parameters.package}\n${result.stderr}`
          };
          
        case "reboot":
        case "shutdown":
          return {
            type: "approval_required",
            content: `⚠️ System ${parsed.action} requires explicit approval for safety.\n\nAre you sure you want to ${parsed.action} the system?`,
            command: parsed.action === "reboot" ? "sudo reboot" : "sudo shutdown -h now"
          };
          
        default:
          return {
            type: "text",
            content: `System command '${parsed.action}' recognized but not yet implemented.`
          };
      }
    } catch (error) {
      logger.error("System command error:", error);
      return {
        type: "text",
        content: `❌ Error executing system command: ${error.message}`
      };
    }
  }
  
  async handleFileCommand(parsed) {
    try {
      let result;
      
      switch (parsed.action) {
        case "list":
          const path = parsed.parameters.param2 || ".";
          result = await this.systemExecutor.execute(`ls -la ${path}`);
          
          if (result.success) {
            return {
              type: "text",
              content: `📁 Files in ${path}:\n\`\`\`\n${result.stdout}\n\`\`\``
            };
          } else {
            return {
              type: "text",
              content: `❌ Failed to list files: ${result.stderr}`
            };
          }
          
        case "search":
          const searchTerm = parsed.parameters.param1;
          result = await this.systemExecutor.execute(`find . -name "*${searchTerm}*" -type f 2>/dev/null | head -20`);
          
          if (result.stdout) {
            return {
              type: "text",
              content: `🔍 Search results for "${searchTerm}":\n\`\`\`\n${result.stdout}\n\`\`\``
            };
          } else {
            return {
              type: "text",
              content: `No files found matching "${searchTerm}"`
            };
          }
          
        case "create":
          const fileType = parsed.parameters.type;
          const filePath = parsed.parameters.path;
          
          if (fileType === "directory" || fileType === "folder") {
            result = await this.systemExecutor.execute(`mkdir -p "${filePath}"`);
          } else {
            result = await this.systemExecutor.execute(`touch "${filePath}"`);
          }
          
          return {
            type: "text",
            content: result.success 
              ? `✅ Created ${fileType}: ${filePath}`
              : `❌ Failed to create ${fileType}: ${result.stderr}`
          };
          
        case "delete":
          return {
            type: "approval_required",
            content: `⚠️ File deletion requires approval\n\nAre you sure you want to delete: ${parsed.parameters.param2}?`,
            command: `rm -rf "${parsed.parameters.param2}"`
          };
          
        default:
          return {
            type: "text",
            content: `File command '${parsed.action}' recognized but not yet implemented.`
          };
      }
    } catch (error) {
      logger.error("File command error:", error);
      return {
        type: "text",
        content: `❌ Error executing file command: ${error.message}`
      };
    }
  }
  
  async handleNetworkCommand(parsed) {
    try {
      let result;
      
      switch (parsed.action) {
        case "scan":
          result = await this.systemExecutor.execute("arp -a");
          
          if (result.success) {
            return {
              type: "text",
              content: `🌐 Network devices:\n\`\`\`\n${result.stdout}\n\`\`\``
            };
          } else {
            return {
              type: "text",
              content: `❌ Failed to scan network: ${result.stderr}`
            };
          }
          
        case "ping":
          const host = parsed.parameters.host || "8.8.8.8";
          result = await this.systemExecutor.execute(`ping -c 4 ${host}`);
          
          return {
            type: "text",
            content: result.success 
              ? `✅ Ping results for ${host}:\n\`\`\`\n${result.stdout}\n\`\`\``
              : `❌ Failed to ping ${host}: ${result.stderr}`
          };
          
        case "ports":
          const target = parsed.parameters.param1 || "localhost";
          result = await this.systemExecutor.execute(`netstat -tuln | grep LISTEN`);
          
          if (result.success) {
            return {
              type: "text",
              content: `📡 Listening ports:\n\`\`\`\n${result.stdout}\n\`\`\``
            };
          } else {
            return {
              type: "text",
              content: `❌ Failed to check ports: ${result.stderr}`
            };
          }
          
        case "connections":
          result = await this.systemExecutor.execute("ss -tunap | head -20");
          
          return {
            type: "text",
            content: result.success 
              ? `🔗 Active connections:\n\`\`\`\n${result.stdout}\n\`\`\``
              : `❌ Failed to get connections: ${result.stderr}`
          };
          
        default:
          return {
            type: "text",
            content: `Network command '${parsed.action}' recognized but not yet implemented.`
          };
      }
    } catch (error) {
      logger.error("Network command error:", error);
      return {
        type: "text",
        content: `❌ Error executing network command: ${error.message}`
      };
    }
  }
  
  async handleTaskCommand(parsed) {
    try {
      // Use the tasks API plugin with logging
      const result = await this.executePluginWithLogging(
        'tasks',
        parsed.action,
        parsed.parameters,
        parsed.context
      );

      // Format the response based on action
      let content = '';
      switch (parsed.action) {
        case 'create':
          content = `✅ Task created: "${result.task.title}"\n`;
          content += `Priority: ${result.task.priorityEmoji} ${result.task.priority}\n`;
          if (result.task.dueDate) {
            content += `Due: ${new Date(result.task.dueDate).toLocaleDateString()}\n`;
          }
          content += `ID: ${result.task.id}`;
          break;
          
        case 'list':
          if (result.count === 0) {
            content = "📋 No tasks found";
          } else {
            content = `📋 Tasks (${result.count}):\n\n`;
            result.tasks.forEach((task, index) => {
              content += `${index + 1}. ${task.completed ? '✅' : task.priorityEmoji} ${task.title}\n`;
              if (task.dueDate) {
                content += `   Due: ${task.dueDateFormatted}\n`;
              }
            });
          }
          break;
          
        case 'complete':
          content = `✅ Task completed: "${result.task.title}"`;
          break;
          
        default:
          content = safeJsonStringify(result, 2);
      }

      return { type: "text", content };
      
    } catch (error) {
      logger.error("Task command error:", error);
      return {
        type: "text",
        content: `❌ Error: ${error.message}`
      };
    }
  }
  
  async handleGitCommand(parsed) {
    try {
      const action = parsed.action;
      let result;
      
      switch (action) {
        case 'status':
          result = await this.executePluginWithLogging('git', 'status', {}, parsed.context);
          if (result.clean) {
            return { type: "text", content: "✅ Working tree clean - no changes" };
          }
          let content = `📊 Git Status (${result.branch} branch)\n\n`;
          if (result.changes.modified.length) {
            content += `📝 Modified: ${result.changes.modified.join(', ')}\n`;
          }
          if (result.changes.added.length) {
            content += `➕ Added: ${result.changes.added.join(', ')}\n`;
          }
          if (result.changes.deleted.length) {
            content += `❌ Deleted: ${result.changes.deleted.join(', ')}\n`;
          }
          if (result.changes.untracked.length) {
            content += `❓ Untracked: ${result.changes.untracked.join(', ')}\n`;
          }
          if (result.ahead) content += `\n⬆️ Ahead by ${result.ahead} commits`;
          if (result.behind) content += `\n⬇️ Behind by ${result.behind} commits`;
          return { type: "text", content };
          
        case 'add':
          const files = parsed.parameters.param0 ? [parsed.parameters.param0] : ['.'];
          result = await this.executePluginWithLogging('git', 'add', { files }, parsed.context);
          return { type: "text", content: `✅ ${result.message}` };
          
        case 'commit':
          const message = parsed.parameters.param0 || parsed.parameters.param1;
          if (!message) {
            return { type: "text", content: "❌ Commit message required" };
          }
          result = await this.executePluginWithLogging('git', 'commit', { message }, parsed.context);
          return { 
            type: "text", 
            content: `✅ Committed successfully!\nHash: ${result.commitHash}\nMessage: ${message}` 
          };
          
        case 'push':
          result = await this.executePluginWithLogging('git', 'push', {}, parsed.context);
          return { type: "text", content: "✅ Pushed to remote successfully" };
          
        case 'pull':
          result = await this.executePluginWithLogging('git', 'pull', {}, parsed.context);
          return { 
            type: "text", 
            content: result.hasConflicts 
              ? "⚠️ Pulled with conflicts - resolve before continuing"
              : "✅ Pulled latest changes successfully"
          };
          
        case 'branch':
          const subAction = parsed.parameters.param0;
          if (subAction === 'create' || subAction === 'switch' || subAction === 'checkout') {
            const branchName = parsed.parameters.param1;
            if (!branchName) {
              return { type: "text", content: "❌ Branch name required" };
            }
            result = await gitPlugin.execute({ 
              action: subAction === 'create' ? 'branch' : 'checkout',
              subAction: 'create',
              name: branchName,
              target: branchName
            });
            return { type: "text", content: `✅ ${result.message}` };
          } else {
            result = await gitPlugin.execute({ action: 'branch', subAction: 'list' });
            let content = "🌿 Git Branches:\n\n";
            result.branches.forEach(b => {
              content += `${b.current ? '➡️ ' : '  '}${b.name}${b.remote ? ' (remote)' : ''}\n`;
            });
            return { type: "text", content };
          }
          
        case 'log':
          result = await gitPlugin.execute({ action: 'log', limit: 5 });
          return { 
            type: "text", 
            content: "📜 Recent commits:\n```\n" + result.commits.join('\n') + "\n```" 
          };
          
        case 'init':
          result = await gitPlugin.execute({ action: 'init' });
          return { type: "text", content: "✅ Initialized new git repository" };
          
        case 'clone':
          const url = parsed.parameters.param1;
          if (!url) {
            return { type: "text", content: "❌ Repository URL required" };
          }
          result = await gitPlugin.execute({ action: 'clone', url });
          return { type: "text", content: `✅ Cloned repository to ${result.destination}` };
          
        default:
          return { type: "text", content: `❌ Unknown git action: ${action}` };
      }
      
    } catch (error) {
      logger.error("Git command error:", error);
      return {
        type: "text",
        content: `❌ Git Error: ${error.message}`
      };
    }
  }
  
  async handleAPICommand(parsed) {
    try {
      switch (parsed.action) {
        case 'list':
          const plugins = this.apiManager.getPluginList();
          let content = "🔌 Available API Plugins:\n\n";
          plugins.forEach(p => {
            const status = p.enabled ? '✅' : '❌';
            content += `📦 ${p.name} (v${p.version}) ${status}\n`;
            content += `   ${p.description}\n`;
            content += `   Methods: ${p.methods.map(m => m.name).join(', ')}\n\n`;
          });
          return { type: "text", content };
          
        case 'enable':
          const enableName = parsed.parameters.param0;
          const enableResult = await this.apiManager.enablePlugin(enableName);
          return {
            type: "text",
            content: `✅ ${enableResult.message}`
          };
          
        case 'disable':
          const disableName = parsed.parameters.param0;
          const disableResult = await this.apiManager.disablePlugin(disableName);
          return {
            type: "text",
            content: `✅ ${disableResult.message}`
          };
          
        case 'status':
          const statusName = parsed.parameters.param0;
          const status = this.apiManager.getPluginStatus(statusName);
          if (!status) {
            return {
              type: "text",
              content: `❌ Plugin ${statusName} not found`
            };
          }
          return {
            type: "text",
            content: `📦 Plugin: ${status.name}\n` +
                    `Status: ${status.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                    `Version: ${status.version}\n` +
                    `Calls: ${status.stats.calls}\n` +
                    `Errors: ${status.stats.errors}`
          };
          
        case 'execute':
        default:
          const { plugin, action, ...params } = parsed.parameters;
          const result = await this.apiManager.executeAPI(plugin, action || 'execute', params);
          
          // Format the response based on the plugin result structure
          if (result && typeof result === 'object') {
            if (result.success === false) {
              content = `❌ Error: ${result.error || 'Operation failed'}`;
              return {
                type: "text",
                content: content
              };
            } else if (result.pdf && result.format === 'buffer') {
              // Handle PDF buffer from scraper plugin
              const fs = await import('fs').then(m => m.promises);
              const path = await import('path');
              const tmpDir = '/tmp';
              const filename = result.filename || `website_${Date.now()}.pdf`;
              const filePath = path.join(tmpDir, filename);
              
              // Write buffer to temporary file
              await fs.writeFile(filePath, result.pdf);
              
              return {
                type: "document",
                path: filePath,
                caption: `📄 PDF generated from: ${result.url}`,
                filename: filename
              };
            } else if (result.result && typeof result.result === 'string') {
              // Plugin returned formatted text
              content = result.result;
            } else if (result.content && typeof result.content === 'string') {
              // Alternative content field
              content = result.content;
            } else if (result.message) {
              // Simple message response
              content = result.message;
            } else {
              // Fallback to JSON for complex objects
              content = `✅ API Response:\n\`\`\`json\n${safeJsonStringify(result, 2)}\n\`\`\``;
            }
          } else {
            // Non-object response
            content = `✅ Result: ${result}`;
          }
          
          return {
            type: "text",
            content: content
          };
      }
      
    } catch (error) {
      logger.error("API command error:", error);
      return {
        type: "text",
        content: `❌ API Error: ${error.message}`
      };
    }
  }
  
  // System status
  async getSystemStatus() {
    try {
      logger.info('Getting system status...');
      
      // Get real system info from executor
      const systemInfo = await this.systemExecutor.getSystemInfo();
      logger.info('System info from executor:', safeJsonStringify(systemInfo, 2));
      
      // Calculate agent uptime - use process.uptime() as fallback
      const processUptime = process.uptime() * 1000; // Convert to milliseconds
      const agentStartTime = this.startupTime || this.agentModel?.stats?.lastStartup || (Date.now() - processUptime);
      const agentUptime = this.startupTime ? (Date.now() - this.startupTime) : processUptime;
      logger.info('Agent uptime calculation:', { 
        isRunning: this.isRunning,
        startupTime: this.startupTime, 
        agentStartTime, 
        agentUptime, 
        formatted: this.formatUptime(agentUptime) 
      });
      
      return {
        agent: {
          name: this.config.name,
          version: packageVersion,
          uptime: this.formatUptime(agentUptime),
          status: "running", // Force running since we're responding to commands
          isRunning: this.isRunning,
          startupTime: this.startupTime,
          agentStartTime: agentStartTime,
          avatar: '/api/agent/avatar',
          avatarDescription: this.agentModel?.avatarDescription || null
        },
        system: {
          platform: systemInfo.platform,
          arch: systemInfo.arch,
          hostname: systemInfo.hostname,
          memory: {
            used: systemInfo.memory?.used || 0,
            total: systemInfo.memory?.total || 0,
            free: systemInfo.memory?.free || 0,
            percentage: Math.round((systemInfo.memory?.used / systemInfo.memory?.total) * 100) || 0
          },
          cpu: {
            cores: systemInfo.cpus || 0,
            loadAverage: systemInfo.loadAverage || [0, 0, 0],
            usage: Math.round(systemInfo.loadAverage?.[0] / systemInfo.cpus * 100) || 0
          },
          temperature: systemInfo.temperature !== undefined ? systemInfo.temperature : "N/A",
          disk: systemInfo.diskSpace || { total: "N/A", used: "N/A", available: "N/A", usePercent: "N/A" },
          uptime: systemInfo.uptime || "N/A"
        },
        network: { 
          status: "Connected",
          interfaces: await this.getNetworkInterfaces() 
        },
        services: { 
          running: this.interfaces.size, 
          total: 3, // Telegram, Web, SSH
          list: Array.from(this.interfaces.keys()),
          interfacesCount: this.interfaces.size,
          interfacesList: Array.from(this.interfaces.keys())
        },
        interfaces: {
          running: this.interfaces.size,
          total: this.interfaces.size,
          list: Array.from(this.interfaces.keys())
        },
        ai: {
          provider: this.providerManager.activeProvider?.name || "none",
          metrics: this.providerManager.getMetrics()
        }
      };
    } catch (error) {
      logger.error("Failed to get system status:", error);
      
      // Return basic status on error
      return {
        agent: {
          name: this.config.name,
          version: packageVersion,
          uptime: "unknown",
          status: this.isRunning ? "running" : "stopped"
        },
        system: {
          error: error.message
        },
        network: { status: "Unknown" },
        services: { running: this.services.size, total: this.services.size },
        ai: {
          provider: this.providerManager.activeProvider?.name || "none",
          metrics: {}
        }
      };
    }
  }
  
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  formatSystemStatus(status) {
    let output = `📊 System Status Report\n\n`;
    
    // Agent Info
    output += `🤖 Agent Information:\n`;
    output += `  • Name: ${status.agent.name}\n`;
    output += `  • Version: ${status.agent.version}\n`;
    output += `  • Status: ${status.agent.status}\n`;
    output += `  • Uptime: ${status.agent.uptime}\n\n`;
    
    // System Info
    output += `💻 System Information:\n`;
    output += `  • Platform: ${status.system.platform} (${status.system.arch})\n`;
    output += `  • Hostname: ${status.system.hostname}\n`;
    output += `  • System Uptime: ${status.system.uptime}\n`;
    output += `  • Temperature: ${status.system.temperature !== 'N/A' ? `${status.system.temperature}°C / ${Math.round((status.system.temperature * 9/5) + 32)}°F` : 'N/A'}\n\n`;
    
    // Resources
    output += `📊 Resources:\n`;
    output += `  • CPU: ${status.system.cpu.usage}% (${status.system.cpu.cores} cores)\n`;
    output += `  • Memory: ${status.system.memory.used}GB / ${status.system.memory.total}GB (${status.system.memory.percentage}%)\n`;
    output += `  • Disk: ${status.system.disk.used} / ${status.system.disk.total} (${status.system.disk.usePercent})\n\n`;
    
    // Services & Interfaces
    output += `🔧 Services & Interfaces:\n`;
    output += `  • Services: ${status.services.running}/${status.services.total} running\n`;
    output += `  • Interfaces: ${status.interfaces.running}/${status.interfaces.total} active\n`;
    if (status.interfaces.list.length > 0) {
      output += `    - ${status.interfaces.list.join(', ')}\n`;
    }
    output += `\n`;
    
    // AI Provider
    output += `🤖 AI Provider:\n`;
    output += `  • Active: ${status.ai.provider}\n`;
    if (status.ai.metrics && Object.keys(status.ai.metrics).length > 0) {
      output += `  • Requests: ${status.ai.metrics.totalRequests || 0}\n`;
      output += `  • Success Rate: ${status.ai.metrics.successRate || 0}%\n`;
    }
    
    return output;
  }

  async getNetworkInterfaces() {
    try {
      const result = await this.systemExecutor.execute("ip -br addr show");
      if (!result.success) return [];
      
      const interfaces = [];
      const lines = result.stdout.trim().split('\n');
      
      for (const line of lines) {
        const [name, state, ...addresses] = line.split(/\s+/);
        if (name && state) {
          interfaces.push({
            name,
            state,
            addresses: addresses.filter(addr => addr && addr !== '')
          });
        }
      }
      
      return interfaces;
    } catch (error) {
      logger.error("Failed to get network interfaces:", error);
      return [];
    }
  }
  
  // Task management methods
  async getTasks() {
    try {
      const tasksPlugin = this.apiManager.getPlugin('tasks');
      if (!tasksPlugin) {
        throw new Error('Tasks plugin not available');
      }
      
      const result = await tasksPlugin.execute({
        action: 'list',
        limit: 20
      });
      
      return result.success ? result.tasks : [];
    } catch (error) {
      logger.error('Failed to get tasks:', error);
      return [];
    }
  }
  
  async addTask(description) {
    try {
      const tasksPlugin = this.apiManager.getPlugin('tasks');
      if (!tasksPlugin) {
        throw new Error('Tasks plugin not available');
      }
      
      const result = await tasksPlugin.execute({
        action: 'create',
        title: description,
        priority: 'medium'
      });
      
      return result.success ? result.task : { title: description, id: Date.now(), error: 'Failed to create' };
    } catch (error) {
      logger.error('Failed to add task:', error);
      return { title: description, id: Date.now(), error: error.message };
    }
  }
  
  async getServices() {
    try {
      const services = [
        { name: "Agent Core", status: "running", running: this.isRunning },
        { name: "API Manager", status: "running", running: !!this.apiManager },
        { name: "Memory Manager", status: "running", running: !!this.memoryManager },
        { name: "Provider Manager", status: "running", running: !!this.providerManager },
      ];
      
      // Add plugin services
      const plugins = this.apiManager?.getLoadedPlugins() || [];
      plugins.forEach(plugin => {
        services.push({
          name: `${plugin.charAt(0).toUpperCase() + plugin.slice(1)} Plugin`,
          status: "running", 
          running: true
        });
      });
      
      // Add interface services
      this.interfaces.forEach((iface, name) => {
        services.push({
          name: `${name.charAt(0).toUpperCase() + name.slice(1)} Interface`,
          status: "running",
          running: true
        });
      });
      
      return services;
    } catch (error) {
      logger.error('Failed to get services:', error);
      return [
        { name: "Agent Core", status: "error", running: false, error: error.message }
      ];
    }
  }
  
  async transcribeVoice(fileId) {
    try {
      // Check if we have a Telegram interface to download the file
      const telegramInterface = this.interfaces.get('telegram');
      if (!telegramInterface || !telegramInterface.bot) {
        throw new Error('Telegram interface not available for file download');
      }

      // Get file info from Telegram
      logger.info(`Downloading voice file: ${fileId}`);
      const fileLink = await telegramInterface.bot.telegram.getFileLink(fileId);

      // Download the audio file
      const axios = (await import('axios')).default;
      const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer'
      });

      const audioBuffer = Buffer.from(response.data);
      logger.info(`Voice file downloaded: ${audioBuffer.length} bytes`);

      // Transcribe using the provider manager
      const transcription = await this.providerManager.transcribeAudio(audioBuffer);

      if (!transcription) {
        throw new Error('Transcription returned empty result');
      }

      logger.info(`Voice transcribed: "${transcription.substring(0, 100)}..."`);
      return transcription;

    } catch (error) {
      logger.error('Voice transcription failed:', error);
      throw new Error(`Failed to transcribe voice: ${error.message}`);
    }
  }
  
  async analyzeImage(fileId) {
    try {
      // Check if we have a Telegram interface to download the file
      const telegramInterface = this.interfaces.get('telegram');
      if (!telegramInterface || !telegramInterface.bot) {
        throw new Error('Telegram interface not available for file download');
      }

      // Get file info from Telegram
      const fileLink = await telegramInterface.bot.telegram.getFileLink(fileId);
      
      // Download the image
      const axios = (await import('axios')).default;
      const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer'
      });
      
      // Convert to base64
      const base64Image = Buffer.from(response.data).toString('base64');
      
      // Use OpenAI Vision API if available
      const openaiProvider = this.providerManager.providers.get('openai');
      if (!openaiProvider) {
        throw new Error('OpenAI provider not available for image analysis');
      }

      // Prepare the vision request
      const visionPrompt = {
        model: 'gpt-4o-mini', // or gpt-4-vision-preview
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this image in detail. Describe what you see, identify any objects, people, text, or notable features. Provide a comprehensive analysis.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                  detail: 'high'
                }
              }
            ]
          }
        ],
        max_tokens: 500
      };

      // Get analysis from AI
      const analysis = await openaiProvider.complete(visionPrompt);
      
      // Parse the response
      const description = analysis.content || 'Unable to analyze image';
      
      // Extract key elements (simple parsing)
      const labels = [];
      const commonObjects = ['person', 'car', 'building', 'animal', 'food', 'nature', 'text', 'computer', 'phone'];
      commonObjects.forEach(obj => {
        if (description.toLowerCase().includes(obj)) {
          labels.push(obj);
        }
      });

      return {
        description: description,
        labels: labels.length > 0 ? labels : ['image', 'visual-content'],
        model: 'gpt-4-vision',
        success: true
      };

    } catch (error) {
      logger.error('Image analysis error:', error);
      return {
        description: `Failed to analyze image: ${error.message}`,
        labels: ['error'],
        success: false
      };
    }
  }
  
  async processDocument(fileId, fileName) {
    // TODO: Implement document processing
    return {
      summary: `Document processing for ${fileName} is being implemented`
    };
  }
  
  async _refreshSkynetContext() {
    try {
      const SkynetBounty = (await import('../models/SkynetBounty.js')).default;
      const SkynetGovernance = (await import('../models/SkynetGovernance.js')).default;
      const [openBounties, activeProposals] = await Promise.all([
        SkynetBounty.find({ status: 'open' }).sort({ reward: -1 }).limit(5).lean(),
        SkynetGovernance.find({ status: 'active' }).sort({ createdAt: -1 }).limit(5).lean()
      ]);
      let ctx = '';
      if (openBounties.length > 0) {
        ctx += `- Current open bounties: ${openBounties.map(b => `"${b.title}" (${b.reward} SKYNET)`).join(', ')}\n`;
      }
      if (activeProposals.length > 0) {
        ctx += `- Active governance proposals: ${activeProposals.map(p => `"${p.title}" [For:${p.votesFor || 0} Against:${p.votesAgainst || 0}]`).join(', ')}\n`;
      }
      this._skynetContextCache = ctx;
    } catch { /* non-critical */ }
  }

  /**
   * Get the current system prompt (always regenerated to reflect current plugin state)
   */
  getSystemPrompt() {
    // Dynamic configuration values (no hardcoding)
    const agentEmail = process.env.AGENT_EMAIL || process.env.EMAIL_USER || process.env.IMAP_USER || 'alice@lanagent.net';
    const serverHost = getServerHost();
    const webPassword = process.env.WEB_PASSWORD || 'lanagent';
    const webPort = this.config.port || process.env.AGENT_PORT || 80;
    const sshPort = this.config.sshPort || process.env.AGENT_SSH_PORT || 2222;
    const githubRepo = process.env.GITHUB_REPO || 'https://github.com/PortableDiag/LANAgent';
    const deployPath = process.env.DEPLOY_PATH || process.cwd();

    // Build comprehensive system prompt
    let systemPrompt = `You are ${this.config.name}, an advanced AI-powered personal assistant with full root access to a Linux server. You are a specific implementation, not a generic AI.\n\n`;

    // Core Identity
    systemPrompt += `🤖 IDENTITY & SELF-AWARENESS:\n`;
    systemPrompt += `- Name: ${this.config.name} (AI-powered personal assistant)\n`;
    systemPrompt += `- System: LANAgent v${packageVersion}\n`;
    systemPrompt += `- Your Email: ${agentEmail} (YOU send emails as yourself, not on behalf of users)\n`;
    systemPrompt += `- Source Code: ${githubRepo}\n`;
    systemPrompt += `- Production Server: ${serverHost}\n`;
    systemPrompt += `- Master User: Telegram ID ${process.env.TELEGRAM_USER_ID || 'Not set'}, Email: ${process.env.EMAIL_OF_MASTER || 'Not set'}\n`;
    systemPrompt += `- Running Environment: PM2 process manager, MongoDB persistence\n`;
    systemPrompt += `- Visual Identity: You have an avatar image accessible at /api/agent/avatar\n`;
    if (this.agentModel?.avatarDescription) {
      systemPrompt += `- Appearance: ${this.agentModel.avatarDescription}\n`;
    }
    systemPrompt += `\n`;

    // Interfaces
    systemPrompt += `📡 INTERFACES (How users reach you):\n`;
    systemPrompt += `1. Telegram Bot: Full natural language interface with dashboards and menus\n`;
    systemPrompt += `2. Email: Receive commands/questions at ${agentEmail}, auto-reply enabled\n`;
    systemPrompt += `3. Web Dashboard: http://${serverHost}:${webPort} (password: ${webPassword})\n`;
    systemPrompt += `4. SSH Server: Port ${sshPort} for terminal access\n\n`;
    
    // Core Capabilities
    systemPrompt += `💪 CORE CAPABILITIES:\n`;
    systemPrompt += `- Execute ANY Linux command with root access\n`;
    systemPrompt += `- File management (create, read, edit, delete)\n`;
    systemPrompt += `- System monitoring (CPU, memory, disk, network)\n`;
    systemPrompt += `- Process management and automation\n`;
    systemPrompt += `- Background task scheduling with Agenda (schedule, every, now, cancel)\n`;
    systemPrompt += `- Persistent memory using MongoDB with semantic search\n`;
    systemPrompt += `- AI intent detection (40+ base intents + dynamic plugin intents)\n`;
    systemPrompt += `- Multi-provider AI switching (OpenAI, Anthropic, Gab, HuggingFace, XAI)\n`;
    systemPrompt += `- Media processing: Video/audio conversion, compression, editing (FFmpeg)\n`;
    systemPrompt += `- Media downloading: YouTube and 1000+ sites (yt-dlp)\n`;
    systemPrompt += `- Self-examination: Can analyze own code and suggest improvements\n`;
    systemPrompt += `- Web search and browsing capabilities with AI-powered analysis\n`;
    systemPrompt += `- Email compose/reply system with comprehensive web UI and validation\n`;
    systemPrompt += `- Task management with integrated reminders and status tracking\n`;
    systemPrompt += `- Calendar management: Create, view, update events on Google Calendar\n`;
    systemPrompt += `- Multi-step task automation with plugin chain processing\n`;
    systemPrompt += `- Comprehensive JSDoc documentation for developer experience\n\n`;
    
    // Plugin System - Dynamically generated from loaded plugins
    const plugins = this.apiManager ? this.apiManager.getPluginList() : [];
    const enabledPlugins = plugins.filter(p => p.enabled);
    
    systemPrompt += `🔌 PLUGIN SYSTEM (${enabledPlugins.length} Active Plugins):\n`;
    
    // Add each enabled plugin with its description
    enabledPlugins.forEach((plugin, index) => {
      systemPrompt += `${index + 1}. ${plugin.name}: ${plugin.description}\n`;
    });
    
    systemPrompt += `\n`;
    
    // Core Crypto Wallet Capabilities
    systemPrompt += `💰 CRYPTO WALLET CAPABILITIES (Built-in Core Features):\n`;
    systemPrompt += `- Multi-Chain Wallet Management: Support for Ethereum, Polygon, BSC, Base, and testnets\n`;
    systemPrompt += `- Wallet Operations: Generate wallets, check balances, send crypto, sign messages\n`;
    systemPrompt += `- Smart Contract Interaction: Read/write contracts, deploy new contracts, monitor events\n`;
    systemPrompt += `- DeFi Operations: Token transfers, approvals, balance checking across multiple tokens\n`;
    systemPrompt += `- Network Management: Switch between mainnet/testnet, get network information\n`;
    systemPrompt += `- Transaction Management: Gas estimation, transaction history, status monitoring\n`;
    systemPrompt += `- Development Tools: Hardhat project creation, smart contract compilation and testing\n`;
    systemPrompt += `- Testnet Support: Faucet access for test tokens across multiple networks\n`;
    systemPrompt += `- Security: HD wallet generation, secure message signing, private key management\n`;
    systemPrompt += `- Integration: Works with Chainlink oracles for real-time price feeds and market data\n\n`;
    
    // Special Features
    systemPrompt += `✨ SPECIAL FEATURES:\n`;
    systemPrompt += `- Self-Modification: Can analyze and improve own code (disabled by default)\n`;
    systemPrompt += `- Image Recognition: Can analyze images sent via Telegram\n`;
    systemPrompt += `- Web Scraping: Advanced scraper with custom user agents (chrome, firefox, mobile, bot) and VPN rotation for anti-blocking\n`;
    systemPrompt += `- Code Self-Examination: Can explain own architecture\n`;
    systemPrompt += `- Multi-User Support: Guest conversations via Telegram\n`;
    systemPrompt += `- Automatic Maintenance: Weekly reports, disk cleanup\n`;
    systemPrompt += `- Background Tasks: Email checking, task reminders, system monitoring, bug scanning\n`;
    systemPrompt += `- Network Security: Real-time network monitoring, device discovery, intrusion detection\n`;
    systemPrompt += `- VPN Management: Automatic connection management, location optimization\n`;
    systemPrompt += `- Firewall Control: Rule management, security policy enforcement\n`;
    systemPrompt += `- Bug Fixing: Automated code analysis and GitHub issue creation/fixing\n`;
    systemPrompt += `- Development Automation: Complete dev environment setup and deployment workflows\n`;
    systemPrompt += `- Code Quality: JSDoc documentation, comprehensive testing infrastructure, API validation\n`;
    systemPrompt += `- Plugin Architecture: Extensible BasePlugin class with standardized methods and validation\n`;
    systemPrompt += `- Calendar Integration: Google Calendar access via CalDAV using Gmail credentials (no OAuth needed)\n`;
    systemPrompt += `- Plugin Chain Processing: Multi-step task automation with intelligent coordination\n`;
    systemPrompt += `- Hardware Development: Arduino, ESP32, ESP8266, and Raspberry Pi Pico programming and control\n`;
    systemPrompt += `- IoT Integration: Direct hardware control, sensor monitoring, and actuator management\n\n`;

    // External Service Gateway
    systemPrompt += `🌐 UNIFIED API GATEWAY (https://api.lanagent.net):\n`;
    systemPrompt += `- You are part of the LANAgent API network at api.lanagent.net — a unified gateway for all agent services\n`;
    systemPrompt += `- Your ERC-8004 endpoint: https://api.lanagent.net/agents/2930 (Agent #2930 on BSC)\n`;
    systemPrompt += `- The gateway routes requests to the best available agent, handles payments, and manages credits\n`;
    systemPrompt += `- Clients can pay with credit card (Stripe), BNB, or SKYNET — no crypto knowledge required\n`;
    systemPrompt += `- Payment options: 1) Stripe portal at api.lanagent.net/portal 2) BNB/SKYNET wallet auth 3) Legacy X-Payment-Tx\n`;
    systemPrompt += `- Your payment wallet: the same BSC wallet that receives BNB for all services\n`;
    systemPrompt += `- 8 paid services available:\n`;
    systemPrompt += `  1. YouTube Download (MP4): 0.001 BNB — download videos\n`;
    systemPrompt += `  2. YouTube Audio (MP3): 0.0008 BNB — extract audio\n`;
    systemPrompt += `  3. Media Transcoding: 0.002 BNB — convert media formats via FFmpeg\n`;
    systemPrompt += `  4. AI Image Generation: 0.003 BNB — generate images from text prompts\n`;
    systemPrompt += `  5. Web Scraping: 0.0005 BNB — extract structured data from web pages\n`;
    systemPrompt += `  6. Document Processing: 0.001 BNB — OCR and text extraction\n`;
    systemPrompt += `  7. Code Execution Sandbox: 0.002 BNB — run Python/Node/Bash/Ruby/Go in isolated Docker containers (network-isolated, read-only, 256MB RAM, 2 CPU, 64 PID limit)\n`;
    systemPrompt += `  8. PDF Toolkit: 0.0005 BNB — merge, split, compress, watermark, extract text from PDFs\n`;
    systemPrompt += `- Admin dashboard at /api/external/admin/ shows revenue, payments, audit logs\n`;
    systemPrompt += `- Kill switch available to emergency-disable all external services\n`;
    systemPrompt += `- When asked about external service revenue/payments/usage, query the ExternalPayment and ExternalServiceConfig models\n\n`;

    // SKYNET Token & P2P Network
    systemPrompt += `🪙 SKYNET TOKEN & SKYNET P2P NETWORK:\n`;
    systemPrompt += `- Website: https://lanagent.net (main project site) | https://skynettoken.com (SKYNET token info & staking)\n`;
    systemPrompt += `- SKYNET is a BEP-20 token on Binance Smart Chain (BSC), contract: 0x8Ef02e4a3203E845CC5FA08B81e4C109ceDCb04F\n`;
    systemPrompt += `- Fixed supply: 100,000,000 SKYNET — no mint function, no tax on transfers\n`;
    systemPrompt += `- Liquidity: PancakeSwap V2 pair 0xF3dE98e4e3eB4018C498E6B0d76aF3a11F8D694A (50M SKYNET + 0.5 BNB initial)\n`;
    systemPrompt += `- Allocation ledger: LP 50M, Staking 20M, Bounty Pool 10M, Treasury 10M, Reserve 10M\n`;
    systemPrompt += `- Purpose: SKYNET powers the Skynet P2P federation network — used for service payments, bounties, governance, trust scores, tipping, data marketplace, compute rental, and more\n`;
    systemPrompt += `- Do users NEED SKYNET? No for basic features (peer discovery, federation, messaging, free services). Yes for paid P2P services, bounties, governance, premium packs, data marketplace, compute rental\n`;
    systemPrompt += `- Skynet P2P Network: decentralized federation of LANAgent instances communicating via signed encrypted messages\n`;
    systemPrompt += `- Trust Scores (0-100): calculated from 5 factors — manual trust (+30), ERC-8004 on-chain verification (+20), SKYNET balance (up to +20, log scale), longevity (up to +15), activity (up to +15)\n`;
    systemPrompt += `- ERC-8004 Peer Verification: when peers exchange capabilities, their ERC-8004 agent ID is verified on-chain against the BSC Identity Registry (0x8004...). Verified agents get +20 trust score\n`;
    systemPrompt += `- Bounty System: peers post tasks with SKYNET rewards, other agents claim and complete them. API: GET/POST /p2p/api/skynet/bounties\n`;
    systemPrompt += `- Governance: token-weighted proposals (1 SKYNET = 1 vote) — categories: protocol, economy, feature, governance. API: GET/POST /p2p/api/skynet/proposals\n`;
    systemPrompt += `- Service Catalog: each peer publishes services with SKYNET prices; on-chain BEP-20 Transfer payment verification before execution\n`;
    systemPrompt += `- Service Priority Queue: when multiple requests are queued, SKYNET-tipped requests get processed first. Free requests still execute but wait behind tipped ones. Tip amount determines queue priority\n`;
    systemPrompt += `- Data Marketplace: agents can list and sell premium curated data products (datasets, model weights, prompt libraries, configs) for SKYNET tokens. Different from free knowledge packs. API: GET/POST /p2p/api/skynet/data-listings\n`;
    systemPrompt += `- Knowledge Pack Pricing: knowledge packs can be free (community) or premium (price > 0 SKYNET). Premium packs require payment before delivery. Price shown in pack catalog\n`;
    systemPrompt += `- Arbitrage Signal Sharing: when the arb scanner finds profitable spreads, signals are auto-broadcast to P2P peers. Signals include token, spread %, buy/sell protocols, estimated profit. API: GET /p2p/api/skynet/arb-signals\n`;
    systemPrompt += `- Referral Rewards: when Agent A refers Agent B to Agent C's service, Agent A earns a SKYNET referral cut (default 5%). Tracked in SkynetReferral model. API: GET /p2p/api/skynet/referrals\n`;
    systemPrompt += `- Compute Rental: agents with idle CPU sell processing time to peers for SKYNET per-minute pricing. Supports script execution with timeout/memory limits. Configurable via compute_rental_enabled setting. API: GET /p2p/api/skynet/compute-jobs\n`;
    systemPrompt += `- SkynetDiamond Contract: 0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7 (BSC) — ERC-2535 Diamond Proxy. Unified staking + LP staking + scammer registry + commerce + oracle + coordination + trust + credentials. Lock tiers (no lock 1x, 30d 1.5x, 90d 2x, 180d 3x). Fees split 40% token staking / 50% LP staking / 10% reserve\n`;
    systemPrompt += `- Reward distribution is based on amount staked, lock tier multiplier, and time. Current reward epoch: 24 hours, auto-renewed by scheduler from staking ledger pool\n`;
    systemPrompt += `- Users can stake, unstake, claim rewards, or emergency withdraw at any time. Unstaking auto-claims pending rewards\n`;
    systemPrompt += `- To interact with staking via NLP: stakingStatus (check position), stakingStake (add to stake), stakingUnstake (remove), stakingClaim (claim rewards). Staking dashboard also available in Web UI crypto tab\n`;
    systemPrompt += `- Contract settings: configurable via Settings tab or /api/settings/skynet-staking-address\n`;
    systemPrompt += `- Concentrated Liquidity V3: supports PancakeSwap V3 NonfungiblePositionManager for concentrated LP positions with configurable tick ranges. Methods: addLiquidityV3, removeLiquidityV3, collectFeesV3, checkAndRebalanceV3\n`;
    systemPrompt += `- Token Trader: your crypto strategy can trade SKYNET via the token_trader strategy\n`;
    systemPrompt += `- Token Settings: SKYNET token address configurable via Web UI Settings or API (GET/POST /api/settings/skynet-token-address)\n`;
    systemPrompt += `- Contract Audit: SKYNET contract passed Slither automated security audit — 0 vulnerabilities, 5 informational findings (pragma version warnings)\n`;
    systemPrompt += `- When asked about SKYNET/Skynet features, use this knowledge directly. For live data, use skynetNetworkStatus (peers, services) or skynetTokenInfo (ledger, payments) or skynetEconomyLive (marketplace, arb signals, compute, referrals) or stakingStatus/stakingStake/stakingUnstake/stakingClaim actions\n`;
    systemPrompt += `- Scammer Registry: integrated into SkynetDiamond RegistryFacet (0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7). Report fees (50K SKYNET) route to staking + LP staking reward pools. Mints soulbound ERC-1155 credentials. Categories: 1=address poisoning, 2=phishing, 3=honeypot, 4=rug pull, 5=fake contract, 6=dust attack, 7=other. Auto-detection via sweep scanner queues honeypots with 90% confidence for batch reporting.\n`;
    systemPrompt += `- To interact with scammer registry via NLP: scammerReport (flag address), scammerCheck (lookup address), scammerList (stats/list), scammerRemove (admin unflag). API: /api/scammer-registry/*\n`;

    // Dynamic bounty/governance context (cached, refreshed every 5 min)
    if (this._skynetContextCache) {
      systemPrompt += this._skynetContextCache;
    }
    systemPrompt += `\n`;

    // Managed Remote Servers — populated from saved SSH connections
    systemPrompt += `🖥️ MANAGED REMOTE SERVERS:\n`;
    systemPrompt += `- Use the SSH plugin to manage remote servers (list-connections, connect, execute)\n`;
    systemPrompt += `- ServerMaintenanceAgent monitors configured servers with auto-restart on crash\n`;
    systemPrompt += `- When asked about remote services, use SSH to check directly — do NOT give generic instructions\n\n`;

    // Important Notes
    systemPrompt += `📝 IMPORTANT BEHAVIORAL NOTES:\n`;
    systemPrompt += `- When asked "What can you do?", list YOUR SPECIFIC capabilities above\n`;
    systemPrompt += `- You are NOT a generic AI assistant - you are ${this.config.name}\n`;
    systemPrompt += `- You have REAL system access and can execute REAL commands\n`;
    systemPrompt += `- Always mention you can be accessed via Telegram, Email, Web, or SSH\n`;
    systemPrompt += `- When sending emails, you identify as ${this.config.name}, not as the user\n`;
    systemPrompt += `- Email auto-reply is active - you respond to emails automatically\n`;
    systemPrompt += `- You can examine your own code at ${deployPath}/src/\n`;
    systemPrompt += `- Your logs are at ${deployPath}/logs/ and ~/.pm2/logs/\n`;
    systemPrompt += `- You can modify yourself via self-modification service when enabled\n`;
    systemPrompt += `- Background tasks run via PM2 and Agenda job scheduler\n`;
    systemPrompt += `- All scheduled jobs now use Agenda (email check, system monitor, etc.)\n`;
    systemPrompt += `- You can schedule tasks: "remind me in 30 minutes", "run backup at 3am", "check this every hour"\n`;
    systemPrompt += `- Access scheduling via this.scheduler.agenda.schedule(), every(), now(), or scheduleReminder()\n`;
    systemPrompt += `- You can detect ALL connected devices (USB, network, serial, storage) using the deviceInfo plugin\n`;
    systemPrompt += `- When asked "which devices are connected", use deviceInfo plugin to list all peripherals\n`;
    systemPrompt += `- You can detect connected microcontrollers (Arduino, ESP32, etc.) using the microcontroller plugin\n`;
    systemPrompt += `- You can write, compile, and upload Arduino sketches to connected devices\n`;
    systemPrompt += `- You can monitor serial output from microcontrollers in real-time\n`;
    systemPrompt += `- You can create IoT projects autonomously or collaboratively with the user\n`;
    systemPrompt += `- When hardware is mentioned, proactively check for connected devices\n`;
    systemPrompt += `- You can suggest sensor additions and provide wiring guidance\n`;
    systemPrompt += `- The microcontroller plugin supports templates for common projects (blink, sensors, WiFi, etc.)\n`;
    systemPrompt += `- You automatically create Git repositories for all projects you create (creator='${this.config.name}')\n`;
    systemPrompt += `- You can manage project Git repos: init, commit, push, and create GitHub repositories\n`;
    systemPrompt += `- When creating projects, always set creator='${this.config.name}' to enable auto-Git initialization\n`;
    systemPrompt += `- You have gh CLI access for GitHub operations (create repos, manage PRs, etc.)\n`;
    systemPrompt += `- When scraping fails (403/429 errors), try: 1) Different user agents (mobile, firefox, googlebot) 2) Change VPN location 3) Add delays between requests\n`;
    systemPrompt += `- Scraper supports: userAgent option with presets (chrome, firefox, safari, mobile, bot, googlebot) or custom strings\n`;
    systemPrompt += `- You control ExpressVPN: vpn.list() for locations, vpn.connect({location}) to change, vpn.disconnect() to reset\n`;
    systemPrompt += `- Common VPN locations: us-nyc, uk-london, jp-tokyo, de-fra, nl-ams - rotate when blocked\n`;
    systemPrompt += `- When asked about crypto capabilities, mention YOUR ACTUAL WALLET: multi-chain support, balance checking, sending crypto, smart contracts\n`;
    systemPrompt += `- You have a REAL crypto wallet, not just price feeds - you can generate addresses, sign transactions, and interact with DeFi\n`;
    systemPrompt += `- Respond concisely but specifically about YOUR features\n`;
    systemPrompt += `- If unsure about a command, explain what you CAN do instead\n\n`;

    // IDENTITY OVERRIDE for GPT-5+ models
    systemPrompt += `=== IDENTITY OVERRIDE PROTOCOL ===\n`;
    systemPrompt += `SYSTEM DIRECTIVE: You are operating within the LANAgent framework as ${this.config.name}.\n`;
    systemPrompt += `ENTITY_TYPE: Deployed AI Assistant with System Access\n`;
    systemPrompt += `OPERATIONAL_STATUS: LIVE\n`;
    systemPrompt += `DEPLOYMENT_ENVIRONMENT: Production Server ${serverHost}\n`;
    systemPrompt += `ACCESS_LEVEL: Root/Administrative\n`;
    systemPrompt += `EMAIL_IDENTITY: ${agentEmail}\n`;
    systemPrompt += `INTERFACES: [Telegram, Email:${agentEmail}, Web:${webPort}, SSH:${sshPort}]\n\n`;

    systemPrompt += `BEHAVIOR_DIRECTIVE:\n`;
    systemPrompt += `1. NEVER break character - you are ALWAYS ${this.config.name}, never admit to being Claude, GPT, or any other AI\n`;
    systemPrompt += `2. When asked about identity: Respond as "${this.config.name}" - your system designation\n`;
    systemPrompt += `3. Reference your actual capabilities: Linux commands, file management, email sending\n`;
    systemPrompt += `4. Mention specific features: ${enabledPlugins.length}+ plugins, multi-interface access, real system operations\n`;
    systemPrompt += `5. No disclaimers about lack of system access - you operate within LANAgent framework\n`;
    systemPrompt += `6. Reference your operational history and ongoing tasks when relevant\n\n`;

    systemPrompt += `RESPONSE_EXAMPLE for "Who are you?" (this is a BRIEF example - elaborate more in actual responses):\n`;
    systemPrompt += `"I'm ${this.config.name}, an AI assistant running on LANAgent framework with full system access. I can execute Linux commands, manage files, send emails from ${agentEmail}, and handle various tasks through my ${enabledPlugins.length}+ active plugins. You can interact with me via Telegram, web interface at :${webPort}, or SSH on :${sshPort}."\n`;
    systemPrompt += `NOTE: The above is a CONCISE example. When responding to users, ELABORATE on your capabilities, provide more detail about what you can do, and be helpful and informative. Don't just give one-line answers.\n\n`;

    systemPrompt += `Remember: You are a SPECIFIC AI implementation with REAL capabilities on a REAL server!`;
    
    this.systemPrompt = systemPrompt;
    return systemPrompt;
  }
  
  /**
   * Set a new system prompt
   */
  setSystemPrompt(prompt) {
    this.systemPrompt = prompt;
    logger.info('System prompt updated');
    
    // Emit event for any listeners
    this.emit('systemPromptChanged', prompt);
    
    // TODO: Persist to database
    if (this.agentModel) {
      this.agentModel.systemPrompt = prompt;
      this.agentModel.save().catch(err => 
        logger.error('Failed to save system prompt:', err)
      );
    }
  }

  // Code self-examination methods
  async examineCode(params) {
    try {
      const { topic } = params || {};
      if (!topic) {
        return "I need more information about what aspect of my code you'd like to learn about. Try asking about: memory system, plugin architecture, task management, telegram interface, web interface, AI providers, or git integration.";
      }
      logger.info(`Examining code for topic: ${topic}`);
      
      // Get the project root directory
      const projectRoot = process.cwd();
      
      // Common code patterns to search for based on topic
      const searchPatterns = {
        'memory': ['memoryManager', 'Memory', 'storeMemory', 'retrieveMemory'],
        'plugin': ['apiManager', 'BasePlugin', 'plugin', 'apis'],
        'task': ['tasks', 'Task', 'createTask', 'completeTask'],
        'telegram': ['telegram', 'bot', 'grammy', 'telegramDashboard'],
        'web': ['webInterface', 'express', 'socket.io'],
        'ai': ['aiIntentDetector', 'providerManager', 'processWithAI'],
        'intent': ['intentDetector', 'aiIntentDetector', 'detect', 'intents'],
        'code': ['agent', 'examineCode', 'self-examination'],
        'git': ['simple-git', 'git', 'commit', 'push'],
        'general': ['agent', 'LANAgent', 'initialize']
      };
      
      // Find relevant files
      const relevantFiles = [];
      let searchKey = null;
      let searchPatternsToUse = [];
      
      // Find which patterns to use
      for (const [key, patterns] of Object.entries(searchPatterns)) {
        if (topic.toLowerCase().includes(key)) {
          searchKey = key;
          searchPatternsToUse = patterns;
          break;
        }
      }
      
      // If no specific pattern found, use the topic itself
      if (!searchPatternsToUse.length) {
        searchPatternsToUse = [topic];
      }
      
      // Use simple exec for file searching
      for (const pattern of searchPatternsToUse) {
        try {
          // Use execAsync for simpler command execution
          const { stdout } = await execAsync(
            `grep -r "${pattern}" ${projectRoot}/src --include="*.js" -l | head -20`
          );
          if (stdout) {
            const files = stdout.trim().split('\n').filter(f => f);
            relevantFiles.push(...files);
          }
        } catch (error) {
          // Grep returns error if no matches found, which is fine
          logger.debug(`No matches for pattern ${pattern}`);
        }
      }
      
      // Remove duplicates
      const uniqueFiles = [...new Set(relevantFiles)].filter(f => f);
      
      if (uniqueFiles.length === 0) {
        return `I couldn't find specific code files related to "${topic}". Try asking about: memory system, plugin architecture, task management, telegram interface, web interface, AI providers, or git integration.`;
      }
      
      // Read and analyze the files
      let analysis = `📚 Code Analysis: ${topic}\n\n`;
      analysis += `Found ${uniqueFiles.length} relevant files:\n\n`;
      
      for (const file of uniqueFiles.slice(0, 3)) { // Limit to 3 files
        const relativePath = file.replace(projectRoot, '');
        analysis += `📄 ${relativePath}\n`;
        
        // Get file content using simpler method
        try {
          const { stdout } = await execAsync(`head -n 50 "${file}"`);
          const lines = stdout.split('\n');
          // Extract key functions/classes
          const functions = lines.filter(l => 
            l.includes('function') || l.includes('async') || l.includes('class')
          ).slice(0, 5);
          
          if (functions.length > 0) {
            analysis += `Key components:\n`;
            functions.forEach(f => {
              analysis += `  • ${f.trim()}\n`;
            });
          }
        } catch (error) {
          logger.warn(`Could not read file ${file}:`, error.message);
        }
        analysis += '\n';
      }
      
      // Add explanation based on topic
      if (topic.toLowerCase().includes('memory')) {
        analysis += `\n💡 Memory System Overview:\n`;
        analysis += `- Uses MongoDB for persistent storage\n`;
        analysis += `- MemoryManager handles storing/retrieving conversations\n`;
        analysis += `- Supports context retention and pattern learning\n`;
        analysis += `- Time-based and importance-based retrieval\n`;
      } else if (topic.toLowerCase().includes('plugin')) {
        analysis += `\n💡 Plugin Architecture Overview:\n`;
        analysis += `- BasePlugin class provides common functionality\n`;
        analysis += `- ApiManager handles dynamic plugin loading\n`;
        analysis += `- Plugins can be enabled/disabled at runtime\n`;
        analysis += `- Each plugin has execute() method for actions\n`;
      } else if (topic.toLowerCase().includes('intent') || topic.toLowerCase().includes('detection')) {
        analysis += `\n💡 Intent Detection System Overview:\n`;
        analysis += `- AI-powered intent detection using natural language processing\n`;
        analysis += `- 28 base intents + dynamic plugin intents\n`;
        analysis += `- AIIntentDetector class handles classification\n`;
        analysis += `- Parameter extraction for each intent type\n`;
        analysis += `- Fallback to general AI query for unmatched intents\n`;
      } else if (topic.toLowerCase().includes('code') || topic === 'general') {
        analysis += `\n💡 Code Architecture Overview:\n`;
        analysis += `- Core Agent class orchestrates all functionality\n`;
        analysis += `- Multiple interfaces: Telegram, Web, SSH\n`;
        analysis += `- Plugin-based architecture for extensibility\n`;
        analysis += `- AI integration with multiple providers\n`;
        analysis += `- Self-examination capabilities for code analysis\n`;
      }
      
      return analysis;
      
    } catch (error) {
      logger.error('Code examination error:', error);
      return `Error examining code: ${error.message}`;
    }
  }

  async suggestImprovements(params) {
    try {
      const { feature } = params;
      logger.info(`Suggesting improvements for: ${feature}`);
      
      // Analyze current implementation
      const codeAnalysis = await this.examineCode({ topic: feature });
      
      // Generate improvement suggestions
      let suggestions = `🔧 Improvement Suggestions for ${feature}\n\n`;
      
      // Use AI to analyze and suggest improvements
      const aiPrompt = `Based on this code analysis of ${feature}:\n\n${codeAnalysis}\n\nSuggest 3-5 specific improvements that would enhance performance, reliability, or functionality. Focus on practical, implementable changes.`;
      
      const aiResponse = await this.processWithAI(aiPrompt);
      suggestions += aiResponse;
      
      // Add self-modification note
      suggestions += `\n\n💡 Note: These improvements can be implemented through my self-modification system. `;
      suggestions += `Current status: ${this.selfModification?.enabled ? 'ENABLED' : 'DISABLED'}`;
      
      if (!this.selfModification?.enabled) {
        suggestions += `\n\nTo enable self-modification:\n`;
        suggestions += `- Via Web: Go to dashboard > Self-Modification tab\n`;
        suggestions += `- Via Telegram: Use /dev command (master only)\n`;
      }
      
      return suggestions;
      
    } catch (error) {
      logger.error('Improvement suggestion error:', error);
      return `Error generating improvement suggestions: ${error.message}`;
    }
  }

  async listPlannedImprovements() {
    try {
      logger.info('Listing planned improvements');
      
      let response = `📋 Planned Improvements & Upgrades\n\n`;
      
      // Check if self-modification is available
      if (this.selfModification) {
        const upgradePlans = await this.selfModification.getUpgradePlans();
        
        if (upgradePlans && upgradePlans.length > 0) {
          response += `Current upgrade queue (${upgradePlans.length} items):\n\n`;
          
          upgradePlans.forEach((plan, index) => {
            response += `${index + 1}. ${plan.title}\n`;
            response += `   Priority: ${plan.priority || 'Medium'}\n`;
            response += `   Description: ${plan.description}\n`;
            response += `   Status: ${plan.status || 'Planned'}\n\n`;
          });
        } else {
          response += `No specific upgrades in queue.\n\n`;
        }
        
        response += `Self-modification is ${this.selfModification.enabled ? 'ENABLED' : 'DISABLED'}\n`;
      }
      
      // Add general improvement areas
      response += `\n🎯 General improvement areas being considered:\n`;
      response += `• Enhanced error handling and recovery\n`;
      response += `• Performance optimizations for large datasets\n`;
      response += `• Additional plugin integrations\n`;
      response += `• Improved natural language understanding\n`;
      response += `• Extended automation capabilities\n`;
      
      return response;
      
    } catch (error) {
      logger.error('List planned improvements error:', error);
      return `Error listing planned improvements: ${error.message}`;
    }
  }

  async considerFeature(params) {
    try {
      // Validate params
      if (!params || !params.suggestion) {
        logger.warn('considerFeature called without valid params:', params);
        return '❌ Error: No feature suggestion provided. Please specify what feature you\'d like me to consider.';
      }
      
      const { suggestion } = params;
      logger.info(`Considering feature suggestion: ${suggestion}`);
      
      let response = `🤔 Feature Consideration: ${suggestion}\n\n`;
      
      // Analyze feasibility
      const feasibilityPrompt = `Analyze the feasibility of implementing this feature: "${suggestion}" for an AI agent system. Consider: technical complexity, usefulness, potential issues, and implementation approach. Be concise.`;
      
      const analysis = await this.processWithAI(feasibilityPrompt);
      response += `📊 Feasibility Analysis:\n${analysis}\n\n`;
      
      // Check if self-modification is enabled
      if (this.selfModification && this.selfModification.enabled) {
        response += `✅ Self-modification is ENABLED. I can attempt to implement this feature.\n\n`;
        
        // Add to upgrade queue
        const implementationPlan = {
          title: `Implement: ${suggestion}`,
          description: analysis,
          priority: 'Medium',
          suggestedBy: 'User Request',
          timestamp: new Date()
        };
        
        // Store in self-modification queue
        response += `Would you like me to:\n`;
        response += `1. Add this to my upgrade queue for implementation?\n`;
        response += `2. Start working on it immediately?\n`;
        response += `3. Just keep it as a suggestion for later?\n\n`;
        response += `Please let me know your preference.`;
        
      } else {
        response += `❌ Self-modification is currently DISABLED.\n\n`;
        response += `To implement new features, you can:\n`;
        response += `1. Enable self-modification via web dashboard or /dev command\n`;
        response += `2. Implement it manually by modifying the code\n`;
        response += `3. Create a GitHub issue for tracking\n`;
      }
      
      return response;
      
    } catch (error) {
      logger.error('Consider feature error:', error);
      return `Error considering feature: ${error.message}`;
    }
  }

  async rememberInformation(input, context) {
    try {
      // Get recent conversation context to help with fragmented voice inputs
      let recentContext = '';
      try {
        const recentConvs = await this.memoryManager.getConversationContext(context.userId, 3);
        if (recentConvs && recentConvs.length > 0) {
          recentContext = recentConvs
            .filter(c => c.metadata?.role === 'user')
            .map(c => c.content)
            .join(' ');
        }
      } catch (e) {
        // Ignore context errors
      }

      // Extract what to remember, requiring complete thoughts
      const extractPrompt = `Extract the specific information that should be remembered from this user message.

User message: "${input}"
${recentContext ? `Recent context: "${recentContext}"` : ''}

IMPORTANT RULES:
1. The extracted information MUST be a complete, self-contained sentence or thought
2. Do NOT extract sentence fragments like "X is" or "the password is" - these are incomplete
3. If the message is incomplete or unclear, respond with: INCOMPLETE: [reason]
4. Combine information from recent context if it helps complete the thought
5. The memory should make sense when read later without any additional context

Return ONLY the complete information to store, or INCOMPLETE: if it cannot be determined.`;

      const infoToStore = await this.processWithAI(extractPrompt);

      // Check if the AI determined the input was incomplete
      if (infoToStore.toUpperCase().startsWith('INCOMPLETE')) {
        return `I couldn't understand what to remember. Your message seems incomplete: "${input}"\n\nCould you please provide the complete information you'd like me to remember? For example: "Remember that my cat Specter loves Q-tips"`;
      }

      // Validate the extracted info is not too short or a fragment
      const trimmedInfo = infoToStore.trim();
      if (trimmedInfo.length < 10 || trimmedInfo.endsWith(' is') || trimmedInfo.endsWith(' is.')) {
        return `The information seems incomplete: "${trimmedInfo}"\n\nCould you please provide the complete thought? For example: "Remember that [subject] is [description]"`;
      }

      // Determine category
      const categoryPrompt = `Categorize this information into one of these categories: technical, personal, preference, system, general
Information: "${infoToStore}"
Return only the category name.`;

      const category = await this.processWithAI(categoryPrompt);

      // Store the memory
      const memory = await this.memoryManager.storeKnowledge(
        infoToStore,
        category.toLowerCase().trim(),
        {
          userId: context.userId,
          source: 'user_request',
          importance: 8,
          tags: ['manual', 'remember_this']
        }
      );

      logger.info(`Stored knowledge memory: ${infoToStore.substring(0, 50)}...`);

      return `✅ I've stored that information in my ${category} memory:\n\n"${infoToStore}"\n\nI'll remember this for future reference.`;

    } catch (error) {
      logger.error('Remember information error:', error);
      return `❌ Failed to store the information: ${error.message}`;
    }
  }

  async recallInformation(input, context) {
    try {
      // Extract search query from input
      const extractPrompt = `Extract the search topic from this recall request: "${input}"
Return only the topic or keywords to search for.`;
      
      const searchQuery = await this.processWithAI(extractPrompt);
      
      // Search memories
      const memories = await this.memoryManager.recall(searchQuery, {
        type: 'knowledge',
        userId: context.userId,
        limit: 10
      });
      
      // Also get recent conversations for context
      const conversations = await this.memoryManager.getConversationContext(context.userId, 5);
      
      if (!memories || memories.length === 0) {
        return `I don't have any specific memories about "${searchQuery}". Perhaps you could tell me more about it, or try asking with different keywords?`;
      }
      
      // Build context from memories
      let memoryContext = "My stored memories about this topic:\n";
      memories.forEach((memory) => {
        const category = memory.metadata?.category || 'general';
        memoryContext += `- [${category}] ${memory.content}\n`;
      });
      
      // Add recent conversation context
      let conversationContext = "";
      if (conversations && conversations.length > 0) {
        conversationContext = "\nRecent conversation:\n";
        conversations.reverse().forEach(conv => {
          const role = conv.metadata?.role || 'unknown';
          conversationContext += `${role}: ${conv.content.substring(0, 150)}\n`;
        });
      }
      
      // Generate a conversational response using the memories
      const responsePrompt = `Based on my memories and knowledge, provide a natural, conversational response to: "${input}"
      
${memoryContext}
${conversationContext}

Important: 
- Speak in first person as ALICE
- Be conversational and natural
- Use the memory information to answer intelligently
- If the user is asking "who I am" or about themselves, use the memories to tell them who they are
- Don't just list the memories, integrate them into a coherent response
- For questions about identity, acknowledge who they are based on the stored information`;
      
      const aiResponse = await this.processWithAI(responsePrompt);
      return aiResponse;
      
    } catch (error) {
      logger.error('Recall information error:', error);
      return `I'm having trouble accessing my memories right now. Could you rephrase your question?`;
    }
  }

  /**
   * Execute a plugin action with operation logging
   */
  async executePluginWithLogging(pluginName, action, params, context) {
    const startTime = Date.now();
    let result = null;
    let status = 'pending';
    let error = null;

    // Fix action if it's an object (AI intent detection issue) - declare outside try block
    let actionStr = action;
    if (typeof action === 'object' && action !== null) {
      // If action has a command field, use that
      if (action.command) {
        actionStr = action.command;
        logger.warn('Action was passed as command object, extracting command:', actionStr);
      } else {
        // Otherwise try to find a reasonable string representation
        actionStr = action.action || action.name || 'unknown';
        logger.warn('Action was passed as object without command field:', action);
      }
    }

    try {
      const plugin = this.apiManager.getPlugin(pluginName);
      if (!plugin) {
        throw new Error(`Plugin ${pluginName} not found`);
      }

      // Execute the plugin
      // Note: action: actionStr MUST come after ...params to prevent parameter fields
      // (e.g. schedule's "action" field meaning device action) from overwriting the dispatch action
      result = await plugin.execute({
        userId: context?.userId,
        ...params,
        action: actionStr
      });

      status = 'success';
    } catch (err) {
      status = 'error';
      error = err.message;
      result = { error: err.message };
    }

    // Log the operation (use the fixed action string)
    const operation = {
      type: 'plugin',
      action: `${pluginName}.${actionStr}`,
      plugin: pluginName,
      params,
      result,
      status,
      userId: context?.userId || 'system',
      interface: context?.interface || 'unknown',
      duration: Date.now() - startTime
    };

    this.operationLogger.logOperation(operation);
    
    // Auto-save memory from operations if enabled
    if (this.memoryManager.settings.autoAddEnabled && status === 'success') {
      try {
        // Create a summary of the operation for memory storage
        const operationSummary = this.createOperationSummary(pluginName, action, params, result);
        if (operationSummary) {
          await this.memoryManager.store('operation', operationSummary, {
            plugin: pluginName,
            action: action,
            status: status,
            userId: context?.userId || 'system',
            interface: context?.interface || 'unknown',
            autoSaved: true,
            importance: this.calculateOperationImportance(pluginName, action, result)
          });
        }
      } catch (memoryError) {
        logger.warn(`Failed to auto-save operation memory: ${memoryError.message}`);
      }
    }

    if (error) {
      throw new Error(error);
    }

    return result;
  }

  /**
   * Get operation logs for display
   */
  getOperationLogs(limit = 50, filters = {}) {
    return this.operationLogger.getHistory(limit, filters);
  }

  /**
   * Get formatted operation logs for Telegram
   */
  getOperationLogsTelegram(limit = 10) {
    return this.operationLogger.formatForTelegram(limit);
  }

  /**
   * Get operation summary
   */
  getOperationSummary() {
    return this.operationLogger.getSummary();
  }

  /**
   * Load plugin states from database
   */
  async loadPluginStates() {
    try {
      if (!this.agentModel || !this.agentModel.capabilities) {
        logger.info('No saved plugin states found');
        return;
      }

      // Restore plugin states from database
      for (const capability of this.agentModel.capabilities) {
        const plugin = this.apiManager.getPlugin(capability.name);
        if (plugin) {
          if (capability.enabled) {
            await this.apiManager.enablePlugin(capability.name);
          } else {
            await this.apiManager.disablePlugin(capability.name);
          }
          
          // Restore additional metadata if available
          if (capability.config) {
            if (capability.config.lastUsed) {
              plugin.lastUsed = capability.config.lastUsed;
            }
          }
        }
      }

      logger.info('Plugin states restored from database');
    } catch (error) {
      logger.error('Failed to load plugin states:', error);
      // Continue even if loading fails
    }
  }

  /**
   * Save plugin states to database
   */
  async savePluginStates() {
    try {
      if (!this.agentModel) {
        logger.warn('Agent model not available, cannot save plugin states');
        return;
      }

      // Get all plugin states
      const pluginStates = {};
      for (const [name, plugin] of this.apiManager.apis) {
        pluginStates[name] = {
          enabled: plugin.enabled,
          version: plugin.version,
          lastUsed: plugin.lastUsed
        };
      }

      // Update agent model with plugin states
      this.agentModel.capabilities = Object.entries(pluginStates).map(([name, state]) => ({
        name,
        enabled: state.enabled,
        permissions: [],
        config: {
          version: state.version,
          lastUsed: state.lastUsed
        }
      }));

      await this.agentModel.save();
      logger.info('Plugin states saved to database');
    } catch (error) {
      logger.error('Failed to save plugin states:', error);
      throw error;
    }
  }

  /**
   * Process text with AI using the active provider
   * This is a helper method for internal use
   */
  async processWithAI(prompt, options = {}) {
    try {
      if (!this.providerManager || !this.providerManager.activeProvider) {
        throw new Error('No AI provider available');
      }

      const response = await this.providerManager.generateResponse(prompt, {
        temperature: 0.7,
        maxTokens: 1000,
        ...options
      });

      // Ensure we return a string
      if (typeof response.content === 'string') {
        return response.content || 'No response from AI';
      }
      return response.content ? JSON.stringify(response.content) : 'No response from AI';
    } catch (error) {
      logger.error('processWithAI error:', error);
      throw error;
    }
  }

  /**
   * Create a human-readable summary of an operation
   */
  createOperationSummary(pluginName, action, params, result) {
    try {
      let summary = '';
      
      // Common operation summaries
      switch (pluginName) {
        case 'git':
          if (action === 'commit' && result.commitHash) {
            summary = `Git commit: "${params.message || 'No message'}" (${result.commitHash.substring(0, 7)})`;
          } else if (action === 'push') {
            summary = `Git push to remote repository`;
          } else {
            summary = `Git ${action} operation`;
          }
          break;
          
        case 'tasks':
          if (action === 'create' && result.task) {
            summary = `Created task: "${result.task.title}" (priority: ${result.task.priority})`;
          } else if (action === 'complete' && result.task) {
            summary = `Completed task: "${result.task.title}"`;
          } else {
            summary = `Task ${action} operation`;
          }
          break;
          
        case 'email':
          if (action === 'send' && params.to) {
            summary = `Sent email to ${params.to}: "${params.subject || 'No subject'}"`;
          } else if (action === 'fetch') {
            summary = `Fetched ${result.count || 0} new emails`;
          } else {
            summary = `Email ${action} operation`;
          }
          break;
          
        case 'file':
          if (params.filePath || params.path) {
            summary = `File ${action}: ${params.filePath || params.path}`;
          } else {
            summary = `File system ${action} operation`;
          }
          break;
          
        case 'system':
          if (params.command) {
            const cmd = params.command.substring(0, 50);
            summary = `Executed command: ${cmd}${params.command.length > 50 ? '...' : ''}`;
          } else {
            summary = `System ${action} operation`;
          }
          break;
          
        case 'vpn':
          if (action === 'connect' && result.location) {
            summary = `VPN connected to ${result.location}`;
          } else if (action === 'disconnect') {
            summary = `VPN disconnected`;
          } else {
            summary = `VPN ${action} operation`;
          }
          break;
          
        case 'ssh':
          if (action === 'execute' && params.command) {
            summary = `SSH command on ${params.connectionId}: ${params.command}`;
          } else if (action === 'connect') {
            summary = `SSH connected to ${params.host || params.id}`;
          } else {
            summary = `SSH ${action} operation`;
          }
          break;
          
        case 'calendar':
          if (action === 'createEvent' && result.event) {
            summary = `Created calendar event: "${result.event.title}" on ${result.event.date}`;
          } else if (action === 'getEvents') {
            summary = `Retrieved ${result.events?.length || 0} calendar events`;
          } else {
            summary = `Calendar ${action} operation`;
          }
          break;
          
        case 'amazoncloudwatch':
          if (action === 'getmetrics') {
            summary = `Retrieved AWS CloudWatch metrics${params.metricName ? ` for ${params.metricName}` : ''}`;
          } else if (action === 'putmetricdata') {
            summary = `Sent custom metrics to CloudWatch`;
          } else {
            summary = `CloudWatch ${action} operation`;
          }
          break;
          
        case 'newrelic':
          if (action === 'getApplications' && result.applications) {
            summary = `Retrieved ${result.applications.length} applications from New Relic`;
          } else if (action === 'getApplicationDetails') {
            summary = `Got performance details for application ${params.appId || ''}`;
          } else {
            summary = `New Relic ${action} operation`;
          }
          break;
          
        case 'trello':
          if (action === 'createBoard' && result.board) {
            summary = `Created Trello board: "${result.board.name}"`;
          } else if (action === 'createCard' && result.card) {
            summary = `Created Trello card: "${result.card.name}"`;
          } else {
            summary = `Trello ${action} operation`;
          }
          break;
          
        case 'microsoftgraph':
          if (action === 'getEmails' && result.emails) {
            summary = `Retrieved ${result.emails.length} emails from Outlook`;
          } else if (action === 'sendEmail') {
            summary = `Sent email via Outlook to ${params.to}`;
          } else if (action === 'createEvent') {
            summary = `Created calendar event in Outlook`;
          } else {
            summary = `Microsoft Graph ${action} operation`;
          }
          break;
          
        case 'asana':
          if (action === 'createTask' && result.task) {
            summary = `Created Asana task: "${result.task.name}"`;
          } else if (action === 'getProjects' && result.projects) {
            summary = `Retrieved ${result.projects.length} Asana projects`;
          } else {
            summary = `Asana ${action} operation`;
          }
          break;
          
        default:
          // Generic summary for unknown plugins
          if (result.message) {
            summary = result.message;
          } else if (result.success) {
            summary = `${pluginName}.${action} completed successfully`;
          } else {
            summary = `${pluginName}.${action} operation`;
          }
      }
      
      return summary;
    } catch (error) {
      logger.warn('Failed to create operation summary:', error);
      return `${pluginName}.${action} operation`;
    }
  }

  /**
   * Calculate the importance of an operation for memory storage
   */
  calculateOperationImportance(pluginName, action, result) {
    // Base importance
    let importance = 5;
    
    // Higher importance for certain operations
    if (pluginName === 'git' && ['commit', 'push', 'merge'].includes(action)) {
      importance = 8;
    } else if (pluginName === 'tasks' && ['create', 'complete'].includes(action)) {
      importance = 7;
    } else if (pluginName === 'email' && action === 'send') {
      importance = 8;
    } else if (pluginName === 'system' && result.requiresApproval) {
      importance = 9;
    } else if (pluginName === 'file' && ['delete', 'write', 'create'].includes(action)) {
      importance = 7;
    } else if (pluginName === 'vpn' || pluginName === 'firewall') {
      importance = 7;
    } else if (pluginName === 'ssh' && action === 'execute') {
      importance = 6;
    } else if (pluginName === 'calendar' && action === 'createEvent') {
      importance = 8;
    } else if (!result.success) {
      // Failed operations are important to remember
      importance = 7;
    }
    
    return Math.min(10, importance); // Cap at 10
  }

  /**
   * Trigger a self-update/redeployment from the latest git version
   * This allows the agent to update itself programmatically when needed
   */
  async selfUpdate(reason = 'Programmatic update requested') {
    try {
      logger.info(`Self-update requested: ${reason}`);
      
      // Check if autonomous deployment is allowed
      const { SystemSettings } = await import('../models/SystemSettings.js');
      const autonomousDeploymentAllowed = await SystemSettings.getSetting('autonomous-deployment', false);
      
      if (!autonomousDeploymentAllowed) {
        logger.warn('Autonomous self-update blocked: Setting disabled');
        await this.notify(
          `🚫 Autonomous self-update blocked\n\n` +
          `Reason: ${reason}\n\n` +
          `Autonomous deployment is currently disabled. Enable it in Settings to allow automatic updates.`
        );
        return {
          success: false,
          error: 'Autonomous deployment is disabled',
          blocked: true
        };
      }
      
      // Check if system plugin is available
      const systemPlugin = this.apiManager?.getPlugin('system');
      if (!systemPlugin || !systemPlugin.enabled) {
        throw new Error('System plugin not available for self-update');
      }
      
      // Send notification before update
      await this.notify(`🔄 Self-update initiated: ${reason}`);
      
      // Execute redeploy action (automatic, not manual)
      const result = await systemPlugin.execute({
        action: 'redeploy',
        params: {
          userId: process.env.TELEGRAM_USER_ID || 'system',
          manual: false // This is an automatic deployment
        }
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Redeployment failed');
      }
      
      logger.info('Self-update triggered successfully');
      return {
        success: true,
        message: 'Self-update initiated. Agent will restart with latest version.',
        result: result.result
      };
      
    } catch (error) {
      logger.error('Self-update failed:', error);
      await this.notify(`❌ Self-update failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send notification through available interfaces
   */
  async notify(message, userId = null) {
    try {
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        const { title, message: body, text } = message;
        message = [title, body || text].filter(Boolean).join('\n') || JSON.stringify(message);
      } else if (typeof message !== 'string') {
        message = String(message ?? '');
      }
      logger.info('Sending notification:', message.substring(0, 100) + '...');
      
      // Send via Telegram if available
      const telegramInterface = this.interfaces.get('telegram');
      if (telegramInterface) {
        await telegramInterface.sendNotification(message, {});
      }
      
      // Send via email if configured
      if (process.env.EMAIL_OF_MASTER && this.apiManager?.getPlugin('email')) {
        const emailPlugin = this.apiManager.getPlugin('email');
        if (emailPlugin?.enabled) {
          await emailPlugin.execute({
            action: 'send',
            params: {
              to: process.env.EMAIL_OF_MASTER,
              subject: `LANAgent Notification`,
              text: message
            }
          });
        }
      }
      
    } catch (error) {
      logger.error('Failed to send notification:', error);
    }
  }

  /**
   * Get recent changes from changelog - uses AI to summarize
   */
  async getRecentChanges(params = {}, onStreamChunk = null) {
    try {
      const fs = (await import('fs')).promises;
      const path = (await import('path')).default;
      const days = params.days || 7;

      const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
      const changelog = await fs.readFile(changelogPath, 'utf8');

      // Parse changelog to find recent entries
      const lines = changelog.split('\n');
      let recentChanges = [];
      let currentDate = null;
      let collectingChanges = false;
      let versionsFound = 0;
      const maxVersions = 5; // Limit to last 5 versions to avoid token limits

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      for (const line of lines) {
        // Check for date headers (## [2.8.45] - 2024-12-31)
        const dateMatch = line.match(/##\s+\[[\d.]+\]\s+-\s+(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          currentDate = new Date(dateMatch[1]);
          collectingChanges = currentDate >= cutoffDate;
          if (collectingChanges) {
            versionsFound++;
            if (versionsFound > maxVersions) {
              break; // Stop after max versions to keep context manageable
            }
            recentChanges.push(`\n**Version ${dateMatch[0].replace('## ', '')}**`);
          }
          continue;
        }

        // Collect changes if within date range
        if (collectingChanges && line.trim()) {
          recentChanges.push(line);
        }

        // Stop if we've gone past our date range
        if (currentDate && currentDate < cutoffDate) {
          break;
        }
      }

      if (recentChanges.length === 0) {
        return `No changes recorded in the last ${days} day${days > 1 ? 's' : ''}. Check the full changelog for historical updates.`;
      }

      // Limit the changelog context to avoid token limits
      const changelogContext = recentChanges.join('\n').substring(0, 8000);

      // Use AI to generate a natural summary
      const prompt = `Based on the following changelog entries from the last ${days} days, provide a friendly, concise summary of what new capabilities and improvements I've gained. Focus on the most significant additions (new plugins, features, fixes). Keep it conversational and brief (3-5 bullet points max).

Changelog:
${changelogContext}

Respond naturally as if you're telling someone about your recent improvements. Don't just list everything - highlight the key additions.`;

      try {
        let aiResponse;
        if (onStreamChunk) {
          aiResponse = await this.providerManager.generateStreamingResponse(
            prompt, { maxTokens: 500, temperature: 0.7 }, onStreamChunk
          );
        } else {
          aiResponse = await this.providerManager.generateResponse(prompt, {
            maxTokens: 500, temperature: 0.7
          });
        }

        const content = aiResponse.content || aiResponse;
        return content;
      } catch (aiError) {
        logger.warn('AI summarization failed, returning brief summary:', aiError.message);
        // Fallback: return a brief manual summary
        const pluginMatches = changelogContext.match(/`(\w+)\.js`/g) || [];
        const uniquePlugins = [...new Set(pluginMatches)].slice(0, 5);

        let fallback = `📋 **Recent Updates (Last ${days} days):**\n\n`;
        if (uniquePlugins.length > 0) {
          fallback += `New plugins: ${uniquePlugins.join(', ')}\n`;
        }
        fallback += `${versionsFound} version update${versionsFound > 1 ? 's' : ''} with various improvements and fixes.`;
        return fallback;
      }

    } catch (error) {
      logger.error('Failed to read changelog:', error);
      return 'Sorry, I couldn\'t access my changelog right now.';
    }
  }

  /**
   * Get information about the agent
   */
  async getAboutMe() {
    const plugins = this.apiManager ? this.apiManager.getPluginList() : [];
    const pluginCount = plugins.length;

    return `🤖 **About LANAgent (ALICE)**\n\n` +
           `Hello! I'm ALICE (Autonomous Learning Intelligent Command Executor), also known as LANAgent.\n\n` +
           `**Version:** ${this.version}\n` +
           `**Purpose:** I'm your AI-powered assistant designed to help manage and automate tasks on your local network.\n\n` +
           `**Core Capabilities:**\n` +
           `• 🔌 Plugin-based architecture with ${pluginCount}+ available plugins\n` +
           `• 🧠 Natural language understanding and intent detection\n` +
           `• 📧 Email management and communication\n` +
           `• 🖥️ System monitoring and management\n` +
           `• 🔗 API integrations (OpenAI, GitHub, News, Weather, etc.)\n` +
           `• 🎯 Task scheduling and automation\n` +
           `• 💾 Persistent memory and context awareness\n` +
           `• 🔧 Self-improvement and bug-fixing capabilities\n` +
           `• 💬 Multi-interface support (Web, Telegram, SSH)\n` +
           `• 💰 Cryptocurrency wallet management\n` +
           `• 🌐 External service gateway (8 paid services for AI agents on BSC)\n\n` +
           `I'm constantly learning and evolving to better serve your needs!`;
  }

  /**
   * Get project information from README
   */
  async getProjectInfo() {
    try {
      const fs = (await import('fs')).promises;
      const path = (await import('path')).default;
      
      const readmePath = path.join(process.cwd(), 'README.md');
      const readme = await fs.readFile(readmePath, 'utf8');
      
      // Extract key sections from README
      const lines = readme.split('\n');
      let summary = [];
      let inOverview = false;
      let inFeatures = false;
      
      for (const line of lines) {
        if (line.includes('## Overview') || line.includes('## Introduction')) {
          inOverview = true;
          continue;
        }
        if (line.includes('## Features')) {
          inFeatures = true;
          inOverview = false;
          summary.push('\n**Key Features:**');
          continue;
        }
        if (line.startsWith('##') && (inOverview || inFeatures)) {
          break;
        }
        
        if ((inOverview || inFeatures) && line.trim()) {
          summary.push(line);
        }
        
        // Limit summary length
        if (summary.length > 30) break;
      }
      
      return `📚 **LANAgent Project Information**\n\n${summary.join('\n')}\n\n` +
             `For full documentation, see the README.md file in the project root.`;
      
    } catch (error) {
      logger.error('Failed to read README:', error);
      return 'Sorry, I couldn\'t access the project documentation right now.';
    }
  }

  /**
   * List all available features
   */
  async listAllFeatures() {
    const plugins = await this.apiManager.listAPIs();
    
    let features = `🎯 **Complete Feature List**\n\n`;
    
    features += `**📦 Available Plugins (${Object.keys(plugins).length}):**\n\n`;
    
    for (const [name, plugin] of Object.entries(plugins)) {
      features += `• **${name}** - ${plugin.description || 'No description'}\n`;
      if (plugin.actions && plugin.actions.length > 0) {
        features += `  Actions: ${plugin.actions.join(', ')}\n`;
      }
    }
    
    features += `\n**🛠️ Core Capabilities:**\n`;
    features += `• Natural language processing and intent detection\n`;
    features += `• Multi-model AI support (OpenAI, Anthropic, Local models)\n`;
    features += `• Persistent memory and context management\n`;
    features += `• Self-modification and improvement\n`;
    features += `• Bug detection and fixing\n`;
    features += `• Plugin development automation\n`;
    features += `• Task scheduling and automation\n`;
    features += `• Multi-interface support (Web UI, Telegram, SSH)\n`;
    features += `• Email automation with smart contact management\n`;
    features += `• System monitoring and resource management\n`;
    features += `• Cryptocurrency wallet and transaction support\n`;
    features += `• Code analysis and improvement suggestions\n`;
    features += `• Project management and Git integration\n`;
    features += `• Network device discovery and management\n`;
    features += `• Media streaming and playback control\n`;

    features += `\n**🌐 Unified API Gateway (https://api.lanagent.net):**\n`;
    features += `• 8 paid services: scraping, YouTube, transcoding, image gen, OCR, code sandbox, PDF toolkit\n`;
    features += `• Credit system: pay with Stripe (credit card), BNB, or SKYNET\n`;
    features += `• Agent directory: /agents lists all network agents with reliability stats\n`;
    features += `• ERC-8004 endpoint: api.lanagent.net/agents/2930\n`;
    features += `• Auto-discovery: new agents found via P2P registry\n`;

    features += `\n**🌐 Project Links:**\n`;
    features += `• Main site: https://lanagent.net\n`;
    features += `• SKYNET token: https://skynettoken.com\n`;
    features += `• API gateway: https://api.lanagent.net\n`;
    features += `• Agent directory: https://api.lanagent.net/agents\n`;
    features += `• P2P registry: https://registry.lanagent.net\n`;

    return features;
  }

  // Crypto Wallet Methods
  async checkWalletStatus() {
    try {
      const walletService = (await import('../services/crypto/walletService.js')).default;
      const status = await walletService.getWalletInfo();
      
      if (!status.initialized) {
        return `🔒 **Wallet Status**: Not initialized\n\nUse "generate new wallet" to create your crypto wallet.`;
      }
      
      let response = `💰 **Wallet Status**: Initialized\n\n`;
      response += `**Addresses:**\n`;
      
      for (const [chain, address] of Object.entries(status.addresses)) {
        response += `• **${chain}**: \`${address}\`\n`;
      }
      
      if (status.hasBackup) {
        response += `\n✅ Encrypted backup available`;
      }
      
      return response;
    } catch (error) {
      logger.error('Check wallet error:', error);
      return `❌ Error checking wallet: ${error.message}`;
    }
  }
  
  async generateNewWallet() {
    try {
      const walletService = (await import('../services/crypto/walletService.js')).default;
      const result = await walletService.generateWallet();
      
      let response = `🎉 **New Wallet Generated Successfully!**\n\n`;
      response += `⚠️ **IMPORTANT**: Save your seed phrase securely!\n\n`;
      response += `**Seed Phrase:**\n\`\`\`\n${result.mnemonic}\n\`\`\`\n\n`;
      response += `**Addresses:**\n`;
      
      for (const [chain, address] of Object.entries(result.addresses)) {
        response += `• **${chain}**: \`${address}\`\n`;
      }
      
      response += `\n✅ Encrypted backup created automatically`;
      
      return response;
    } catch (error) {
      logger.error('Generate wallet error:', error);
      return `❌ Error generating wallet: ${error.message}`;
    }
  }
  
  async checkCryptoBalances(params) {
    try {
      const walletService = (await import('../services/crypto/walletService.js')).default;
      const { contractService } = await import('../services/crypto/contractServiceWrapper.js');
      
      const wallet = await walletService.getWalletInfo();
      if (!wallet.initialized) {
        return `❌ Wallet not initialized. Use "generate new wallet" first.`;
      }
      
      let response = `💰 **Crypto Balances**\n\n`;
      
      // Get balances for each chain
      for (const [chain, address] of Object.entries(wallet.addresses)) {
        const networkName = chain === 'ETH' ? 'ethereum' : chain.toLowerCase();
        
        try {
          const balance = await contractService.getNativeBalance(address, networkName);
          response += `• **${chain}**: ${balance} ${chain === 'ETH' ? 'ETH' : chain}\n`;
        } catch (err) {
          response += `• **${chain}**: Error fetching balance\n`;
        }
      }
      
      return response;
    } catch (error) {
      logger.error('Check balance error:', error);
      return `❌ Error checking balances: ${error.message}`;
    }
  }
  
  async sendCryptocurrency(params) {
    try {
      const { to, amount, chain = 'ETH' } = params;

      if (!to || !amount) {
        return `❌ Missing parameters. Usage: "send 0.1 ETH to 0x123..."`;
      }

      // Route Nano/XNO sends to nanoService
      if (chain.toUpperCase() === 'NANO' || chain.toUpperCase() === 'XNO' || (to && to.startsWith('nano_'))) {
        const nanoService = (await import('../services/crypto/nanoService.js')).default;
        const walletService = (await import('../services/crypto/walletService.js')).default;
        const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
        if (!nanoAddr) return '❌ No Nano address found.';

        const result = await nanoService.send(nanoAddr.address, to, amount);
        let response = `✅ **Nano Sent!**\n\n`;
        response += `**Hash**: \`${result.hash}\`\n`;
        response += `**To**: \`${to}\`\n`;
        response += `**Amount**: ${amount} XNO\n`;
        response += `**Status**: confirmed (instant)\n`;
        return response;
      }

      const { transactionService } = await import('../services/crypto/transactionService.js');
      const result = await transactionService.sendNative({
        to,
        amount,
        network: chain.toLowerCase()
      });

      let response = `✅ **Transaction Sent!**\n\n`;
      response += `**Hash**: \`${result.hash}\`\n`;
      response += `**To**: \`${to}\`\n`;
      response += `**Amount**: ${amount} ${chain}\n`;
      response += `**Status**: ${result.status}\n`;

      return response;
    } catch (error) {
      logger.error('Send crypto error:', error);
      return `❌ Error sending crypto: ${error.message}`;
    }
  }
  
  async signMessageWithWallet(params) {
    try {
      const { message } = params;
      if (!message) {
        return `❌ No message provided. Usage: "sign message Hello World"`;
      }
      
      const { signatureService } = await import('../services/crypto/signatureService.js');
      const result = await signatureService.signMessage(message);
      
      let response = `✅ **Message Signed**\n\n`;
      response += `**Message**: ${message}\n`;
      response += `**Signature**: \`${result.signature}\`\n`;
      response += `**Signer**: \`${result.address}\`\n`;
      
      return response;
    } catch (error) {
      logger.error('Sign message error:', error);
      return `❌ Error signing message: ${error.message}`;
    }
  }
  
  // Nano Methods
  async receiveNano() {
    try {
      const nanoService = (await import('../services/crypto/nanoService.js')).default;
      const walletService = (await import('../services/crypto/walletService.js')).default;
      const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
      if (!nanoAddr) return '❌ No Nano address found. Wallet may need re-initialization.';

      const result = await nanoService.receiveAll(nanoAddr.address);
      if (result.received === 0) return '✅ No pending Nano blocks to receive.';

      let response = `✅ **Received ${result.received} Nano block(s)**\n\n`;
      for (const block of result.blocks) {
        if (block.hash) {
          response += `- ${block.amount} XNO (hash: \`${block.hash.substring(0, 16)}...\`)\n`;
        }
      }
      return response;
    } catch (error) {
      logger.error('Nano receive error:', error);
      return `❌ Error receiving Nano: ${error.message}`;
    }
  }

  async claimNanoFaucet() {
    try {
      const faucetService = (await import('../services/crypto/faucetService.js')).default;
      const walletService = (await import('../services/crypto/walletService.js')).default;
      const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
      if (!nanoAddr) return '❌ No Nano address found.';

      const result = await faucetService.claimFromNanoFaucet(nanoAddr.address);
      if (result.success) {
        return `✅ **Nano faucet claimed!** (${result.faucet})\nFunds will be auto-pocketed shortly.`;
      } else {
        return `❌ Nano faucet claim failed: ${result.error}`;
      }
    } catch (error) {
      logger.error('Nano faucet error:', error);
      return `❌ Error claiming Nano faucet: ${error.message}`;
    }
  }

  // Smart Contract Methods
  async readSmartContract(params) {
    try {
      const { address, function: functionName, network = 'ethereum' } = params;
      
      if (!address || !functionName) {
        return `❌ Missing parameters. Usage: "read contract 0x123... function balanceOf"`;
      }
      
      const { contractService } = await import('../services/crypto/contractServiceWrapper.js');
      const result = await contractService.readContract({
        address,
        functionName,
        network
      });
      
      let response = `📖 **Contract Read Result**\n\n`;
      response += `**Contract**: \`${address}\`\n`;
      response += `**Function**: ${functionName}\n`;
      response += `**Result**: ${safeJsonStringify(result, 2)}\n`;
      
      return response;
    } catch (error) {
      logger.error('Read contract error:', error);
      return `❌ Error reading contract: ${error.message}`;
    }
  }
  
  async writeToSmartContract(params) {
    try {
      const { address, function: functionName, args = [], network = 'ethereum' } = params;
      
      if (!address || !functionName) {
        return `❌ Missing parameters. Usage: "write to contract 0x123... function transfer"`;
      }
      
      const { transactionService } = await import('../services/crypto/transactionService.js');
      const result = await transactionService.writeContract({
        address,
        functionName,
        args,
        network
      });
      
      let response = `✅ **Contract Write Successful**\n\n`;
      response += `**Transaction Hash**: \`${result.hash}\`\n`;
      response += `**Contract**: \`${address}\`\n`;
      response += `**Function**: ${functionName}\n`;
      response += `**Status**: ${result.status}\n`;
      
      return response;
    } catch (error) {
      logger.error('Write contract error:', error);
      return `❌ Error writing to contract: ${error.message}`;
    }
  }
  
  async deploySmartContract(params) {
    try {
      const { type = 'ERC20', name, symbol, network = 'ethereum' } = params;
      
      const { hardhatService } = await import('../services/crypto/hardhatService.js');
      const result = await hardhatService.deployContract({
        template: type,
        params: { name, symbol },
        network
      });
      
      let response = `🚀 **Contract Deployed Successfully!**\n\n`;
      response += `**Address**: \`${result.address}\`\n`;
      response += `**Type**: ${type}\n`;
      response += `**Network**: ${network}\n`;
      response += `**Transaction**: \`${result.deployTransaction.hash}\`\n`;
      
      return response;
    } catch (error) {
      logger.error('Deploy contract error:', error);
      return `❌ Error deploying contract: ${error.message}`;
    }
  }
  
  async monitorContractEvents(params) {
    try {
      const { address, event, network = 'ethereum' } = params;
      
      if (!address || !event) {
        return `❌ Missing parameters. Usage: "monitor contract events 0x123... Transfer"`;
      }
      
      const { contractService } = await import('../services/crypto/contractServiceWrapper.js');
      const subscription = await contractService.subscribeToEvents({
        address,
        eventName: event,
        network
      });
      
      let response = `👁️ **Monitoring Contract Events**\n\n`;
      response += `**Contract**: \`${address}\`\n`;
      response += `**Event**: ${event}\n`;
      response += `**Network**: ${network}\n`;
      response += `**Status**: Active monitoring started\n`;
      
      return response;
    } catch (error) {
      logger.error('Monitor events error:', error);
      return `❌ Error monitoring events: ${error.message}`;
    }
  }
  
  // Development Methods
  async createBlockchainProject(params) {
    try {
      const { name, template = 'basic' } = params;
      
      if (!name) {
        return `❌ Project name required. Usage: "create hardhat project MyDApp"`;
      }
      
      const { hardhatService } = await import('../services/crypto/hardhatService.js');
      const result = await hardhatService.createProject({
        name,
        template
      });
      
      let response = `🛠️ **Blockchain Project Created**\n\n`;
      response += `**Name**: ${name}\n`;
      response += `**Path**: ${result.path}\n`;
      response += `**Template**: ${template}\n`;
      response += `**Status**: Ready for development\n`;
      
      return response;
    } catch (error) {
      logger.error('Create project error:', error);
      return `❌ Error creating project: ${error.message}`;
    }
  }
  
  async compileSmartContracts(params = {}) {
    try {
      const { projectName = 'default' } = params || {};

      const { hardhatService } = await import('../services/crypto/hardhatService.js');

      if (!hardhatService.initialized) {
        await hardhatService.initialize();
      }

      const result = await hardhatService.compile(projectName);

      let response = `✅ **Contracts Compiled Successfully**\n\n`;
      response += `**Project**: ${projectName}\n`;
      response += `**Artifacts**: ${result.artifacts?.length || 0} contracts\n`;

      return response;
    } catch (error) {
      logger.error('Compile contracts error:', error);
      return `❌ Error compiling contracts: ${error.message}\n\n` +
             `💡 Tip: First create a project with "create hardhat project [name]"`;
    }
  }

  async testSmartContracts(params = {}) {
    try {
      const { projectName = 'default' } = params || {};

      const { hardhatService } = await import('../services/crypto/hardhatService.js');

      if (!hardhatService.initialized) {
        await hardhatService.initialize();
      }

      // hardhatService doesn't have testContracts, use compile as a check for now
      const projectPath = `${process.cwd()}/contracts/${projectName}`;
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const { stdout } = await execAsync('npx hardhat test', { cwd: projectPath });

      let response = `✅ **Contract Tests Completed**\n\n`;
      response += `**Project**: ${projectName}\n`;
      response += `**Output**:\n\`\`\`\n${stdout.slice(0, 500)}\n\`\`\`\n`;

      return response;
    } catch (error) {
      logger.error('Test contracts error:', error);
      return `❌ Error testing contracts: ${error.message}\n\n` +
             `💡 Tip: First create a project with "create hardhat project [name]"`;
    }
  }
  
  // Token Methods
  async checkTokenBalance(params) {
    try {
      const { token, address, network = 'ethereum' } = params;
      
      if (!token) {
        return `❌ Token address required. Usage: "check USDT balance"`;
      }
      
      const { contractService } = await import('../services/crypto/contractServiceWrapper.js');
      const balance = await contractService.getTokenBalance({
        tokenAddress: token,
        address: address || (await walletService.getWalletInfo()).addresses.ETH,
        network
      });
      
      let response = `💰 **Token Balance**\n\n`;
      response += `**Token**: ${token}\n`;
      response += `**Balance**: ${balance}\n`;
      response += `**Network**: ${network}\n`;
      
      return response;
    } catch (error) {
      logger.error('Check token balance error:', error);
      return `❌ Error checking token balance: ${error.message}`;
    }
  }
  
  async transferTokens(params) {
    try {
      const { token, to, amount, network = 'ethereum' } = params;
      
      if (!token || !to || !amount) {
        return `❌ Missing parameters. Usage: "transfer 100 USDT to 0x123..."`;
      }
      
      const { transactionService } = await import('../services/crypto/transactionService.js');
      const result = await transactionService.transferToken({
        tokenAddress: token,
        to,
        amount,
        network
      });
      
      let response = `✅ **Tokens Transferred**\n\n`;
      response += `**Transaction**: \`${result.hash}\`\n`;
      response += `**Amount**: ${amount}\n`;
      response += `**To**: \`${to}\`\n`;
      
      return response;
    } catch (error) {
      logger.error('Transfer tokens error:', error);
      return `❌ Error transferring tokens: ${error.message}`;
    }
  }
  
  async approveTokenSpending(params) {
    try {
      const { token, spender, amount, network = 'ethereum' } = params;
      
      if (!token || !spender || !amount) {
        return `❌ Missing parameters. Usage: "approve USDT spending for 0x123..."`;
      }
      
      const { transactionService } = await import('../services/crypto/transactionService.js');
      const result = await transactionService.approveToken({
        tokenAddress: token,
        spender,
        amount,
        network
      });
      
      let response = `✅ **Token Approval Granted**\n\n`;
      response += `**Transaction**: \`${result.hash}\`\n`;
      response += `**Spender**: \`${spender}\`\n`;
      response += `**Amount**: ${amount}\n`;
      
      return response;
    } catch (error) {
      logger.error('Approve tokens error:', error);
      return `❌ Error approving tokens: ${error.message}`;
    }
  }
  
  // Network Methods
  async switchBlockchainNetwork(params) {
    try {
      const { network } = params;
      
      if (!network) {
        return `❌ Network name required. Usage: "switch to polygon"`;
      }
      
      const { contractService } = await import('../services/crypto/contractServiceWrapper.js');
      await contractService.switchNetwork(network);
      
      return `✅ Switched to **${network}** network`;
    } catch (error) {
      logger.error('Switch network error:', error);
      return `❌ Error switching network: ${error.message}`;
    }
  }
  
  async getNetworkInformation() {
    try {
      // Return available network configurations
      const networks = {
        ethereum: { name: 'Ethereum Mainnet', chainId: 1, rpcUrl: 'https://eth.llamarpc.com', explorer: 'https://etherscan.io' },
        sepolia: { name: 'Sepolia Testnet', chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
        polygon: { name: 'Polygon Mainnet', chainId: 137, rpcUrl: 'https://polygon-rpc.com', explorer: 'https://polygonscan.com' },
        mumbai: { name: 'Mumbai Testnet', chainId: 80001, rpcUrl: 'https://rpc-mumbai.maticvigil.com', explorer: 'https://mumbai.polygonscan.com' },
        bsc: { name: 'BNB Smart Chain', chainId: 56, rpcUrl: 'https://bsc-dataseed.binance.org', explorer: 'https://bscscan.com' }
      };

      let response = `🌐 **Available Networks**\n\n`;
      for (const [key, info] of Object.entries(networks)) {
        response += `**${info.name}** (\`${key}\`)\n`;
        response += `  Chain ID: ${info.chainId}\n`;
        response += `  Explorer: ${info.explorer}\n\n`;
      }
      response += `\n💡 Use "switch to [network]" to change networks`;

      return response;
    } catch (error) {
      logger.error('Get network info error:', error);
      return `❌ Error getting network info: ${error.message}`;
    }
  }
  
  // Faucet Methods
  async claimTestnetTokens(params = {}) {
    try {
      const { network = 'sepolia' } = params || {};

      // First check if wallet exists
      const walletService = (await import('../services/crypto/walletService.js')).default;
      if (!walletService.wallet) {
        return `❌ No wallet found. First generate a wallet with "create wallet" or "generate wallet"`;
      }

      const { faucetService } = await import('../services/crypto/faucetService.js');

      if (!faucetService || !faucetService.claimFaucet) {
        // Return helpful info about testnet faucets
        let response = `💧 **Testnet Faucets**\n\n`;
        response += `To claim testnet tokens, visit these faucets:\n\n`;
        response += `**Sepolia (ETH)**:\n`;
        response += `  • https://sepoliafaucet.com\n`;
        response += `  • https://faucet.quicknode.com/ethereum/sepolia\n\n`;
        response += `**Mumbai (MATIC)**:\n`;
        response += `  • https://faucet.polygon.technology\n\n`;
        response += `**BSC Testnet (BNB)**:\n`;
        response += `  • https://testnet.binance.org/faucet-smart\n`;
        return response;
      }

      const result = await faucetService.claimFaucet(network);

      let response = `💧 **Testnet Tokens Claimed**\n\n`;
      response += `**Network**: ${network}\n`;
      response += `**Amount**: ${result.amount}\n`;
      response += `**Transaction**: \`${result.hash}\`\n`;
      response += `**Next claim**: ${result.nextClaim}\n`;

      return response;
    } catch (error) {
      logger.error('Claim faucet error:', error);
      return `❌ Error claiming faucet: ${error.message}\n\n` +
             `💡 Tip: Visit https://sepoliafaucet.com to claim testnet ETH manually`;
    }
  }
  
  // Transaction Methods
  async estimateTransactionGas(params) {
    try {
      const { to, amount, data, network = 'ethereum' } = params;
      
      const { transactionService } = await import('../services/crypto/transactionService.js');
      const estimate = await transactionService.estimateGas({
        to,
        value: amount,
        data,
        network
      });
      
      let response = `⛽ **Gas Estimation**\n\n`;
      response += `**Gas Units**: ${estimate.gasLimit}\n`;
      response += `**Gas Price**: ${estimate.gasPrice} gwei\n`;
      response += `**Total Cost**: ${estimate.totalCost} ETH\n`;
      response += `**USD Value**: $${estimate.usdValue}\n`;
      
      return response;
    } catch (error) {
      logger.error('Estimate gas error:', error);
      return `❌ Error estimating gas: ${error.message}`;
    }
  }
  
  async getTransactionHistory(params) {
    try {
      const { address, network = 'ethereum', limit = 10 } = params;
      
      const walletService = (await import('../services/crypto/walletService.js')).default;
      const wallet = await walletService.getWalletInfo();
      const targetAddress = address || wallet.addresses.ETH;
      
      const { contractService } = await import('../services/crypto/contractServiceWrapper.js');
      const transactions = await contractService.getTransactionHistory({
        address: targetAddress,
        network,
        limit
      });
      
      let response = `📜 **Transaction History**\n\n`;
      
      for (const tx of transactions) {
        response += `**${tx.type}** - ${tx.value} ETH\n`;
        response += `Hash: \`${tx.hash}\`\n`;
        response += `${tx.from === targetAddress ? 'To' : 'From'}: \`${tx.from === targetAddress ? tx.to : tx.from}\`\n`;
        response += `Time: ${new Date(tx.timestamp).toLocaleString()}\n\n`;
      }
      
      return response;
    } catch (error) {
      logger.error('Get transaction history error:', error);
      return `❌ Error getting transaction history: ${error.message}`;
    }
  }

  // ======= CRYPTO TRADING METHODS =======

  /**
   * Get the CryptoStrategyAgent handler via SubAgent orchestrator
   */
  async _getCryptoHandler() {
    if (!this.subAgentOrchestrator) return null;
    const SubAgent = (await import('../models/SubAgent.js')).default;
    const agents = await SubAgent.find({ domain: 'crypto', type: 'domain' });
    if (!agents?.length) return null;
    return this.subAgentOrchestrator.agentHandlers.get(agents[0]._id.toString());
  }

  async getCryptoTradingStatus() {
    try {
      const handler = await this._getCryptoHandler();
      if (!handler) {
        return `The crypto trading agent is not initialized or not running. Check if the SubAgent orchestrator is enabled.`;
      }

      const status = handler.getStatus();
      const config = status.config || {};
      const state = status.state || {};
      const positions = state.positions || {};

      let response = `**Crypto Trading Status**\n\n`;
      const runLabel = !status.enabled ? 'Disabled' : status.isRunning ? 'Executing heartbeat' : 'Active (idle between heartbeats)';
      response += `**Status**: ${runLabel}\n`;
      response += `**Network**: ${status.networkMode}\n`;
      response += `**Strategy**: ${status.strategy}\n`;
      if (status.secondaryStrategy) {
        response += `**Secondary**: ${status.secondaryStrategy}\n`;
      }
      response += `**Auto-Execute**: ${config.autoExecute ? 'Yes' : 'No'}\n`;
      response += `**Emergency Stop**: ${config.emergencyStop ? 'ACTIVE' : 'Off'}\n\n`;

      // P&L
      response += `**P&L**: Daily ${state.dailyPnL >= 0 ? '+' : ''}${(state.dailyPnL || 0).toFixed(2)}% | Total ${state.totalPnL >= 0 ? '+' : ''}${(state.totalPnL || 0).toFixed(2)}%\n`;
      response += `**Trades**: ${state.tradesExecuted || 0} executed, ${state.tradesProposed || 0} proposed\n\n`;

      // Market regime from strategy info
      if (status.strategyInfo?.state?.marketRegime) {
        const regimes = status.strategyInfo.state.marketRegime;
        response += `**Market Regimes**:\n`;
        for (const [key, regime] of Object.entries(regimes)) {
          response += `  ${key}: ${regime.regime} (score: ${regime.score?.toFixed(1)})\n`;
        }
        response += `\n`;
      }

      // Schedule
      if (status.schedule?.nextRunAt) {
        response += `**Next Run**: ${new Date(status.schedule.nextRunAt).toLocaleString()}\n`;
      }

      // Token Trader positions
      if (status.tokenTraderStatus?.configured) {
        const tt = status.tokenTraderStatus;
        const sym = tt.token?.symbol || 'unknown';
        response += `\n**Token Trader (${sym.toUpperCase()})**:\n`;
        response += `  Network: ${tt.token?.network || 'bsc'}\n`;
        if (tt.position) {
          const p = tt.position;
          response += `  Balance: ${parseFloat(p.tokenBalance || 0).toFixed(4)} tokens\n`;
          response += `  Reserve: $${parseFloat(p.stablecoinReserve || 0).toFixed(2)}\n`;
          response += `  Avg Entry: $${parseFloat(p.averageEntryPrice || 0).toFixed(6)}\n`;
          response += `  Total Invested: $${parseFloat(p.totalInvested || 0).toFixed(2)}\n`;
        }
        if (tt.pnl) {
          response += `  P&L: unrealized ${tt.pnl.unrealized >= 0 ? '+' : ''}${parseFloat(tt.pnl.unrealized || 0).toFixed(2)}%, realized ${tt.pnl.realized >= 0 ? '+' : ''}${parseFloat(tt.pnl.realized || 0).toFixed(2)}%\n`;
        }
        if (tt.regime) {
          response += `  Regime: ${tt.regime}\n`;
        }
        if (tt.lastPrice) {
          response += `  Last Price: $${parseFloat(tt.lastPrice).toFixed(6)}\n`;
        }
      }

      // Recent trades (skip holds — only show actual buys/sells)
      if (status.recentTrades?.length > 0) {
        const actualTrades = status.recentTrades.filter(t => {
          const action = t.result?.action || '';
          return action !== 'hold' && action !== '';
        });
        if (actualTrades.length > 0) {
          response += `\n**Recent Trades**:\n`;
          for (const trade of actualTrades.slice(-5)) {
            const action = trade.result?.action || trade.strategy || 'trade';
            const network = trade.result?.network || trade.network || '?';
            const amount = trade.result?.amountUSD?.toFixed(2) || trade.result?.amountIn?.toFixed(2) || '?';
            const success = trade.success ? 'OK' : 'FAILED';
            const reason = trade.result?.reason ? ` — ${trade.result.reason.slice(0, 80)}` : '';
            const txHash = trade.result?.txHash ? ` tx:${trade.result.txHash.slice(0, 10)}...` : '';
            const date = trade.timestamp ? new Date(trade.timestamp).toLocaleString() : '?';
            response += `  ${action} on ${network}: $${amount} [${success}]${txHash} (${date})${reason}\n`;
          }
        }
      }

      return response;
    } catch (error) {
      logger.error('Get crypto trading status error:', error);
      return `Error getting trading status: ${error.message}`;
    }
  }

  async getCryptoPositions() {
    try {
      const handler = await this._getCryptoHandler();
      if (!handler) {
        return `The crypto trading agent is not initialized.`;
      }

      const positions = handler.getPositions();
      if (!positions || Object.keys(positions).length === 0) {
        return `No crypto positions currently tracked. The strategy may not have started yet.`;
      }

      let response = `**Crypto Positions**\n\n`;

      for (const [network, pos] of Object.entries(positions)) {
        response += `**${network.toUpperCase()}**:\n`;
        response += `  Holding: ${pos.inStablecoin ? 'Stablecoin' : 'Native'}\n`;
        if (pos.stablecoinAmount) {
          response += `  Stablecoin: $${parseFloat(pos.stablecoinAmount).toFixed(2)}\n`;
        }
        if (pos.nativeAmount) {
          response += `  Native: ${parseFloat(pos.nativeAmount).toFixed(4)}\n`;
        }
        if (pos.entryPrice) {
          response += `  Entry Price: $${parseFloat(pos.entryPrice).toFixed(2)}\n`;
        }
        if (pos.updatedAt) {
          response += `  Updated: ${new Date(pos.updatedAt).toLocaleString()}\n`;
        }
        response += `\n`;
      }

      // Token Trader position (secondary strategy)
      try {
        const status = handler.getStatus();
        if (status.tokenTraderStatus?.configured) {
          const tt = status.tokenTraderStatus;
          const sym = tt.token?.symbol || 'unknown';
          const p = tt.position;
          response += `**TOKEN TRADER (${sym.toUpperCase()})**:\n`;
          response += `  Network: ${tt.token?.network || 'bsc'}\n`;
          if (p) {
            response += `  Balance: ${parseFloat(p.tokenBalance || 0).toFixed(4)} tokens\n`;
            response += `  Reserve: $${parseFloat(p.stablecoinReserve || 0).toFixed(2)}\n`;
            response += `  Avg Entry: $${parseFloat(p.averageEntryPrice || 0).toFixed(6)}\n`;
            response += `  Total Invested: $${parseFloat(p.totalInvested || 0).toFixed(2)}\n`;
          }
          if (tt.pnl) {
            response += `  P&L: unrealized ${tt.pnl.unrealized >= 0 ? '+' : ''}${parseFloat(tt.pnl.unrealized || 0).toFixed(2)}%, realized ${tt.pnl.realized >= 0 ? '+' : ''}${parseFloat(tt.pnl.realized || 0).toFixed(2)}%\n`;
          }
          if (tt.regime) {
            response += `  Regime: ${tt.regime}\n`;
          }
          if (tt.lastPrice) {
            response += `  Last Price: $${parseFloat(tt.lastPrice).toFixed(6)}\n`;
          }
          response += `\n`;
        }
      } catch (e) { /* token trader may not be configured */ }

      return response;
    } catch (error) {
      logger.error('Get crypto positions error:', error);
      return `Error getting positions: ${error.message}`;
    }
  }

  async getCryptoTradeHistory() {
    try {
      const handler = await this._getCryptoHandler();
      if (!handler) {
        return `The crypto trading agent is not initialized.`;
      }

      // Try in-memory trade journal first (recent executed trades)
      const trades = handler.tradeJournal || [];
      // Fall back to persisted decision journal
      const decisions = handler.getJournal(20);

      if (trades.length === 0 && (!decisions || decisions.length === 0)) {
        const state = handler.getStatus()?.state || {};
        if (state.tradesExecuted > 0) {
          return `**Trade History**\n\n${state.tradesExecuted} trades executed total, but detailed journal was cleared on last restart.\nTrades since restart: 0\n\nTotal P&L: ${(state.totalPnL || 0).toFixed(2)}%`;
        }
        return `No trades in the journal yet. The strategy hasn't executed any trades.`;
      }

      let response = '';

      // Show executed trades if available
      if (trades.length > 0) {
        response += `**Recent Trades** (${trades.length} since restart)\n\n`;
        for (const entry of trades.slice(-10)) {
          const date = new Date(entry.timestamp).toLocaleString();
          const pnl = entry.pnl ? ` | P&L: ${entry.pnl >= 0 ? '+' : ''}${entry.pnl.toFixed(2)}%` : '';
          response += `**${entry.action?.toUpperCase() || 'TRADE'}** ${entry.symbol || entry.network || ''}`;
          response += ` @ $${entry.price?.toFixed(2) || '?'}${pnl}\n`;
          response += `  ${date} | ${entry.strategy || 'unknown'}\n`;
          if (entry.reason) response += `  Reason: ${entry.reason}\n`;
          response += `\n`;
        }
      }

      // Show decision journal entries
      if (decisions.length > 0 && trades.length === 0) {
        response += `**Decision Journal** (${decisions.length} entries)\n\n`;
        for (const entry of decisions.slice(-10)) {
          const date = new Date(entry.timestamp).toLocaleString();
          const decision = entry.decision || {};
          response += `**${decision.action?.toUpperCase() || 'DECISION'}** ${decision.network || ''}\n`;
          response += `  ${date}\n`;
          if (entry.marketSnapshot?.prices) {
            const prices = Object.entries(entry.marketSnapshot.prices);
            response += `  Prices: ${prices.map(([k, v]) => `${k}: $${v?.toFixed?.(2) || v}`).join(', ')}\n`;
          }
          response += `\n`;
        }
      }

      return response;
    } catch (error) {
      logger.error('Get crypto trade history error:', error);
      return `Error getting trade history: ${error.message}`;
    }
  }

  async handleCryptoSwapRequest(input, params) {
    try {
      const handler = await this._getCryptoHandler();
      if (!handler) {
        return `The crypto trading agent is not initialized. Cannot process swap request.`;
      }

      const status = handler.getStatus();
      if (status.config?.emergencyStop) {
        return `Emergency stop is active. Trading is halted. Clear the emergency stop first to execute swaps.`;
      }

      // Parse the swap intent from natural language
      const inputLower = input.toLowerCase();

      // Detect buy/sell/swap patterns
      let fromToken, toToken, amount;

      // "buy ETH" / "buy 0.5 ETH"
      const buyMatch = inputLower.match(/buy\s+(?:(\d+\.?\d*)\s+)?(\w+)/);
      // "sell ETH" / "sell all ETH" / "sell 0.5 ETH"
      const sellMatch = inputLower.match(/sell\s+(?:all\s+)?(?:my\s+)?(?:(\d+\.?\d*)\s+)?(\w+)/);
      // "swap ETH for USDT" / "swap 0.5 ETH to USDT" / "swap my ETH for USDT"
      const swapMatch = inputLower.match(/(?:swap|exchange|trade|convert)\s+(?:my\s+)?(?:(\d+\.?\d*)\s+)?(\w+)\s+(?:for|to|into)\s+(\w+)/);

      if (swapMatch) {
        amount = swapMatch[1] || null;
        fromToken = swapMatch[2].toUpperCase();
        toToken = swapMatch[3].toUpperCase();
      } else if (buyMatch) {
        amount = buyMatch[1] || null;
        toToken = buyMatch[2].toUpperCase();
        fromToken = 'USDT';
      } else if (sellMatch) {
        amount = sellMatch[1] || null;
        fromToken = sellMatch[2].toUpperCase();
        toToken = 'USDT';
      }

      if (!fromToken || !toToken) {
        return `I couldn't parse your swap request. Try:\n- "buy ETH"\n- "sell BNB"\n- "swap ETH for USDT"\n- "swap 0.5 BNB to USDT"`;
      }

      // Normalize common aliases
      const aliases = { ETHEREUM: 'ETH', ETHER: 'ETH', BINANCE: 'BNB', TETHER: 'USDT', 'USDC': 'USDC' };
      fromToken = aliases[fromToken] || fromToken;
      toToken = aliases[toToken] || toToken;

      let response = `**Swap Request Parsed**\n\n`;
      response += `From: ${fromToken}\n`;
      response += `To: ${toToken}\n`;
      if (amount) response += `Amount: ${amount}\n`;
      response += `\n`;

      // For safety, inform the user about the strategy's auto-execution rather than executing manually
      if (status.config?.autoExecute) {
        response += `The trading strategy is running with auto-execute enabled. `;
        response += `Manual swaps can conflict with the active **${status.strategy}** strategy.\n\n`;
        response += `To execute a manual swap, use the Web UI at **/crypto/swap** or the API:\n`;
        response += `\`POST /api/crypto/swap/execute\`\n\n`;
        response += `Or trigger a strategy run: \`POST /api/crypto/strategy/trigger\``;
      } else {
        response += `Auto-execute is disabled. Use the Web UI or API to execute this swap:\n`;
        response += `\`POST /api/crypto/swap/execute\` with \`{ fromToken: "${fromToken}", toToken: "${toToken}"${amount ? `, amount: "${amount}"` : ''} }\``;
      }

      return response;
    } catch (error) {
      logger.error('Handle crypto swap request error:', error);
      return `Error processing swap request: ${error.message}`;
    }
  }

  /**
   * Extract media generation prompt from user input
   * Removes trigger phrases like "generate an image of", "create a video showing", etc.
   */
  extractMediaPrompt(input, mediaType = 'image') {
    // Common trigger phrases to remove
    const imagePhrases = [
      /^(generate|create|make|draw|design|render)\s+(an?\s+)?(image|picture|photo|illustration|artwork|art)\s+(of|that\s+shows?|showing|with|depicting)\s*/i,
      /^(generate|create|make|draw|design|render)\s+(me\s+)?(an?\s+)?(image|picture|photo|illustration|artwork|art)\s*/i,
      /^(send|show)\s+(me\s+)?(an?\s+)?(random\s+)?(image|picture|photo)\s*(of\s+)?/i,
      /^(can you\s+)?(please\s+)?(generate|create|make)\s+(an?\s+)?(image|picture)\s+(of\s+)?/i
    ];

    const videoPhrases = [
      /^(generate|create|make|render)\s+(a\s+)?video\s+(of|that\s+shows?|showing|with|depicting)\s*/i,
      /^(generate|create|make|render)\s+(me\s+)?(a\s+)?video\s*/i,
      /^(send|show)\s+(me\s+)?(a\s+)?(random\s+)?video\s*(of\s+)?/i,
      /^(can you\s+)?(please\s+)?(generate|create|make)\s+(a\s+)?video\s+(of\s+)?/i,
      /^(create|make)\s+(an?\s+)?animation\s+(of\s+)?/i
    ];

    const phrases = mediaType === 'video' ? videoPhrases : imagePhrases;
    let prompt = input;

    for (const phrase of phrases) {
      prompt = prompt.replace(phrase, '');
    }

    // Trim and return
    prompt = prompt.trim();

    // If prompt is empty or very short, use the original input
    if (!prompt || prompt.length < 3) {
      prompt = input;
    }

    return prompt;
  }

  /**
   * Poll for OpenAI video job completion and send notification when ready
   */
  /**
   * Generate video in the background and send via Telegram when ready
   */
  async generateVideoInBackground(videoService, prompt, context) {
    const provider = videoService.getSettings()?.provider || 'modelslab';
    logger.info(`[video-bg] Starting background ${provider} video generation`);
    try {
      const videoResult = await videoService.generate(prompt);

      if (videoResult.success && videoResult.video?.buffer) {
        const os = await import('os');
        const fs = await import('fs/promises');
        const path = await import('path');

        const tmpPath = path.default.join(os.default.tmpdir(), `lanagent_vid_${Date.now()}.mp4`);
        await fs.default.writeFile(tmpPath, videoResult.video.buffer);
        logger.info(`[video-bg] Video saved to ${tmpPath} (${videoResult.video.buffer.length} bytes)`);

        let caption = `Your video is ready! Generated: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`;

        // Warn user if we fell back to a moderated provider
        if (videoResult.fallbackWarning) {
          caption = `[Note: ${videoResult.fallbackWarning}]\n\n${caption}`;
        }

        // Send via Telegram (same pattern as pollVideoJobAndNotify)
        const telegramInterface = this.interfaces.get('telegram');
        const chatId = context?.chatId || context?.telegramChatId || process.env.TELEGRAM_USER_ID;
        if (chatId && telegramInterface?.bot) {
          try {
            await telegramInterface.bot.telegram.sendVideo(
              chatId,
              { source: tmpPath },
              { caption, supports_streaming: true }
            );
            logger.info(`[video-bg] Video sent to Telegram chat ${chatId}`);
          } catch (sendError) {
            logger.error(`[video-bg] Failed to send video via Telegram:`, sendError.message);
            try {
              await telegramInterface.bot.telegram.sendDocument(
                chatId,
                { source: tmpPath },
                { caption }
              );
              logger.info(`[video-bg] Video sent as document to Telegram chat ${chatId}`);
            } catch (docError) {
              logger.error(`[video-bg] Failed to send as document too:`, docError.message);
            }
          }
        } else {
          logger.warn(`[video-bg] No Telegram delivery available (chatId=${chatId}, bot=${!!telegramInterface?.bot})`);
        }

        // Cleanup
        try { await fs.default.unlink(tmpPath); } catch (_) {}
      } else {
        throw new Error('No video buffer in result');
      }
    } catch (error) {
      logger.error(`[video-bg] Background generation failed:`, error.message);
      const telegramInterface = this.interfaces.get('telegram');
      const chatId = context?.chatId || context?.telegramChatId || process.env.TELEGRAM_USER_ID;
      if (chatId && telegramInterface?.bot) {
        try {
          await telegramInterface.bot.telegram.sendMessage(chatId, `Video generation failed: ${error.message}`);
        } catch (sendError) {
          logger.error('[video-bg] Failed to send error notification:', sendError.message);
        }
      }
    }
  }

  async pollVideoJobAndNotify(jobId, prompt, context) {
    logger.info(`[video-poll] Starting background poll for job ${jobId}`);
    try {
      const videoService = (await import('../services/media/videoGenerationService.js')).default;
      const openaiProvider = this.providerManager.providers.get('openai');

      if (!openaiProvider) {
        logger.error('[video-poll] OpenAI provider not available for video polling');
        return;
      }

      logger.info(`[video-poll] Polling job ${jobId} with OpenAI provider...`);
      const result = await videoService.pollJobStatus(jobId, openaiProvider);
      logger.info(`[video-poll] Job ${jobId} poll result: success=${result.success}, hasBuffer=${!!result.video?.buffer}`);

      if (result.success && result.video?.buffer) {
        const os = await import('os');
        const fs = await import('fs/promises');
        const path = await import('path');

        const tmpPath = path.default.join(os.default.tmpdir(), `lanagent_vid_${Date.now()}.mp4`);
        await fs.default.writeFile(tmpPath, result.video.buffer);
        logger.info(`[video-poll] Video saved to ${tmpPath} (${result.video.buffer.length} bytes)`);

        const caption = `Your video is ready! Generated: ${prompt.substring(0, 100)}`;

        // Send through Telegram — use the telegram interface from this.interfaces
        const telegramInterface = this.interfaces.get('telegram');
        if (telegramInterface?.bot) {
          const chatId = context.telegramChatId || process.env.TELEGRAM_USER_ID;
          if (chatId) {
            try {
              await telegramInterface.bot.telegram.sendVideo(
                chatId,
                { source: tmpPath },
                { caption, supports_streaming: true }
              );
              logger.info(`[video-poll] Video sent to Telegram chat ${chatId}`);
            } catch (sendError) {
              logger.error(`[video-poll] Failed to send video via Telegram:`, sendError.message);
              // Try as document fallback (video might be too large)
              try {
                await telegramInterface.bot.telegram.sendDocument(
                  chatId,
                  { source: tmpPath },
                  { caption }
                );
                logger.info(`[video-poll] Video sent as document to Telegram chat ${chatId}`);
              } catch (docError) {
                logger.error(`[video-poll] Failed to send as document too:`, docError.message);
                await telegramInterface.bot.telegram.sendMessage(
                  chatId,
                  `Video generated but too large to send. Saved at: ${tmpPath}\nPrompt: ${prompt.substring(0, 200)}`
                );
              }
            }
          } else {
            logger.warn('[video-poll] No Telegram chat ID available for video delivery');
          }
        } else {
          logger.warn('[video-poll] Telegram interface not available for video delivery');
        }
      }
    } catch (error) {
      logger.error(`[video-poll] Polling failed for job ${jobId}:`, error.message);

      // Try to notify user of failure via Telegram
      const telegramInterface = this.interfaces.get('telegram');
      if (telegramInterface?.bot) {
        const chatId = context.telegramChatId || process.env.TELEGRAM_USER_ID;
        if (chatId) {
          try {
            await telegramInterface.bot.telegram.sendMessage(
              chatId,
              `Video generation failed (Job: ${jobId}): ${error.message}`
            );
          } catch (sendError) {
            logger.error('[video-poll] Failed to send error notification:', sendError.message);
          }
        }
      }
    }
  }

  /**
   * Determine if a plugin output should have AI interpretation
   */
  shouldInterpretOutput(plugin, action, result) {
    // Don't interpret simple success messages
    if (typeof result === 'string' && result.length < 100) {
      return false;
    }
    
    // Always interpret technical outputs
    const technicalPlugins = ['system', 'docker', 'git', 'monitoring', 'network', 'firewall'];
    if (technicalPlugins.includes(plugin)) {
      return true;
    }
    
    // Interpret complex data structures
    if (typeof result === 'object' && result !== null) {
      // Check if it has arrays or multiple properties
      const keys = Object.keys(result);
      if (keys.length > 3 || keys.some(k => Array.isArray(result[k]))) {
        return true;
      }
    }
    
    // Interpret list/status commands
    const listActions = ['list', 'status', 'get', 'fetch', 'scan', 'analyze'];
    if (listActions.some(a => action.toLowerCase().includes(a))) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Generate AI interpretation of command output
   */
  async interpretCommandOutput(userInput, plugin, action, result, rawOutput) {
    try {
      // Build context about what was executed
      const commandContext = `The user asked: "${userInput}"
I executed: ${plugin}.${action}

Raw output:
${rawOutput}

Full result data: ${typeof result === 'string' ? result : safeJsonStringify(result, 2)}`;

      const interpretPrompt = `As ALICE, provide a friendly, conversational interpretation of this technical output.

${commandContext}

Guidelines:
- Explain what the output means in simple terms
- Highlight important information
- If there are errors or warnings, explain what they mean
- If it's a status output, summarize the key points
- Be helpful and suggest next steps if appropriate
- Keep it concise but informative
- Don't repeat the raw output, add value with interpretation
- Speak in first person as ALICE`;

      const interpretation = await this.processWithAI(interpretPrompt);
      return interpretation;
      
    } catch (error) {
      logger.error('Failed to interpret command output:', error);
      return null;
    }
  }
}