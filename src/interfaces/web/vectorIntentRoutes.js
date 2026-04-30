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

// Test vector search
router.post('/search', async (req, res) => {
  try {
    const { query, k = 10, filters = null } = req.body;

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

    // Cache by deterministic hash of (query, k, filters) — same request returns
    // cached results for 5 minutes, avoiding repeated embedding+vector lookups
    const cacheKey = crypto
      .createHash('sha1')
      .update(JSON.stringify({ query, k, filters }))
      .digest('hex');
    const cached = searchCache.get(cacheKey);
    if (cached) {
      return res.json({ query, results: cached, cached: true });
    }

    // Generate query embedding
    const queryEmbedding = await retryOperation(() => embeddingService.generateEmbedding(query), { retries: 3, context: 'embeddingGeneration' });

    // Search vector store with optional filters
    const results = await retryOperation(() => vectorStore.search(queryEmbedding, k, filters), { retries: 3, context: 'vectorSearch' });

    searchCache.set(cacheKey, results);

    res.json({
      query,
      results
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