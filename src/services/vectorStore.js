import { connect } from '@lancedb/lancedb';
import { logger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs/promises';

export class VectorStoreService {
  constructor() {
    this.db = null;
    this.table = null;
    this.tableName = process.env.VECTOR_STORE_COLLECTION || 'intent_embeddings';
    this.dbPath = process.env.VECTOR_STORE_PATH || './data/lancedb';
    this.initialized = false;
  }

  async initialize() {
    try {
      // Ensure the data directory exists
      await fs.mkdir(this.dbPath, { recursive: true });

      // Connect to LanceDB
      this.db = await connect(this.dbPath);
      logger.info(`Connected to LanceDB at ${this.dbPath}`);

      // Check if table exists
      const tables = await this.db.tableNames();
      
      if (tables.includes(this.tableName)) {
        // Open existing table
        this.table = await this.db.openTable(this.tableName);
        const count = await this.table.countRows();
        logger.info(`Opened existing table '${this.tableName}' with ${count} embeddings`);
      } else {
        // Table will be created on first insert
        logger.info(`Table '${this.tableName}' will be created on first intent insertion`);
      }

      this.initialized = true;
      logger.info('VectorStore service initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize VectorStore:', error);
      throw error;
    }
  }

  async addIntent(intent) {
    if (!this.initialized) {
      throw new Error('VectorStore not initialized');
    }

    try {
      const record = {
        id: intent.id,
        vector: intent.embedding,
        // Ensure all fields are properly typed
        name: intent.metadata.name || '',
        description: intent.metadata.description || '',
        // Use '_fallback' for intents without a plugin - these should trigger natural language handling
        plugin: intent.metadata.plugin || '_fallback',
        action: intent.metadata.action || '_fallback',
        category: intent.metadata.category || 'general',
        type: intent.metadata.type || 'base',
        examples: JSON.stringify(intent.metadata.examples || []),
        enabled: Boolean(intent.metadata.enabled)
      };
      
      // Create table on first insert if it doesn't exist
      if (!this.table) {
        this.table = await this.db.createTable(this.tableName, [record]);
        logger.info(`Created table '${this.tableName}' with first intent`);
      } else {
        await this.table.add([record]);
      }
      
      logger.debug(`Added intent to vector store: ${intent.id}`);
    } catch (error) {
      logger.error('Failed to add intent to vector store:', error);
      throw error;
    }
  }

  async addIntents(intents) {
    if (!this.initialized) {
      throw new Error('VectorStore not initialized');
    }

    try {
      const records = intents.map(intent => ({
        id: intent.id,
        vector: intent.embedding,
        // Ensure all fields are properly typed
        name: intent.metadata.name || '',
        description: intent.metadata.description || '',
        // Use '_fallback' for intents without a plugin - these should trigger natural language handling
        plugin: intent.metadata.plugin || '_fallback',
        action: intent.metadata.action || '_fallback',
        category: intent.metadata.category || 'general',
        type: intent.metadata.type || 'base',
        examples: JSON.stringify(intent.metadata.examples || []),
        enabled: Boolean(intent.metadata.enabled)
      }));

      // Create table on first insert if it doesn't exist
      if (!this.table) {
        this.table = await this.db.createTable(this.tableName, records);
        logger.info(`Created table '${this.tableName}' with ${records.length} intents`);
      } else {
        await this.table.add(records);
      }
      
      logger.info(`Added ${intents.length} intents to vector store`);
    } catch (error) {
      logger.error('Failed to add intents to vector store:', error);
      throw error;
    }
  }

  async search(queryEmbedding, k = 15, filter = null) {
    if (!this.initialized || !this.table) {
      throw new Error('VectorStore not initialized or empty');
    }

    try {
      logger.info(`Starting vector search with k=${k}, embedding length=${queryEmbedding.length}`);
      
      // Build the search query
      let searchQuery = this.table.search(queryEmbedding);
      
      // Add filters if provided
      if (filter) {
        // LanceDB uses SQL-like where clauses
        // Example: filter = { enabled: true, category: 'system' }
        const whereClauses = [];
        for (const [key, value] of Object.entries(filter)) {
          if (typeof value === 'string') {
            whereClauses.push(`${key} = '${value}'`);
          } else {
            whereClauses.push(`${key} = ${value}`);
          }
        }
        if (whereClauses.length > 0) {
          searchQuery = searchQuery.where(whereClauses.join(' AND '));
        }
      }
      
      // Execute search
      logger.info('Executing search query...');
      const results = await searchQuery.limit(k).toArray();
      
      // Log the raw results type for debugging
      logger.info(`Search results type: ${typeof results}, isArray: ${Array.isArray(results)}, length: ${Array.isArray(results) ? results.length : 'N/A'}`);
      if (results && !Array.isArray(results)) {
        logger.info(`Results object keys: ${Object.keys(results).join(', ')}`);
      }
      if (Array.isArray(results) && results.length > 0) {
        logger.info(`First result keys: ${Object.keys(results[0]).join(', ')}`);
      }
      
      // Transform results into our format
      const formattedResults = (Array.isArray(results) ? results : []).map(result => {
        const { vector, _distance, examples, ...metadata } = result;
        return {
          id: metadata.id,
          metadata: {
            ...metadata,
            examples: examples ? JSON.parse(examples) : []
          },
          distance: _distance,
          similarity: 1 - _distance // Convert distance to similarity
        };
      });
      
      logger.info(`Vector search returned ${formattedResults.length} results`);
      return formattedResults;
      
    } catch (error) {
      logger.error('Vector search failed:', error);
      throw error;
    }
  }

  async updateIntent(id, embedding = null, metadata = null) {
    if (!this.initialized || !this.table) {
      throw new Error('VectorStore not initialized or empty');
    }

    try {
      // LanceDB doesn't have direct update, so we need to delete and re-add
      await this.deleteIntent(id);
      
      // Get existing data if only updating partial fields
      const existing = await this.table.where(`id = '${id}'`).execute();
      if (existing.length === 0) {
        throw new Error(`Intent ${id} not found`);
      }
      
      const currentData = existing[0];
      const newRecord = {
        id,
        vector: embedding || currentData.vector,
        ...(metadata || currentData)
      };
      
      await this.table.add([newRecord]);
      logger.debug(`Updated intent in vector store: ${id}`);
      
    } catch (error) {
      logger.error('Failed to update intent:', error);
      throw error;
    }
  }

  async deleteIntent(id) {
    if (!this.initialized || !this.table) {
      throw new Error('VectorStore not initialized or empty');
    }

    try {
      // LanceDB uses SQL-like syntax for deletion
      await this.table.delete(`id = '${id}'`);
      logger.debug(`Deleted intent from vector store: ${id}`);
    } catch (error) {
      logger.error('Failed to delete intent:', error);
      throw error;
    }
  }

  async deleteIntents(ids) {
    if (!this.initialized || !this.table) {
      throw new Error('VectorStore not initialized or empty');
    }

    try {
      // Delete multiple intents
      const idList = ids.map(id => `'${id}'`).join(',');
      await this.table.delete(`id IN (${idList})`);
      logger.info(`Deleted ${ids.length} intents from vector store`);
    } catch (error) {
      logger.error('Failed to delete intents:', error);
      throw error;
    }
  }

  async clear() {
    if (!this.initialized) {
      throw new Error('VectorStore not initialized');
    }

    try {
      // Drop and recreate table
      if (this.table) {
        await this.db.dropTable(this.tableName);
        this.table = null;
        logger.info('Vector store cleared');
      }
    } catch (error) {
      logger.error('Failed to clear vector store:', error);
      throw error;
    }
  }

  async getStats() {
    if (!this.initialized) {
      throw new Error('VectorStore not initialized');
    }

    try {
      const stats = {
        totalIntents: 0,
        tableName: this.tableName,
        dbPath: this.dbPath,
        sampleIntents: []
      };
      
      if (this.table) {
        stats.totalIntents = await this.table.countRows();
        
        // Get sample intents - use a query to retrieve a few rows
        try {
          // Create a dummy vector filled with zeros for the query
          const dummyVector = new Array(1536).fill(0);
          const samples = await this.table.search(dummyVector).limit(5).toArray();
          stats.sampleIntents = samples.map(s => {
            const { vector, _distance, examples, ...metadata } = s;
            return {
              ...metadata,
              examples: examples ? JSON.parse(examples) : []
            };
          });
        } catch (e) {
          // If search doesn't work, just skip samples
          stats.sampleIntents = [];
        }
      }
      
      return stats;
    } catch (error) {
      logger.error('Failed to get vector store stats:', error);
      throw error;
    }
  }

  async close() {
    // LanceDB doesn't require explicit connection closing
    this.initialized = false;
    this.table = null;
    this.db = null;
    logger.info('VectorStore service closed');
  }
}

// Export singleton instance
export const vectorStore = new VectorStoreService();