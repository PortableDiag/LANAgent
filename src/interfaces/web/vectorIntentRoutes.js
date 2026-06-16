import express from 'express';
import crypto from 'crypto';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';
import { logger } from '../../utils/logger.js';
import { intentIndexer } from '../../utils/intentIndexer.js';
import { retryOperation } from '../../utils/retryUtils.js';

const router = express.Router();

// 5-minute cache for /search results keyed by (query, k, filters) hash
const searchCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Rate-limit vector intent endpoints (embedding/search are expensive)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
router.use(limiter);

// Lazy load auth middleware to avoid early environment access
let authenticateTokenMiddleware = null;

// Middleware to ensure auth is loaded before use
async function ensureAuth(req, res, next) {
  if (!authenticateTokenMiddleware) {
    try {
      const authModule = await import('./auth.js');
      authenticateTokenMiddleware = authModule.authenticateToken;
      logger.debug('Auth middleware loaded for vector intent routes');
    } catch (error) {
      logger.error('Failed to load auth middleware:', error);
      return res.status(500).json({ error: 'Authentication system not ready' });
    }
  }
  authenticateTokenMiddleware(req, res, next);
}

// Apply auth to all routes
router.use(ensureAuth);

// Index all intents
router.post('/index', async (req, res) => {
  try {
    logger.info('Starting intent indexing...');
    
    // Get agent from app locals
    const agent = req.app.locals.agent;
    if (!agent) {
      return res.status(500).json({
        error: 'Agent not available'
      });
    }
    
    // Check if vector services are initialized
    const vectorStore = agent.services.get('vectorStore');
    const embeddingService = agent.services.get('embeddingService');
    
    if (!vectorStore || !embeddingService) {
      return res.status(503).json({
        error: 'Vector services not initialized. Set ENABLE_VECTOR_INTENT=true'
      });
    }
    
    const result = await retryOperation(() => intentIndexer.indexAllIntents(agent), { retries: 3, context: 'intentIndexing' });
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Intent indexing failed:', error);
    res.status(500).json({
      error: 'Failed to index intents',
      message: error.message
    });
  }
});

// Get index stats
router.get('/stats', async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    if (!agent) {
      return res.status(500).json({
        error: 'Agent not available'
      });
    }
    
    const vectorStore = agent.services.get('vectorStore');
    if (!vectorStore) {
      return res.status(503).json({
        error: 'Vector store not initialized'
      });
    }
    
    const stats = await vectorStore.getStats();
    const indexStats = intentIndexer.getIndexStats();
    
    res.json({
      vectorStore: stats,
      indexer: indexStats
    });
  } catch (error) {
    logger.error('Failed to get stats:', error);
    res.status(500).json({
      error: 'Failed to get stats',
      message: error.message
    });
  }
});

/**
 * Apply Mongo-style metadata filters to vector-search results in JS,
 * after the underlying vectorStore.search has run.
 *
 * Why post-search (not passed into vectorStore.search):
 * - vectorStore.search's `filters` arg only supports flat equality on
 *   top-level columns (it builds a `WHERE k = v` SQL clause for LanceDB).
 *   That can't express range / set / regex / negation filters.
 * - Running rich filters in JS over the already-bounded result set (k=10
 *   typical) is cheap and works regardless of the vector backend.
 *
 * Supported per-field forms:
 *   - direct value      → equality (`{category: 'support'}`)
 *   - {$eq, $ne}        → equality / inequality
 *   - {$in, $nin}       → set membership
 *   - {$gt, $gte, $lt, $lte} → numeric comparison
 *   - {$regex, $options}     → string regex (options optional, eg 'i')
 *
 * Multiple operators on the same field AND together. Unknown operators
 * are ignored (caller-supplied junk doesn't accidentally allow-all).
 *
 * Exported for unit testing — there's no value in routing every test
 * through the express handler when the filter logic is the actual unit.
 */
export function applyMetadataFilters(results, metadataFilters) {
  if (!metadataFilters || typeof metadataFilters !== 'object' || Object.keys(metadataFilters).length === 0) {
    return results;
  }
  return results.filter(result => {
    const metadata = result.metadata || {};
    for (const [field, filterValue] of Object.entries(metadataFilters)) {
      const value = metadata[field];
      if (filterValue !== null && typeof filterValue === 'object' && !Array.isArray(filterValue)) {
        // Operator object: every operator must match (AND semantics).
        for (const [op, opVal] of Object.entries(filterValue)) {
          if (op === '$options') continue; // consumed by $regex
          if (op === '$eq')  { if (value !== opVal) return false; continue; }
          if (op === '$ne')  { if (value === opVal) return false; continue; }
          if (op === '$in')  { if (!Array.isArray(opVal) || !opVal.includes(value)) return false; continue; }
          if (op === '$nin') { if (Array.isArray(opVal) && opVal.includes(value)) return false; continue; }
          if (op === '$gt')  { if (typeof value !== 'number' || !(value >  opVal)) return false; continue; }
          if (op === '$gte') { if (typeof value !== 'number' || !(value >= opVal)) return false; continue; }
          if (op === '$lt')  { if (typeof value !== 'number' || !(value <  opVal)) return false; continue; }
          if (op === '$lte') { if (typeof value !== 'number' || !(value <= opVal)) return false; continue; }
          if (op === '$regex') {
            if (typeof value !== 'string') return false;
            try {
              const flags = typeof filterValue.$options === 'string' ? filterValue.$options : '';
              if (!new RegExp(opVal, flags).test(value)) return false;
            } catch { return false; } // bad pattern → no match (safer than allow-all)
            continue;
          }
          // Unknown operator → reject this result rather than silently
          // letting it through.
          return false;
        }
      } else {
        if (value !== filterValue) return false;
      }
    }
    return true;
  });
}

// Test vector search
router.post('/search', async (req, res) => {
  try {
    const { query, k = 10, filters = null, minSimilarity = 0, metadataFilters = null } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const agent = req.app.locals.agent;
    if (!agent) {
      return res.status(500).json({
        error: 'Agent not available'
      });
    }

    const vectorStore = agent.services.get('vectorStore');
    const embeddingService = agent.services.get('embeddingService');

    if (!vectorStore || !embeddingService) {
      return res.status(503).json({
        error: 'Vector services not initialized'
      });
    }

    // Cache by deterministic hash of (query, k, filters, minSimilarity,
    // metadataFilters). Caller-supplied JSON-stringification is stable
    // for primitive-leafed objects, which is what we accept here.
    const cacheKey = crypto
      .createHash('sha1')
      .update(JSON.stringify({ query, k, filters, minSimilarity, metadataFilters }))
      .digest('hex');
    const cached = searchCache.get(cacheKey);
    if (cached) {
      return res.json({ query, results: cached, cached: true });
    }

    // Generate query embedding
    const queryEmbedding = await retryOperation(() => embeddingService.generateEmbedding(query), { retries: 3, context: 'embeddingGeneration' });

    // Search vector store with optional flat-equality filters
    const results = await retryOperation(() => vectorStore.search(queryEmbedding, k, filters), { retries: 3, context: 'vectorSearch' });

    // vectorStore.search already returns similarity (1 - distance) per result.
    // Filter by the caller's confidence threshold.
    const threshold = Number.isFinite(minSimilarity) ? minSimilarity : 0;
    let filtered = threshold > 0
      ? results.filter(r => typeof r.similarity === 'number' && r.similarity >= threshold)
      : results;

    // Apply richer per-field metadata filters (operators, ranges, regex)
    // post-vector-search. See applyMetadataFilters for the supported forms.
    if (metadataFilters) {
      filtered = applyMetadataFilters(filtered, metadataFilters);
    }

    searchCache.set(cacheKey, filtered);

    res.json({
      query,
      minSimilarity: threshold,
      totalCandidates: results.length,
      results: filtered
    });
  } catch (error) {
    logger.error('Vector search failed:', error);
    res.status(500).json({
      error: 'Search failed',
      message: error.message
    });
  }
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'vectorIntent' });
});

export default router;