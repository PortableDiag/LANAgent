import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

/**
 * ReActAgent - Implements the ReAct (Reasoning + Acting) pattern
 *
 * The ReAct pattern interleaves reasoning (thinking) with acting (tool use)
 * in a loop: Thought -> Action -> Observation -> Thought -> ...
 *
 * This allows the agent to:
 * - Break down complex tasks step by step
 * - Adjust strategy based on observations
 * - Provide transparent reasoning traces
 */
export class ReActAgent extends EventEmitter {
  constructor(agent, options = {}) {
    super();
    this.agent = agent;
    this.maxIterations = options.maxIterations || 10;
    this.thoughtTimeout = options.thoughtTimeout || 30000; // 30 seconds per thought
    this.showThoughts = options.showThoughts || false;
    this.thoughtStore = options.thoughtStore || null;

    // Build tool descriptions from available plugins
    this.tools = [];
    this.toolMap = new Map();
    this.toolPerformanceCache = new NodeCache({ stdTTL: 3600 });
  }

  /**
   * Initialize the agent with available tools/plugins
   */
  async initialize() {
    await this.refreshTools();
    logger.info(`ReActAgent initialized with ${this.tools.length} tools`);
  }

  /**
   * Refresh the list of available tools from plugins
   */
  async refreshTools() {
    this.tools = [];
    this.toolMap.clear();

    if (!this.agent.apiManager) {
      logger.warn('APIManager not available for ReActAgent');
      return;
    }

    // Get all enabled plugins
    const plugins = this.agent.apiManager.plugins;
    if (!plugins) return;

    for (const [name, plugin] of plugins) {
      if (!plugin.enabled) continue;

      // Create tool entry from plugin
      const tool = {
        name: name,
        description: plugin.description || `${name} plugin`,
        commands: plugin.commands || [],
        parameters: this.extractParameters(plugin)
      };

      this.tools.push(tool);
      this.toolMap.set(name, plugin);
    }
  }

  /**
   * Extract parameter information from plugin commands
   */
  extractParameters(plugin) {
    const params = [];
    if (plugin.commands) {
      for (const cmd of plugin.commands) {
        params.push({
          action: cmd.command,
          description: cmd.description,
          usage: cmd.usage
        });
      }
    }
    return params;
  }

  /**
   * Run the ReAct loop for a given query
   */
  async run(query, context = {}) {
    const thoughts = [];
    let iteration = 0;
    const startTime = Date.now();

    logger.info(`ReActAgent starting with query: ${query.substring(0, 100)}...`);
    this.emit('start', { query, context });

    try {
      while (iteration < this.maxIterations) {
        iteration++;
        logger.info(`ReAct iteration ${iteration}/${this.maxIterations}`);

        // Step 1: THOUGHT - Reason about current state
        const thought = await this.think(query, thoughts, context);
        thoughts.push({ type: 'thought', content: thought, iteration, timestamp: new Date() });
        this.emit('thought', { iteration, thought });

        if (this.showThoughts && context.showThinking) {
          await context.showThinking(`💭 Thinking: ${thought.reasoning?.substring(0, 100)}...`);
        }

        // Check if we have a final answer
        if (thought.finalAnswer) {
          const result = {
            success: true,
            answer: thought.finalAnswer,
            thoughts,
            iterations: iteration,
            duration: Date.now() - startTime
          };

          // Store thought chain if thought store is available
          if (this.thoughtStore) {
            await this.thoughtStore.saveThoughtChain(query, thoughts, result);
          }

          this.emit('complete', result);
          return result;
        }

        // Check if we need more information (clarification)
        if (thought.needsClarification) {
          return {
            success: false,
            needsClarification: true,
            clarificationQuestion: thought.clarificationQuestion,
            thoughts,
            iterations: iteration,
            duration: Date.now() - startTime
          };
        }

        // Step 2: ACTION - Decide what tool to use
        if (thought.action && thought.action.tool) {
          const action = thought.action;
          thoughts.push({ type: 'action', content: action, iteration, timestamp: new Date() });
          this.emit('action', { iteration, action });

          if (this.showThoughts && context.showThinking) {
            await context.showThinking(`🔧 Action: ${action.tool}.${action.command}`);
          }

          // Step 3: OBSERVATION - Execute and observe result
          const observation = await this.executeAction(action, context);
          thoughts.push({ type: 'observation', content: observation, iteration, timestamp: new Date() });
          this.emit('observation', { iteration, observation });

          if (this.showThoughts && context.showThinking) {
            const obsPreview = typeof observation === 'string'
              ? observation.substring(0, 100)
              : JSON.stringify(observation).substring(0, 100);
            await context.showThinking(`👁️ Observation: ${obsPreview}...`);
          }
        }
      }

      // Max iterations reached
      const result = {
        success: false,
        error: 'Max iterations reached without finding an answer',
        thoughts,
        iterations: iteration,
        duration: Date.now() - startTime
      };

      if (this.thoughtStore) {
        await this.thoughtStore.saveThoughtChain(query, thoughts, result);
      }

      this.emit('maxIterations', result);
      return result;

    } catch (error) {
      logger.error('ReActAgent error:', error, {
        state: this.getState(),
        query,
        iteration,
        thoughts: thoughts.length
      });
      const result = {
        success: false,
        error: error.message,
        thoughts,
        iterations: iteration,
        duration: Date.now() - startTime
      };

      this.emit('error', { error, result });
      return result;
    }
  }

  /**
   * Generate a thought based on current state
   */
  async think(query, history, context) {
    const prompt = this.buildThinkingPrompt(query, history);

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 1000,
        temperature: 0.3
      });

      const content = response.content || response;
      return this.parseThought(content);
    } catch (error) {
      logger.error('ReAct thinking error:', error, {
        query,
        historyLength: history.length
      });
      throw error;
    }
  }

  /**
   * Build the prompt for the thinking step
   */
  buildThinkingPrompt(query, history) {
    // Format tool descriptions, prioritized by past performance
    const toolDescriptions = this.getPrioritizedTools().map(tool => {
      const commands = tool.parameters.map(p => `  - ${p.action}: ${p.description}`).join('\n');
      return `**${tool.name}**: ${tool.description}\n${commands}`;
    }).join('\n\n');

    // Format history
    const historyText = history.length > 0
      ? history.map(h => {
          switch (h.type) {
            case 'thought':
              return `Thought: ${h.content.reasoning || JSON.stringify(h.content)}`;
            case 'action':
              return `Action: ${h.content.tool}.${h.content.command}(${JSON.stringify(h.content.params || {})})`;
            case 'observation':
              const obs = typeof h.content === 'string' ? h.content : JSON.stringify(h.content);
              return `Observation: ${obs.substring(0, 500)}${obs.length > 500 ? '...' : ''}`;
            default:
              return '';
          }
        }).join('\n')
      : 'No previous steps.';

    return `You are a reasoning agent that thinks step-by-step to solve tasks. You have access to tools that can help you gather information and take actions.

## Available Tools:
${toolDescriptions}

## Previous Steps:
${historyText}

## Current Task:
${query}

## Instructions:
Think about what you need to do next. You can either:
1. Use a tool to get information or take an action
2. Provide a final answer if you have enough information
3. Ask for clarification if the task is unclear

Respond in this JSON format:
{
  "reasoning": "Your step-by-step reasoning about what to do next",
  "action": {
    "tool": "tool_name",
    "command": "action_name",
    "params": { "param1": "value1" }
  },
  "finalAnswer": "Your final answer if you're done (omit if not ready)",
  "needsClarification": false,
  "clarificationQuestion": "Question to ask if needed (omit if not needed)"
}

Only include "action" if you need to use a tool.
Only include "finalAnswer" if you have completed the task.
Respond with valid JSON only.`;
  }

  /**
   * Parse the thought response from LLM
   */
  parseThought(response) {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          reasoning: parsed.reasoning || '',
          action: parsed.action || null,
          finalAnswer: parsed.finalAnswer || null,
          needsClarification: parsed.needsClarification || false,
          clarificationQuestion: parsed.clarificationQuestion || null
        };
      }

      // Fallback: treat as reasoning text
      return {
        reasoning: response,
        action: null,
        finalAnswer: null,
        needsClarification: false,
        clarificationQuestion: null
      };
    } catch (error) {
      logger.warn('Failed to parse thought response:', error.message);
      return {
        reasoning: response,
        action: null,
        finalAnswer: null,
        needsClarification: false,
        clarificationQuestion: null
      };
    }
  }

  /**
   * Execute an action using the appropriate plugin
   * Includes retry logic for transient failures (network issues, timeouts)
   */
  async executeAction(action, context) {
    const { tool, command, params } = action;

    try {
      const plugin = this.toolMap.get(tool);
      if (!plugin) {
        return { error: `Tool '${tool}' not found` };
      }

      // Execute the plugin action with retry logic for transient failures
      const result = await retryOperation(
        async () => plugin.execute({
          action: command,
          ...params
        }),
        {
          retries: 2,
          minTimeout: 1000,
          maxTimeout: 5000,
          onRetry: (error, attempt) => {
            logger.warn(`ReAct plugin execution retry ${attempt} for ${tool}.${command}: ${error.message}`);
          }
        }
      );

      this.updateToolPerformance(tool, true);

      return {
        success: true,
        tool,
        command,
        result
      };
    } catch (error) {
      logger.error(`ReAct action execution error (${tool}.${command}):`, error, {
        tool,
        command,
        params
      });

      this.updateToolPerformance(tool, false);

      return {
        success: false,
        tool,
        command,
        error: error.message
      };
    }
  }

  /**
   * Update tool performance based on execution success or failure
   */
  updateToolPerformance(toolName, success) {
    const performance = this.toolPerformanceCache.get(toolName) || { successCount: 0, failureCount: 0 };
    if (success) {
      performance.successCount += 1;
    } else {
      performance.failureCount += 1;
    }
    this.toolPerformanceCache.set(toolName, performance);
  }

  /**
   * Get tools sorted by past performance (higher success rate first)
   */
  getPrioritizedTools() {
    return [...this.tools].sort((a, b) => {
      const aPerf = this.toolPerformanceCache.get(a.name) || { successCount: 0, failureCount: 0 };
      const bPerf = this.toolPerformanceCache.get(b.name) || { successCount: 0, failureCount: 0 };
      return (bPerf.successCount - bPerf.failureCount) - (aPerf.successCount - aPerf.failureCount);
    });
  }

  /**
   * Check if a query requires complex reasoning
   */
  async needsReasoning(query, context = {}) {
    // Simple heuristics for when to use ReAct
    const indicators = [
      /\b(and then|after that|first|second|finally)\b/i,
      /\b(if|when|unless|based on)\b/i,
      /\b(check|verify|confirm|ensure)\b/i,
      /\b(compare|analyze|evaluate)\b/i,
      /\b(find|search|look for).+\b(and|then)\b/i,
      /\b(multiple|several|various)\b/i
    ];

    // Check if query matches complexity indicators
    for (const pattern of indicators) {
      if (pattern.test(query)) {
        return true;
      }
    }

    // Check query length (longer queries often need reasoning)
    if (query.length > 200) {
      return true;
    }

    return false;
  }

  /**
   * Get the current state of the agent
   */
  getState() {
    return {
      maxIterations: this.maxIterations,
      showThoughts: this.showThoughts,
      toolCount: this.tools.length,
      tools: this.tools.map(t => t.name)
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    if (config.maxIterations !== undefined) {
      this.maxIterations = config.maxIterations;
    }
    if (config.showThoughts !== undefined) {
      this.showThoughts = config.showThoughts;
    }
    if (config.thoughtTimeout !== undefined) {
      this.thoughtTimeout = config.thoughtTimeout;
    }
  }
}

export default ReActAgent;
