import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation, isRetryableError } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const contractEventSchema = new mongoose.Schema({
  contractAddress: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  network: {
    type: String,
    required: true,
    index: true
  },
  eventName: {
    type: String,
    required: true,
    index: true
  },
  blockNumber: {
    type: Number,
    required: true,
    index: true
  },
  blockHash: String,
  transactionHash: {
    type: String,
    required: true,
    index: true
  },
  transactionIndex: Number,
  logIndex: Number,
  removed: {
    type: Boolean,
    default: false
  },
  returnValues: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  signature: String,
  topics: [String],
  rawData: String,
  decodedData: mongoose.Schema.Types.Mixed,
  timestamp: {
    type: Date,
    index: true
  },
  subscription: {
    id: String,
    active: Boolean,
    filters: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
contractEventSchema.index({ contractAddress: 1, network: 1, blockNumber: -1 });
contractEventSchema.index({ contractAddress: 1, eventName: 1, timestamp: -1 });

// Initialize cache
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Get cached data or fetch from database if not cached
 * @param {String} key - Cache key
 * @param {Function} fetchFunc - Function to fetch data if not in cache
 * @returns {Promise<Object>} - Cached or fetched data
 */
async function getCachedData(key, fetchFunc) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const data = await fetchFunc();
  cache.set(key, data);
  return data;
}

// Method to format event for display
contractEventSchema.methods.toDisplay = function() {
  return {
    event: this.eventName,
    contract: this.contractAddress,
    network: this.network,
    block: this.blockNumber,
    txHash: this.transactionHash,
    data: this.returnValues,
    timestamp: this.timestamp
  };
};

// Save the event with retry mechanism for transient errors
contractEventSchema.methods.saveWithRetry = async function(options = {}) {
  const retryOptions = {
    context: `ContractEvent save (${this.eventName})`,
    retries: 3,
    minTimeout: 1000,
    maxTimeout: 4000,
    ...options
  };

  return retryOperation(
    async (attempt) => {
      try {
        const result = await this.save();
        return result;
      } catch (error) {
        // Only retry if it's a retryable error
        if (!isRetryableError(error)) {
          logger.error('Non-retryable error saving ContractEvent', {
            event: this.eventName,
            contract: this.contractAddress,
            error: error.message
          });
          throw error;
        }
        throw error;
      }
    },
    retryOptions
  );
};

/**
 * Batch save multiple events with retry mechanism
 * Uses insertMany with ordered:false for efficient bulk inserts
 */
contractEventSchema.statics.batchSaveWithRetry = async function(events, options = {}) {
  if (!events || events.length === 0) {
    return [];
  }

  const retryOptions = {
    context: 'ContractEvent batch save',
    retries: 3,
    minTimeout: 1000,
    maxTimeout: 4000,
    ...options
  };

  return retryOperation(
    async () => {
      try {
        const result = await this.insertMany(events, { ordered: false });
        logger.info(`Batch saved ${result.length} contract events`);
        return result;
      } catch (error) {
        if (!isRetryableError(error)) {
          logger.error('Non-retryable error in batch saving ContractEvents', {
            count: events.length,
            error: error.message
          });
          throw error;
        }
        throw error;
      }
    },
    retryOptions
  );
};

/**
 * Fetch contract events with caching
 * @param {Object} query - Query object for fetching events
 * @returns {Promise<Array>} - List of contract events
 */
contractEventSchema.statics.fetchEventsWithCache = async function(query) {
  const cacheKey = JSON.stringify(query);
  return getCachedData(cacheKey, async () => {
    return this.find(query).exec();
  });
};

export const ContractEvent = mongoose.model('ContractEvent', contractEventSchema);