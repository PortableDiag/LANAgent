import { logger } from '../../utils/logger.js';
import mongoose from 'mongoose';

/**
 * ThoughtStore - Persists and retrieves reasoning traces
 *
 * Stores the thought chains from ReAct and Plan-Execute agents
 * Enables:
 * - Learning from past reasoning patterns
 * - Debugging and analysis of agent behavior
 * - Bootstrapping new reasoning with similar past queries
 */

// Mongoose schema for thought chains
const thoughtChainSchema = new mongoose.Schema({
  query: {
    type: String,
    required: true,
    index: true
  },
  queryEmbedding: {
    type: [Number],
    default: null
  },
  agentType: {
    type: String,
    enum: ['react', 'plan-execute', 'unknown'],
    default: 'unknown'
  },
  thoughts: [{
    type: {
      type: String,
      enum: ['thought', 'action', 'observation', 'plan', 'step', 'error']
    },
    content: mongoose.Schema.Types.Mixed,
    iteration: Number,
    stepNumber: Number,
    timestamp: Date
  }],
  result: {
    success: Boolean,
    answer: mongoose.Schema.Types.Mixed, // Can be string or object (API discovery results, etc.)
    error: String,
    iterations: Number,
    completedSteps: Number,
    totalSteps: Number,
    duration: Number
  },
  metadata: {
    userId: String,
    context: mongoose.Schema.Types.Mixed,
    tags: [String]
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  accessCount: {
    type: Number,
    default: 0
  },
  lastAccessedAt: Date
});

// Create text index for query search
thoughtChainSchema.index({ query: 'text' });

// Model (lazy-loaded to handle timing with mongoose connection)
let ThoughtChain = null;

function getModel() {
  if (!ThoughtChain) {
    try {
      ThoughtChain = mongoose.model('ThoughtChain');
    } catch {
      ThoughtChain = mongoose.model('ThoughtChain', thoughtChainSchema);
    }
  }
  return ThoughtChain;
}

export class ThoughtStore {
  constructor(options = {}) {
    this.memoryManager = options.memoryManager;
    this.embeddingProvider = options.embeddingProvider;
    this.vectorStore = options.vectorStore;
    this.maxHistoryDays = options.maxHistoryDays || 30;
    this.similarityThreshold = options.similarityThreshold || 0.75;
    this.initialized = false;
  }

  /**
   * Initialize the thought store
   */
  async initialize() {
    try {
      // Ensure model is available
      getModel();
      this.initialized = true;
      logger.info('ThoughtStore initialized');
    } catch (error) {
      logger.error('ThoughtStore initialization error:', error);
      throw error;
    }
  }

  /**
   * Save a thought chain from reasoning
   */
  async saveThoughtChain(query, thoughts, result, context = {}) {
    try {
      const Model = getModel();

      // Determine agent type from thought structure
      let agentType = 'unknown';
      if (thoughts.some(t => t.type === 'plan')) {
        agentType = 'plan-execute';
      } else if (thoughts.some(t => t.type === 'thought' && t.content?.action)) {
        agentType = 'react';
      }

      // Generate embedding for similarity search
      let queryEmbedding = null;
      if (this.embeddingProvider) {
        try {
          queryEmbedding = await this.embeddingProvider.generateEmbedding(query);
        } catch (error) {
          logger.warn('Failed to generate embedding for thought chain:', error.message);
        }
      }

      const thoughtChain = new Model({
        query,
        queryEmbedding,
        agentType,
        thoughts: thoughts.map(t => ({
          type: t.type,
          content: t.content,
          iteration: t.iteration,
          stepNumber: t.stepNumber,
          timestamp: t.timestamp || new Date()
        })),
        result: {
          success: result.success,
          answer: result.answer,
          error: result.error,
          iterations: result.iterations,
          completedSteps: result.completedSteps,
          totalSteps: result.totalSteps,
          duration: result.duration
        },
        metadata: {
          userId: context.userId,
          context: context,
          tags: context.tags || []
        }
      });

      await thoughtChain.save();
      logger.debug(`Saved thought chain for query: ${query.substring(0, 50)}...`);

      return thoughtChain._id;
    } catch (error) {
      logger.error('Failed to save thought chain:', error);
      throw error;
    }
  }

  /**
   * Find similar reasoning traces for bootstrapping
   * @param {string} query - The query to find similar reasoning for
   * @param {Object} options - Search options
   * @param {number} options.limit - Maximum number of results
   * @param {boolean} options.successfulOnly - Only return successful chains
   * @param {string} options.agentType - Filter by agent type
   * @param {number} options.minSimilarity - Minimum similarity threshold
   * @param {string[]} options.metadataTags - Filter by metadata tags (all must match)
   * @param {string} options.userId - Filter by user ID
   * @param {string} options.sortBy - Sort by field (createdAt, duration, accessCount)
   */
  async findSimilarReasoning(query, options = {}) {
    const {
      limit = 5,
      successfulOnly = true,
      agentType = null,
      minSimilarity = this.similarityThreshold,
      metadataTags = [],
      userId = null,
      sortBy = 'createdAt'
    } = options;

    try {
      const Model = getModel();

      // If we have embedding capability, use vector similarity
      if (this.embeddingProvider && this.vectorStore) {
        return await this.findSimilarByEmbedding(query, { limit, successfulOnly, agentType, minSimilarity, metadataTags, userId, sortBy });
      }

      // Fallback to text search
      const filter = {};
      if (successfulOnly) {
        filter['result.success'] = true;
      }
      if (agentType) {
        filter.agentType = agentType;
      }
      // Filter by metadata tags (all specified tags must be present)
      if (metadataTags.length > 0) {
        filter['metadata.tags'] = { $all: metadataTags };
      }
      // Filter by user ID
      if (userId) {
        filter['metadata.userId'] = userId;
      }

      // Build sort options based on sortBy parameter
      const sortOptions = { score: { $meta: 'textScore' } };
      if (sortBy === 'duration') {
        sortOptions['result.duration'] = -1;
      } else if (sortBy === 'accessCount') {
        sortOptions.accessCount = -1;
      } else {
        sortOptions.createdAt = -1;
      }

      const results = await Model.find({
        ...filter,
        $text: { $search: query }
      })
        .sort(sortOptions)
        .limit(limit)
        .select('-queryEmbedding'); // Exclude large embedding array

      return results.map(r => ({
        id: r._id,
        query: r.query,
        agentType: r.agentType,
        thoughts: r.thoughts,
        result: r.result,
        similarity: 'text_match',
        createdAt: r.createdAt
      }));
    } catch (error) {
      logger.error('Failed to find similar reasoning:', error);
      return [];
    }
  }

  /**
   * Find similar reasoning using embedding similarity
   */
  async findSimilarByEmbedding(query, options = {}) {
    const {
      limit = 5,
      successfulOnly = true,
      agentType = null,
      minSimilarity = this.similarityThreshold,
      metadataTags = [],
      userId = null,
      sortBy = 'createdAt'
    } = options;

    try {
      const Model = getModel();

      // Generate embedding for query
      const queryEmbedding = await this.embeddingProvider.generateEmbedding(query);
      if (!queryEmbedding) {
        return [];
      }

      // Get candidates that have embeddings
      const filter = { queryEmbedding: { $exists: true, $ne: null } };
      if (successfulOnly) {
        filter['result.success'] = true;
      }
      if (agentType) {
        filter.agentType = agentType;
      }
      // Filter by metadata tags (all specified tags must be present)
      if (metadataTags.length > 0) {
        filter['metadata.tags'] = { $all: metadataTags };
      }
      // Filter by user ID
      if (userId) {
        filter['metadata.userId'] = userId;
      }

      // Build sort options based on sortBy parameter
      const sortOptions = {};
      if (sortBy === 'duration') {
        sortOptions['result.duration'] = -1;
      } else if (sortBy === 'accessCount') {
        sortOptions.accessCount = -1;
      } else {
        sortOptions.createdAt = -1;
      }

      const candidates = await Model.find(filter)
        .sort(sortOptions)
        .limit(100) // Get recent candidates for comparison
        .lean();

      // Calculate similarities
      const withSimilarity = candidates.map(c => ({
        ...c,
        similarity: this.cosineSimilarity(queryEmbedding, c.queryEmbedding)
      }));

      // Filter and sort by similarity
      const filtered = withSimilarity
        .filter(c => c.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      return filtered.map(r => ({
        id: r._id,
        query: r.query,
        agentType: r.agentType,
        thoughts: r.thoughts,
        result: r.result,
        similarity: r.similarity,
        createdAt: r.createdAt
      }));
    } catch (error) {
      logger.error('Failed to find similar by embedding:', error);
      return [];
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Get a specific thought chain by ID
   */
  async getThoughtChain(id) {
    try {
      const Model = getModel();
      const chain = await Model.findById(id);

      if (chain) {
        // Update access stats
        chain.accessCount += 1;
        chain.lastAccessedAt = new Date();
        await chain.save();
      }

      return chain;
    } catch (error) {
      logger.error('Failed to get thought chain:', error);
      return null;
    }
  }

  /**
   * Get recent thought chains
   * @param {Object} options - Query options
   * @param {number} options.limit - Maximum number of results
   * @param {string} options.agentType - Filter by agent type
   * @param {boolean} options.successfulOnly - Only return successful chains
   * @param {string[]} options.metadataTags - Filter by metadata tags (all must match)
   * @param {string} options.userId - Filter by user ID
   * @param {string} options.sortBy - Sort by field (createdAt, duration, accessCount)
   */
  async getRecentChains(options = {}) {
    const {
      limit = 20,
      agentType = null,
      successfulOnly = false,
      metadataTags = [],
      userId = null,
      sortBy = 'createdAt'
    } = options;

    try {
      const Model = getModel();
      const filter = {};

      if (agentType) {
        filter.agentType = agentType;
      }
      if (successfulOnly) {
        filter['result.success'] = true;
      }
      // Filter by metadata tags (all specified tags must be present)
      if (metadataTags.length > 0) {
        filter['metadata.tags'] = { $all: metadataTags };
      }
      // Filter by user ID
      if (userId) {
        filter['metadata.userId'] = userId;
      }

      // Build sort options based on sortBy parameter
      const sortOptions = {};
      if (sortBy === 'duration') {
        sortOptions['result.duration'] = -1;
      } else if (sortBy === 'accessCount') {
        sortOptions.accessCount = -1;
      } else {
        sortOptions.createdAt = -1;
      }

      return await Model.find(filter)
        .sort(sortOptions)
        .limit(limit)
        .select('-queryEmbedding -thoughts.content'); // Exclude large fields
    } catch (error) {
      logger.error('Failed to get recent chains:', error);
      return [];
    }
  }

  /**
   * Get statistics about stored thought chains
   */
  async getStats() {
    try {
      const Model = getModel();

      const [
        total,
        successful,
        reactCount,
        planExecuteCount,
        recentWeek
      ] = await Promise.all([
        Model.countDocuments(),
        Model.countDocuments({ 'result.success': true }),
        Model.countDocuments({ agentType: 'react' }),
        Model.countDocuments({ agentType: 'plan-execute' }),
        Model.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } })
      ]);

      const avgIterations = await Model.aggregate([
        { $match: { agentType: 'react' } },
        { $group: { _id: null, avg: { $avg: '$result.iterations' } } }
      ]);

      const avgSteps = await Model.aggregate([
        { $match: { agentType: 'plan-execute' } },
        { $group: { _id: null, avg: { $avg: '$result.completedSteps' } } }
      ]);

      return {
        total,
        successful,
        successRate: total > 0 ? (successful / total * 100).toFixed(1) + '%' : '0%',
        byAgentType: {
          react: reactCount,
          planExecute: planExecuteCount,
          unknown: total - reactCount - planExecuteCount
        },
        recentWeek,
        averages: {
          reactIterations: avgIterations[0]?.avg?.toFixed(1) || 0,
          planExecuteSteps: avgSteps[0]?.avg?.toFixed(1) || 0
        }
      };
    } catch (error) {
      logger.error('Failed to get thought store stats:', error);
      return { total: 0, successful: 0, successRate: '0%' };
    }
  }

  /**
   * Clean up old thought chains
   */
  async cleanup(options = {}) {
    const {
      olderThanDays = this.maxHistoryDays,
      keepSuccessful = true
    } = options;

    try {
      const Model = getModel();
      const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

      const filter = { createdAt: { $lt: cutoffDate } };
      if (keepSuccessful) {
        filter['result.success'] = false;
      }

      const result = await Model.deleteMany(filter);
      logger.info(`Cleaned up ${result.deletedCount} old thought chains`);
      return result.deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup thought chains:', error);
      return 0;
    }
  }

  /**
   * Export thought chains for analysis
   */
  async exportChains(options = {}) {
    const {
      startDate,
      endDate,
      agentType,
      format = 'json'
    } = options;

    try {
      const Model = getModel();
      const filter = {};

      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) filter.createdAt.$lte = new Date(endDate);
      }
      if (agentType) {
        filter.agentType = agentType;
      }

      const chains = await Model.find(filter)
        .sort({ createdAt: -1 })
        .select('-queryEmbedding')
        .lean();

      if (format === 'json') {
        return chains;
      }

      // Simple text format
      return chains.map(c => {
        let text = `Query: ${c.query}\n`;
        text += `Agent: ${c.agentType}\n`;
        text += `Success: ${c.result.success}\n`;
        text += `Duration: ${c.result.duration}ms\n`;
        text += `Date: ${c.createdAt}\n`;
        text += '---\n';
        return text;
      }).join('\n');
    } catch (error) {
      logger.error('Failed to export thought chains:', error);
      return format === 'json' ? [] : '';
    }
  }
}

export default ThoughtStore;
