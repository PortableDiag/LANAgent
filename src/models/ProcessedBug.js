import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const processedBugSchema = new mongoose.Schema({
  issueNumber: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  issueTitle: {
    type: String,
    required: true
  },
  processedAt: {
    type: Date,
    default: Date.now
  },
  fixResult: {
    type: String,
    enum: ['success', 'failed', 'skipped'],
    required: true,
    index: true
  },
  prUrl: {
    type: String,
    default: null
  },
  branchName: {
    type: String,
    default: null
  },
  errorMessage: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Add compound index for frequently queried fields
processedBugSchema.index({ issueNumber: 1, fixResult: 1 });

class ProcessedBugModel {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
  }

  /**
   * Get cached data or fetch from database if not cached
   * @param {string} key - Cache key
   * @param {Function} fetchFunc - Function to fetch data if not cached
   * @returns {Promise<any>} - Cached or fetched data
   */
  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
  }

  /**
   * Fetch processed bug by issue number with caching and retry logic
   * @param {number} issueNumber - Issue number to fetch
   * @returns {Promise<any>} - Processed bug data
   */
  async fetchProcessedBug(issueNumber) {
    const key = `processedBug_${issueNumber}`;
    return this.getCachedData(key, async () => {
      return retryOperation(async () => {
        try {
          const bug = await ProcessedBug.findOne({ issueNumber }).exec();
          if (!bug) {
            throw new Error(`Processed bug with issue number ${issueNumber} not found`);
          }
          return bug;
        } catch (error) {
          logger.error(`Error fetching processed bug: ${error.message}`);
          throw error;
        }
      });
    });
  }
}

export const ProcessedBug = mongoose.model('ProcessedBug', processedBugSchema);
export const processedBugModel = new ProcessedBugModel();