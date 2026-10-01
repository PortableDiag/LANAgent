import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import NodeCache from 'node-cache';
import { listTools, selectRelevantTools, formatToolsForPrompt, executeTool, findPastExamples, DESCRIBE_TOOL } from './toolCatalog.js';
import { getSkillsService, learnSkillFromTask } from '../skills/skillsService.js';
import { TodoList, TODO_TOOL, TODO_TOOL_PROMPT, runTodoTool } from './todoList.js';

// Steps spent only on the to-do list do not use up maxIterations, up to this many per run
export const FREE_TODO_STEPS = 3;

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
    this.executionBudget = options.executionBudget || options.budget || {};
    this.activeRun = null;

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
   * Refresh the list of available tools from plugins. The catalog is read live on every
   * run; this snapshot only serves getState() and the startup log.
   */
  async refreshTools() {
    this.tools = listTools(this.agent);
    this.toolMap = new Map(this.tools.map(t => [t.name, t]));
  }

  /**
   * Create a bounded promise that observes cooperative cancellation.
   */
  async _boundedOperation(operation, timeoutMs, signal, label) {
    if (signal?.aborted) {
      throw this._terminationError('cancelled', 'Execution was cancelled');
    }

    let timer;
    let abortHandler;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(this._terminationError('budgetExceeded', `${label} exceeded its ${timeoutMs}ms limit`));
          }, timeoutMs);
        })
      : null;
    const cancellation = signal
      ? new Promise((_, reject) => {
          abortHandler = () => reject(this._terminationError('cancelled', 'Execution was cancelled'));
          signal.addEventListener('abort', abortHandler, { once: true });
        })
      : null;

    try {
      const promises = [operation()];
      if (timeout) promises.push(timeout);
      if (cancellation) promises.push(cancellation);
      return await Promise.race(promises);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  /**
   * Construct an internal termination error with machine-readable metadata.
   */
  _terminationError(type, reason) {
    const error = new Error(reason);
    error.terminationType = type;
    return error;
  }

  /**
   * Check whether the current run may continue.
   */
  _checkBudget(run) {
    if (run.signal?.aborted) {
      throw this._terminationError('cancelled', 'Execution was cancelled');
    }

    const elapsed = Date.now() - run.startTime;
    if (run.budget.timeoutMs !== undefined && elapsed >= run.budget.timeoutMs) {
      throw this._terminationError('budgetExceeded', `Execution exceeded its ${run.budget.timeoutMs}ms time budget`);
    }

    if (run.budget.maxToolCalls !== undefined && run.toolCalls >= run.budget.maxToolCalls) {
      throw this._terminationError('budgetExceeded', `Maximum tool-call budget of ${run.budget.maxToolCalls} was reached`);
    }
  }

  /**
   * Return a structured result for a cancelled or budget-limited run.
   */
  _terminationResult(error, thoughts, iteration, startTime) {
    const cancelled = error.terminationType === 'cancelled';
    const result = {
      success: false,
      ...(cancelled ? { cancelled: true } : { budgetExceeded: true }),
      reason: error.message,
      error: error.message,
      thoughts,
      iterations: iteration,
      duration: Date.now() - startTime
    };
    this.emit(cancelled ? 'cancelled' : 'budgetExceeded', result);
    return result;
  }

  /**
   * Run the ReAct loop for a given query
   */
  async run(query, context = {}) {
    // Resuming after a clarification: keep the earlier steps and add the user's answer
    const resume = context.resume;
    const thoughts = resume?.thoughts ? [...resume.thoughts] : [];
    if (resume) {
      thoughts.push({
        type: 'observation',
        content: `You asked the user: "${resume.question}". The user answered: "${resume.answer}"`,
        iteration: 0,
        timestamp: new Date()
      });
    }

    // The task's own to-do list (per run, in memory), carried over a clarification pause
    const todo = new TodoList();
    ReActAgent.replayTodo(todo, thoughts);
    const withTodo = r => (todo.empty ? r : { ...r, todo: todo.snapshot() });
    // Progress line for the user, with the to-do list under it when there is one
    const progress = async (line) => {
      if (!context.showThinking) return;
      const list = todo.render();
      const text = [line, list].filter(Boolean).join('\n\n');
      if (text) await context.showThinking(text);
    };

    const signal = context.signal || context.abortSignal;
    const budget = { ...this.executionBudget, ...(context.budget || context.executionBudget || {}) };
    const run = {
      signal,
      budget,
      startTime: Date.now(),
      toolCalls: 0,
      iteration: 0,
      todo
    };
    this.activeRun = run;

    let iteration = 0;
    const startTime = run.startTime;

    logger.info(`ReActAgent starting with query: ${query.substring(0, 100)}...`);
    this.emit('start', { query, context, budget });

    try {
      this._checkBudget(run);

      // Tools and worked examples are chosen once per task: the plugins relevant to it get
      // full command lists, and similar tasks that succeeded before are shown as examples.
      await this.refreshTools();
      const relevant = await selectRelevantTools(this.agent, query, { available: this.tools });
      const pastExamples = await findPastExamples(this.thoughtStore, query);
      if (pastExamples) logger.info('ReAct: reusing similar past reasoning as examples');
      const skills = await getSkillsService().promptFor(query).catch(() => '');
      if (skills) logger.info('ReAct: following a matching skill');
      const guidance = { relevant, pastExamples, skills, todo };
      let freeTodoSteps = 0;

      while (iteration < this.maxIterations + freeTodoSteps) {
        this._checkBudget(run);
        iteration++;
        run.iteration = iteration;
        logger.info(`ReAct iteration ${iteration}/${this.maxIterations + freeTodoSteps}`);

        // Step 1: THOUGHT - Reason about current state
        const thought = await this._boundedOperation(
          () => this.think(query, thoughts, { ...context, signal }, guidance),
          // Only an explicit per-step budget bounds a thought. thoughtTimeout (30 s) was
          // never enforced and sits far below the provider's own retry budget, so racing
          // it would abort slow-but-healthy providers.
          budget.maxActionDurationMs,
          signal,
          'Thinking'
        );
        thoughts.push({ type: 'thought', content: thought, iteration, timestamp: new Date() });
        this.emit('thought', { iteration, thought });

        if (this.showThoughts && context.showThinking) {
          await context.showThinking(`💭 Thinking: ${thought.reasoning?.substring(0, 100)}...`);
        }

        // A to-do list sent alongside the step ("todo": [...]) is applied first
        if (Array.isArray(thought.todo)) {
          const before = todo.revision;
          try { todo.write(thought.todo); } catch { /* malformed list: keep the old one */ }
          if (todo.revision !== before && !thought.action?.tool && !thought.finalAnswer) await progress('');
        }

        // Check if we have a final answer
        if (thought.finalAnswer) {
          const result = withTodo({
            success: true,
            answer: thought.finalAnswer,
            thoughts,
            iterations: iteration,
            duration: Date.now() - startTime
          });

          // Store thought chain if thought store is available
          if (this.thoughtStore) {
            await this.thoughtStore.saveThoughtChain(query, thoughts, result);
          }

          // Turn a multi-step success into a reusable skill (best effort, not awaited)
          learnSkillFromTask({ providerManager: this.agent.providerManager, query, thoughts, answer: result.answer });

          this.emit('complete', result);
          return result;
        }

        // Check if we need more information (clarification)
        if (thought.needsClarification) {
          return withTodo({
            success: false,
            needsClarification: true,
            clarificationQuestion: thought.clarificationQuestion,
            clarificationOptions: thought.clarificationOptions,
            thoughts,
            iterations: iteration,
            duration: Date.now() - startTime
          });
        }

        // The to-do tool is pure state on this run: no plugin, no tool-call budget
        if (thought.action?.tool === TODO_TOOL) {
          const before = todo.revision;
          const observation = runTodoTool(todo, thought.action.params || {});
          thoughts.push({ type: 'observation', content: observation, iteration, timestamp: new Date() });
          this.emit('todo', { iteration, todo: observation.result });
          if (todo.revision !== before) await progress('📝 To-do updated');
          if (freeTodoSteps < FREE_TODO_STEPS) freeTodoSteps++;
          continue;
        }

        // Step 2: ACTION - Decide what tool to use
        if (thought.action && thought.action.tool) {
          this._checkBudget(run);
          const action = thought.action;
          thoughts.push({ type: 'action', content: action, iteration, timestamp: new Date() });
          this.emit('action', { iteration, action });

          // Tool steps are always reported (briefly); full thoughts only with showThoughts
          await progress(`🔧 ${action.tool}.${action.command}`);

          // Step 3: OBSERVATION - Execute and observe result
          run.toolCalls++;
          const observation = await this._boundedOperation(
            () => this.executeAction(action, { ...context, signal }),
            budget.maxActionDurationMs,
            signal,
            `Action ${action.tool}.${action.command}`
          );
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
      const result = withTodo({
        success: false,
        error: 'Max iterations reached without finding an answer',
        reason: 'Max iterations reached without finding an answer',
        thoughts,
        iterations: iteration,
        duration: Date.now() - startTime
      });

      if (this.thoughtStore) {
        await this.thoughtStore.saveThoughtChain(query, thoughts, result);
      }

      this.emit('maxIterations', result);
      return result;

    } catch (error) {
      if (error.terminationType === 'cancelled' || error.terminationType === 'budgetExceeded') {
        return withTodo(this._terminationResult(error, thoughts, iteration, startTime));
      }

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

      // Guard — `'error'` emit without listeners synchronously throws.
      if (this.listenerCount('error') > 0) {
        this.emit('error', { error, result });
      }
      return result;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  /**
   * Rebuild a run's to-do list from earlier steps (a task resumed after a clarification):
   * each "todo" sent with a thought is re-applied, each todo tool result restored.
   */
  static replayTodo(todo, thoughts = []) {
    for (const t of thoughts) {
      try {
        if (t?.type === 'thought' && Array.isArray(t.content?.todo)) todo.write(t.content.todo);
        else if (t?.type === 'observation' && t.content?.tool === TODO_TOOL && t.content.result) todo.restore(t.content.result);
      } catch { /* a malformed old entry does not stop the resume */ }
    }
    return todo;
  }

  /**
   * Generate a thought based on current state
   */
  async think(query, history, context, guidance = {}) {
    const prompt = this.buildThinkingPrompt(query, history, guidance);

    try {
      // No retry wrapper here: generateResponse already retries and fails over, and its
      // wall-clock budget is longer than any fixed per-thought race could safely be.
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
  buildThinkingPrompt(query, history, { relevant = [], pastExamples = '', skills = '', todo = null } = {}) {
    // Relevant tools in full, the rest as a catalog ranked by past performance
    const toolDescriptions = formatToolsForPrompt(this.tools, relevant, this.getPrioritizedTools());

    // Format history
    const historyText = history.length > 0
      ? history.map(h => {
          switch (h.type) {
            case 'thought':
              return `Thought: ${h.content.reasoning || JSON.stringify(h.content)}`;
            case 'action':
              return `Action: ${h.content.tool}.${h.content.command}(${JSON.stringify(h.content.params || {})})`;
            case 'observation':
              if (h.content?.tool === TODO_TOOL) {
                return `Observation: to-do list ${h.content.command === 'write' ? 'saved' : 'read'}${h.content.success === false ? ` (failed: ${h.content.error})` : ''}, revision ${h.content.result?.revision ?? 0} (current list shown below)`;
              }
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

${TODO_TOOL_PROMPT}

${skills ? `## Skills (known procedures for this kind of task; follow them where they apply):\n${skills}\n\n` : ''}${pastExamples ? `## Similar Tasks That Worked Before:\n${pastExamples}\n\n` : ''}## Previous Steps:
${historyText}

${todo && !todo.empty ? `## ${todo.promptBlock()}\nKeep it current: mark items done as you finish them.\n\n` : ''}## Current Task:
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
  "clarificationQuestion": "Question to ask if needed (omit if not needed)",
  "clarificationOptions": ["Up to 4 short likely answers, if the question has obvious choices (omit otherwise)"],
  "todo": [{"text": "step", "status": "pending|in_progress|done"}]
}

Only include "action" if you need to use a tool. To see the commands of a tool listed only by name, use {"tool": "${DESCRIBE_TOOL}", "command": "describe", "params": {"name": "<tool>"}}.
Only include "finalAnswer" if you have completed the task.
Only include "todo" when your to-do list changes, and then send the whole list.
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
        const options = Array.isArray(parsed.clarificationOptions)
          ? parsed.clarificationOptions.filter(o => typeof o === 'string' && o.trim()).map(o => o.trim().substring(0, 60)).slice(0, 4)
          : [];
        return {
          reasoning: parsed.reasoning || '',
          action: parsed.action || null,
          finalAnswer: parsed.finalAnswer || null,
          needsClarification: (parsed.needsClarification && !!parsed.clarificationQuestion) || false,
          clarificationQuestion: parsed.clarificationQuestion || null,
          clarificationOptions: options,
          ...(Array.isArray(parsed.todo) ? { todo: parsed.todo } : {})
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
   * Execute an action using the appropriate plugin.
   * Not retried: a plugin command can have side effects that must not be repeated.
   */
  async executeAction(action, context) {
    const { tool, command, params } = action;
    const outcome = await executeTool(this.agent, tool, command, params || {}, context);
    if (tool !== DESCRIBE_TOOL) this.updateToolPerformance(tool, outcome.success);
    if (!outcome.success) {
      logger.warn(`ReAct action ${tool}.${command} failed: ${outcome.error || 'plugin reported failure'}`);
    }
    return { success: outcome.success, tool, command, ...(outcome.error ? { error: outcome.error } : { result: outcome.result }) };
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
    const run = this.activeRun;
    return {
      maxIterations: this.maxIterations,
      showThoughts: this.showThoughts,
      toolCount: this.tools.length,
      tools: this.tools.map(t => t.name),
      activeBudget: run ? { ...run.budget } : null,
      cancellation: {
        active: !!run,
        cancelled: !!run?.signal?.aborted,
        toolCalls: run?.toolCalls || 0,
        elapsedMs: run ? Date.now() - run.startTime : 0
      }
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
    if (config.executionBudget !== undefined) {
      this.executionBudget = { ...config.executionBudget };
    }
    if (config.budget !== undefined) {
      this.executionBudget = { ...config.budget };
    }
  }
}

export default ReActAgent;
