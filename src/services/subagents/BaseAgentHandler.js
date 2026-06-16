import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';

/**
 * BaseAgentHandler
 *
 * Base class for all sub-agent handlers.
 * Provides common functionality for execution, state management, and tool access.
 */
export class BaseAgentHandler extends EventEmitter {
  constructor(mainAgent, agentDoc) {
    super();
    this.mainAgent = mainAgent;
    this.agentDoc = agentDoc;
    this.running = false;
    this.paused = false;
    this.shouldStop = false;

    // Tools available to this agent
    this.tools = new Map();

    // Usage statistics for tool prioritization
    this.toolUsageStats = new Map();

    // Cost tracking for this session
    this.sessionCosts = {
      apiCalls: 0,
      tokens: 0,
      cost: 0
    };
  }

  /**
   * Initialize the handler - override in subclasses
   */
  async initialize() {
    // Load allowed tools from agent config
    await this.loadTools();
    logger.debug(`BaseAgentHandler initialized for ${this.agentDoc.name}`);
  }

  /**
   * Load tools available to this agent
   */
  async loadTools() {
    const allowedTools = this.agentDoc.config?.allowedTools || [];

    // If empty, allow all plugin tools
    const plugins = this.mainAgent.apiManager?.plugins;
    if (!plugins) return;

    for (const [name, plugin] of plugins) {
      if (!plugin.enabled) continue;

      // Check if this tool is allowed
      if (allowedTools.length === 0 || allowedTools.includes(name)) {
        this.tools.set(name, plugin);
        this.toolUsageStats.set(name, { frequency: 0, successRate: 0 });
      }
    }

    logger.debug(`Loaded ${this.tools.size} tools for agent ${this.agentDoc.name}`);
  }

  /**
   * Execute the agent - must be overridden
   */
  async execute(options = {}) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Stop the agent
   */
  async stop() {
    this.shouldStop = true;
    this.running = false;
    logger.info(`Agent ${this.agentDoc.name} stop requested`);
  }

  /**
   * Pause the agent
   */
  async pause() {
    this.paused = true;
    logger.info(`Agent ${this.agentDoc.name} paused`);
  }

  /**
   * Resume the agent
   */
  async resume() {
    this.paused = false;
    logger.info(`Agent ${this.agentDoc.name} resumed`);
  }

  /**
   * Check if should continue running
   */
  shouldContinue() {
    if (this.shouldStop) return false;
    if (this.paused) return false;
    return true;
  }

  /**
   * Wait while paused
   */
  async waitIfPaused() {
    while (this.paused && !this.shouldStop) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Execute a tool
   */
  async executeTool(toolName, action, params = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not available: ${toolName}`);
    }

    // Check if action requires approval
    const requiresApproval = this.agentDoc.config?.requiresApproval?.forActions || [];
    if (requiresApproval.includes(`${toolName}.${action}`)) {
      const approval = await this.requestApproval(
        `${toolName}.${action}`,
        `Execute ${toolName}.${action} with params: ${JSON.stringify(params)}`,
        { toolName, action, params }
      );

      if (approval.status !== 'approved') {
        return { success: false, reason: 'Action requires approval' };
      }
    }

    // Execute the tool
    const result = await tool.execute({ action, ...params });

    // Track usage
    this.sessionCosts.apiCalls++;
    this.updateToolUsageStats(toolName, result.success);

    return result;
  }

  /**
   * Update tool usage statistics
   */
  updateToolUsageStats(toolName, success) {
    const stats = this.toolUsageStats.get(toolName);
    if (!stats) return;

    stats.frequency += 1;
    stats.successRate = ((stats.successRate * (stats.frequency - 1)) + (success ? 1 : 0)) / stats.frequency;
  }

  /**
   * Prioritize tools based on usage statistics
   */
  prioritizeTools() {
    return Array.from(this.tools.keys()).sort((a, b) => {
      const statsA = this.toolUsageStats.get(a);
      const statsB = this.toolUsageStats.get(b);

      if (!statsA || !statsB) return 0;

      // Sort by success rate first, then by frequency
      if (statsA.successRate !== statsB.successRate) {
        return statsB.successRate - statsA.successRate;
      }
      return statsB.frequency - statsA.frequency;
    });
  }

  /**
   * Generate AI response with cost tracking
   */
  async generateResponse(prompt, options = {}) {
    if (!this.mainAgent.providerManager) {
      throw new Error('Provider manager not available');
    }

    // Refresh agentDoc from database to get latest budget/usage
    if (this.agentDoc._id) {
      const SubAgent = this.agentDoc.constructor;
      const freshDoc = await SubAgent.findById(this.agentDoc._id);
      if (freshDoc) {
        this.agentDoc = freshDoc;
      }
    }

    // Check budget before calling
    const budget = this.agentDoc.config?.budget;
    if (budget) {
      const dailyUsed = this.agentDoc.usage?.daily?.apiCalls || 0;
      if (dailyUsed >= budget.dailyApiCalls) {
        throw new Error('Daily API call budget exceeded');
      }
    }

    const response = await this.mainAgent.providerManager.generateResponse(prompt, options);

    // Track usage
    this.sessionCosts.apiCalls++;
    if (response.usage) {
      this.sessionCosts.tokens += response.usage.total_tokens || 0;
    }

    // Record usage to agent doc
    await this.agentDoc.recordUsage(
      1,
      response.usage?.total_tokens || 0,
      0 // TODO: calculate cost based on model
    );

    return response;
  }

  /**
   * Request approval for an action
   */
  async requestApproval(action, description, data = {}) {
    return await this.agentDoc.requestApproval(action, description, data);
  }

  /**
   * Add a learning
   */
  async addLearning(category, insight, confidence = 0.5) {
    await this.agentDoc.addLearning(category, insight, confidence);
  }

  /**
   * Add a blocker
   */
  async addBlocker(description, severity = 'medium') {
    await this.agentDoc.addBlocker(description, severity);
  }

  /**
   * Log to agent history
   * Uses findOneAndUpdate to avoid VersionError conflicts
   */
  async log(event, details = {}) {
    const SubAgent = this.agentDoc.constructor;
    const historyEntry = {
      timestamp: new Date(),
      event,
      details,
      sessionId: this.agentDoc.state?.currentSession?.startedAt?.toISOString()
    };

    // Use atomic update to avoid version conflicts
    const updated = await SubAgent.findByIdAndUpdate(
      this.agentDoc._id,
      {
        $push: {
          history: {
            $each: [historyEntry],
            $slice: -100  // Keep last 100 entries
          }
        },
        $set: { updatedAt: new Date() }
      },
      { new: true }
    );

    // Sync local doc version
    if (updated) {
      this.agentDoc.__v = updated.__v;
    }
  }

  /**
   * Update domain state
   * Uses findOneAndUpdate to avoid VersionError conflicts
   */
  async updateState(updates) {
    const SubAgent = this.agentDoc.constructor;

    // Build $set operations for nested updates
    const setOps = {};
    for (const [key, value] of Object.entries(updates)) {
      setOps[`state.domainState.${key}`] = value;
    }
    setOps.updatedAt = new Date();

    const updated = await SubAgent.findByIdAndUpdate(
      this.agentDoc._id,
      { $set: setOps },
      { new: true }
    );

    // Sync local state
    if (updated) {
      this.agentDoc.state.domainState = updated.state.domainState;
      this.agentDoc.__v = updated.__v;
    }
  }

  /**
   * Get domain state
   */
  getState() {
    return this.agentDoc.state.domainState || {};
  }

  /**
   * Get domain config
   */
  getConfig() {
    return this.agentDoc.config?.domainConfig || {};
  }

  /**
   * Update domain config
   */
  async updateConfig(updates) {
    this.agentDoc.config.domainConfig = {
      ...this.agentDoc.config.domainConfig,
      ...updates
    };
    await this.agentDoc.save();
  }

  /**
   * Called when an approval is granted
   */
  async onApproved(approval) {
    // Override in subclasses to handle post-approval logic
    logger.info(`Approval granted for ${approval.action} on agent ${this.agentDoc.name}`);
  }

  /**
   * Get handler status
   */
  getStatus() {
    return {
      name: this.agentDoc.name,
      running: this.running,
      paused: this.paused,
      shouldStop: this.shouldStop,
      toolCount: this.tools.size,
      sessionCosts: this.sessionCosts
    };
  }
}

export default BaseAgentHandler;