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
  }

  async initialize() {
    await super.initialize();
    logger.info(`TaskAgentHandler initialized for: ${this.agentDoc.name}`);
  }

  /**
   * Execute the task
   */
  async execute(options = {}) {
    this.running = true;
    this.shouldStop = false;
    this.interrupted = false;

    const task = this.agentDoc.goal?.description || options.task;
    if (!task) {
      return { success: false, error: 'No task specified' };
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
      await this.log('task_started', { task, timeout });

      let iteration = 0;
      let result = null;
      const thoughts = [];

      while (iteration < this.maxIterations && !this.shouldStop && !this.interrupted) {
        iteration++;

        // Check if paused
        await this.waitIfPaused();
        if (this.shouldStop || this.interrupted) break;

        // Think about what to do
        const thought = await this.think(task, thoughts);
        thoughts.push(thought);

        await this.log('thought', { iteration, thought: thought.reasoning });

        // Check if we have a final answer
        if (thought.finalAnswer) {
          result = {
            success: true,
            answer: thought.finalAnswer,
            iterations: iteration,
            thoughts: thoughts.map(t => t.reasoning)
          };
          break;
        }

        // Execute action if specified
        if (thought.action?.tool) {
          try {
            const actionResult = await this.executeTool(
              thought.action.tool,
              thought.action.action,
              thought.action.params || {}
            );
            thoughts.push({
              type: 'observation',
              result: actionResult
            });
            await this.log('action_executed', {
              iteration,
              tool: thought.action.tool,
              action: thought.action.action,
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
          thoughts: thoughts.map(t => t.reasoning || t.result || t.error)
        };
      }

      // Mark as completed — but not when interrupted: an interrupted run is not a
      // completion, and leaving status 'running' lets the orchestrator's
      // endSession close the session and record its metrics normally.
      if (!this.interrupted) {
        this.agentDoc.status = 'completed';
        await this.agentDoc.save();
      }

      await this.log('task_completed', { result: result.success, iterations: iteration });
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
      .map(([name, plugin]) => {
        const commands = (plugin.commands || [])
          .map(c => `  - ${c.command}: ${c.description}`)
          .join('\n');
        return `**${name}**: ${plugin.description}\n${commands}`;
      })
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
