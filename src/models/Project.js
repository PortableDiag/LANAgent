import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const projectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['planning', 'active', 'paused', 'completed', 'archived'],
    default: 'planning'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  path: {
    type: String,
    trim: true
  },
  gitRepo: {
    type: String,
    trim: true
  },
  tasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  }],
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  },
  createdBy: String,
  updatedBy: String,
  versions: [{
    timestamp: {
      type: Date,
      default: Date.now
    },
    changes: {
      type: Map,
      of: mongoose.Schema.Types.Mixed
    },
    updatedBy: String
  }]
}, {
  timestamps: true
});

// Create indexes
projectSchema.index({ name: 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ tags: 1 });

/**
 * Add a method to safely add a single task
 * @param {mongoose.Schema.Types.ObjectId} taskId - The ID of the task to add
 */
projectSchema.methods.addTask = async function(taskId) {
  if (!this.tasks.includes(taskId)) {
    this.tasks.push(taskId);
    await this.save();
    cache.del(`tasks_${this._id}`);
  }
};

/**
 * Add a method to remove tasks
 * @param {mongoose.Schema.Types.ObjectId} taskId - The ID of the task to remove
 */
projectSchema.methods.removeTask = async function(taskId) {
  this.tasks = this.tasks.filter(id => !id.equals(taskId));
  await this.save();
  cache.del(`tasks_${this._id}`);
};

/**
 * Add a method to bulk add tasks
 * @param {Array<mongoose.Schema.Types.ObjectId>} taskIds - An array of task IDs to add
 */
projectSchema.methods.addTasks = async function(taskIds) {
  try {
    const uniqueTaskIds = [...new Set(taskIds)];
    const newTasks = uniqueTaskIds.filter(taskId => !this.tasks.includes(taskId));
    if (newTasks.length > 0) {
      this.tasks.push(...newTasks);
      await this.save();
      cache.del(`tasks_${this._id}`);
    }
  } catch (error) {
    logger.error('Error adding tasks:', error);
    throw new Error('Failed to add tasks');
  }
};

/**
 * Add a method to bulk remove tasks
 * @param {Array<mongoose.Schema.Types.ObjectId>} taskIds - An array of task IDs to remove
 */
projectSchema.methods.removeTasks = async function(taskIds) {
  try {
    const taskSet = new Set(taskIds.map(id => id.toString()));
    this.tasks = this.tasks.filter(taskId => !taskSet.has(taskId.toString()));
    await this.save();
    cache.del(`tasks_${this._id}`);
  } catch (error) {
    logger.error('Error removing tasks:', error);
    throw new Error('Failed to remove tasks');
  }
};

/**
 * Calculate the project's progress based on task completion
 * @returns {Promise<number>} - The percentage of project completion
 */
projectSchema.methods.calculateProgress = async function() {
  try {
    if (this.tasks.length === 0) return 0;

    const cacheKey = `tasks_${this._id}`;
    let tasks = cache.get(cacheKey);
    if (!tasks) {
      tasks = await retryOperation(() => mongoose.model('Task').find({ _id: { $in: this.tasks } }), { context: 'Project.calculateProgress' });
      cache.set(cacheKey, tasks);
    }
    const completedTasks = tasks.filter(task => task.completed).length;
    return (completedTasks / tasks.length) * 100;
  } catch (error) {
    logger.error('Error calculating project progress:', error);
    throw new Error('Failed to calculate project progress');
  }
};

/**
 * Static method to get cached tasks for a project
 * @param {mongoose.Schema.Types.ObjectId} projectId - The project ID
 * @returns {Promise<Array>} - The tasks for the project
 */
projectSchema.statics.getCachedTasks = async function(projectId) {
  const cacheKey = `tasks_${projectId}`;
  let tasks = cache.get(cacheKey);
  if (!tasks) {
    const project = await this.findById(projectId);
    if (!project || project.tasks.length === 0) return [];
    tasks = await retryOperation(() => mongoose.model('Task').find({ _id: { $in: project.tasks } }), { context: 'Project.getCachedTasks' });
    cache.set(cacheKey, tasks);
  }
  return tasks;
};

/**
 * Add a new version entry to the project
 * @param {Object} changes - The changes made in this version
 * @param {String} updatedBy - The user who made the changes
 */
projectSchema.methods.addVersion = async function(changes, updatedBy) {
  try {
    this.versions.push({ changes, updatedBy });
    await this.save();
  } catch (error) {
    logger.error('Error adding version:', error);
    throw new Error('Failed to add version');
  }
};

/**
 * Static method to search projects based on multiple criteria
 * @param {Object} searchParams - The search parameters
 * @returns {Promise<Array>} - The filtered projects
 */
projectSchema.statics.advancedSearch = async function(searchParams) {
  try {
    const { tags, status, priority } = searchParams;
    const matchStage = {};

    if (tags) {
      matchStage.tags = { $in: tags };
    }
    if (status) {
      matchStage.status = status;
    }
    if (priority) {
      matchStage.priority = priority;
    }

    const projects = await retryOperation(() => this.aggregate([
      { $match: matchStage }
    ]), { context: 'Project.advancedSearch' });

    return projects;
  } catch (error) {
    logger.error('Error performing advanced search:', error);
    throw new Error('Failed to perform advanced search');
  }
};

const Project = mongoose.model('Project', projectSchema);

export default Project;