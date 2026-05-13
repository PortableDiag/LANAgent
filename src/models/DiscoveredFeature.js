import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

/**
 * Discovered Feature Schema for GitHub-discovered features and improvements
 * These are separate from user-requested features and have lower priority
 */
const DiscoveredFeatureSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxLength: 200
  },
  
  description: {
    type: String,
    required: true,
    trim: true,
    maxLength: 5000
  },
  
  type: {
    type: String,
    required: true,
    enum: [
      'readme_feature',
      'structure_feature',
      'plugin_idea',
      'integration',
      'enhancement',
      'workflow',
      'capability',
      'api_feature',
      'ui_feature',
      'automation',
      'commit_feature',
      'code_pattern',
      'implementation_pattern',
      'code_search_feature',
      'other'
    ]
  },
  
  source: {
    repository: {
      type: String,
      required: true
    },
    url: String,
    filePath: String,
    language: String
  },
  
  implementation: {
    suggestion: String,
    confidence: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium'
    },
    targetFile: String,
    estimatedEffort: {
      type: String,
      enum: ['small', 'medium', 'large'],
      default: 'medium'
    },
    // How this feature should be applied. Set by the classifier at discovery time
    // (or backfilled later). findImplementable filters out null and 'skip', so an
    // unclassified record never reaches self-modification.
    //   modify     — enhance an existing file at implementation.targetFile
    //   new-plugin — create a new plugin file at implementation.targetFile
    //                (auto-discovered from src/api/plugins/ on next restart)
    //   skip       — not implementable as plugin or modify; surface for manual review
    kind: {
      type: String,
      enum: ['modify', 'new-plugin', 'skip'],
      default: null
    },
    kindRationale: String
  },
  
  codeSnippets: [{
    code: {
      type: String,
      maxLength: 10000 // Increased from 5000 to handle larger snippets
    },
    language: String,
    filePath: String,
    contextNotes: String
  }],
  
  status: {
    type: String,
    default: 'discovered',
    enum: [
      'discovered',     // Just found
      'analyzing',      // Being analyzed for implementation
      'implementing',   // Currently being implemented
      'implemented',    // Successfully implemented
      'rejected'       // Determined not suitable
    ]
  },
  
  implementedAt: Date,
  implementedPR: String,
  implementedBy: String, // 'self-modification', 'plugin-development', 'manual'
  
  discoveredBy: {
    type: String,
    default: 'github_discovery'
  },
  
  priority: {
    type: Number,
    default: 0 // Lower than user requests
  },
  
  tags: [String],
  
  // For deduplication
  fingerprint: {
    type: String,
    unique: true,
    sparse: true
  }
}, {
  timestamps: true,
  collection: 'discoveredFeatures'
});

// Indexes for efficient querying
DiscoveredFeatureSchema.index({ status: 1, priority: -1 });
DiscoveredFeatureSchema.index({ 'source.repository': 1 });
DiscoveredFeatureSchema.index({ type: 1 });
DiscoveredFeatureSchema.index({ createdAt: -1 });
DiscoveredFeatureSchema.index({ fingerprint: 1 });

// Initialize cache
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Methods
DiscoveredFeatureSchema.methods.markAsImplemented = function(prUrl, implementedBy = 'self-modification') {
  this.status = 'implemented';
  this.implementedAt = new Date();
  this.implementedPR = prUrl;
  this.implementedBy = implementedBy;
  return this.save();
};

DiscoveredFeatureSchema.methods.toUpgradeFormat = function() {
  return {
    id: `discovered-${this._id}`,
    type: 'github_discovered_feature',
    title: this.title,
    description: this.description,
    file: this.implementation?.targetFile,
    priority: 'low', // Always low priority for discovered features
    effort: this.implementation?.estimatedEffort || 'medium',
    value: 'medium',
    source: 'github_discovery',
    repository: this.source.repository,
    discoveredFeatureId: this._id,
    hasCodeSnippets: this.codeSnippets && this.codeSnippets.length > 0
  };
};

// Static methods with retry logic for resilience
DiscoveredFeatureSchema.statics.findByRepository = async function(repository) {
  const cacheKey = `findByRepository-${repository}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  try {
    const result = await retryOperation(
      () => this.find({ 'source.repository': repository }).sort({ createdAt: -1 }).lean(),
      { retries: 3, context: 'findByRepository' }
    );
    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.error(`Failed to find by repository: ${repository}`, error);
    throw error;
  }
};

DiscoveredFeatureSchema.statics.findImplementable = async function(limit = 20) {
  const cacheKey = `findImplementable-${limit}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  try {
    const result = await retryOperation(
      () => this.aggregate([
        {
          $match: {
            status: { $in: ['discovered', 'analyzing'] },
            // Require a classifier verdict, and exclude 'skip'. An unclassified
            // record (kind: null/missing) is never picked — it stays in the queue
            // until the backfill job processes it.
            'implementation.kind': { $in: ['modify', 'new-plugin'] },
            'implementation.targetFile': { $nin: [null, ''] }
          }
        },
        { $sort: { priority: -1, createdAt: -1 } },
        { $limit: limit }
      ]).exec(),
      { retries: 3, context: 'findImplementable' }
    );
    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.error('Failed to find implementable features', error);
    throw error;
  }
};

DiscoveredFeatureSchema.statics.searchForExamples = async function(keywords) {
  const regex = new RegExp(keywords.join('|'), 'i');
  const cacheKey = `searchForExamples-${keywords.join('-')}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  try {
    const result = await retryOperation(
      () => this.aggregate([
        { $match: {
          $or: [
            { title: regex },
            { description: regex },
            { 'implementation.suggestion': regex },
            { tags: { $in: keywords } }
          ],
          'codeSnippets.0': { $exists: true }
        }},
        { $limit: 10 }
      ]).exec(),
      { retries: 3, context: 'searchForExamples' }
    );
    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.error(`Failed to search for examples with keywords: ${keywords}`, error);
    throw error;
  }
};

DiscoveredFeatureSchema.statics.cleanup = async function() {
  // Delete implemented features older than 7 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  // Delete stale discovered features older than 30 days that were never implemented
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - 30);

  try {
    const implementedResult = await retryOperation(
      () => this.deleteMany({
        status: 'implemented',
        implementedAt: { $lt: cutoff }
      }),
      { retries: 3, context: 'cleanup-implemented' }
    );

    // Clean up rejected features (e.g. stale target files) older than 3 days
    const rejectedResult = await retryOperation(
      () => this.deleteMany({
        status: 'rejected',
        updatedAt: { $lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
      }),
      { retries: 3, context: 'cleanup-rejected' }
    );

    // Clean up discovered features that have been sitting unimplemented for 30+ days
    const staleResult = await retryOperation(
      () => this.deleteMany({
        status: 'discovered',
        discoveredAt: { $lt: staleCutoff }
      }),
      { retries: 3, context: 'cleanup-stale' }
    );

    const totalDeleted = (implementedResult.deletedCount || 0) + (rejectedResult.deletedCount || 0) + (staleResult.deletedCount || 0);
    if (totalDeleted > 0) {
      logger.info(`🧹 Cleaned up discovered features: ${implementedResult.deletedCount} implemented, ${rejectedResult.deletedCount} rejected, ${staleResult.deletedCount} stale`);
    }
    return totalDeleted;
  } catch (error) {
    logger.error('Failed to cleanup discovered features', error);
    throw error;
  }
};

// Pre-save hook to generate fingerprint
DiscoveredFeatureSchema.pre('save', async function(next) {
  if (!this.fingerprint) {
    // Create fingerprint from key fields to prevent duplicates
    const { createHash } = await import('crypto');
    const fingerprintData = `${this.source.repository}-${this.title}-${this.type}`;
    this.fingerprint = createHash('sha256').update(fingerprintData).digest('hex');
  }
  next();
});

export const DiscoveredFeature = mongoose.model('DiscoveredFeature', DiscoveredFeatureSchema);
