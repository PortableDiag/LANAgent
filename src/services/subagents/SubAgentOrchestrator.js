import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import SubAgent from '../../models/SubAgent.js';

/**
 * SubAgentOrchestrator
 *
 * Central management for all sub-agents (domain, project, task).
 * Handles lifecycle, scheduling, resource allocation, and coordination.
 */
export class SubAgentOrchestrator extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.initialized = false;

    // Active agent instances (runtime handlers)
    this.agentHandlers = new Map(); // agentId -> handler instance

    // Domain agent registry (type -> handler class)
    this.domainRegistry = new Map();

    // Scheduling
    this.checkInterval = null;
    this.checkIntervalMs = 60000; // Check every minute

    logger.info('SubAgentOrchestrator constructed');
  }

  /**
   * Initialize the orchestrator
   */
  async initialize() {
    try {
      logger.info('Initializing SubAgentOrchestrator...');

      // Recover stale sessions (agents stuck in "running" from previous crash/hang)
      const staleAgents = await SubAgent.find({
        enabled: true,
        status: 'running'
      });

      for (const agent of staleAgents) {
        const sessionAge = agent.state?.currentSession?.startedAt
          ? Date.now() - new Date(agent.state.currentSession.startedAt).getTime()
          : Infinity;
        logger.warn(`Recovering stale agent session: ${agent.name} (stuck in running for ${Math.round(sessionAge / 60000)} min)`);
        agent.status = 'idle';
        agent.state.currentSession = {
          startedAt: null,
          iteration: 0,
          lastAction: null,
          lastResult: { error: 'Stale session recovered on startup' }
        };
        await agent.save();
      }

      if (staleAgents.length > 0) {
        logger.info(`Recovered ${staleAgents.length} stale agent session(s)`);
      }

      // Load and initialize all enabled agents
      const agents = await SubAgent.find({ enabled: true });
      logger.info(`Found ${agents.length} enabled sub-agents`);

      for (const agentDoc of agents) {
        await this.initializeAgent(agentDoc);
      }

      // Start the scheduler check loop
      this.startScheduler();

      this.initialized = true;
      logger.info('SubAgentOrchestrator initialized successfully');

      this.emit('initialized', { agentCount: agents.length });
    } catch (error) {
      logger.error('Failed to initialize SubAgentOrchestrator:', error);
      throw error;
    }
  }

  /**
   * Register a domain agent handler class
   */
  registerDomainHandler(domain, handlerClass) {
    this.domainRegistry.set(domain, handlerClass);
    logger.info(`Registered domain handler: ${domain}`);
  }

  /**
   * Initialize a specific agent
   */
  async initializeAgent(agentDoc) {
    try {
      const agentId = agentDoc._id.toString();

      // Check if already initialized
      if (this.agentHandlers.has(agentId)) {
        logger.debug(`Agent ${agentDoc.name} already initialized`);
        return this.agentHandlers.get(agentId);
      }

      // Get handler class based on type and domain
      let HandlerClass;

      if (agentDoc.type === 'domain') {
        HandlerClass = this.domainRegistry.get(agentDoc.domain);
        if (!HandlerClass) {
          logger.warn(`No handler registered for domain: ${agentDoc.domain}`);
          return null;
        }
      } else {
        // For project and task agents, use generic handlers
        const { ProjectAgentHandler } = await import('./ProjectAgentHandler.js');
        const { TaskAgentHandler } = await import('./TaskAgentHandler.js');
        HandlerClass = agentDoc.type === 'project' ? ProjectAgentHandler : TaskAgentHandler;
      }

      // Create handler instance
      const handler = new HandlerClass(this.agent, agentDoc);
      await handler.initialize();

      this.agentHandlers.set(agentId, handler);
      logger.info(`Initialized agent: ${agentDoc.name} (${agentDoc.type}/${agentDoc.domain || 'generic'})`);

      return handler;
    } catch (error) {
      logger.error(`Failed to initialize agent ${agentDoc.name}:`, error);
      return null;
    }
  }

  /**
   * Start the scheduler check loop
   */
  startScheduler() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      await this.checkScheduledAgents();
    }, this.checkIntervalMs);

    logger.info('Sub-agent scheduler started');
  }

  /**
   * Stop the scheduler
   */
  stopScheduler() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('Sub-agent scheduler stopped');
  }

  /**
   * Check for agents that need to run
   */
  async checkScheduledAgents() {
    try {
      const now = new Date();

      // Find agents that should run
      const dueAgents = await SubAgent.find({
        enabled: true,
        status: { $in: ['idle'] },
        'schedule.nextRunAt': { $lte: now }
      });

      for (const agentDoc of dueAgents) {
        const canRunCheck = agentDoc.canRun();
        if (canRunCheck.canRun) {
          logger.info(`Triggering scheduled run for agent: ${agentDoc.name}`);
          await this.runAgent(agentDoc._id.toString());
        } else {
          logger.debug(`Agent ${agentDoc.name} not ready: ${canRunCheck.reason}`);
        }
      }
    } catch (error) {
      logger.error('Error checking scheduled agents:', error);
    }
  }

  /**
   * Create a new sub-agent
   */
  async createAgent(config) {
    try {
      const agentDoc = new SubAgent({
        name: config.name,
        type: config.type,
        domain: config.domain,
        description: config.description,
        projectId: config.projectId,
        goal: config.goal,
        config: {
          ...config.config,
          domainConfig: config.domainConfig || {}
        },
        schedule: config.schedule,
        tags: config.tags,
        createdBy: config.createdBy || 'system'
      });

      await agentDoc.save();
      logger.info(`Created new sub-agent: ${agentDoc.name}`);

      // Initialize if enabled
      if (agentDoc.enabled) {
        await this.initializeAgent(agentDoc);
      }

      this.emit('agentCreated', { agent: agentDoc.getSummary() });
      return agentDoc;
    } catch (error) {
      logger.error('Failed to create sub-agent:', error);
      throw error;
    }
  }

  /**
   * Get an agent by ID
   */
  async getAgent(agentId) {
    return await SubAgent.findById(agentId);
  }

  /**
   * List all agents
   */
  async listAgents(filter = {}) {
    const query = {};

    if (filter.type) query.type = filter.type;
    if (filter.domain) query.domain = filter.domain;
    if (filter.status) query.status = filter.status;
    if (filter.enabled !== undefined) query.enabled = filter.enabled;

    const agents = await SubAgent.find(query).sort({ type: 1, name: 1 });
    return agents.map(a => a.getSummary());
  }

  /**
   * Update an agent's configuration
   */
  async updateAgent(agentId, updates) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    // Update allowed fields
    const allowedFields = ['name', 'description', 'enabled', 'config', 'goal', 'schedule', 'tags'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        if (field === 'config') {
          agentDoc.config = { ...agentDoc.config, ...updates.config };
        } else {
          agentDoc[field] = updates[field];
        }
      }
    }

    await agentDoc.save();

    // Reinitialize if needed
    if (updates.enabled === true && !this.agentHandlers.has(agentId)) {
      await this.initializeAgent(agentDoc);
    } else if (updates.enabled === false && this.agentHandlers.has(agentId)) {
      await this.stopAgent(agentId);
      this.agentHandlers.delete(agentId);
    }

    this.emit('agentUpdated', { agent: agentDoc.getSummary() });
    return agentDoc;
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    // Stop if running
    if (agentDoc.status === 'running') {
      await this.stopAgent(agentId);
    }

    // Remove handler
    this.agentHandlers.delete(agentId);

    // Delete from database
    await SubAgent.findByIdAndDelete(agentId);

    this.emit('agentDeleted', { agentId, name: agentDoc.name });
    logger.info(`Deleted sub-agent: ${agentDoc.name}`);

    return { success: true, message: `Agent ${agentDoc.name} deleted` };
  }

  /**
   * Run an agent
   */
  async runAgent(agentId, options = {}) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    const canRunCheck = agentDoc.canRun();
    if (!canRunCheck.canRun && !options.force) {
      return { success: false, reason: canRunCheck.reason };
    }

    // Get or create handler
    let handler = this.agentHandlers.get(agentId);
    if (!handler) {
      handler = await this.initializeAgent(agentDoc);
      if (!handler) {
        return { success: false, reason: 'Failed to initialize agent handler' };
      }
    }

    // Start session
    await agentDoc.startSession();

    this.emit('agentStarted', { agent: agentDoc.getSummary() });

    // Run asynchronously
    this.executeAgent(handler, agentDoc, options).catch(error => {
      logger.error(`Agent ${agentDoc.name} execution error:`, error);
    });

    return {
      success: true,
      message: `Agent ${agentDoc.name} started`,
      sessionStarted: agentDoc.state.currentSession.startedAt
    };
  }

  /**
   * Execute agent logic (with timeout protection)
   */
  async executeAgent(handler, agentDoc, options = {}) {
    const SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes max per session
    let timeoutHandle;

    try {
      // Wrap execute in Promise.race with timeout to prevent stuck agents
      const executePromise = handler.execute(options);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Session timeout: execution exceeded ${SESSION_TIMEOUT_MS / 60000} minutes`));
        }, SESSION_TIMEOUT_MS);
      });

      const result = await Promise.race([executePromise, timeoutPromise]);
      clearTimeout(timeoutHandle);

      // Update agent state
      agentDoc.state.currentSession.lastResult = result;

      // Calculate next run time
      if (agentDoc.schedule.runPattern) {
        agentDoc.schedule.nextRunAt = this.calculateNextRun(agentDoc.schedule.runPattern);
      }

      // End session
      await agentDoc.endSession(result);

      this.emit('agentCompleted', {
        agent: agentDoc.getSummary(),
        result
      });

      return result;
    } catch (error) {
      clearTimeout(timeoutHandle);
      logger.error(`Agent ${agentDoc.name} execution failed:`, error);

      try {
        await agentDoc.endSession({
          success: false,
          error: error.message,
          context: { stack: error.stack }
        });
      } catch (endErr) {
        logger.error(`Failed to end session for ${agentDoc.name}:`, endErr);
        // Force status reset as last resort
        try {
          agentDoc.status = 'idle';
          await agentDoc.save();
        } catch (saveErr) {
          logger.error(`Failed to force-reset agent ${agentDoc.name} status:`, saveErr);
        }
      }

      this.emit('agentError', {
        agent: agentDoc.getSummary(),
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Stop a running agent
   */
  async stopAgent(agentId) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    const handler = this.agentHandlers.get(agentId);
    if (handler && typeof handler.stop === 'function') {
      await handler.stop();
    }

    if (agentDoc.status === 'running') {
      await agentDoc.endSession({ stopped: true });
    }

    agentDoc.status = 'stopped';
    await agentDoc.save();

    this.emit('agentStopped', { agent: agentDoc.getSummary() });
    logger.info(`Stopped agent: ${agentDoc.name}`);

    return { success: true, message: `Agent ${agentDoc.name} stopped` };
  }

  /**
   * Pause an agent
   */
  async pauseAgent(agentId) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    const handler = this.agentHandlers.get(agentId);
    if (handler && typeof handler.pause === 'function') {
      await handler.pause();
    }

    agentDoc.status = 'paused';
    await agentDoc.save();

    this.emit('agentPaused', { agent: agentDoc.getSummary() });
    return { success: true, message: `Agent ${agentDoc.name} paused` };
  }

  /**
   * Resume a paused agent
   */
  async resumeAgent(agentId) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    if (agentDoc.status !== 'paused') {
      return { success: false, reason: 'Agent is not paused' };
    }

    const handler = this.agentHandlers.get(agentId);
    if (handler && typeof handler.resume === 'function') {
      await handler.resume();
    }

    agentDoc.status = 'idle';
    await agentDoc.save();

    this.emit('agentResumed', { agent: agentDoc.getSummary() });
    return { success: true, message: `Agent ${agentDoc.name} resumed` };
  }

  /**
   * Dispatch a domain event to all agents subscribed via eventTriggers
   */
  async dispatchEvent(eventName, eventData = {}) {
    try {
      const subscribers = await SubAgent.find({
        enabled: true,
        status: { $in: ['idle'] },
        'schedule.eventTriggers': eventName
      });

      if (subscribers.length === 0) {
        logger.debug(`No agents subscribed to event: ${eventName}`);
        return [];
      }

      logger.info(`Dispatching event '${eventName}' to ${subscribers.length} agent(s)`);

      const results = [];
      for (const agentDoc of subscribers) {
        const canRunCheck = agentDoc.canRun();
        if (!canRunCheck.canRun) {
          logger.debug(`Agent ${agentDoc.name} cannot run: ${canRunCheck.reason}`);
          results.push({ agentId: agentDoc._id.toString(), skipped: true, reason: canRunCheck.reason });
          continue;
        }

        try {
          const result = await this.runAgent(agentDoc._id.toString(), {
            eventName,
            eventData,
            triggeredBy: 'event'
          });
          results.push({ agentId: agentDoc._id.toString(), ...result });
        } catch (error) {
          logger.error(`Event dispatch failed for agent ${agentDoc.name}:`, error);
          results.push({ agentId: agentDoc._id.toString(), error: error.message });
        }
      }

      this.emit('eventDispatched', { eventName, subscriberCount: subscribers.length, results });
      return results;
    } catch (error) {
      logger.error(`Failed to dispatch event ${eventName}:`, error);
      return [];
    }
  }

  /**
   * Process an approval
   */
  async processApproval(agentId, approvalId, approved, decidedBy = 'user') {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    const approval = await agentDoc.processApproval(approvalId, approved, decidedBy);

    this.emit('approvalProcessed', {
      agent: agentDoc.getSummary(),
      approval,
      approved
    });

    // If approved and agent was waiting, trigger execution
    if (approved && agentDoc.status === 'idle') {
      const handler = this.agentHandlers.get(agentId);
      if (handler && typeof handler.onApproved === 'function') {
        await handler.onApproved(approval);
      }
    }

    return { success: true, approval };
  }

  /**
   * Get agent history
   */
  async getAgentHistory(agentId, limit = 50) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    return agentDoc.history.slice(-limit).reverse();
  }

  /**
   * Get agent learnings
   */
  async getAgentLearnings(agentId) {
    const agentDoc = await SubAgent.findById(agentId);
    if (!agentDoc) {
      throw new Error('Agent not found');
    }

    return agentDoc.state.learnings;
  }

  /**
   * Calculate next run time from pattern
   */
  calculateNextRun(pattern) {
    // Simple patterns for now
    const now = Date.now();

    if (pattern === 'hourly') {
      return new Date(now + 60 * 60 * 1000);
    } else if (pattern === 'daily') {
      return new Date(now + 24 * 60 * 60 * 1000);
    } else if (pattern.endsWith('m')) {
      const minutes = parseInt(pattern);
      return new Date(now + minutes * 60 * 1000);
    } else if (pattern.endsWith('h')) {
      const hours = parseInt(pattern);
      return new Date(now + hours * 60 * 60 * 1000);
    } else if (pattern === 'event-driven') {
      return null; // No scheduled run
    }

    // Default to 1 hour
    return new Date(now + 60 * 60 * 1000);
  }

  /**
   * Get orchestrator status
   */
  getStatus() {
    const handlers = Array.from(this.agentHandlers.entries());

    return {
      initialized: this.initialized,
      schedulerRunning: !!this.checkInterval,
      totalAgents: handlers.length,
      registeredDomains: Array.from(this.domainRegistry.keys()),
      agents: handlers.map(([id, handler]) => ({
        id,
        name: handler.agentDoc?.name,
        status: handler.agentDoc?.status
      }))
    };
  }

  /**
   * Shutdown the orchestrator
   */
  async shutdown() {
    logger.info('Shutting down SubAgentOrchestrator...');

    this.stopScheduler();

    // Stop all running agents
    for (const [agentId, handler] of this.agentHandlers) {
      try {
        if (typeof handler.stop === 'function') {
          await handler.stop();
        }
      } catch (error) {
        logger.error(`Error stopping agent ${agentId}:`, error);
      }
    }

    this.agentHandlers.clear();
    this.initialized = false;

    logger.info('SubAgentOrchestrator shutdown complete');
  }
}

// Singleton instance
let orchestratorInstance = null;

export function getOrchestrator(agent) {
  if (!orchestratorInstance && agent) {
    orchestratorInstance = new SubAgentOrchestrator(agent);
  }
  return orchestratorInstance;
}

export default SubAgentOrchestrator;
