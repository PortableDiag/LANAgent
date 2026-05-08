import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import { jsonClone } from '../utils/jsonUtils.js';

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

const modelCacheSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
    unique: true,
    enum: ['openai', 'anthropic', 'huggingface', 'gab', 'xai', 'ollama', 'bitnet']
  },
  
  models: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  
  apiFormat: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  lastChecked: {
    type: Date,
    default: Date.now
  },
  
  metadata: {
    totalModels: Number,
    categories: [String],
    source: String,
    version: String
  },
  
  versionHistory: [{
    version: {
      type: String,
      required: true
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now
    },
    models: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    apiFormat: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    metadata: {
      totalModels: Number,
      categories: [String],
      changeReason: String
    }
  }],
  
  versionSettings: {
    maxVersions: {
      type: Number,
      default: 10
    },
    retentionDays: {
      type: Number,
      default: 30
    }
  },

  usageAnalytics: {
    requestCount: {
      type: Number,
      default: 0
    },
    totalResponseTime: {
      type: Number,
      default: 0
    },
    errorCount: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

modelCacheSchema.index({ provider: 1 });
modelCacheSchema.index({ lastChecked: -1 });

modelCacheSchema.methods.isStale = function(maxAgeHours = 24) {
  const age = Date.now() - this.lastChecked.getTime();
  return age > (maxAgeHours * 60 * 60 * 1000);
};

modelCacheSchema.methods.getModelsByCategory = function(category) {
  if (Array.isArray(this.models)) {
    return this.models.filter(m => m.category === category);
  } else if (typeof this.models === 'object') {
    return this.models[category] || [];
  }
  return [];
};

modelCacheSchema.methods.cleanupOldVersions = async function() {
  try {
    const settings = this.versionSettings || { maxVersions: 10, retentionDays: 30 };
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - settings.retentionDays);
    
    this.versionHistory = this.versionHistory.filter(v => v.timestamp > cutoffDate);
    
    if (this.versionHistory.length > settings.maxVersions) {
      this.versionHistory.sort((a, b) => b.timestamp - a.timestamp);
      this.versionHistory = this.versionHistory.slice(0, settings.maxVersions);
    }
    
    logger.info(`Cleaned up version history for ${this.provider}, retained ${this.versionHistory.length} versions`);
  } catch (error) {
    logger.error(`Error cleaning up versions for ${this.provider}:`, error);
  }
};

modelCacheSchema.methods.getVersion = function(version) {
  const versionData = this.versionHistory.find(v => v.version === version);
  if (!versionData) {
    logger.warn(`Version ${version} not found for provider ${this.provider}`);
    return null;
  }
  return {
    version: versionData.version,
    timestamp: versionData.timestamp,
    models: versionData.models,
    apiFormat: versionData.apiFormat,
    metadata: versionData.metadata
  };
};

modelCacheSchema.methods.listVersions = function() {
  return this.versionHistory.map(v => ({
    version: v.version,
    timestamp: v.timestamp,
    totalModels: v.metadata?.totalModels || 0,
    changeReason: v.metadata?.changeReason || 'No reason provided'
  })).sort((a, b) => b.timestamp - a.timestamp);
};

modelCacheSchema.methods.restoreVersion = async function(version) {
  try {
    const versionData = this.getVersion(version);
    if (!versionData) {
      throw new Error(`Version ${version} not found`);
    }
    
    const restoreVersion = {
      version: new Date().toISOString(),
      timestamp: new Date(),
      models: jsonClone(this.models),
      apiFormat: jsonClone(this.apiFormat),
      metadata: {
        ...this.metadata,
        changeReason: `Restored from version ${version}`
      }
    };
    
    this.versionHistory.push(restoreVersion);
    
    this.models = versionData.models;
    this.apiFormat = versionData.apiFormat;
    this.metadata = {
      ...versionData.metadata,
      version: new Date().toISOString()
    };
    this.lastChecked = new Date();
    
    await this.save();
    logger.info(`Restored ${this.provider} models to version ${version}`);
    return true;
  } catch (error) {
    logger.error(`Error restoring version ${version} for ${this.provider}:`, error);
    return false;
  }
};

modelCacheSchema.methods.trackUsage = function(responseTime, isError = false) {
  this.usageAnalytics.requestCount += 1;
  this.usageAnalytics.totalResponseTime += responseTime;
  if (isError) {
    this.usageAnalytics.errorCount += 1;
  }
  return this.save();
};

modelCacheSchema.methods.getUsageAnalytics = function() {
  const { requestCount, totalResponseTime, errorCount } = this.usageAnalytics;
  return {
    requestCount,
    averageResponseTime: requestCount ? totalResponseTime / requestCount : 0,
    errorRate: requestCount ? errorCount / requestCount : 0
  };
};

/**
 * Static method to aggregate usage analytics data
 * and format it for external consumption.
 */
modelCacheSchema.statics.getUsageAnalyticsData = async function() {
  try {
    const analyticsData = await this.aggregate([
      {
        $group: {
          _id: null,
          totalRequests: { $sum: "$usageAnalytics.requestCount" },
          totalResponseTime: { $sum: "$usageAnalytics.totalResponseTime" },
          totalErrors: { $sum: "$usageAnalytics.errorCount" }
        }
      },
      {
        $project: {
          _id: 0,
          totalRequests: 1,
          averageResponseTime: {
            $cond: {
              if: { $eq: ["$totalRequests", 0] },
              then: 0,
              else: { $divide: ["$totalResponseTime", "$totalRequests"] }
            }
          },
          errorRate: {
            $cond: {
              if: { $eq: ["$totalRequests", 0] },
              then: 0,
              else: { $divide: ["$totalErrors", "$totalRequests"] }
            }
          }
        }
      }
    ]);
    return analyticsData[0] || { totalRequests: 0, averageResponseTime: 0, errorRate: 0 };
  } catch (error) {
    logger.error('Error aggregating usage analytics data:', error);
    throw new Error('Failed to retrieve usage analytics data');
  }
};

modelCacheSchema.statics.getLatestModels = async function(provider) {
  try {
    const cacheKey = `latestModels:${provider}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      logger.info(`Cache hit for latest models of provider ${provider}`);
      return cachedData;
    }
    
    const data = await retryOperation(() => this.findOne({ provider }).sort({ lastChecked: -1 }), { retries: 3 });
    if (data) {
      cache.set(cacheKey, data);
    }
    return data;
  } catch (error) {
    logger.error(`Error fetching latest models for provider ${provider}:`, error);
    throw new Error('Failed to fetch latest models');
  }
};

modelCacheSchema.statics.updateCache = async function(provider, models, apiFormat = {}, changeReason = 'Automatic update') {
  const metadata = {
    totalModels: Array.isArray(models) ? models.length : 
                 Object.values(models).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0),
    categories: Array.isArray(models) ? 
                [...new Set(models.map(m => m.category).filter(Boolean))] :
                Object.keys(models),
    source: 'web-scrape',
    version: new Date().toISOString()
  };
  
  try {
    const existingEntry = await retryOperation(() => this.findOne({ provider }), { retries: 3, context: 'ModelCache.findOne' });
    const versionData = {
      version: metadata.version,
      timestamp: new Date(),
      models: jsonClone(models),
      apiFormat: jsonClone(apiFormat),
      metadata: {
        totalModels: metadata.totalModels,
        categories: metadata.categories,
        changeReason
      }
    };

    if (existingEntry) {
      const modelsChanged = JSON.stringify(existingEntry.models) !== JSON.stringify(models);
      
      if (modelsChanged) {
        existingEntry.versionHistory.push(versionData);
        await existingEntry.cleanupOldVersions();
        
        logger.info(`Model cache updated for ${provider}, version history size: ${existingEntry.versionHistory.length}`);
      } else {
        logger.info(`Model cache for ${provider} unchanged, skipping version creation`);
      }
      
      existingEntry.models = models;
      existingEntry.apiFormat = apiFormat;
      existingEntry.lastChecked = new Date();
      existingEntry.metadata = metadata;
      
      const savedEntry = await retryOperation(() => existingEntry.save(), { retries: 3, context: 'ModelCache.save' });
      cache.set(`latestModels:${provider}`, savedEntry);
      return savedEntry;
    } else {
      logger.info(`Creating new model cache entry for ${provider}`);
      const newEntry = await retryOperation(() => this.create({
        provider,
        models,
        apiFormat,
        lastChecked: new Date(),
        metadata,
        versionHistory: [versionData]
      }), { retries: 3, context: 'ModelCache.create' });
      cache.set(`latestModels:${provider}`, newEntry);
      return newEntry;
    }
  } catch (error) {
    logger.error(`Error updating cache for provider ${provider}:`, error);
    throw new Error('Failed to update cache');
  }
};

modelCacheSchema.statics.getModelVersion = async function(provider, version) {
  try {
    const entry = await this.findOne({ provider });
    if (!entry) {
      logger.error(`No cache entry found for provider ${provider}`);
      return null;
    }
    return entry.getVersion(version);
  } catch (error) {
    logger.error(`Error retrieving version ${version} for provider ${provider}:`, error);
    throw new Error('Failed to retrieve model version');
  }
};

modelCacheSchema.statics.listProviderVersions = async function(provider) {
  try {
    const entry = await this.findOne({ provider });
    if (!entry) {
      logger.warn(`No cache entry found for provider ${provider}`);
      return [];
    }
    return entry.listVersions();
  } catch (error) {
    logger.error(`Error listing versions for provider ${provider}:`, error);
    throw new Error('Failed to list versions');
  }
};

modelCacheSchema.statics.compareVersions = async function(provider, version1, version2) {
  try {
    const entry = await this.findOne({ provider });
    if (!entry) {
      throw new Error(`No cache entry found for provider ${provider}`);
    }
    
    const v1 = entry.getVersion(version1);
    const v2 = entry.getVersion(version2);
    
    if (!v1 || !v2) {
      throw new Error('One or both versions not found');
    }
    
    const v1Models = Array.isArray(v1.models) ? v1.models : Object.values(v1.models).flat();
    const v2Models = Array.isArray(v2.models) ? v2.models : Object.values(v2.models).flat();
    
    const v1ModelIds = new Set(v1Models.map(m => m.id || m.name || m.model));
    const v2ModelIds = new Set(v2Models.map(m => m.id || m.name || m.model));
    
    return {
      version1: {
        version: v1.version,
        timestamp: v1.timestamp,
        totalModels: v1Models.length
      },
      version2: {
        version: v2.version,
        timestamp: v2.timestamp,
        totalModels: v2Models.length
      },
      added: [...v2ModelIds].filter(id => !v1ModelIds.has(id)),
      removed: [...v1ModelIds].filter(id => !v2ModelIds.has(id)),
      unchanged: [...v1ModelIds].filter(id => v2ModelIds.has(id))
    };
  } catch (error) {
    logger.error(`Error comparing versions for provider ${provider}:`, error);
    throw error;
  }
};

export const ModelCache = mongoose.model('ModelCache', modelCacheSchema);
