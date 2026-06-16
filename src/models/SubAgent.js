import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

/**
 * SubAgent Model
 * Represents autonomous sub-agents that operate under the main LANAgent
 *
 * Types:
 * - domain: Specialized persistent agents (e.g., crypto trading)
 * - project: Goal-oriented multi-session agents
 * - task: Short-lived delegated task agents
 */
const subAgentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['domain', 'project', 'task'],
    required: true
  },
  domain: {
    type: String,
    trim: true,
    // For domain agents: 'crypto', 'monitoring', etc.
    // For project agents: linked project ID
    // For task agents: task description category
  },
  description: {
    type: String,
    trim: true
  },

  // Status tracking
  status: {
    type: String,
    enum: ['idle', 'running', 'paused', 'stopped', 'error', 'completed', 'waiting_approval'],
    default: 'idle'
  },
  enabled: {
    type: Boolean,
    default: true
  },

  // For project agents - link to Project model
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project'
  },

  // Goal/objective for the agent
  goal: {
    description: String,
    successCriteria: [String],
    currentPhase: String,
    phases: [{
      name: String,
      status: { type: String, enum: ['pending', 'in_progress', 'completed', 'failed'] },
      startedAt: Date,
      completedAt: Date,
      result: mongoose.Schema.Types.Mixed
    }]
  },

  // Configuration
  config: {
    // Execution settings
    maxSessionsPerDay: { type: Number, default: 5 },
    sessionDurationMinutes: { type: Number, default: 30 },
    cooldownMinutes: { type: Number, default: 60 },

    // Budget controls
    budget: {
      dailyApiCalls: { type: Number, default: 100 },
      dailyTokens: { type: Number, default: 50000 },
      maxCostPerSession: { type: Number, default: 0.50 } // USD
    },

    // Approval requirements
    requiresApproval: {
      forActions: [String], // Actions that need human approval
      forPhaseTransition: { type: Boolean, default: false },
      forHighValueDecisions: { type: Boolean, default: true }
    },

    // Tools/plugins this agent can use
    allowedTools: [String],

    // Domain-specific config (flexible)
    domainConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },

  // Runtime state
  state: {
    currentSession: {
      startedAt: Date,
      iteration: { type: Number, default: 0 },
      lastAction: String,
      lastResult: mongoose.Schema.Types.Mixed
    },

    // Learning/adaptation
    learnings: [{
      timestamp: { type: Date, default: Date.now },
      category: String,
      insight: String,
      confidence: Number
    }],

    // Blockers that need resolution
    blockers: [{
      description: String,
      since: { type: Date, default: Date.now },
      severity: { type: String, enum: ['low', 'medium', 'high', 'critical'] },
      resolved: { type: Boolean, default: false },
      resolvedAt: Date,
      resolution: String
    }],

    // Pending approvals
    pendingApprovals: [{
      action: String,
      description: String,
      requestedAt: { type: Date, default: Date.now },
      data: mongoose.Schema.Types.Mixed,
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      decidedAt: Date,
      decidedBy: String
    }],

    // Domain-specific state (flexible)
    domainState: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },

  // Usage tracking
  usage: {
    totalSessions: { type: Number, default: 0 },
    totalApiCalls: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },

    // Daily tracking (reset daily)
    daily: {
      date: Date,
      apiCalls: { type: Number, default: 0 },
      tokens: { type: Number, default: 0 },
      cost: { type: Number, default: 0 }
    },

    // Performance metrics
    performance: {
      successRate: { type: Number, default: 0 },
      avgSessionDuration: { type: Number, default: 0 },
      lastSuccessAt: Date,
      lastErrorAt: Date
    }
  },

  // Scheduling
  schedule: {
    nextRunAt: Date,
    lastRunAt: Date,
    runPattern: String, // cron pattern or 'event-driven'
    eventTriggers: [String] // Events that can trigger this agent
  },

  // History/journal
  history: [{
    timestamp: { type: Date, default: Date.now },
    event: String,
    details: mongoose.Schema.Types.Mixed,
    sessionId: String
  }],

  // Error tracking
  lastError: {
    message: String,
    stack: String,
    timestamp: Date,
    context: mongoose.Schema.Types.Mixed
  },

  // Metadata
  createdBy: String,
  tags: [String]
}, {
  timestamps: true
});

// Indexes
subAgentSchema.index({ type: 1, status: 1 });
subAgentSchema.index({ domain: 1 });
subAgentSchema.index({ enabled: 1 });
subAgentSchema.index({ 'schedule.nextRunAt': 1 });
subAgentSchema.index({ projectId: 1 });

/**
 * Check if agent can run (budget, cooldown, etc.)
 */
subAgentSchema.methods.canRun = function() {
  // Check if enabled
  if (!this.enabled) {
    return { canRun: false, reason: 'Agent is disabled' };
  }

  // Check status
  if (this.status === 'running') {
    return { canRun: false, reason: 'Agent is already running' };
  }

  if (this.status === 'waiting_approval') {
    return { canRun: false, reason: 'Agent is waiting for approval' };
  }

  // Check daily budget
  const today = new Date().toDateString();
  if (this.usage.daily.date?.toDateString() === today) {
    if (this.usage.daily.apiCalls >= this.config.budget.dailyApiCalls) {
      return { canRun: false, reason: 'Daily API call budget exceeded' };
    }
    if (this.usage.daily.tokens >= this.config.budget.dailyTokens) {
      return { canRun: false, reason: 'Daily token budget exceeded' };
    }
  }

  // Check cooldown
  if (this.schedule.lastRunAt) {
    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
    const timeSinceLastRun = Date.now() - this.schedule.lastRunAt.getTime();
    if (timeSinceLastRun < cooldownMs) {
      const remainingMinutes = Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
      return { canRun: false, reason: `Cooldown: ${remainingMinutes} minutes remaining` };
    }
  }

  // Check for unresolved critical blockers
  const criticalBlockers = this.state.blockers.filter(
    b => !b.resolved && b.severity === 'critical'
  );
  if (criticalBlockers.length > 0) {
    return { canRun: false, reason: `Critical blocker: ${criticalBlockers[0].description}` };
  }

  return { canRun: true };
};

/**
 * Start a new session
 */
subAgentSchema.methods.startSession = async function() {
  const canRunCheck = this.canRun();
  if (!canRunCheck.canRun) {
    throw new Error(canRunCheck.reason);
  }

  this.status = 'running';
  this.state.currentSession = {
    startedAt: new Date(),
    iteration: 0,
    lastAction: null,
    lastResult: null
  };
  this.schedule.lastRunAt = new Date();
  this.usage.totalSessions++;

  // Reset daily counters if new day
  const today = new Date().toDateString();
  if (this.usage.daily.date?.toDateString() !== today) {
    this.usage.daily = {
      date: new Date(),
      apiCalls: 0,
      tokens: 0,
      cost: 0
    };
  }

  this.addHistory('session_started', { sessionNumber: this.usage.totalSessions });
  await this.save();

  return this.state.currentSession;
};

/**
 * End current session
 */
subAgentSchema.methods.endSession = async function(result = {}) {
  if (this.status !== 'running') {
    return;
  }

  const duration = this.state.currentSession.startedAt
    ? (Date.now() - this.state.currentSession.startedAt.getTime()) / 60000
    : 0;

  // Update performance metrics
  const oldAvg = this.usage.performance.avgSessionDuration || 0;
  const sessions = this.usage.totalSessions || 1;
  this.usage.performance.avgSessionDuration =
    (oldAvg * (sessions - 1) + duration) / sessions;

  if (result.success) {
    this.usage.performance.lastSuccessAt = new Date();
    // Update success rate
    const oldRate = this.usage.performance.successRate || 0;
    this.usage.performance.successRate =
      (oldRate * (sessions - 1) + 100) / sessions;
  } else if (result.error) {
    this.usage.performance.lastErrorAt = new Date();
    this.lastError = {
      message: result.error,
      timestamp: new Date(),
      context: result.context
    };
    // Update success rate
    const oldRate = this.usage.performance.successRate || 0;
    this.usage.performance.successRate =
      (oldRate * (sessions - 1)) / sessions;
  }

  this.status = result.waitingApproval ? 'waiting_approval' : 'idle';
  this.addHistory('session_ended', {
    duration: Math.round(duration),
    result: result.success ? 'success' : (result.error ? 'error' : 'completed'),
    iterations: this.state.currentSession.iteration
  });

  await this.save();
};

/**
 * Record API usage
 */
subAgentSchema.methods.recordUsage = async function(apiCalls = 1, tokens = 0, cost = 0) {
  this.usage.totalApiCalls += apiCalls;
  this.usage.totalTokens += tokens;
  this.usage.totalCost += cost;

  this.usage.daily.apiCalls += apiCalls;
  this.usage.daily.tokens += tokens;
  this.usage.daily.cost += cost;

  if (this.state.currentSession) {
    this.state.currentSession.iteration++;
  }

  await this.save();
};

/**
 * Add a history entry
 */
subAgentSchema.methods.addHistory = function(event, details = {}) {
  this.history.push({
    timestamp: new Date(),
    event,
    details,
    sessionId: this.state.currentSession?.startedAt?.toISOString()
  });

  // Keep only last 500 entries
  if (this.history.length > 500) {
    this.history = this.history.slice(-500);
  }
};

/**
 * Add a learning/insight
 */
subAgentSchema.methods.addLearning = async function(category, insight, confidence = 0.5) {
  this.state.learnings.push({
    timestamp: new Date(),
    category,
    insight,
    confidence
  });

  // Keep only last 100 learnings
  if (this.state.learnings.length > 100) {
    this.state.learnings = this.state.learnings.slice(-100);
  }

  await this.save();
};

/**
 * Add a blocker
 */
subAgentSchema.methods.addBlocker = async function(description, severity = 'medium') {
  this.state.blockers.push({
    description,
    severity,
    since: new Date(),
    resolved: false
  });

  this.addHistory('blocker_added', { description, severity });
  await this.save();
};

/**
 * Resolve a blocker
 */
subAgentSchema.methods.resolveBlocker = async function(blockerId, resolution) {
  const blocker = this.state.blockers.id(blockerId);
  if (blocker) {
    blocker.resolved = true;
    blocker.resolvedAt = new Date();
    blocker.resolution = resolution;
    this.addHistory('blocker_resolved', { blockerId, resolution });
    await this.save();
  }
};

/**
 * Request approval for an action
 */
subAgentSchema.methods.requestApproval = async function(action, description, data = {}) {
  const approval = {
    action,
    description,
    requestedAt: new Date(),
    data,
    status: 'pending'
  };

  this.state.pendingApprovals.push(approval);
  this.status = 'waiting_approval';
  this.addHistory('approval_requested', { action, description });
  await this.save();

  return approval;
};

/**
 * Process approval decision
 */
subAgentSchema.methods.processApproval = async function(approvalId, approved, decidedBy) {
  const approval = this.state.pendingApprovals.id(approvalId);
  if (!approval || approval.status !== 'pending') {
    throw new Error('Approval not found or already processed');
  }

  approval.status = approved ? 'approved' : 'rejected';
  approval.decidedAt = new Date();
  approval.decidedBy = decidedBy;

  // If no more pending approvals, set status back to idle
  const stillPending = this.state.pendingApprovals.filter(a => a.status === 'pending');
  if (stillPending.length === 0) {
    this.status = 'idle';
  }

  this.addHistory('approval_processed', {
    approvalId,
    action: approval.action,
    approved,
    decidedBy
  });
  await this.save();

  return approval;
};

/**
 * Get summary for display
 */
subAgentSchema.methods.getSummary = function() {
  return {
    id: this._id,
    name: this.name,
    type: this.type,
    domain: this.domain,
    status: this.status,
    enabled: this.enabled,
    lastRun: this.schedule.lastRunAt,
    nextRun: this.schedule.nextRunAt,
    canRun: this.canRun(),
    usage: {
      sessions: this.usage.totalSessions,
      apiCalls: this.usage.totalApiCalls,
      dailyBudgetUsed: this.usage.daily.apiCalls,
      dailyBudgetLimit: this.config.budget.dailyApiCalls,
      successRate: Math.round(this.usage.performance.successRate)
    },
    pendingApprovals: this.state.pendingApprovals.filter(a => a.status === 'pending').length,
    blockers: this.state.blockers.filter(b => !b.resolved).length,
    currentPhase: this.goal?.currentPhase
  };
};

/**
 * Apply runtime configuration changes without restarting the agent.
 * Deep-merges into the nested `config` subdoc and optionally updates top-level
 * `enabled` / `status`. Records a config_updated history entry.
 *
 * @param {Object} updates - { config?, enabled?, status? }
 *   - config: partial config to deep-merge (e.g. { budget: { dailyApiCalls: 200 } })
 *   - enabled: top-level boolean
 *   - status: top-level status string
 */
subAgentSchema.methods.updateConfig = async function(updates = {}) {
  if (!updates || typeof updates !== 'object') {
    throw new Error('updateConfig requires an object');
  }

  const before = {
    enabled: this.enabled,
    status: this.status,
    config: this.config ? this.config.toObject() : {}
  };

  if (updates.config && typeof updates.config === 'object') {
    // Apply per-leaf using mongoose set() so nested subdocs aren't clobbered
    const applyDeep = (prefix, value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        this.set(prefix, value);
        return;
      }
      for (const [k, v] of Object.entries(value)) {
        applyDeep(`${prefix}.${k}`, v);
      }
    };
    applyDeep('config', updates.config);
  }

  if (updates.enabled !== undefined) {
    this.enabled = !!updates.enabled;
  }

  if (updates.status && this.status !== updates.status) {
    this.status = updates.status;
  }

  this.addHistory('config_updated', {
    before,
    after: { enabled: this.enabled, status: this.status, config: updates.config }
  });

  await this.save();
  return this;
};

const SubAgent = mongoose.model('SubAgent', subAgentSchema);

export default SubAgent;
