import { connect } from '@lancedb/lancedb';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';

/**
 * Vector store for RAG documents. Separate from memoryVectorStore so RAG
 * docs don't pollute the memory namespace (different schema: documents have
 * arbitrary metadata, no userId/category/etc).
 *
 * Implements the interface RAGChain expects (see services/rag/ragChain.js
 * and services/rag/retriever.js):
 *   - addDocument(record)
 *   - search(queryEmbedding, k, filter)  // positional, returns rows with .similarity
 *   - deleteByFilter(filter)
 *   - getStats()
 *
 * Shares the LanceDB instance at $VECTOR_STORE_PATH (./data/lancedb by
 * default) with the memory store, but uses its own table 'rag_documents'.
 */
export class RAGVectorStore {
  constructor() {
    this.db = null;
    this.table = null;
    this.tableName = 'rag_documents';
    this.dbPath = process.env.VECTOR_STORE_PATH || './data/lancedb';
    this.initialized = false;
  }

  async initialize() {
    try {
      await fs.mkdir(this.dbPath, { recursive: true });
      this.db = await connect(this.dbPath);
      logger.info(`RAGVectorStore: Connected to LanceDB at ${this.dbPath}`);

      const tables = await this.db.tableNames();
      if (tables.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
        const count = await this.table.countRows();
        logger.info(`RAGVectorStore: Opened table '${this.tableName}' with ${count} documents`);
      } else {
        // Table created lazily on first addDocument so we can infer the
        // embedding width from the first record's vector.
        logger.info(`RAGVectorStore: Table '${this.tableName}' will be created on first document`);
      }

      this.initialized = true;
      logger.info('RAGVectorStore initialized successfully');
    } catch (err) {
      logger.error(`Failed to initialize RAGVectorStore: ${err?.message || err}`);
      throw err;
    }
  }

  /**
   * Add one document record. Expected shape (from RAGChain.storeChunks):
   *   { id, vector, content, type, source, ingestedAt, ...metadata }
   * Returns the document id.
   */
  async addDocument(record) {
    if (!this.initialized) throw new Error('RAGVectorStore not initialized');
    if (!record?.vector?.length) throw new Error('addDocument requires a non-empty vector');

    const { id, vector, content, type, source, ingestedAt, ...rest } = record;
    const row = {
      id: id || `rag_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      vector,
      content: typeof content === 'string' ? content : '',
      type: type || 'rag_document',
      source: source || '',
      ingestedAt: ingestedAt || new Date().toISOString(),
      metadata: JSON.stringify(rest)
    };

    if (!this.table) {
      this.table = await this.db.createTable(this.tableName, [row]);
    } else {
      await this.table.add([row]);
    }
    return row.id;
  }

  /**
   * Vector similarity search.
   * Matches the signature retriever.js calls: search(queryEmbedding, k, filter).
   * Returns rows with .similarity (1 - distance), .pageContent (= content),
   * and any metadata fields hoisted from the JSON blob.
   */
  async search(queryEmbedding, k = 5, filter = null) {
    if (!this.initialized || !this.table) return [];
    if (!queryEmbedding?.length) return [];

    try {
      let q = this.table.search(queryEmbedding);

      if (filter && typeof filter === 'object') {
        const clauses = [];
        for (const [field, value] of Object.entries(filter)) {
          if (value === null || value === undefined) continue;
          const esc = String(value).replace(/'/g, "''");
          // Only quote the column name when it isn't a plain lowercase
          // identifier — DataFusion treats "source" = 'x' differently from
          // source = 'x' in some builds (the quoted form ends up comparing
          // literal strings on the LHS). camelCase columns still need
          // quoting to preserve case.
          const colSql = /^[a-z][a-z0-9_]*$/.test(field) ? field : `"${field}"`;
          clauses.push(`${colSql} = '${esc}'`);
        }
        if (clauses.length) q = q.where(clauses.join(' AND '));
      }

      const rows = await q.limit(k).toArray();
      return rows.map(r => {
        const { vector, _distance, metadata, id, content, type, source, ingestedAt } = r;
        let parsed = {};
        try { parsed = metadata ? JSON.parse(metadata) : {}; } catch { /* keep empty */ }
        // Match memoryVectorStore convention: 1 - L2/cosine distance. Negative
        // similarities (very distant matches) get filtered by the retriever's
        // scoreThreshold (defaults to 0).
        const similarity = typeof _distance === 'number' ? 1 - _distance : 0;
        // Knowledge plugin's search formatter reads doc.metadata.fullContent /
        // doc.metadata.content / doc.metadata.source — nest those so existing
        // consumers work. Keep pageContent + content at top level too for any
        // direct callers.
        return {
          id,
          pageContent: content,
          content,
          similarity,
          distance: _distance,
          metadata: {
            ...parsed,
            fullContent: content,
            content,
            source,
            type,
            ingestedAt
          }
        };
      });
    } catch (err) {
      logger.warn(`RAGVectorStore search failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Delete documents matching all fields in `filter` (AND-combined).
   * Used by RAGChain when re-ingesting a source.
   */
  async deleteByFilter(filter) {
    if (!this.initialized || !this.table || !filter) return 0;

    const clauses = [];
    for (const [field, value] of Object.entries(filter)) {
      if (value === null || value === undefined) continue;
      const esc = String(value).replace(/'/g, "''");
      const colSql = /^[a-z][a-z0-9_]*$/.test(field) ? field : `"${field}"`;
      clauses.push(`${colSql} = '${esc}'`);
    }
    if (!clauses.length) return 0;

    try {
      const before = await this.table.countRows();
      await this.table.delete(clauses.join(' AND '));
      const after = await this.table.countRows();
      return before - after;
    } catch (err) {
      logger.warn(`RAGVectorStore deleteByFilter failed: ${err.message}`);
      return 0;
    }
  }

  async getStats() {
    if (!this.initialized || !this.table) {
      return { totalDocuments: 0, tableName: this.tableName, initialized: this.initialized };
    }
    try {
      const totalDocuments = await this.table.countRows();
      return { totalDocuments, tableName: this.tableName, initialized: true };
    } catch {
      return { totalDocuments: 0, tableName: this.tableName, initialized: false };
    }
  }
}

export const ragVectorStore = new RAGVectorStore();
