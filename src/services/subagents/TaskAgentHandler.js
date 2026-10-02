import { logger } from '../../utils/logger.js';
import { BaseAgentHandler } from './BaseAgentHandler.js';
import { safeTimeout } from '../../utils/errorHandlers.js';

/**
 * TaskAgentHandler
 *
 * Handles short-lived delegated tasks.
 * Designed for focused, single-purpose operations that complete in one session.
 */
export class TaskAgentHandler extends BaseAgentHandler {
  constructor(mainAgent, agentDoc) {
    super(mainAgent, agentDoc);
    this.maxIterations = 10;
    this.timeoutId = null;
    this.interrupted = false;
    this.toolPolicy = this.normalizeToolPolicy(
      agentDoc?.config?.domainConfig?.toolPolicy
    );
  }

  async initialize() {
    await super.initialize();
    logger.info(`TaskAgentHandler initialized for: ${this.agentDoc.name}`);
  }

  /**
   * Normalize a task tool policy into a predictable, serializable shape.
   *
   * @param {Object} policy - Raw policy configuration
   * @returns {Object} Normalized policy
   */
  normalizeToolPolicy(policy) {
    policy = policy && typeof policy === 'object' ? policy : {};
    const normalizeList = (value) => {
      if (!Array.isArray(value)) return [];
      return [...new Set(
        value
          .filter(item => typeof item === 'string')
          .map(item => item.trim().toLowerCase())
          .filter(Boolean)
      )];
    };

    return {
      allowedTools: normalizeList(policy.allowedTools),
      deniedTools: normalizeList(policy.deniedTools),
      allowedCommands: normalizeList(policy.allowedCommands),
      deniedCommands: normalizeList(policy.deniedCommands),
      readOnly: policy.readOnly === true
    };
  }

  /**
   * Return policy information suitable for task results and audit records.
   *
   * @returns {Object} Normalized policy metadata
   */
  getToolPolicyMetadata() {
    return {
      allowedTools: [...this.toolPolicy.allowedTools],
      deniedTools: [...this.toolPolicy.deniedTools],
      allowedCommands: [...this.toolPolicy.allowedCommands],
      deniedCommands: [...this.toolPolicy.deniedCommands],
      readOnly: this.toolPolicy.readOnly
    };
  }

  /**
   * Determine whether a tool is permitted by the configured tool policy.
   *
   * @param {string} toolName - Plugin/tool name
   * @returns {boolean} Whether the tool may be shown or executed
   */
  isToolAllowed(toolName) {
    const name = String(toolName || '').trim().toLowerCase();
    if (!name) return false;

    if (this.toolPolicy.deniedTools.includes(name)) return false;
    if (
      this.toolPolicy.allowedTools.length > 0 &&
      !this.toolPolicy.allowedTools.includes(name)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Resolve a command definition from a plugin.
   *
   * @param {Object} plugin - Loaded plugin
   * @param {string} action - Command name
   * @returns {Object|null} Command definition
   */
  getCommandDefinition(plugin, action) {
    const commandName = String(action || '').trim().toLowerCase();
    return (plugin?.commands || []).find(command =>
      String(command?.command || '').trim().toLowerCase() === commandName
    ) || null;
  }

  /**
   * Determine whether a command mutates state.
   *
   * Commands explicitly marked read-only are safe. Common query command names
   * are also treated as read-only for compatibility with plugins whose command
   * metadata predates the policy fields.
   *
   * @param {Object|null} commandDefinition - Plugin command metadata
   * @param {string} action - Command name
   * @returns {boolean} Whether the command should be treated as mutating
   */
  isMutatingAction(commandDefinition, action) {
    if (commandDefinition?.mutating === true) return true;
    if (commandDefinition?.readOnly === true) return false;
    if (commandDefinition?.readOnly === false) return true;

    const commandName = String(action || '').trim().toLowerCase();
    const readOnlyPrefix = /^(get|list|fetch|find|search|read|query|status|describe|inspect|check|lookup|view|show|ping|health)/;
    return !readOnlyPrefix.test(commandName);
  }

  /**
   * Check a proposed action against the tool and command policy.
   *
   * @param {string} toolName - Plugin/tool name
   * @param {string} action - Command name
   * @returns {Object} Policy decision
   */
  checkToolPolicy(toolName, action) {
    const normalizedTool = String(toolName || '').trim().toLowerCase();
    const normalizedAction = String(action || '').trim().toLowerCase();
    const commandKey = `${normalizedTool}.${normalizedAction}`;
    const plugin = this.tools.get(toolName) || this.tools.get(normalizedTool);
    const commandDefinition = this.getCommandDefinition(plugin, action);
    const mutating = this.isMutatingAction(commandDefinition, action);

    if (!this.isToolAllowed(normalizedTool)) {
      return {
        allowed: false,
        reason: 'tool_denied',
        message: `Tool "${toolName}" is not permitted by the task tool policy.`,
        mutating,
        commandDefinition
      };
    }

    if (
      this.toolPolicy.deniedCommands.includes(normalizedAction) ||
      this.toolPolicy.deniedCommands.includes(commandKey)
    ) {
      return {
        allowed: false,
        reason: 'command_denied',
        message: `Command "${toolName}.${action}" is not permitted by the task tool policy.`,
        mutating,
        commandDefinition
      };
    }

    if (
      this.toolPolicy.allowedCommands.length > 0 &&
      !this.toolPolicy.allowedCommands.includes(normalizedAction) &&
      !this.toolPolicy.allowedCommands.includes(commandKey)
    ) {
      return {
        allowed: false,
        reason: 'command_not_allowed',
        message: `Command "${toolName}.${action}" is outside the task tool policy allow-list.`,
        mutating,
        commandDefinition
      };
    }

    if (this.toolPolicy.readOnly && mutating) {
      return {
        allowed: false,
        reason: 'read_only',
        message: `Command "${toolName}.${action}" is not available in read-only mode.`,
        mutating,
        commandDefinition
      };
    }

    return {
      allowed: true,
      reason: null,
      message: null,
      mutating,
      commandDefinition
    };
  }

  /**
   * Record a policy block as an observation and in task history.
   *
   * @param {Array} thoughts - Current thought history
   * @param {number} iteration - Current iteration
   * @param {string} tool - Requested tool
   * @param {string} action - Requested action
   * @param {Object} block - Block details
   */
  async recordPolicyBlock(thoughts, iteration, tool, action, block) {
    const observation = {
      type: 'policy_blocked',
      policyBlocked: true,
      tool,
      action,
      reason: block.reason,
      message: block.message,
      policy: this.getToolPolicyMetadata()
    };

    thoughts.push({ type: 'observation', result: observation });
    await this.log('policy_blocked', {
      iteration,
      tool,
      action,
      reason: block.reason,
      message: block.message,
      policy: this.getToolPolicyMetadata()
    });
  }

  /**
   * Execute the task
   */
  async execute(options = {}) {
    this.running = true;
    this.shouldStop = false;
    this.interrupted = false;
    this.toolPolicy = this.normalizeToolPolicy(
      options.toolPolicy ??
      this.agentDoc.config?.domainConfig?.toolPolicy
    );

    const task = this.agentDoc.goal?.description || options.task;
    if (!task) {
      return {
        success: false,
        error: 'No task specified',
        policy: this.getToolPolicyMetadata()
      };
    }

    // Cooperative execution timeout. The orchestrator's Promise.race session
    // timeout (20 min) only abandons the AWAIT — the handler itself keeps running
    // as a zombie until maxIterations. This timeout makes the handler stop itself.
    // Sources, most specific first: per-call option, per-agent domainConfig, then
    // the agent's sessionDurationMinutes budget (schema default 30 min), so every
    // task agent gets a self-stop bound without any new configuration.
    const timeout = options.timeout
      || this.agentDoc.config?.domainConfig?.timeoutMs
      || ((this.agentDoc.config?.sessionDurationMinutes || 0) * 60000);
    if (timeout > 0) {
      this.setupTimeout(timeout);
    }

    try {
      await this.log('task_started', {
        task,
        timeout,
        policy: this.getToolPolicyMetadata()
      });

      let iteration = 0;
      let result = null;
      const thoughts = [];

      while (iteration < this.maxIterations && !this.shouldStop && !this.interrupted) {
        iteration++;

        // Check if paused
        await this.waitIfPaused();
        if (this.shouldStop || this.interrupted) break;

        // Think about what to do next
        const thought = await this.think(task, thoughts);
        thoughts.push(thought);

        await this.log('thought', { iteration, thought: thought.reasoning });

        // Check if we have a final answer
        if (thought.finalAnswer) {
          result = {
            success: true,
            answer: thought.finalAnswer,
            iterations: iteration,
            thoughts: thoughts.map(t => t.reasoning),
            policy: this.getToolPolicyMetadata()
          };
          break;
        }

        // Execute action if specified
        if (thought.action?.tool) {
          const tool = thought.action.tool;
          const action = thought.action.action;
          const params = thought.action.params || {};
          const policyDecision = this.checkToolPolicy(tool, action);

          if (!policyDecision.allowed) {
            await this.recordPolicyBlock(
              thoughts,
              iteration,
              tool,
              action,
              policyDecision
            );
            continue;
          }

          try {
            const actionResult = await this.executeTool(tool, action, params);
            thoughts.push({
              type: 'observation',
              result: actionResult
            });
            await this.log('action_executed', {
              iteration,
              tool,
              action,
              success: actionResult?.success
            });
          } catch (error) {
            thoughts.push({
              type: 'observation',
              error: error.message
            });
          }
        }
      }

      if (!result) {
        const errorMessage = this.interrupted
          ? 'Task was interrupted'
          : this.shouldStop
            ? 'Task was stopped'
            : 'Max iterations reached';

        result = {
          success: false,
          error: errorMessage,
          interrupted: this.interrupted,
          iterations: iteration,
          thoughts: thoughts.map(t => t.reasoning || t.result || t.error),
          policy: this.getToolPolicyMetadata()
        };
      }

      // Mark as completed — but not when interrupted: an interrupted run is not a
      // completion, and leaving status 'running' lets the orchestrator's
      // endSession close the session and record its metrics normally.
      if (!this.interrupted) {
        this.agentDoc.status = 'completed';
        await this.agentDoc.save();
      }

      await this.log('task_completed', {
        result: result.success,
        iterations: iteration,
        policy: this.getToolPolicyMetadata()
      });
      return result;

    } catch (error) {
      logger.error(`TaskAgentHandler execution error:`, error);
      await this.log('task_error', { error: error.message });
      throw error;
    } finally {
      this.cleanupTimeout();
      this.running = false;
    }
  }

  /**
   * Set up execution timeout
   */
  setupTimeout(timeoutMs) {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = safeTimeout(() => {
      logger.info(`Task timeout reached after ${timeoutMs}ms`);
      this.shouldStop = true;
    }, timeoutMs, 'TaskAgentHandler.timeout');
  }

  /**
   * Clean up timeout resources
   */
  cleanupTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Interrupt task execution.
   *
   * Flags only, deliberately: writing agentDoc.status here would (a) fail
   * validation ('interrupted' is not in the SubAgent status enum) and (b) even
   * with an enum change, break the session lifecycle — endSession() early-returns
   * unless status is 'running', so a mid-run status write leaves the session open
   * and its metrics unrecorded. The loop observes the flags, returns a
   * 'Task was interrupted' result, and the orchestrator closes the session
   * through the normal endSession path. Interruption is tracked via the
   * 'task_interrupted' history entry and the result's `interrupted` field.
   */
  async interrupt() {
    logger.info(`Task interruption requested for ${this.agentDoc.name}`);
    this.interrupted = true;
    this.shouldStop = true;
    this.cleanupTimeout();
    await this.log('task_interrupted', { timestamp: new Date().toISOString() });
  }

  /**
   * Think about what to do next
   */
  async think(task, previousThoughts) {
    const toolDescriptions = Array.from(this.tools.entries())
      .filter(([name]) => this.isToolAllowed(name))
      .map(([name, plugin]) => {
        const commands = (plugin.commands || [])
          .filter(command => {
            const decision = this.checkToolPolicy(name, command.command);
            return decision.allowed;
          })
          .map(c => `  - ${c.command}: ${c.description}`)
          .join('\n');

        // A plugin whose every command the policy removed is hidden entirely;
        // one that never declared commands is listed as before.
        if (!commands && (plugin.commands || []).length > 0) return null;
        return `**${name}**: ${plugin.description}\n${commands}`;
      })
      .filter(Boolean)
      .join('\n\n');

    const historyText = previousThoughts
      .map((t, i) => {
        if (t.type === 'observation') {
          return `Observation: ${JSON.stringify(t.result || t.error).substring(0, 500)}`;
        }
        return `Thought ${i + 1}: ${t.reasoning}${t.action ? `\nAction: ${t.action.tool}.${t.action.action}` : ''}`;
      })
      .join('\n');

    const prompt = `You are a task agent completing a specific task.

TASK: ${task}

AVAILABLE TOOLS:
${toolDescriptions || 'No tools available'}

PREVIOUS STEPS:
${historyText || 'None yet'}

Think about what to do next. You can:
1. Use a tool to get information or take action
2. Provide a final answer if the task is complete

Respond in JSON format:
{
  "reasoning": "Your step-by-step reasoning",
  "action": {
    "tool": "tool_name",
    "action": "action_name",
    "params": {}
  },
  "finalAnswer": "Your final answer if task is complete (omit if not done)"
}

Only include "action" if you need to use a tool.
Only include "finalAnswer" if the task is complete.`;

    const response = await this.generateResponse(prompt, {
      maxTokens: 1000,
      temperature: 0.3
    });

    const content = response.content || response;

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      logger.warn('Failed to parse task agent thought:', error.message);
    }

    return {
      reasoning: content,
      action: null,
      finalAnswer: null
    };
  }
}

export default TaskAgentHandler;
