import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const GeneratedSongSchema = new mongoose.Schema({
  prompt: {
    type: String,
    required: true
  },
  provider: {
    type: String,
    required: true,
    enum: ['suno', 'mubert', 'soundverse', 'huggingface']
  },
  title: {
    type: String,
    default: 'Untitled'
  },
  genre: String,
  mood: String,
  style: String,
  audioUrl: String,
  localPath: String,
  duration: Number,
  lyrics: String,
  instrumental: {
    type: Boolean,
    default: false
  },
  taskId: String,
  status: {
    type: String,
    enum: ['pending', 'generating', 'completed', 'failed', 'delivered'],
    default: 'pending'
  },
  deliveredVia: [{
    type: String,
    enum: ['telegram', 'email']
  }],
  error: String,
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  requestedBy: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  completedAt: Date
});

GeneratedSongSchema.index({ provider: 1, status: 1, createdAt: -1 });
GeneratedSongSchema.index({ taskId: 1 });

// Add cache for provider health status
const providerHealthCache = new NodeCache({ stdTTL: 300 }); // 5 minutes TTL

/**
 * Get provider health status
 * @param {string} provider - Provider name
 * @returns {object} Health status information
 */
GeneratedSongSchema.statics.getProviderHealth = function(provider) {
  return providerHealthCache.get(provider) || { failures: 0, lastFailure: null };
};

/**
 * Update provider health status after failure
 * @param {string} provider - Provider name
 * @param {Error} error - Error that occurred
 */
GeneratedSongSchema.statics.updateProviderHealth = function(provider, error) {
  const health = this.getProviderHealth(provider);
  health.failures += 1;
  health.lastFailure = new Date();
  health.lastError = error.message;
  providerHealthCache.set(provider, health);
  logger.warn(`Provider ${provider} health updated: ${health.failures} failures`);
};

/**
 * Reset provider health status after successful operation
 * @param {string} provider - Provider name
 */
GeneratedSongSchema.statics.resetProviderHealth = function(provider) {
  providerHealthCache.set(provider, { failures: 0, lastFailure: null });
  logger.info(`Provider ${provider} health reset to healthy`);
};

/**
 * Check if provider should be considered unhealthy
 * @param {string} provider - Provider name
 * @returns {boolean} True if provider is unhealthy
 */
GeneratedSongSchema.statics.isProviderUnhealthy = function(provider) {
  const health = this.getProviderHealth(provider);
  return health.failures >= 3 && 
         health.lastFailure && 
         (Date.now() - new Date(health.lastFailure).getTime()) < 300000; // 5 minutes
};

/**
 * Get healthy providers ordered by preference
 * @param {string} preferredProvider - Preferred provider
 * @returns {Array<string>} List of healthy providers
 */
GeneratedSongSchema.statics.getHealthyProviders = function(preferredProvider) {
  const allProviders = ['suno', 'mubert', 'soundverse', 'huggingface'];
  const healthyProviders = allProviders.filter(p => !this.isProviderUnhealthy(p));
  
  // Move preferred provider to front if it's healthy
  if (preferredProvider && healthyProviders.includes(preferredProvider)) {
    const index = healthyProviders.indexOf(preferredProvider);
    healthyProviders.splice(index, 1);
    healthyProviders.unshift(preferredProvider);
  }
  
  return healthyProviders;
};

/**
 * Execute song generation with smart retry and fallback
 * @param {Function} generationFn - Function to execute for generation
 * @param {Object} options - Generation options
 * @param {string} options.provider - Primary provider
 * @param {number} options.retries - Number of retries
 * @returns {Promise<Object>} Generation result
 */
GeneratedSongSchema.statics.generateWithRetry = async function(generationFn, options = {}) {
  const { provider, retries = 3 } = options;
  const healthyProviders = this.getHealthyProviders(provider);
  
  if (healthyProviders.length === 0) {
    throw new Error('No healthy providers available');
  }

  let lastError;
  let currentProviderIndex = 0;

  // Try each provider until one succeeds or we run out of providers
  while (currentProviderIndex < healthyProviders.length) {
    const currentProvider = healthyProviders[currentProviderIndex];
    
    try {
      logger.info(`Attempting generation with provider: ${currentProvider}`);
      
      const result = await retryOperation(
        () => generationFn(currentProvider),
        {
          retries,
          onRetry: (error, attempt) => {
            logger.warn(`Generation attempt ${attempt} failed with ${currentProvider}: ${error.message}`);
            this.updateProviderHealth(currentProvider, error);
          }
        }
      );
      
      // Success - reset provider health
      this.resetProviderHealth(currentProvider);
      return {
        ...result,
        provider: currentProvider,
        metadata: {
          ...result.metadata,
          retryAttempts: retries - (result.attemptsLeft || retries),
          fallbackUsed: currentProvider !== provider
        }
      };
    } catch (error) {
      lastError = error;
      this.updateProviderHealth(currentProvider, error);
      logger.error(`Generation failed with provider ${currentProvider}: ${error.message}`);
      currentProviderIndex++;
    }
  }

  // All providers failed
  throw lastError;
};

/**
 * Update song generation status with enhanced error tracking
 * @param {string} id - Song ID
 * @param {Object} updates - Status updates
 * @returns {Promise<Object>} Updated document
 */
GeneratedSongSchema.statics.updateGenerationStatus = async function(id, updates) {
  try {
    const updateData = { ...updates };
    
    // Track retry attempts in metadata
    if (updates.status === 'failed' && updates.error) {
      const song = await this.findById(id);
      if (song) {
        const metadata = song.metadata || {};
        metadata.retryCount = (metadata.retryCount || 0) + 1;
        metadata.lastError = updates.error;
        metadata.lastAttempt = new Date();
        updateData.metadata = metadata;
        
        // Mark provider as unhealthy if this is a consistent failure
        this.updateProviderHealth(song.provider, new Error(updates.error));
      }
    } else if (updates.status === 'completed') {
      // Reset provider health on successful completion
      const song = await this.findById(id);
      if (song) {
        this.resetProviderHealth(song.provider);
      }
      updateData.completedAt = new Date();
    }
    
    return await this.findByIdAndUpdate(id, updateData, { new: true });
  } catch (error) {
    logger.error(`Failed to update generation status for ${id}: ${error.message}`);
    throw error;
  }
};

/**
 * Get generation statistics by provider
 * @returns {Promise<Object>} Provider statistics
 */
GeneratedSongSchema.statics.getGenerationStats = async function() {
  try {
    const stats = await this.aggregate([
      {
        $group: {
          _id: '$provider',
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          averageDuration: { $avg: '$duration' }
        }
      }
    ]);
    
    // Add health information
    const statsWithHealth = stats.map(stat => ({
      ...stat,
      health: this.getProviderHealth(stat._id)
    }));
    
    return statsWithHealth;
  } catch (error) {
    logger.error(`Failed to get generation stats: ${error.message}`);
    throw error;
  }
};

export const GeneratedSong = mongoose.model('GeneratedSong', GeneratedSongSchema);
