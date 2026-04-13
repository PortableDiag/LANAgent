import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';

/**
 * PlanExecuteAgent - Implements the Plan-and-Execute pattern
 *
 * Unlike ReAct which interleaves thinking and acting, Plan-Execute:
 * 1. Creates a complete plan upfront
 * 2. Executes each step sequentially
 * 3. Optionally replans if errors occur or conditions change
 *
 * This is better for tasks where:
 * - The full scope can be determined upfront
 * - Steps are well-defined and predictable
 * - You want clear progress tracking
 */
export class PlanExecuteAgent extends EventEmitter {
  constructor(agent, options = {}) {
    super();
    this.agent = agent;
    this.enableReplanning = options.enableReplanning !== false;
    this.maxReplans = options.maxReplans || 3;
    this.showProgress = options.showProgress || false;
    this.thoughtStore = options.thoughtStore || null;

    // Components
    this.planner = new Planner(agent, options);
    this.executor = new Executor(agent, options);
  }

  /**
   * Initialize the agent
   */
  async initialize() {
    await this.planner.initialize();
    await this.executor.initialize();
    logger.info('PlanExecuteAgent initialized');
  }

  /**
   * Run the Plan-Execute loop for a given task
   */
  async run(task, context = {}) {
    const startTime = Date.now();
    let replanCount = 0;
    let plan = null;
    const results = [];

    logger.info(`PlanExecuteAgent starting with task: ${task.substring(0, 100)}...`);
    this.emit('start', { task, context });

    try {
      // Step 1: Create initial plan
      plan = await this.planner.createPlan(task, context);
      this.emit('planCreated', { plan });

      if (this.showProgress && context.showThinking) {
        await context.showThinking(`📋 Plan created with ${plan.steps.length} steps`);
      }

      // Validate plan
      if (!plan.steps || plan.steps.length === 0) {
        return {
          success: false,
          error: 'Could not create a valid plan for this task',
          plan,
          results,
          duration: Date.now() - startTime
        };
      }

      // Step 2: Execute each step
      const sortedSteps = this.planner.sortStepsByPriority(plan.steps);
      for (let i = 0; i < sortedSteps.length; i++) {
        const step = sortedSteps[i];
        const stepNumber = i + 1;

        this.emit('stepStart', { stepNumber, step, totalSteps: sortedSteps.length });

        if (this.showProgress && context.showThinking) {
          await context.showThinking(`⏳ Step ${stepNumber}/${sortedSteps.length}: ${step.description}`);
        }

        // Execute the step
        const result = await this.executor.execute(step, context);
        results.push({ step, result, stepNumber });

        this.emit('stepComplete', { stepNumber, step, result, totalSteps: sortedSteps.length });

        // Check for failure
        if (!result.success) {
          logger.warn(`Step ${stepNumber} failed: ${result.error}`);

          // Step 3: Replan if enabled and we haven't exceeded max replans
          if (this.enableReplanning && replanCount < this.maxReplans) {
            replanCount++;
            this.emit('replanning', { reason: result.error, replanCount });

            if (this.showProgress && context.showThinking) {
              await context.showThinking(`🔄 Replanning due to error (attempt ${replanCount}/${this.maxReplans})`);
            }

            // Create new plan considering the error
            plan = await this.planner.replan(task, plan, results, result.error);
            this.emit('planUpdated', { plan, replanCount });

            if (plan.steps && plan.steps.length > 0) {
              // Reset loop to start with new plan
              i = -1;
              results.length = 0; // Clear previous results
              continue;
            } else {
              return {
                success: false,
                error: `Failed to replan after error: ${result.error}`,
                plan,
                results,
                replanCount,
                duration: Date.now() - startTime
              };
            }
          } else {
            // No replanning or max replans reached
            const finalResult = {
              success: false,
              error: result.error,
              plan,
              results,
              completedSteps: i,
              totalSteps: sortedSteps.length,
              replanCount,
              duration: Date.now() - startTime
            };

            if (this.thoughtStore) {
              await this.thoughtStore.saveThoughtChain(task, [{ type: 'plan', content: plan }, ...results], finalResult);
            }

            this.emit('failed', finalResult);
            return finalResult;
          }
        }
      }

      // All steps completed successfully
      const finalResult = {
        success: true,
        plan,
        results,
        completedSteps: sortedSteps.length,
        totalSteps: sortedSteps.length,
        replanCount,
        duration: Date.now() - startTime,
        summary: this.generateSummary(task, plan, results)
      };

      if (this.thoughtStore) {
        await this.thoughtStore.saveThoughtChain(task, [{ type: 'plan', content: plan }, ...results], finalResult);
      }

      this.emit('complete', finalResult);
      return finalResult;

    } catch (error) {
      logger.error('PlanExecuteAgent error:', error);
      const errorResult = {
        success: false,
        error: error.message,
        plan,
        results,
        replanCount,
        duration: Date.now() - startTime
      };

      this.emit('error', { error, result: errorResult });
      return errorResult;
    }
  }

  /**
   * Generate a summary of the execution
   */
  generateSummary(task, plan, results) {
    const successfulSteps = results.filter(r => r.result.success);
    const failedSteps = results.filter(r => !r.result.success);

    let summary = `Task: ${task}\n\n`;
    summary += `Plan: ${plan.objective || 'Execute task'}\n`;
    summary += `Steps completed: ${successfulSteps.length}/${results.length}\n\n`;

    summary += 'Results:\n';
    for (const { stepNumber, step, result } of results) {
      const status = result.success ? '✅' : '❌';
      summary += `${status} Step ${stepNumber}: ${step.description}\n`;
      if (result.output) {
        const outputPreview = typeof result.output === 'string'
          ? result.output.substring(0, 100)
          : JSON.stringify(result.output).substring(0, 100);
        summary += `   Output: ${outputPreview}...\n`;
      }
    }

    return summary;
  }

  /**
   * Get current state
   */
  getState() {
    return {
      enableReplanning: this.enableReplanning,
      maxReplans: this.maxReplans,
      showProgress: this.showProgress
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    if (config.enableReplanning !== undefined) {
      this.enableReplanning = config.enableReplanning;
    }
    if (config.maxReplans !== undefined) {
      this.maxReplans = config.maxReplans;
    }
    if (config.showProgress !== undefined) {
      this.showProgress = config.showProgress;
    }
  }
}

/**
 * Planner - Creates and updates execution plans
 */
class Planner {
  constructor(agent, options = {}) {
    this.agent = agent;
    this.planTimeout = options.planTimeout || 60000;
    this.tools = [];
  }

  async initialize() {
    await this.refreshTools();
  }

  async refreshTools() {
    this.tools = [];
    if (!this.agent.apiManager || !this.agent.apiManager.plugins) return;

    for (const [name, plugin] of this.agent.apiManager.plugins) {
      if (!plugin.enabled) continue;

      this.tools.push({
        name,
        description: plugin.description || `${name} plugin`,
        commands: (plugin.commands || []).map(cmd => ({
          command: cmd.command,
          description: cmd.description
        }))
      });
    }
  }

  /**
   * Create an initial plan for a task
   */
  async createPlan(task, context = {}) {
    const toolDescriptions = this.tools.map(t => {
      const cmds = t.commands.map(c => `  - ${c.command}: ${c.description}`).join('\n');
      return `**${t.name}**: ${t.description}\n${cmds}`;
    }).join('\n\n');

    const prompt = `You are a planning agent. Create a step-by-step plan to accomplish the following task.

## Available Tools:
${toolDescriptions}

## Task:
${task}

## Instructions:
Create a detailed plan with specific steps. Each step should use one of the available tools.

Respond in this JSON format:
{
  "objective": "Brief description of the overall goal",
  "steps": [
    {
      "stepNumber": 1,
      "description": "What this step does",
      "tool": "tool_name",
      "command": "action_name",
      "params": { "param1": "value1" },
      "expectedOutput": "What we expect to get from this step",
      "complexity": "low|medium|high",
      "urgency": "low|medium|high"
    }
  ],
  "dependencies": "Any dependencies between steps",
  "estimatedComplexity": "low|medium|high"
}

Respond with valid JSON only.`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 1500,
        temperature: 0.3
      });

      const content = response.content || response;
      return this.parsePlan(content);
    } catch (error) {
      logger.error('Planner error:', error);
      throw error;
    }
  }

  /**
   * Create a revised plan after an error
   */
  async replan(task, originalPlan, results, error) {
    const completedSteps = results.filter(r => r.result.success);
    const completedSummary = completedSteps.map(r =>
      `Step ${r.stepNumber}: ${r.step.description} - ${r.result.success ? 'Success' : 'Failed'}`
    ).join('\n');

    const prompt = `You are a planning agent. The original plan encountered an error and needs revision.

## Original Task:
${task}

## Original Plan Objective:
${originalPlan.objective}

## Completed Steps:
${completedSummary || 'None'}

## Error Encountered:
${error}

## Instructions:
Create a revised plan that:
1. Considers what was already accomplished
2. Works around or addresses the error
3. Completes the remaining task

Respond in this JSON format:
{
  "objective": "Revised goal considering the error",
  "steps": [
    {
      "stepNumber": 1,
      "description": "What this step does",
      "tool": "tool_name",
      "command": "action_name",
      "params": { "param1": "value1" },
      "expectedOutput": "What we expect",
      "complexity": "low|medium|high",
      "urgency": "low|medium|high"
    }
  ],
  "adaptations": "How this plan addresses the previous error"
}

Respond with valid JSON only.`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 1500,
        temperature: 0.4
      });

      const content = response.content || response;
      return this.parsePlan(content);
    } catch (error) {
      logger.error('Replanner error:', error);
      return { steps: [], objective: 'Replan failed' };
    }
  }

  /**
   * Parse plan response from LLM
   */
  parsePlan(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          objective: parsed.objective || 'Execute task',
          steps: (parsed.steps || []).map((step, idx) => ({
            stepNumber: step.stepNumber || idx + 1,
            description: step.description || `Step ${idx + 1}`,
            tool: step.tool,
            command: step.command,
            params: step.params || {},
            expectedOutput: step.expectedOutput,
            complexity: step.complexity || 'medium',
            urgency: step.urgency || 'medium',
            priority: this.calculatePriority(step.complexity, step.urgency)
          })),
          dependencies: parsed.dependencies,
          estimatedComplexity: parsed.estimatedComplexity || 'medium',
          adaptations: parsed.adaptations
        };
      }

      logger.warn('Could not parse plan response as JSON');
      return { steps: [], objective: 'Parse failed' };
    } catch (error) {
      logger.error('Plan parse error:', error);
      return { steps: [], objective: 'Parse failed' };
    }
  }

  /**
   * Calculate priority based on complexity and urgency
   */
  calculatePriority(complexity, urgency) {
    const complexityWeight = { low: 1, medium: 2, high: 3 };
    const urgencyWeight = { low: 1, medium: 2, high: 3 };
    return complexityWeight[complexity] + urgencyWeight[urgency];
  }

  /**
   * Sort steps by priority
   */
  sortStepsByPriority(steps) {
    return steps.sort((a, b) => b.priority - a.priority);
  }
}

/**
 * Executor - Executes individual plan steps
 */
class Executor {
  constructor(agent, options = {}) {
    this.agent = agent;
    this.stepTimeout = options.stepTimeout || 30000;
    this.toolMap = new Map();
  }

  async initialize() {
    await this.refreshTools();
  }

  async refreshTools() {
    this.toolMap.clear();
    if (!this.agent.apiManager || !this.agent.apiManager.plugins) return;

    for (const [name, plugin] of this.agent.apiManager.plugins) {
      if (plugin.enabled) {
        this.toolMap.set(name, plugin);
      }
    }
  }

  /**
   * Execute a single step
   */
  async execute(step, context = {}) {
    const { tool, command, params } = step;

    try {
      // Validate tool exists
      const plugin = this.toolMap.get(tool);
      if (!plugin) {
        return {
          success: false,
          error: `Tool '${tool}' not found or not enabled`,
          step
        };
      }

      // Execute with timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Step execution timeout')), this.stepTimeout)
      );

      const executionPromise = plugin.execute({
        action: command,
        ...params
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);

      return {
        success: true,
        output: result,
        step
      };
    } catch (error) {
      logger.error(`Executor error for ${tool}.${command}:`, error);
      return {
        success: false,
        error: error.message,
        step
      };
    }
  }
}

export default PlanExecuteAgent;
