import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';

/**
 * BaseAgentHandler
 *
 * Base class for all sub-agent handlers.
 * Provides common functionality for execution, state management, and tool access.
 */
const MAX_TRACE_ENTRIES = 200;
const MAX_TRACE_FIELD_CHARS = 2000;

/**
 * Reduce a prompt/params/result/response to a bounded, serialisable form so
 * the trace never pins large provider responses or tool payloads in memory.
 */
function summarizeForTrace(value) {
  if (value === undefined || value === null) return value;
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) return undefined;
  return text.length > MAX_TRACE_FIELD_CHARS
    ? `${text.slice(0, MAX_TRACE_FIELD_CHARS)}… [${text.length} chars]`
    : text;
}

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

    // Execution trace for debugging and audit. In-memory ring buffer — the
    // handler lives for the process lifetime, so it must stay bounded.
    this.executionTrace = [];
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

    // The registry is apiManager.apis, NOT .plugins — reading the wrong property
    // yielded undefined and returned here, leaving every task/project agent with
    // zero tools while still reporting a healthy start. Its values are wrapper
    // entries {instance, enabled, calls, …}: `enabled` is on the wrapper, but the
    // callable tool (execute/commands/description) is entry.instance.
    const registry = this.mainAgent.apiManager?.apis;
    if (!registry) {
      logger.warn(`No plugin registry available — agent ${this.agentDoc.name} starts with no tools`);
      return;
    }

    for (const [name, entry] of registry) {
      const plugin = entry?.instance;
      if (!plugin || !entry.enabled) continue;

      // If empty, allow all plugin tools
      if (allowedTools.length === 0 || allowedTools.includes(name)) {
        this.tools.set(name, plugin);
        this.toolUsageStats.set(name, { frequency: 0, successRate: 0 });
      }
    }

    // Logged at info, and loudly when empty: a toolless agent still "succeeds" —
    // it just reports that it cannot do anything, which reads like a model failure
    // rather than a wiring failure.
    if (this.tools.size === 0) {
      logger.warn(`Agent ${this.agentDoc.name} loaded 0 tools (allowedTools: ${allowedTools.length ? allowedTools.join(', ') : 'all'}) — it cannot take any action`);
    } else {
      logger.info(`Loaded ${this.tools.size} tools for agent ${this.agentDoc.name}`);
    }
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
    const startTime = Date.now();
    const traceEntry = {
      type: 'tool_execution',
      timestamp: new Date(),
      toolName,
      action,
      params: summarizeForTrace(params),
      sessionId: this.agentDoc.state?.currentSession?.startedAt?.toISOString()
    };

    try {
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
          traceEntry.approvalStatus = 'denied';
          traceEntry.duration = Date.now() - startTime;
          this.recordTrace(traceEntry);
          return { success: false, reason: 'Action requires approval' };
        }
        traceEntry.approvalStatus = 'approved';
      }

      // Execute the tool
      const result = await tool.execute({ action, ...params });
      
      // Track usage
      this.sessionCosts.apiCalls++;
      this.updateToolUsageStats(toolName, result.success);

      traceEntry.result = summarizeForTrace(result);
      traceEntry.duration = Date.now() - startTime;
      this.recordTrace(traceEntry);

      return result;
    } catch (error) {
      traceEntry.error = error.message;
      traceEntry.duration = Date.now() - startTime;
      this.recordTrace(traceEntry);
      throw error;
    }
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
    const startTime = Date.now();
    const traceEntry = {
      type: 'ai_response',
      timestamp: new Date(),
      prompt: summarizeForTrace(prompt),
      sessionId: this.agentDoc.state?.currentSession?.startedAt?.toISOString()
    };

    try {
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

      traceEntry.response = summarizeForTrace(response);
      traceEntry.duration = Date.now() - startTime;
      this.recordTrace(traceEntry);

      return response;
    } catch (error) {
      traceEntry.error = error.message;
      traceEntry.duration = Date.now() - startTime;
      this.recordTrace(traceEntry);
      throw error;
    }
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

  /**
   * Append a trace entry, dropping the oldest beyond MAX_TRACE_ENTRIES.
   * @param {Object} entry
   */
  recordTrace(entry) {
    this.executionTrace.push(entry);
    if (this.executionTrace.length > MAX_TRACE_ENTRIES) {
      this.executionTrace.splice(0, this.executionTrace.length - MAX_TRACE_ENTRIES);
    }
  }

  /**
   * Get execution trace for debugging and audit purposes
   * @param {string} sessionId - Session ID to filter traces
   * @returns {Array} Chronological history of tool executions, prompts, and responses
   */
  getExecutionTrace(sessionId) {
    if (!sessionId) {
      return [...this.executionTrace];
    }
    
    return this.executionTrace.filter(entry => 
      entry.sessionId === sessionId
    );
  }
}

export default BaseAgentHandler;
