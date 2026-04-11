import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const developmentItemSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true
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
  status: {
    type: String,
    enum: ['pending', 'in-progress', 'completed', 'archived'],
    default: 'pending'
  },
  type: {
    type: String,
    enum: ['feature', 'edit', 'research'],
    required: true
  },
  completedAt: Date,
  createdBy: String,
  updatedBy: String
}, {
  timestamps: true
});

// Create indexes for efficient querying
developmentItemSchema.index({ type: 1, status: 1 });
developmentItemSchema.index({ tags: 1 });
developmentItemSchema.index({ priority: 1 });

/**
 * New feature: Advanced filtering capability
 * Filters development items based on multiple criteria.
 * @param {Object} query - The query object containing filter criteria.
 * @returns {Promise<Array>} - The filtered development items.
 */
developmentItemSchema.statics.filterItems = async function(query) {
  try {
    const filter = {};

    if (query.tags) {
      filter.tags = { $in: query.tags };
    }
    if (query.priority) {
      filter.priority = query.priority;
    }
    if (query.status) {
      filter.status = query.status;
    }
    if (query.type) {
      filter.type = query.type;
    }

    const results = await this.find(filter).exec();
    return results;
  } catch (error) {
    logger.error('Error filtering development items:', error);
    throw error;
  }
};

/**
 * Archive completed development items older than `days` days.
 * Driven by an Agenda job in scheduler.js (`archive-old-dev-items`).
 * @param {Number} days - Items completed more than this many days ago will be archived.
 * @returns {Promise<{matched: number, modified: number}>}
 */
developmentItemSchema.statics.archiveOldCompletedItems = async function(days = 30) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const result = await this.updateMany(
      { status: 'completed', completedAt: { $lt: cutoffDate } },
      { $set: { status: 'archived' } }
    );

    const modified = result.modifiedCount ?? result.nModified ?? 0;
    if (modified > 0) {
      logger.info(`Archived ${modified} completed development items older than ${days} days.`);
    }
    return { matched: result.matchedCount ?? result.n ?? 0, modified };
  } catch (error) {
    logger.error('Error archiving old completed development items:', error);
    throw error;
  }
};

const DevelopmentPlan = mongoose.model('DevelopmentPlan', developmentItemSchema);

DevelopmentPlan.commands = [
  { command: 'filterItems', description: 'Filter development items based on criteria', usage: 'filterItems({ tags, priority, status, type })' },
  { command: 'archiveOldCompletedItems', description: 'Archive completed items older than N days', usage: 'archiveOldCompletedItems(days)' }
];

DevelopmentPlan.execute = async function(command, params) {
  switch (command) {
    case 'filterItems':
      return await this.filterItems(params);
    case 'archiveOldCompletedItems':
      return await this.archiveOldCompletedItems(params?.days ?? 30);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

export default DevelopmentPlan;