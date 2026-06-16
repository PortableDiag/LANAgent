import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';

/**
 * SubAgents Plugin
 *
 * Provides natural language interface to the Sub-Agent Orchestrator.
 * Allows creating, managing, and monitoring autonomous sub-agents.
 */
export default class SubAgentsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'subagents';
    this.version = '1.0.0';
    this.description = 'Manage autonomous sub-agents for complex tasks';
    this.category = 'system';
    this.enabled = true;

    this.commands = [
      // Status & Listing
      {
        command: 'listAgents',
        description: 'List all sub-agents',
        usage: 'list agents [type:domain|project|task]',
        examples: [
          'list all agents',
          'show my sub-agents',
          'what agents are running',
          'list domain agents',
          'show project agents'
        ]
      },
      {
        command: 'getStatus',
        description: 'Get orchestrator and agent status',
        usage: 'status [agentId]',
        examples: [
          'sub-agent status',
          'orchestrator status',
          'how are my agents doing'
        ]
      },

      // Crypto Agent
      {
        command: 'createCryptoAgent',
        description: 'Create a crypto strategy agent',
        usage: 'create crypto agent [networkMode:testnet|mainnet]',
        examples: [
          'create crypto agent',
          'set up crypto trading agent',
          'start crypto strategy agent on testnet'
        ]
      },
      {
        command: 'getCryptoStatus',
        description: 'Get crypto agent status',
        usage: 'crypto agent status',
        examples: [
          'crypto agent status',
          'how is my crypto agent',
          'check crypto trading'
        ]
      },
      {
        command: 'runCryptoAgent',
        description: 'Run the crypto strategy agent',
        usage: 'run crypto agent',
        examples: [
          'run crypto agent',
          'execute crypto strategy',
          'start crypto trading'
        ]
      },

      // Project Agents
      {
        command: 'createProjectAgent',
        description: 'Create a project agent for autonomous goal execution',
        usage: 'create project agent <name> <goal>',
        examples: [
          'create project agent for ESP32 development',
          'set up autonomous agent for refactoring auth',
          'new project agent to build sensor hub'
        ]
      },

      // Task Agents
      {
        command: 'createTaskAgent',
        description: 'Create and run a task agent',
        usage: 'create task agent <task>',
        examples: [
          'create task to research API patterns',
          'run task agent for code review',
          'delegate task to find security issues'
        ]
      },

      // Agent Control
      {
        command: 'runAgent',
        description: 'Run a specific agent',
        usage: 'run agent <agentId>',
        examples: [
          'run agent abc123',
          'start the project agent',
          'execute agent'
        ]
      },
      {
        command: 'stopAgent',
        description: 'Stop a running agent',
        usage: 'stop agent <agentId>',
        examples: [
          'stop agent abc123',
          'halt the crypto agent',
          'stop running agent'
        ]
      },
      {
        command: 'pauseAgent',
        description: 'Pause an agent',
        usage: 'pause agent <agentId>',
        examples: [
          'pause agent abc123',
          'pause crypto agent'
        ]
      },
      {
        command: 'resumeAgent',
        description: 'Resume a paused agent',
        usage: 'resume agent <agentId>',
        examples: [
          'resume agent abc123',
          'unpause crypto agent'
        ]
      },
      {
        command: 'deleteAgent',
        description: 'Delete an agent',
        usage: 'delete agent <agentId>',
        examples: [
          'delete agent abc123',
          'remove the test agent'
        ]
      },

      // Approvals
      {
        command: 'listApprovals',
        description: 'List pending approvals',
        usage: 'list approvals',
        examples: [
          'what approvals are pending',
          'show agent approvals',
          'any approvals waiting'
        ]
      },
      {
        command: 'approve',
        description: 'Approve a pending action',
        usage: 'approve <agentId> <approvalId>',
        examples: [
          'approve the trade',
          'approve agent action'
        ]
      },
      {
        command: 'reject',
        description: 'Reject a pending action',
        usage: 'reject <agentId> <approvalId>',
        examples: [
          'reject the trade',
          'deny agent action'
        ]
      },

      // History & Learnings
      {
        command: 'getHistory',
        description: 'Get agent execution history',
        usage: 'history <agentId>',
        examples: [
          'show agent history',
          'what has the crypto agent done'
        ]
      },
      {
        command: 'getLearnings',
        description: 'Get agent learnings',
        usage: 'learnings <agentId>',
        examples: [
          'what has the agent learned',
          'show learnings from crypto agent'
        ]
      }
    ];
  }

  async initialize() {
    // Agent is received via constructor
    // Don't cache orchestrator - it may not exist yet during plugin loading
    // Instead, get it lazily in execute()
    logger.info('SubAgents plugin initialized');
  }

  /**
   * Get orchestrator lazily (it's set on agent after plugins are loaded)
   */
  getOrchestrator() {
    return this.agent?.subAgentOrchestrator || this.agent?.services?.get('subAgentOrchestrator');
  }

  async execute(params) {
    const { action, ...data } = params;
    const orchestrator = this.getOrchestrator();

    if (!orchestrator) {
      return {
        success: false,
        error: 'Sub-agent orchestrator not available. It may still be initializing.'
      };
    }

    // Store for use in methods
    this.orchestrator = orchestrator;

    switch (action) {
      case 'listAgents':
        return await this.listAgents(data);
      case 'getStatus':
        return await this.getStatus(data);
      case 'createCryptoAgent':
        return await this.createCryptoAgent(data);
      case 'getCryptoStatus':
        return await this.getCryptoStatus();
      case 'runCryptoAgent':
        return await this.runCryptoAgent();
      case 'createProjectAgent':
        return await this.createProjectAgent(data);
      case 'createTaskAgent':
        return await this.createTaskAgent(data);
      case 'runAgent':
        return await this.runAgent(data);
      case 'stopAgent':
        return await this.stopAgent(data);
      case 'pauseAgent':
        return await this.pauseAgent(data);
      case 'resumeAgent':
        return await this.resumeAgent(data);
      case 'deleteAgent':
        return await this.deleteAgent(data);
      case 'listApprovals':
        return await this.listApprovals();
      case 'approve':
        return await this.processApproval(data, true);
      case 'reject':
        return await this.processApproval(data, false);
      case 'getHistory':
        return await this.getHistory(data);
      case 'getLearnings':
        return await this.getLearnings(data);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  async listAgents(data) {
    const filter = {};
    if (data.type) filter.type = data.type;

    const agents = await this.orchestrator.listAgents(filter);

    if (agents.length === 0) {
      return {
        success: true,
        message: 'No sub-agents found. Create one using "create crypto agent" or "create project agent".',
        data: []
      };
    }

    const summary = agents.map(a =>
      `- **${a.name}** (${a.type}): ${a.status}${a.pendingApprovals > 0 ? ` - ${a.pendingApprovals} pending approvals` : ''}`
    ).join('\n');

    return {
      success: true,
      message: `Found ${agents.length} sub-agent(s):\n${summary}`,
      data: agents
    };
  }

  async getStatus(data) {
    if (data.agentId) {
      const agent = await this.orchestrator.getAgent(data.agentId);
      if (!agent) {
        return { success: false, error: 'Agent not found' };
      }
      return { success: true, data: agent.getSummary() };
    }

    const status = this.orchestrator.getStatus();
    return {
      success: true,
      message: `Orchestrator Status:\n- Initialized: ${status.initialized}\n- Total Agents: ${status.totalAgents}\n- Registered Domains: ${status.registeredDomains.join(', ') || 'None'}`,
      data: status
    };
  }

  async createCryptoAgent(data) {
    try {
      const existing = await this.orchestrator.listAgents({ domain: 'crypto', type: 'domain' });
      if (existing.length > 0) {
        return {
          success: false,
          error: 'Crypto agent already exists',
          data: existing[0]
        };
      }

      const agent = await this.orchestrator.createAgent({
        name: 'Crypto Strategy Agent',
        type: 'domain',
        domain: 'crypto',
        description: 'Intelligent crypto trading with multiple strategies',
        config: {
          maxSessionsPerDay: 24,
          cooldownMinutes: 30,
          budget: {
            dailyApiCalls: 50,
            dailyTokens: 25000
          },
          requiresApproval: {
            forTrades: data.requireApproval !== false
          }
        },
        domainConfig: {
          networkMode: data.networkMode || 'testnet',
          enabledStrategies: data.strategies || ['native_maximizer'],
          priceThresholds: {
            sellThreshold: data.sellThreshold || 5,
            buyThreshold: data.buyThreshold || -3
          },
          minConfidence: data.minConfidence || 0.7,
          slippageTolerance: 2
        },
        schedule: {
          runPattern: 'event-driven',
          eventTriggers: ['crypto:significant_move', 'crypto:heartbeat', 'manual']
        },
        tags: ['crypto', 'trading', 'automated'],
        createdBy: 'natural_language'
      });

      return {
        success: true,
        message: `Crypto Strategy Agent created! Mode: ${data.networkMode || 'testnet'}. Run it with "run crypto agent".`,
        data: agent.getSummary()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getCryptoStatus() {
    const agents = await this.orchestrator.listAgents({ domain: 'crypto', type: 'domain' });
    if (agents.length === 0) {
      return {
        success: false,
        error: 'No crypto agent found. Create one with "create crypto agent".'
      };
    }

    const agent = await this.orchestrator.getAgent(agents[0].id);
    const handler = this.orchestrator.agentHandlers.get(agents[0].id);

    return {
      success: true,
      message: `Crypto Agent Status: ${agent.status}\nSessions: ${agent.usage.totalSessions}\nSuccess Rate: ${(agent.usage.performance.successRate || 0).toFixed(1)}%`,
      data: {
        ...agent.getSummary(),
        domainState: agent.state.domainState,
        handlerStatus: handler?.getStatus()
      }
    };
  }

  async runCryptoAgent() {
    const agents = await this.orchestrator.listAgents({ domain: 'crypto', type: 'domain' });
    if (agents.length === 0) {
      return {
        success: false,
        error: 'No crypto agent found. Create one with "create crypto agent".'
      };
    }

    const result = await this.orchestrator.runAgent(agents[0].id);
    return {
      success: result.success,
      message: result.success
        ? 'Crypto agent started! It will analyze market data and execute strategies.'
        : `Could not start: ${result.reason}`,
      data: result
    };
  }

  async createProjectAgent(data) {
    if (!data.name && !data.goal) {
      return {
        success: false,
        error: 'Please provide a name and goal for the project agent'
      };
    }

    const agent = await this.orchestrator.createAgent({
      name: data.name || 'New Project Agent',
      type: 'project',
      domain: 'project',
      description: data.goal,
      goal: {
        description: data.goal,
        successCriteria: data.successCriteria || [],
        currentPhase: 'discovery'
      },
      config: {
        maxSessionsPerDay: 5,
        sessionDurationMinutes: 30,
        cooldownMinutes: 60,
        budget: {
          dailyApiCalls: 100,
          dailyTokens: 50000
        },
        requiresApproval: {
          forPhaseTransition: true,
          forHighValueDecisions: true
        }
      },
      schedule: {
        runPattern: data.runPattern || '2h',
        eventTriggers: ['manual', 'approval_granted']
      },
      tags: ['project', 'autonomous'],
      createdBy: 'natural_language'
    });

    return {
      success: true,
      message: `Project Agent "${agent.name}" created! It will start in Discovery phase.`,
      data: agent.getSummary()
    };
  }

  async createTaskAgent(data) {
    if (!data.task) {
      return {
        success: false,
        error: 'Please provide a task description'
      };
    }

    const agent = await this.orchestrator.createAgent({
      name: data.name || `Task: ${data.task.substring(0, 30)}...`,
      type: 'task',
      domain: 'task',
      description: data.task,
      goal: {
        description: data.task
      },
      config: {
        maxSessionsPerDay: 1,
        sessionDurationMinutes: 10,
        cooldownMinutes: 0,
        budget: {
          dailyApiCalls: 20,
          dailyTokens: 10000
        }
      },
      tags: ['task', 'short-lived'],
      createdBy: 'natural_language'
    });

    // Run immediately if requested
    let runResult = null;
    if (data.runImmediately !== false) {
      runResult = await this.orchestrator.runAgent(agent._id.toString());
    }

    return {
      success: true,
      message: `Task Agent created${runResult?.success ? ' and started' : ''}!`,
      data: {
        agent: agent.getSummary(),
        runResult
      }
    };
  }

  async runAgent(data) {
    if (!data.agentId) {
      return { success: false, error: 'Please provide an agent ID' };
    }

    const result = await this.orchestrator.runAgent(data.agentId, { force: data.force });
    return {
      success: result.success,
      message: result.success ? result.message : result.reason,
      data: result
    };
  }

  async stopAgent(data) {
    if (!data.agentId) {
      return { success: false, error: 'Please provide an agent ID' };
    }

    const result = await this.orchestrator.stopAgent(data.agentId);
    return result;
  }

  async pauseAgent(data) {
    if (!data.agentId) {
      return { success: false, error: 'Please provide an agent ID' };
    }

    const result = await this.orchestrator.pauseAgent(data.agentId);
    return result;
  }

  async resumeAgent(data) {
    if (!data.agentId) {
      return { success: false, error: 'Please provide an agent ID' };
    }

    const result = await this.orchestrator.resumeAgent(data.agentId);
    return result;
  }

  async deleteAgent(data) {
    if (!data.agentId) {
      return { success: false, error: 'Please provide an agent ID' };
    }

    const result = await this.orchestrator.deleteAgent(data.agentId);
    return result;
  }

  async listApprovals() {
    const agents = await this.orchestrator.listAgents();
    const allApprovals = [];

    for (const agent of agents) {
      if (agent.pendingApprovals > 0) {
        const fullAgent = await this.orchestrator.getAgent(agent.id);
        const pending = fullAgent.state.pendingApprovals.filter(a => a.status === 'pending');
        pending.forEach(p => {
          allApprovals.push({
            agentId: agent.id,
            agentName: agent.name,
            approval: p
          });
        });
      }
    }

    if (allApprovals.length === 0) {
      return {
        success: true,
        message: 'No pending approvals',
        data: []
      };
    }

    const summary = allApprovals.map(a =>
      `- **${a.agentName}**: ${a.approval.action} - ${a.approval.description}`
    ).join('\n');

    return {
      success: true,
      message: `${allApprovals.length} pending approval(s):\n${summary}`,
      data: allApprovals
    };
  }

  async processApproval(data, approved) {
    if (!data.agentId || !data.approvalId) {
      return { success: false, error: 'Please provide agent ID and approval ID' };
    }

    const result = await this.orchestrator.processApproval(
      data.agentId,
      data.approvalId,
      approved,
      'natural_language'
    );

    return {
      success: true,
      message: `Approval ${approved ? 'granted' : 'rejected'}`,
      data: result
    };
  }

  async getHistory(data) {
    if (!data.agentId) {
      return { success: false, error: 'Please provide an agent ID' };
    }

    const history = await this.orchestrator.getAgentHistory(data.agentId, data.limit || 20);

    if (history.length === 0) {
      return { success: true, message: 'No history found', data: [] };
    }

    const summary = history.slice(0, 10).map(h =>
      `- ${new Date(h.timestamp).toLocaleString()}: ${h.event}`
    ).join('\n');

    return {
      success: true,
      message: `Recent history:\n${summary}`,
      data: history
    };
  }

  async getLearnings(data) {
    if (!data.agentId) {
      return { success: false, error: 'Please provide an agent ID' };
    }

    const learnings = await this.orchestrator.getAgentLearnings(data.agentId);

    if (learnings.length === 0) {
      return { success: true, message: 'No learnings recorded yet', data: [] };
    }

    const summary = learnings.slice(-5).map(l =>
      `- [${l.category}] ${l.insight} (${(l.confidence * 100).toFixed(0)}% confidence)`
    ).join('\n');

    return {
      success: true,
      message: `Recent learnings:\n${summary}`,
      data: learnings
    };
  }
}
