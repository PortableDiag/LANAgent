import { logger } from '../../utils/logger.js';
import { BaseAgentHandler } from './BaseAgentHandler.js';
import Project from '../../models/Project.js';

/**
 * ProjectAgentHandler
 *
 * Handles autonomous project execution with multi-session goal tracking.
 * Works through project phases: discovery, planning, execution, testing, review.
 */
export class ProjectAgentHandler extends BaseAgentHandler {
  constructor(mainAgent, agentDoc) {
    super(mainAgent, agentDoc);
    this.project = null;
  }

  async initialize() {
    await super.initialize();

    // Load linked project if exists
    if (this.agentDoc.projectId) {
      this.project = await Project.findById(this.agentDoc.projectId).populate('tasks');
    }

    logger.info(`ProjectAgentHandler initialized for: ${this.agentDoc.name}`);
  }

  /**
   * Execute a session
   */
  async execute(options = {}) {
    this.running = true;
    this.shouldStop = false;

    try {
      await this.log('execution_started', { options });

      // Determine current phase
      const phase = this.agentDoc.goal?.currentPhase || 'discovery';
      let result;

      switch (phase) {
        case 'discovery':
          result = await this.executeDiscovery();
          break;
        case 'planning':
          result = await this.executePlanning();
          break;
        case 'execution':
          result = await this.executeImplementation();
          break;
        case 'testing':
          result = await this.executeTesting();
          break;
        case 'review':
          result = await this.executeReview();
          break;
        default:
          result = { success: false, error: `Unknown phase: ${phase}` };
      }

      await this.log('execution_completed', { phase, result });
      return result;

    } catch (error) {
      logger.error(`ProjectAgentHandler execution error:`, error);
      await this.log('execution_error', { error: error.message });
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Discovery phase - understand the project requirements
   */
  async executeDiscovery() {
    const goal = this.agentDoc.goal?.description || 'No goal specified';

    const prompt = `You are an autonomous project agent working on: "${goal}"

This is the DISCOVERY phase. Your task is to:
1. Understand the project requirements
2. Identify what information you need
3. List questions that need answers
4. Identify potential challenges

Project context:
${this.project ? `Project: ${this.project.name}\nDescription: ${this.project.description}` : 'No linked project'}

Success criteria:
${(this.agentDoc.goal?.successCriteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}

Respond in JSON format:
{
  "understanding": "Your understanding of the project",
  "requirements": ["list", "of", "requirements"],
  "questions": ["questions", "that", "need", "answers"],
  "challenges": ["potential", "challenges"],
  "readyForPlanning": true/false,
  "nextSteps": ["what", "to", "do", "next"]
}`;

    const response = await this.generateResponse(prompt, { maxTokens: 1500 });
    const content = response.content || response;

    try {
      const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');

      // Store discovery results
      await this.updateState({
        discovery: parsed,
        discoveredAt: new Date()
      });

      // Check if ready for next phase
      if (parsed.readyForPlanning && !parsed.questions?.length) {
        await this.transitionPhase('planning');
        return { success: true, phase: 'discovery', nextPhase: 'planning', result: parsed };
      } else if (parsed.questions?.length > 0) {
        // Need human input
        await this.requestApproval(
          'answer_questions',
          `Discovery phase has questions that need answers`,
          { questions: parsed.questions }
        );
        return { success: true, phase: 'discovery', waitingApproval: true, result: parsed };
      }

      return { success: true, phase: 'discovery', result: parsed };
    } catch (error) {
      await this.addLearning('parsing', 'Failed to parse discovery response', 0.3);
      return { success: false, phase: 'discovery', error: 'Failed to parse response', raw: content };
    }
  }

  /**
   * Planning phase - create implementation plan
   */
  async executePlanning() {
    const discovery = this.getState().discovery || {};

    const prompt = `You are an autonomous project agent in the PLANNING phase.

Goal: ${this.agentDoc.goal?.description}

Discovery findings:
${JSON.stringify(discovery, null, 2)}

Create a detailed implementation plan. Include:
1. Phases/milestones
2. Specific tasks for each phase
3. Dependencies between tasks
4. Estimated complexity (1-10) for each task
5. Risk areas

Respond in JSON format:
{
  "plan": {
    "phases": [
      {
        "name": "Phase name",
        "description": "What this phase accomplishes",
        "tasks": [
          {
            "name": "Task name",
            "description": "What to do",
            "complexity": 5,
            "dependencies": []
          }
        ]
      }
    ]
  },
  "risks": ["identified", "risks"],
  "totalComplexity": 25,
  "readyForExecution": true/false
}`;

    const response = await this.generateResponse(prompt, { maxTokens: 2000 });
    const content = response.content || response;

    try {
      const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');

      await this.updateState({
        plan: parsed.plan,
        risks: parsed.risks,
        plannedAt: new Date()
      });

      // If requires approval for high complexity
      if (parsed.totalComplexity > 30 || this.agentDoc.config?.requiresApproval?.forPhaseTransition) {
        await this.requestApproval(
          'approve_plan',
          `Implementation plan ready for review (complexity: ${parsed.totalComplexity})`,
          { plan: parsed.plan, risks: parsed.risks }
        );
        return { success: true, phase: 'planning', waitingApproval: true, result: parsed };
      }

      if (parsed.readyForExecution) {
        await this.transitionPhase('execution');
        return { success: true, phase: 'planning', nextPhase: 'execution', result: parsed };
      }

      return { success: true, phase: 'planning', result: parsed };
    } catch (error) {
      return { success: false, phase: 'planning', error: 'Failed to parse response', raw: content };
    }
  }

  /**
   * Execution phase - implement the plan
   */
  async executeImplementation() {
    const state = this.getState();
    const plan = state.plan;

    if (!plan?.phases?.length) {
      await this.transitionPhase('planning');
      return { success: false, phase: 'execution', error: 'No plan available', nextPhase: 'planning' };
    }

    // Find current task
    const currentPhaseIndex = state.currentPhaseIndex || 0;
    const currentTaskIndex = state.currentTaskIndex || 0;

    if (currentPhaseIndex >= plan.phases.length) {
      await this.transitionPhase('testing');
      return { success: true, phase: 'execution', nextPhase: 'testing', message: 'All tasks completed' };
    }

    const currentPhase = plan.phases[currentPhaseIndex];
    const currentTask = currentPhase.tasks[currentTaskIndex];

    if (!currentTask) {
      // Move to next phase
      await this.updateState({
        currentPhaseIndex: currentPhaseIndex + 1,
        currentTaskIndex: 0
      });
      return await this.executeImplementation();
    }

    // Execute the task
    const prompt = `You are an autonomous project agent executing a task.

Project Goal: ${this.agentDoc.goal?.description}

Current Phase: ${currentPhase.name}
Current Task: ${currentTask.name}
Task Description: ${currentTask.description}

Available tools: ${Array.from(this.tools.keys()).join(', ')}

What action should be taken to complete this task? If you need to use a tool, specify which one.

Respond in JSON format:
{
  "reasoning": "Your thinking process",
  "action": {
    "type": "tool" | "code" | "research" | "manual",
    "tool": "tool_name if type is tool",
    "toolAction": "action to execute",
    "params": {},
    "description": "What this action does"
  },
  "taskComplete": false,
  "progress": "Description of progress made"
}`;

    const response = await this.generateResponse(prompt, { maxTokens: 1000 });
    const content = response.content || response;

    try {
      const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');

      // Execute the action if it's a tool call
      if (parsed.action?.type === 'tool' && parsed.action?.tool) {
        const toolResult = await this.executeTool(
          parsed.action.tool,
          parsed.action.toolAction,
          parsed.action.params || {}
        );
        parsed.toolResult = toolResult;
      }

      // Update progress
      if (parsed.taskComplete) {
        await this.updateState({
          currentTaskIndex: currentTaskIndex + 1,
          completedTasks: [...(state.completedTasks || []), {
            phase: currentPhase.name,
            task: currentTask.name,
            completedAt: new Date()
          }]
        });
      }

      await this.log('task_progress', {
        phase: currentPhase.name,
        task: currentTask.name,
        progress: parsed.progress,
        complete: parsed.taskComplete
      });

      return {
        success: true,
        phase: 'execution',
        currentPhase: currentPhase.name,
        currentTask: currentTask.name,
        result: parsed
      };
    } catch (error) {
      return { success: false, phase: 'execution', error: 'Failed to parse response', raw: content };
    }
  }

  /**
   * Testing phase - verify implementation
   */
  async executeTesting() {
    const state = this.getState();

    const prompt = `You are an autonomous project agent in the TESTING phase.

Project Goal: ${this.agentDoc.goal?.description}

Success Criteria:
${(this.agentDoc.goal?.successCriteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}

Completed Tasks:
${(state.completedTasks || []).map(t => `- ${t.phase}: ${t.task}`).join('\n')}

Verify that the implementation meets the success criteria. List any issues found.

Respond in JSON format:
{
  "testsPerformed": ["list", "of", "tests"],
  "criteriaResults": [
    { "criterion": "...", "passed": true/false, "notes": "..." }
  ],
  "issues": ["any", "issues", "found"],
  "overallPass": true/false,
  "readyForReview": true/false
}`;

    const response = await this.generateResponse(prompt, { maxTokens: 1500 });
    const content = response.content || response;

    try {
      const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');

      await this.updateState({
        testing: parsed,
        testedAt: new Date()
      });

      if (!parsed.overallPass && parsed.issues?.length > 0) {
        // Need to fix issues - go back to execution
        await this.addBlocker(`Testing failed: ${parsed.issues[0]}`, 'medium');
        await this.transitionPhase('execution');
        return { success: false, phase: 'testing', issues: parsed.issues, nextPhase: 'execution' };
      }

      if (parsed.readyForReview) {
        await this.transitionPhase('review');
        return { success: true, phase: 'testing', nextPhase: 'review', result: parsed };
      }

      return { success: true, phase: 'testing', result: parsed };
    } catch (error) {
      return { success: false, phase: 'testing', error: 'Failed to parse response', raw: content };
    }
  }

  /**
   * Review phase - final review and completion
   */
  async executeReview() {
    const state = this.getState();

    const prompt = `You are an autonomous project agent in the REVIEW phase.

Project Goal: ${this.agentDoc.goal?.description}

Summary of work:
- Discovery: ${state.discovery ? 'Complete' : 'Skipped'}
- Planning: ${state.plan ? `${state.plan.phases?.length} phases planned` : 'Skipped'}
- Execution: ${(state.completedTasks || []).length} tasks completed
- Testing: ${state.testing?.overallPass ? 'Passed' : 'Needs review'}

Learnings from this project:
${(this.agentDoc.state.learnings || []).map(l => `- ${l.category}: ${l.insight}`).join('\n')}

Create a final summary of the project completion.

Respond in JSON format:
{
  "summary": "Project completion summary",
  "achievements": ["what", "was", "accomplished"],
  "lessonsLearned": ["lessons", "for", "future"],
  "recommendations": ["follow-up", "recommendations"],
  "projectComplete": true/false
}`;

    const response = await this.generateResponse(prompt, { maxTokens: 1000 });
    const content = response.content || response;

    try {
      const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');

      await this.updateState({
        review: parsed,
        reviewedAt: new Date()
      });

      // Store lessons learned
      for (const lesson of (parsed.lessonsLearned || [])) {
        await this.addLearning('project_lesson', lesson, 0.8);
      }

      if (parsed.projectComplete) {
        this.agentDoc.status = 'completed';
        await this.agentDoc.save();

        // Update linked project if exists
        if (this.project) {
          this.project.status = 'completed';
          await this.project.save();
        }

        return { success: true, phase: 'review', complete: true, result: parsed };
      }

      return { success: true, phase: 'review', result: parsed };
    } catch (error) {
      return { success: false, phase: 'review', error: 'Failed to parse response', raw: content };
    }
  }

  /**
   * Transition to a new phase
   */
  async transitionPhase(newPhase) {
    const oldPhase = this.agentDoc.goal?.currentPhase;

    // Update phase in goal
    if (!this.agentDoc.goal) {
      this.agentDoc.goal = {};
    }
    this.agentDoc.goal.currentPhase = newPhase;

    // Record phase in phases array
    if (!this.agentDoc.goal.phases) {
      this.agentDoc.goal.phases = [];
    }

    // Mark old phase as completed
    const oldPhaseEntry = this.agentDoc.goal.phases.find(p => p.name === oldPhase);
    if (oldPhaseEntry) {
      oldPhaseEntry.status = 'completed';
      oldPhaseEntry.completedAt = new Date();
    }

    // Add new phase
    this.agentDoc.goal.phases.push({
      name: newPhase,
      status: 'in_progress',
      startedAt: new Date()
    });

    await this.agentDoc.save();
    await this.log('phase_transition', { from: oldPhase, to: newPhase });

    logger.info(`Project agent ${this.agentDoc.name} transitioned from ${oldPhase} to ${newPhase}`);
  }

  /**
   * Handle approval granted
   */
  async onApproved(approval) {
    logger.info(`Approval granted for ${approval.action} on project agent ${this.agentDoc.name}`);

    if (approval.action === 'approve_plan') {
      await this.transitionPhase('execution');
    } else if (approval.action === 'answer_questions') {
      // Questions were answered in approval data
      await this.transitionPhase('planning');
    }
  }
}

export default ProjectAgentHandler;
