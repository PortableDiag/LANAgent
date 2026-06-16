import express from 'express';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * Sub-Agent Orchestrator API Routes
 *
 * Manages autonomous sub-agents (domain, project, task)
 *
 * IMPORTANT: Specific routes (/crypto/*, /project/*, /task/*) MUST be defined
 * BEFORE parameterized routes (/:id/*) to ensure correct matching.
 */

// Helper to get orchestrator
function getOrchestrator(req) {
  const agent = req.app.locals.agent;
  return agent?.subAgentOrchestrator || agent?.services?.get('subAgentOrchestrator');
}

// ==================== STATUS ====================

/**
 * GET /api/subagents/status
 * Get orchestrator status
 */
router.get('/status', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const status = orchestrator.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get orchestrator status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CRYPTO DOMAIN AGENT ====================
// MUST be defined before /:id routes

/**
 * POST /api/subagents/crypto/create
 * Create the default crypto strategy agent
 */
router.post('/crypto/create', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    // Check if crypto agent already exists
    const existing = await orchestrator.listAgents({ domain: 'crypto', type: 'domain' });
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Crypto strategy agent already exists',
        existingAgent: existing[0]
      });
    }

    const {
      networkMode = 'testnet',
      enabledStrategies = ['native_maximizer'],
      priceThresholds = { sellThreshold: 5, buyThreshold: -3 },
      minConfidence = 0.7,
      requiresApproval = { forTrades: true }
    } = req.body;

    const agent = await orchestrator.createAgent({
      name: 'Crypto Strategy Agent',
      type: 'domain',
      domain: 'crypto',
      description: 'Intelligent crypto trading with multiple strategies',
      config: {
        maxSessionsPerDay: 24, // Can run hourly
        cooldownMinutes: 30,
        budget: {
          dailyApiCalls: 50,
          dailyTokens: 25000
        },
        requiresApproval
      },
      domainConfig: {
        networkMode,
        enabledStrategies,
        priceThresholds,
        minConfidence,
        slippageTolerance: 2
      },
      schedule: {
        runPattern: 'event-driven', // Triggered by price signals, not blind loops
        eventTriggers: ['crypto:significant_move', 'crypto:heartbeat', 'manual']
      },
      tags: ['crypto', 'trading', 'automated'],
      createdBy: 'api'
    });

    res.status(201).json({ success: true, data: agent.getSummary() });
  } catch (error) {
    logger.error('Failed to create crypto agent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/subagents/crypto/status
 * Get crypto agent status (convenience endpoint)
 */
router.get('/crypto/status', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const agents = await orchestrator.listAgents({ domain: 'crypto', type: 'domain' });
    if (agents.length === 0) {
      return res.status(404).json({ error: 'Crypto agent not found. Create one first.' });
    }

    const agent = await orchestrator.getAgent(agents[0].id);
    const handler = orchestrator.agentHandlers.get(agents[0].id);

    res.json({
      success: true,
      data: {
        ...agent.getSummary(),
        domainState: agent.state.domainState,
        domainConfig: agent.config.domainConfig,
        handlerStatus: handler?.getStatus()
      }
    });
  } catch (error) {
    logger.error('Failed to get crypto agent status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subagents/crypto/run
 * Run the crypto agent (convenience endpoint)
 */
router.post('/crypto/run', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const agents = await orchestrator.listAgents({ domain: 'crypto', type: 'domain' });
    if (agents.length === 0) {
      return res.status(404).json({ error: 'Crypto agent not found. Create one first.' });
    }

    const result = await orchestrator.runAgent(agents[0].id, req.body);
    res.json(result);
  } catch (error) {
    logger.error('Failed to run crypto agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== PROJECT AGENTS ====================
// MUST be defined before /:id routes

/**
 * POST /api/subagents/project/create
 * Create a project agent from an existing project
 */
router.post('/project/create', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const {
      projectId,
      name,
      goal,
      successCriteria,
      config = {}
    } = req.body;

    if (!name && !projectId) {
      return res.status(400).json({ error: 'Either name or projectId is required' });
    }

    if (!goal?.description) {
      return res.status(400).json({ error: 'goal.description is required' });
    }

    const agent = await orchestrator.createAgent({
      name: name || `Project Agent: ${projectId}`,
      type: 'project',
      domain: 'project',
      projectId,
      description: goal.description,
      goal: {
        description: goal.description,
        successCriteria: successCriteria || [],
        currentPhase: 'discovery',
        phases: []
      },
      config: {
        maxSessionsPerDay: config.maxSessionsPerDay || 5,
        sessionDurationMinutes: config.sessionDurationMinutes || 30,
        cooldownMinutes: config.cooldownMinutes || 60,
        budget: config.budget || {
          dailyApiCalls: 100,
          dailyTokens: 50000
        },
        requiresApproval: config.requiresApproval || {
          forPhaseTransition: true,
          forHighValueDecisions: true
        },
        allowedTools: config.allowedTools || []
      },
      schedule: {
        runPattern: config.runPattern || '2h', // Every 2 hours by default
        eventTriggers: ['manual', 'approval_granted']
      },
      tags: ['project', 'autonomous'],
      createdBy: 'api'
    });

    res.status(201).json({ success: true, data: agent.getSummary() });
  } catch (error) {
    logger.error('Failed to create project agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TASK AGENTS ====================
// MUST be defined before /:id routes

/**
 * POST /api/subagents/task/create
 * Create and run a task agent
 */
router.post('/task/create', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const {
      name,
      task,
      allowedTools = [],
      runImmediately = true
    } = req.body;

    if (!task) {
      return res.status(400).json({ error: 'task is required' });
    }

    const agent = await orchestrator.createAgent({
      name: name || `Task: ${task.substring(0, 30)}...`,
      type: 'task',
      domain: 'task',
      description: task,
      goal: {
        description: task
      },
      config: {
        maxSessionsPerDay: 1,
        sessionDurationMinutes: 10,
        cooldownMinutes: 0,
        budget: {
          dailyApiCalls: 20,
          dailyTokens: 10000
        },
        allowedTools
      },
      tags: ['task', 'short-lived'],
      createdBy: 'api'
    });

    let runResult = null;
    if (runImmediately) {
      runResult = await orchestrator.runAgent(agent._id.toString());
    }

    res.status(201).json({
      success: true,
      data: agent.getSummary(),
      runResult
    });
  } catch (error) {
    logger.error('Failed to create task agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== AGENTS CRUD ====================

/**
 * GET /api/subagents
 * List all sub-agents
 */
router.get('/', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const { type, domain, status, enabled } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (domain) filter.domain = domain;
    if (status) filter.status = status;
    if (enabled !== undefined) filter.enabled = enabled === 'true';

    const agents = await orchestrator.listAgents(filter);
    res.json({ success: true, data: agents });
  } catch (error) {
    logger.error('Failed to list sub-agents:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subagents
 * Create a new sub-agent
 */
router.post('/', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const {
      name,
      type,
      domain,
      description,
      projectId,
      goal,
      config,
      domainConfig,
      schedule,
      tags
    } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }

    if (!['domain', 'project', 'task'].includes(type)) {
      return res.status(400).json({ error: 'Type must be domain, project, or task' });
    }

    const agent = await orchestrator.createAgent({
      name,
      type,
      domain,
      description,
      projectId,
      goal,
      config,
      domainConfig,
      schedule,
      tags,
      createdBy: 'api'
    });

    res.status(201).json({ success: true, data: agent.getSummary() });
  } catch (error) {
    logger.error('Failed to create sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/subagents/:id
 * Get a specific sub-agent
 */
router.get('/:id', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const agent = await orchestrator.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ success: true, data: agent });
  } catch (error) {
    logger.error('Failed to get sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/subagents/:id
 * Update a sub-agent
 */
router.put('/:id', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const agent = await orchestrator.updateAgent(req.params.id, req.body);
    res.json({ success: true, data: agent.getSummary() });
  } catch (error) {
    logger.error('Failed to update sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/subagents/:id
 * Delete a sub-agent
 */
router.delete('/:id', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const result = await orchestrator.deleteAgent(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Failed to delete sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== AGENT CONTROL ====================

/**
 * POST /api/subagents/:id/run
 * Run a sub-agent
 */
router.post('/:id/run', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const { force } = req.body;
    const result = await orchestrator.runAgent(req.params.id, { force });
    res.json(result);
  } catch (error) {
    logger.error('Failed to run sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subagents/:id/stop
 * Stop a running sub-agent
 */
router.post('/:id/stop', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const result = await orchestrator.stopAgent(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Failed to stop sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subagents/:id/pause
 * Pause a sub-agent
 */
router.post('/:id/pause', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const result = await orchestrator.pauseAgent(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Failed to pause sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subagents/:id/resume
 * Resume a paused sub-agent
 */
router.post('/:id/resume', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const result = await orchestrator.resumeAgent(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Failed to resume sub-agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== APPROVALS ====================

/**
 * GET /api/subagents/:id/approvals
 * Get pending approvals for an agent
 */
router.get('/:id/approvals', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const agent = await orchestrator.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const pending = agent.state.pendingApprovals.filter(a => a.status === 'pending');
    res.json({ success: true, data: pending });
  } catch (error) {
    logger.error('Failed to get approvals:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subagents/:id/approvals/:approvalId
 * Process an approval
 */
router.post('/:id/approvals/:approvalId', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const { approved } = req.body;
    if (approved === undefined) {
      return res.status(400).json({ error: 'approved field is required' });
    }

    const result = await orchestrator.processApproval(
      req.params.id,
      req.params.approvalId,
      approved,
      'api'
    );
    res.json(result);
  } catch (error) {
    logger.error('Failed to process approval:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== HISTORY & LEARNINGS ====================

/**
 * GET /api/subagents/:id/history
 * Get agent execution history
 */
router.get('/:id/history', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const history = await orchestrator.getAgentHistory(req.params.id, limit);
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get agent history:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/subagents/:id/learnings
 * Get agent learnings
 */
router.get('/:id/learnings', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    if (!orchestrator) {
      return res.status(503).json({ error: 'Sub-agent orchestrator not available' });
    }

    const learnings = await orchestrator.getAgentLearnings(req.params.id);
    res.json({ success: true, data: learnings });
  } catch (error) {
    logger.error('Failed to get agent learnings:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
