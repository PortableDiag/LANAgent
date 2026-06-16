import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
// Advanced scheduling support - dependencies installed via package.json
// import { RRule } from 'rrule'; // Uncomment when rrule is available
// import moment from 'moment-timezone'; // Uncomment when moment-timezone is available

const taskSchema = new mongoose.Schema({
  // Agent identifier
  agentId: {
    type: String,
    required: true,
    index: true
  },
  
  // Basic information
  title: {
    type: String,
    required: true,
    trim: true
  },
  
  description: {
    type: String,
    trim: true
  },
  
  // Task type and category
  type: {
    type: String,
    enum: ['development', 'system', 'research', 'monitoring', 'backup', 'update', 'custom'],
    default: 'custom',
    index: true
  },
  
  category: {
    type: String,
    index: true
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'paused'],
    default: 'pending',
    index: true
  },
  
  completed: {
    type: Boolean,
    default: false,
    index: true
  },
  
  priority: {
    type: Number,
    default: 5,
    min: 1,
    max: 10,
    index: true
  },
  
  // Execution details
  command: String,
  script: String,
  arguments: mongoose.Schema.Types.Mixed,
  environment: {
    type: Map,
    of: String
  },
  
  // Scheduling
  scheduledFor: Date,
  dueDate: Date,
  recurring: {
    enabled: Boolean,
    pattern: String, // Cron pattern (legacy)
    nextRun: Date,
    lastRun: Date,
    // Advanced scheduling fields (optional)
    rule: String, // RRule string for complex patterns
    timezone: {
      type: String,
      default: 'UTC'
    }
  },
  
  // Dependencies
  dependencies: [{
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task'
    },
    type: {
      type: String,
      enum: ['blocks', 'requires', 'triggers'],
      default: 'blocks'
    }
  }],
  
  // Progress tracking
  progress: {
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    current: String,
    total: String,
    steps: [{
      name: String,
      status: String,
      startedAt: Date,
      completedAt: Date,
      output: String
    }]
  },
  
  // Results and output
  output: {
    stdout: String,
    stderr: String,
    exitCode: Number,
    files: [String],
    data: mongoose.Schema.Types.Mixed
  },
  
  // Error handling
  error: {
    message: String,
    stack: String,
    code: String
  },
  
  retries: {
    count: {
      type: Number,
      default: 0
    },
    maxRetries: {
      type: Number,
      default: 3
    },
    lastRetryAt: Date,
    retryDelay: Number // milliseconds
  },
  
  // Metadata
  createdBy: {
    userId: String,
    userName: String,
    source: String // 'telegram', 'ssh', 'web', 'system'
  },
  
  approvalRequired: {
    type: Boolean,
    default: false
  },
  
  approved: {
    status: Boolean,
    by: String,
    at: Date
  },
  
  // Execution context
  context: {
    workingDirectory: String,
    remoteHost: String,
    requiresRoot: Boolean,
    timeout: Number, // milliseconds
    memory: {
      limit: Number, // MB
      usage: Number
    },
    cpu: {
      limit: Number, // percentage
      usage: Number
    }
  },
  
  // AI assistance
  aiAssisted: {
    enabled: Boolean,
    provider: String,
    model: String,
    prompt: String,
    response: String
  },
  
  // Time tracking
  startedAt: Date,
  completedAt: Date,
  duration: Number, // milliseconds
  
  // Cleanup
  cleanup: {
    required: Boolean,
    commands: [String],
    onFailure: [String],
    completed: Boolean
  },
  
  // Related items
  relatedTasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  }],
  
  memories: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Memory'
  }]
}, {
  timestamps: true
});

// Indexes
taskSchema.index({ status: 1, priority: -1 });
taskSchema.index({ scheduledFor: 1 });
taskSchema.index({ 'recurring.nextRun': 1 });
taskSchema.index({ createdAt: -1 });
taskSchema.index({ 'createdBy.userId': 1 });

// Virtual for isActive
taskSchema.virtual('isActive').get(function() {
  return ['running', 'queued'].includes(this.status);
});

// Methods
taskSchema.methods.start = function() {
  this.status = 'running';
  this.startedAt = new Date();
  this.progress.percentage = 0;
  return this.save();
};

taskSchema.methods.complete = function(output) {
  this.status = 'completed';
  this.completed = true;
  this.completedAt = new Date();
  this.duration = this.completedAt - this.startedAt;
  this.progress.percentage = 100;
  if (output) {
    this.output = output;
  }
  return this.save();
};

taskSchema.methods.fail = function(error) {
  this.status = 'failed';
  this.completedAt = new Date();
  this.duration = this.completedAt - this.startedAt;
  this.error = {
    message: error.message,
    stack: error.stack,
    code: error.code
  };
  return this.save();
};

taskSchema.methods.retry = function() {
  if (this.retries.count >= this.retries.maxRetries) {
    throw new Error('Max retries exceeded');
  }
  
  this.retries.count++;
  this.retries.lastRetryAt = new Date();
  this.status = 'queued';
  this.error = null;
  
  return this.save();
};

taskSchema.methods.addStep = function(stepName) {
  this.progress.steps.push({
    name: stepName,
    status: 'running',
    startedAt: new Date()
  });
  return this.save();
};

taskSchema.methods.completeStep = function(stepName, output) {
  const step = this.progress.steps.find(s => s.name === stepName && s.status === 'running');
  if (step) {
    step.status = 'completed';
    step.completedAt = new Date();
    step.output = output;
  }
  return this.save();
};

// Enhanced scheduling methods
taskSchema.methods.calculateNextRun = function() {
  if (!this.recurring.enabled) {
    return null;
  }
  
  // If RRule is available and rule is set, use it
  if (this.recurring.rule) {
    try {
      // Dynamic import to avoid errors if rrule not installed
      const { RRule } = require('rrule');
      const rule = RRule.fromString(this.recurring.rule);
      const nextRun = rule.after(new Date());
      
      // Apply timezone if moment-timezone is available
      if (this.recurring.timezone && this.recurring.timezone !== 'UTC') {
        try {
          const moment = require('moment-timezone');
          return moment.tz(nextRun, this.recurring.timezone).toDate();
        } catch (e) {
          // Fallback to UTC if moment-timezone not available
          return nextRun;
        }
      }
      
      return nextRun;
    } catch (error) {
      // Fallback to cron pattern if RRule fails
      logger.warn('RRule parsing failed, falling back to cron pattern:', error.message);
    }
  }
  
  // Fallback to existing cron pattern logic
  // This ensures backward compatibility
  return this.recurring.nextRun;
};

// Helper to set advanced recurrence rule
taskSchema.methods.setRecurrenceRule = function(ruleString, timezone = 'UTC') {
  this.recurring.rule = ruleString;
  this.recurring.timezone = timezone;
  this.recurring.nextRun = this.calculateNextRun();
  return this;
};

/**
 * Resolve task dependencies using topological sort
 * @returns {Promise<Array>} Ordered list of task IDs that must complete before this task
 * @throws {Error} If circular dependency detected or dependency not found
 */
taskSchema.methods.resolveDependencies = async function() {
  const resolvedTasks = new Set();
  const unresolvedTasks = new Set();
  const Model = this.constructor;

  const resolveTask = async (task) => {
    unresolvedTasks.add(task._id.toString());

    for (const dependency of task.dependencies || []) {
      const depTask = await Model.findById(dependency.taskId);
      if (!depTask) {
        throw new Error(`Dependency task not found: ${dependency.taskId}`);
      }
      const depIdStr = depTask._id.toString();
      if (!resolvedTasks.has(depIdStr)) {
        if (unresolvedTasks.has(depIdStr)) {
          throw new Error(`Circular dependency detected: ${task.title} <-> ${depTask.title}`);
        }
        await resolveTask(depTask);
      }
    }

    const taskIdStr = task._id.toString();
    resolvedTasks.add(taskIdStr);
    unresolvedTasks.delete(taskIdStr);
  };

  await resolveTask(this);
  return Array.from(resolvedTasks);
};

// Static methods
taskSchema.statics.findActive = function() {
  return this.find({ status: { $in: ['running', 'queued'] } })
    .sort({ priority: -1, createdAt: 1 });
};

taskSchema.statics.findPending = function() {
  return this.find({ 
    status: 'pending',
    $or: [
      { scheduledFor: { $lte: new Date() } },
      { scheduledFor: null }
    ]
  }).sort({ priority: -1, createdAt: 1 });
};

taskSchema.statics.findByUser = function(userId) {
  return this.find({ 'createdBy.userId': userId })
    .sort({ createdAt: -1 });
};

// Find tasks with advanced scheduling that need to run
taskSchema.statics.findRecurringTasksDue = function() {
  return this.find({
    'recurring.enabled': true,
    'recurring.nextRun': { $lte: new Date() },
    status: { $in: ['completed', 'failed'] } // Only reschedule completed/failed tasks
  });
};

taskSchema.statics.cancelRunning = function() {
  return this.updateMany(
    { status: 'running' },
    { 
      $set: { 
        status: 'cancelled',
        completedAt: new Date()
      }
    }
  );
};

export const Task = mongoose.model('Task', taskSchema);