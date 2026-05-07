import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

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
    if (query.creationDateRange) {
      const { startDate, endDate } = query.creationDateRange;
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
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

/**
 * Archive completed development items in batches to bound memory use on
 * large collections. Paginates by _id, runs updateMany per batch with
 * retry on transient errors.
 *
 * @param {Number} days - Items completed more than this many days ago will be archived.
 * @param {Number} batchSize - Number of items processed per batch.
 * @returns {Promise<{matched: number, modified: number, batches: number}>}
 */
developmentItemSchema.statics.archiveOldCompletedItemsBatch = async function(days = 30, batchSize = 100) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let matched = 0;
    let modified = 0;
    let batches = 0;
    let lastId = null;

    while (true) {
      const query = { status: 'completed', completedAt: { $lt: cutoffDate } };
      if (lastId) query._id = { $gt: lastId };

      const batch = await this.find(query).sort({ _id: 1 }).limit(batchSize).select('_id').lean().exec();
      if (batch.length === 0) break;

      const ids = batch.map(item => item._id);
      lastId = ids[ids.length - 1];

      const result = await retryOperation(
        () => this.updateMany({ _id: { $in: ids } }, { $set: { status: 'archived' } }),
        { retries: 3 }
      );

      matched += result.matchedCount ?? result.n ?? 0;
      modified += result.modifiedCount ?? result.nModified ?? 0;
      batches += 1;
    }

    if (modified > 0) {
      logger.info(`Archived ${modified} completed development items older than ${days} days in ${batches} batch(es).`);
    }
    return { matched, modified, batches };
  } catch (error) {
    logger.error('Error archiving old completed development items in batches:', error);
    throw error;
  }
};

const DevelopmentPlan = mongoose.model('DevelopmentPlan', developmentItemSchema);

DevelopmentPlan.commands = [
  { command: 'filterItems', description: 'Filter development items based on criteria', usage: 'filterItems({ tags, priority, status, type, creationDateRange })' },
  { command: 'archiveOldCompletedItems', description: 'Archive completed items older than N days', usage: 'archiveOldCompletedItems(days)' },
  { command: 'archiveOldCompletedItemsBatch', description: 'Archive completed items older than N days in batches', usage: 'archiveOldCompletedItemsBatch({ days, batchSize })' }
];

DevelopmentPlan.execute = async function(command, params) {
  switch (command) {
    case 'filterItems':
      return await this.filterItems(params);
    case 'archiveOldCompletedItems':
      return await this.archiveOldCompletedItems(params?.days ?? 30);
    case 'archiveOldCompletedItemsBatch':
      return await this.archiveOldCompletedItemsBatch(params?.days ?? 30, params?.batchSize ?? 100);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

export default DevelopmentPlan;
