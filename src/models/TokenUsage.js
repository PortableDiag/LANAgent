import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const cache = new NodeCache({ stdTTL: 600 });

const tokenUsageSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
    enum: ['openai', 'anthropic', 'gab', 'huggingface', 'xai', 'ollama', 'bitnet', 'uncensored']
  },
  
  model: {
    type: String,
    required: true
  },
  
  promptTokens: {
    type: Number,
    default: 0
  },
  
  completionTokens: {
    type: Number,
    default: 0
  },
  
  totalTokens: {
    type: Number,
    default: 0
  },
  
  cost: {
    type: Number,
    default: 0
  },
  
  responseTime: {
    type: Number,  // milliseconds
    default: 0
  },
  
  requestType: {
    type: String,
    enum: ['chat', 'embedding', 'audio', 'vision', 'speech', 'tts', 'image', 'video'],
    default: 'chat'
  },
  
  success: {
    type: Boolean,
    default: true
  },
  
  error: String,
  
  userId: {
    type: String,
    index: true
  },
  
  metadata: mongoose.Schema.Types.Mixed
  
}, {
  timestamps: true
});

// Indexes for efficient queries
tokenUsageSchema.index({ provider: 1, createdAt: -1 });
tokenUsageSchema.index({ createdAt: -1 });
tokenUsageSchema.index({ provider: 1, model: 1 });
tokenUsageSchema.index({ userId: 1, createdAt: -1 });

/**
 * Get user-specific metrics.
 * @param {String} userId - The user ID.
 * @returns {Promise<Object>} Aggregated metrics for the user.
 */
tokenUsageSchema.statics.getUserMetrics = async function(userId) {
  try {
    const cachedMetrics = cache.get(`userMetrics-${userId}`);
    if (cachedMetrics) {
      return cachedMetrics;
    }

    const result = await retryOperation(() => this.aggregate([
      {
        $match: { userId }
      },
      {
        $group: {
          _id: '$userId',
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$cost' },
          avgResponseTime: { $avg: '$responseTime' },
          totalRequests: { $sum: 1 }
        }
      }
    ]), { retries: 3 });

    const metrics = result[0] || {
      totalTokens: 0,
      totalCost: 0,
      avgResponseTime: 0,
      totalRequests: 0
    };

    cache.set(`userMetrics-${userId}`, metrics);
    return metrics;
  } catch (error) {
    logger.error('Error fetching user metrics', { userId, error });
    throw error;
  }
};

/**
 * Get daily metrics with caching.
 * @param {String} provider - The provider name.
 * @param {Number} days - Number of days to look back.
 * @returns {Promise<Array>} Aggregated daily metrics.
 */
tokenUsageSchema.statics.getDailyMetrics = async function(provider, days = 7) {
  const cacheKey = `dailyMetrics-${provider}-${days}`;
  const cachedMetrics = cache.get(cacheKey);
  if (cachedMetrics) {
    return cachedMetrics;
  }

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const metrics = await this.aggregate([
      {
        $match: {
          provider,
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
          },
          promptTokens: { $sum: '$promptTokens' },
          completionTokens: { $sum: '$completionTokens' },
          totalTokens: { $sum: '$totalTokens' },
          cost: { $sum: '$cost' },
          requests: { $sum: 1 },
          avgResponseTime: { $avg: '$responseTime' }
        }
      },
      {
        $sort: { '_id.date': 1 }
      }
    ]);

    cache.set(cacheKey, metrics);
    return metrics;
  } catch (error) {
    logger.error('Error fetching daily metrics', { provider, days, error });
    throw error;
  }
};

/**
 * Get model-specific metrics with caching.
 * @param {String} provider - The provider name.
 * @returns {Promise<Array>} Aggregated model metrics.
 */
tokenUsageSchema.statics.getModelMetrics = async function(provider) {
  const cacheKey = `modelMetrics-${provider}`;
  const cachedMetrics = cache.get(cacheKey);
  if (cachedMetrics) {
    return cachedMetrics;
  }

  try {
    const metrics = await this.aggregate([
      {
        $match: { provider }
      },
      {
        $group: {
          _id: '$model',
          promptTokens: { $sum: '$promptTokens' },
          completionTokens: { $sum: '$completionTokens' },
          totalTokens: { $sum: '$totalTokens' },
          cost: { $sum: '$cost' },
          requests: { $sum: 1 },
          avgResponseTime: { $avg: '$responseTime' }
        }
      }
    ]);

    cache.set(cacheKey, metrics);
    return metrics;
  } catch (error) {
    logger.error('Error fetching model metrics', { provider, error });
    throw error;
  }
};

/**
 * Get total metrics with caching.
 * @param {String} provider - The provider name.
 * @returns {Promise<Object>} Aggregated total metrics.
 */
tokenUsageSchema.statics.getTotalMetrics = async function(provider) {
  const cacheKey = `totalMetrics-${provider || 'all'}`;
  const cachedMetrics = cache.get(cacheKey);
  if (cachedMetrics) {
    return cachedMetrics;
  }

  try {
    const result = await this.aggregate([
      {
        $match: provider ? { provider } : {}
      },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalPromptTokens: { $sum: '$promptTokens' },
          totalCompletionTokens: { $sum: '$completionTokens' },
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$cost' },
          avgResponseTime: { $avg: '$responseTime' },
          errors: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } }
        }
      }
    ]);

    const metrics = result[0] || {
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      avgResponseTime: 0,
      errors: 0
    };

    cache.set(cacheKey, metrics);
    return metrics;
  } catch (error) {
    logger.error('Error fetching total metrics', { provider, error });
    throw error;
  }
};

/**
 * Get provider comparison metrics.
 * @returns {Promise<Array>} Aggregated provider comparison metrics.
 */
tokenUsageSchema.statics.getProviderComparison = async function() {
  const cacheKey = 'providerComparison';
  const cachedMetrics = cache.get(cacheKey);
  if (cachedMetrics) {
    return cachedMetrics;
  }

  try {
    const metrics = await this.aggregate([
      {
        $group: {
          _id: '$provider',
          totalRequests: { $sum: 1 },
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$cost' },
          avgResponseTime: { $avg: '$responseTime' },
          successRate: {
            $avg: { $cond: [{ $eq: ['$success', true] }, 1, 0] }
          }
        }
      },
      {
        $sort: { totalRequests: -1 }
      }
    ]);

    cache.set(cacheKey, metrics);
    return metrics;
  } catch (error) {
    logger.error('Error fetching provider comparison', { error });
    throw error;
  }
};

export const TokenUsage = mongoose.model('TokenUsage', tokenUsageSchema);