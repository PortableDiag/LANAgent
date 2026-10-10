import { connect } from '@lancedb/lancedb';
import { randomUUID } from 'crypto';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
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
  /** Returned by _buildFilterClause for a filter that must match no rows. */
  static NEVER_MATCH = '1 = 0';

  constructor() {
    this.db = null;
    this.table = null;
    this.tableName = 'rag_documents';
    this.dbPath = process.env.VECTOR_STORE_PATH || './data/lancedb';
    this.initialized = false;
    this.initializationPromise = null;
    this.statsCache = new NodeCache({ stdTTL: 5, checkperiod: 10 });
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = (async () => {
      try {
        await fs.mkdir(this.dbPath, { recursive: true });
        this.db = await retryOperation(
          async () => connect(this.dbPath)
        );
        logger.info(`RAGVectorStore: Connected to LanceDB at ${this.dbPath}`);

        const tables = await retryOperation(
          async () => this.db.tableNames()
        );
        if (tables.includes(this.tableName)) {
          this.table = await retryOperation(
            async () => this.db.openTable(this.tableName)
          );
          const count = await retryOperation(
            async () => this.table.countRows()
          );
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
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Normalize a document into the schema used by LanceDB.
   *
   * @param {object} record Document record to normalize.
   * @returns {object} Serialized LanceDB row.
   */
  _normalizeRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('addDocuments requires an array of document records');
    }
    if (!Array.isArray(record.vector) || !record.vector.length) {
      throw new Error('addDocuments requires every record to have a non-empty vector');
    }

    const { id, vector, content, type, source, ingestedAt, ...rest } = record;
    return {
      id: id || `rag_${Date.now()}_${randomUUID()}`,
      vector,
      content: typeof content === 'string' ? content : '',
      type: type || 'rag_document',
      source: source || '',
      ingestedAt: ingestedAt || new Date().toISOString(),
      metadata: JSON.stringify(rest)
    };
  }

  /**
   * Add multiple document records in batches.
   *
   * The first row is used to lazily create the table when it does not exist.
   * Subsequent rows are written with one LanceDB add operation per batch.
   *
   * @param {Array<object>} records Document records to add.
   * @param {object} options Batch options.
   * @param {number} [options.batchSize=100] Maximum rows per LanceDB add operation.
   * @returns {Promise<{ids: string[], count: number}>} Inserted IDs and count.
   */
  async addDocuments(records, options = {}) {
    if (!this.initialized) throw new Error('RAGVectorStore not initialized');
    if (!Array.isArray(records)) {
      throw new Error('addDocuments requires an array of document records');
    }
    if (!records.length) return { ids: [], count: 0 };

    const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
      ? options.batchSize
      : 100;
    const rows = records.map(record => this._normalizeRecord(record));
    const insertedIds = rows.map(row => row.id);
    let startIndex = 0;

    // Writes are NOT wrapped in retryOperation: an add that failed after LanceDB
    // committed it would be replayed as duplicate rows, and the common failure here
    // (vector width differs from the table's) is deterministic, so retrying only
    // adds seconds of backoff before the same error.
    if (!this.table) {
      this.table = await this.db.createTable(this.tableName, [rows[0]]);
      startIndex = 1;
    }

    for (let index = startIndex; index < rows.length; index += batchSize) {
      await this.table.add(rows.slice(index, index + batchSize));
    }

    this.statsCache.del('stats');
    return {
      ids: insertedIds,
      count: insertedIds.length
    };
  }

  /**
   * Add one document record. Expected shape (from RAGChain.storeChunks):
   *   { id, vector, content, type, source, ingestedAt, ...metadata }
   * Returns the document id.
   */
  async addDocument(record) {
    const result = await this.addDocuments([record]);
    return result.ids[0];
  }

  /**
   * Build a SQL condition clause for a single filter field.
   *
   * Supports plain equality as well as advanced operators:
   *   - $gt, $lt, $gte, $lte: numeric or string comparisons
   *   - $ne: not equal
   *   - $in: value must be an array; generates IN (...)
   *
   * Multiple operators on the same field are AND-combined.
   * Values are sanitized to prevent SQL injection.
   *
   * @param {string} field - column name
   * @param {*} value - filter value (plain or operator object)
   * @returns {string|null} SQL condition string; null when the value is
   *   null/undefined (field skipped); RAGVectorStore.NEVER_MATCH for an
   *   unsupported operator object (callers must match nothing).
   */
  _buildFilterClause(field, value) {
    if (value === null || value === undefined) return null;

    // Only quote the column name when it isn't a plain lowercase
    // identifier — DataFusion treats "source" = 'x' differently from
    // source = 'x' in some builds (the quoted form ends up comparing
    // literal strings on the LHS). camelCase columns still need
    // quoting to preserve case.
    const colSql = /^[a-z][a-z0-9_]*$/.test(field)
      ? field
      : `"${String(field).replace(/"/g, '""')}"`;

    // Every filterable column (id, content, type, source, ingestedAt) is a
    // string, so literals are quoted strings. Dates become ISO strings, which
    // is how ingestedAt is stored, so range operators compare correctly.
    const quote = (v) => {
      const s = v instanceof Date ? v.toISOString() : String(v);
      return `'${s.replace(/'/g, "''")}'`;
    };
    // Operator values: a finite number stays unquoted for callers comparing
    // numeric expressions; everything else is a quoted string.
    const operand = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : quote(v));

    // Plain value (or Date) = equality, exactly as before operators existed.
    if (typeof value !== 'object' || value instanceof Date) {
      return `${colSql} = ${quote(value)}`;
    }

    const SQL_OPS = { $gt: '>', $lt: '<', $gte: '>=', $lte: '<=', $ne: '!=' };
    const keys = Object.keys(value);

    // Fail closed: an object that isn't purely recognised operators (a typo
    // like $gtt, a nested object, an empty or non-array $in) must not be
    // dropped — dropping a clause BROADENS the match, and deleteByFilter would
    // then delete more than asked. Return the never-match sentinel instead.
    if (!keys.length || keys.some(k => k !== '$in' && !(k in SQL_OPS))) {
      logger.warn(`RAGVectorStore: unsupported filter for field "${field}" (keys: ${keys.join(', ') || 'none'}), matching nothing`);
      return RAGVectorStore.NEVER_MATCH;
    }

    const parts = [];
    for (const op of keys) {
      const opVal = value[op];
      if (opVal === null || opVal === undefined) {
        logger.warn(`RAGVectorStore: ${op} for field "${field}" has no value, matching nothing`);
        return RAGVectorStore.NEVER_MATCH;
      }
      if (op === '$in') {
        if (!Array.isArray(opVal) || opVal.length === 0) {
          logger.warn(`RAGVectorStore: $in for field "${field}" requires a non-empty array, matching nothing`);
          return RAGVectorStore.NEVER_MATCH;
        }
        parts.push(`${colSql} IN (${opVal.map(quote).join(', ')})`);
      } else {
        parts.push(`${colSql} ${SQL_OPS[op]} ${operand(opVal)}`);
      }
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
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
          const clause = this._buildFilterClause(field, value);
          if (clause === RAGVectorStore.NEVER_MATCH) return [];
          if (clause) clauses.push(clause);
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
      const clause = this._buildFilterClause(field, value);
      if (clause === RAGVectorStore.NEVER_MATCH) return 0;
      if (clause) clauses.push(clause);
    }
    if (!clauses.length) return 0;

    try {
      const before = await retryOperation(
        async () => this.table.countRows()
      );
      await retryOperation(
        async () => this.table.delete(clauses.join(' AND '))
      );
      const after = await retryOperation(
        async () => this.table.countRows()
      );
      this.statsCache.del('stats');
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

    const cachedStats = this.statsCache.get('stats');
    if (cachedStats !== undefined) return cachedStats;

    try {
      const totalDocuments = await retryOperation(
        async () => this.table.countRows()
      );
      const stats = { totalDocuments, tableName: this.tableName, initialized: true };
      this.statsCache.set('stats', stats);
      return stats;
    } catch {
      return { totalDocuments: 0, tableName: this.tableName, initialized: false };
    }
  }
}

export const ragVectorStore = new RAGVectorStore();
