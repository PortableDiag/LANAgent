import { connect } from '@lancedb/lancedb';
import { logger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs/promises';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * Vector store service specifically for memory embeddings
 * Uses LanceDB for efficient similarity search on memory content
 */
export class MemoryVectorStore {
  constructor() {
    this.db = null;
    this.table = null;
    this.tableName = 'memory_embeddings';
    this.dbPath = process.env.VECTOR_STORE_PATH || './data/lancedb';
    this.initialized = false;
    this.similarityThreshold = 0.85; // Threshold for deduplication
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
    this.memoryBatch = [];
    this.batchSize = parseInt(process.env.BATCH_SIZE, 10) || 50;
    this.batchTimeout = parseInt(process.env.BATCH_TIMEOUT, 10) || 5000;
    this.batchTimer = null;
  }

  async initialize() {
    try {
      await fs.mkdir(this.dbPath, { recursive: true });
      this.db = await connect(this.dbPath);
      logger.info(`MemoryVectorStore: Connected to LanceDB at ${this.dbPath}`);

      const tables = await this.db.tableNames();

      if (tables.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
        const count = await this.table.countRows();
        logger.info(`MemoryVectorStore: Opened table '${this.tableName}' with ${count} memories`);
      } else {
        logger.info(`MemoryVectorStore: Table '${this.tableName}' will be created on first memory`);
      }

      this.initialized = true;
      logger.info('MemoryVectorStore initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize MemoryVectorStore:', error);
      throw error;
    }
  }

  /**
   * Add a memory to the vector store
   * @param {Object} memory - Memory object with _id, content, embedding, type, metadata
   * @returns {boolean} - True if added, false if duplicate detected
   */
  async addMemory(memory) {
    if (!this.initialized) {
      throw new Error('MemoryVectorStore not initialized');
    }

    if (!memory.embedding || memory.embedding.length === 0) {
      logger.warn('Cannot add memory without embedding');
      return false;
    }

    try {
      const record = {
        id: memory._id.toString(),
        vector: memory.embedding,
        type: memory.type || 'unknown',
        contentPreview: (memory.content || '').substring(0, 500),
        userId: memory.metadata?.userId || '',
        category: memory.metadata?.category || '',
        importance: memory.metadata?.importance || 5,
        tags: JSON.stringify(memory.metadata?.tags || []),
        createdAt: memory.createdAt?.toISOString() || new Date().toISOString()
      };

      this.memoryBatch.push(record);

      if (this.memoryBatch.length >= this.batchSize) {
        await this.flushBatch();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushBatch(), this.batchTimeout);
      }

      logger.debug(`MemoryVectorStore: Queued memory ${memory._id}`);
      return true;
    } catch (error) {
      logger.error('Failed to add memory to vector store:', error);
      throw error;
    }
  }

  /**
   * Flush the batch of memories to the database
   */
  async flushBatch() {
    if (this.memoryBatch.length === 0) {
      return;
    }

    try {
      const batch = this.memoryBatch;
      this.memoryBatch = [];
      clearTimeout(this.batchTimer);
      this.batchTimer = null;

      if (!this.table) {
        this.table = await this.db.createTable(this.tableName, batch);
        logger.info(`MemoryVectorStore: Created table with first batch of memories`);
      } else {
        await retryOperation(() => this.table.add(batch));
      }

      logger.info(`MemoryVectorStore: Flushed ${batch.length} memories to the database`);
    } catch (error) {
      logger.error('Failed to flush memory batch to vector store:', error);
      throw error;
    }
  }

  /**
   * Check if a similar memory already exists (for deduplication)
   * @param {Array<number>} embedding - The embedding to check
   * @param {number} threshold - Similarity threshold (default 0.85)
   * @returns {Object|null} - The similar memory if found, null otherwise
   */
  async findDuplicate(embedding, threshold = null) {
    if (!this.initialized || !this.table) {
      return null;
    }

    const similarityThreshold = threshold || this.similarityThreshold;

    try {
      const results = await this.table
        .search(embedding)
        .limit(1)
        .toArray();

      if (results.length > 0) {
        const similarity = 1 - results[0]._distance;
        if (similarity >= similarityThreshold) {
          logger.debug(`MemoryVectorStore: Found duplicate with similarity ${similarity.toFixed(3)}`);
          return {
            id: results[0].id,
            similarity,
            contentPreview: results[0].contentPreview
          };
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to check for duplicate:', error);
      return null;
    }
  }

  /**
   * Search for similar memories using vector similarity
   * @param {Array<number>} queryEmbedding - The query embedding
   * @param {Object} options - Search options
   * @returns {Array} - Array of similar memories with similarity scores
   */
  async search(queryEmbedding, options = {}) {
    if (!this.initialized || !this.table) {
      logger.warn('MemoryVectorStore not initialized or empty, returning empty results');
      return [];
    }

    const {
      limit = 10,
      minSimilarity = 0.5,
      type = null,
      userId = null,
      category = null
    } = options;

    try {
      let searchQuery = this.table.search(queryEmbedding);

      // Build filter conditions (quote camelCase field names for LanceDB SQL)
      const filters = [];
      if (type) filters.push(`type = '${type}'`);
      if (userId) filters.push(`"userId" = '${userId}'`);
      if (category) filters.push(`category = '${category}'`);

      if (filters.length > 0) {
        searchQuery = searchQuery.where(filters.join(' AND '));
      }

      const results = await searchQuery.limit(limit * 2).toArray(); // Get extra for filtering

      // Transform and filter results
      const formattedResults = results
        .map(result => {
          const { vector, _distance, tags, ...data } = result;
          return {
            id: data.id,
            type: data.type,
            contentPreview: data.contentPreview,
            userId: data.userId,
            category: data.category,
            importance: data.importance,
            tags: tags ? JSON.parse(tags) : [],
            createdAt: data.createdAt,
            distance: _distance,
            similarity: 1 - _distance
          };
        })
        .filter(r => r.similarity >= minSimilarity)
        .slice(0, limit);

      logger.debug(`MemoryVectorStore: Search returned ${formattedResults.length} results`);
      return formattedResults;

    } catch (error) {
      logger.error('MemoryVectorStore search failed:', error);
      return [];
    }
  }

  /**
   * Delete a memory from the vector store
   * @param {string} memoryId - The MongoDB _id of the memory
   */
  async deleteMemory(memoryId) {
    if (!this.initialized || !this.table) {
      return;
    }

    try {
      await this.table.delete(`id = '${memoryId}'`);
      logger.debug(`MemoryVectorStore: Deleted memory ${memoryId}`);
    } catch (error) {
      logger.error('Failed to delete memory from vector store:', error);
    }
  }

  /**
   * Delete multiple memories
   * @param {Array<string>} memoryIds - Array of memory IDs
   */
  async deleteMemories(memoryIds) {
    if (!this.initialized || !this.table || memoryIds.length === 0) {
      return;
    }

    try {
      const idList = memoryIds.map(id => `'${id}'`).join(',');
      await this.table.delete(`id IN (${idList})`);
      logger.info(`MemoryVectorStore: Deleted ${memoryIds.length} memories`);
    } catch (error) {
      logger.error('Failed to delete memories from vector store:', error);
    }
  }

  /**
   * Rebuild the index from MongoDB memories
   * @param {Function} getMemoriesWithEmbeddings - Function to fetch memories from MongoDB
   */
  async rebuildIndex(getMemoriesWithEmbeddings) {
    if (!this.initialized) {
      throw new Error('MemoryVectorStore not initialized');
    }

    try {
      logger.info('MemoryVectorStore: Starting index rebuild...');

      // Clear existing table
      if (this.table) {
        await this.db.dropTable(this.tableName);
        this.table = null;
      }

      // Get all memories with embeddings
      const memories = await getMemoriesWithEmbeddings();

      if (memories.length === 0) {
        logger.info('MemoryVectorStore: No memories with embeddings to index');
        return { indexed: 0 };
      }

      // Add in batches
      const batchSize = 100;
      let indexed = 0;

      for (let i = 0; i < memories.length; i += batchSize) {
        const batch = memories.slice(i, i + batchSize);
        const records = batch.map(m => ({
          id: m._id.toString(),
          vector: m.embedding,
          type: m.type || 'unknown',
          contentPreview: (m.content || '').substring(0, 500),
          userId: m.metadata?.userId || '',
          category: m.metadata?.category || '',
          importance: m.metadata?.importance || 5,
          tags: JSON.stringify(m.metadata?.tags || []),
          createdAt: m.createdAt?.toISOString() || new Date().toISOString()
        }));

        if (!this.table) {
          this.table = await this.db.createTable(this.tableName, records);
        } else {
          await this.table.add(records);
        }

        indexed += batch.length;
        logger.info(`MemoryVectorStore: Indexed ${indexed}/${memories.length} memories`);
      }

      logger.info(`MemoryVectorStore: Index rebuild complete. Indexed ${indexed} memories`);
      return { indexed };

    } catch (error) {
      logger.error('Failed to rebuild memory vector index:', error);
      throw error;
    }
  }

  /**
   * Get statistics about the vector store
   */
  async getStats() {
    if (!this.initialized) {
      return { initialized: false };
    }

    try {
      const stats = {
        initialized: true,
        tableName: this.tableName,
        totalMemories: 0,
        byType: {}
      };

      if (this.table) {
        stats.totalMemories = await this.table.countRows();
      }

      return stats;
    } catch (error) {
      logger.error('Failed to get memory vector store stats:', error);
      return { initialized: true, error: error.message };
    }
  }

  async close() {
    this.initialized = false;
    this.table = null;
    this.db = null;
    logger.info('MemoryVectorStore closed');
  }
}

// Export singleton instance
export const memoryVectorStore = new MemoryVectorStore();