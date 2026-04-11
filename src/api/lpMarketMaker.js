import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import lpMarketMaker from '../services/crypto/lpMarketMaker.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60, checkperiod: 30 });
let initialized = false;

router.use(authenticateToken);

// Lazy-initialize on first request
router.use(async (req, res, next) => {
    if (!initialized) {
        try {
            await retryOperation(() => lpMarketMaker.initialize(), { retries: 3, context: 'LP MM initialize' });
            initialized = true;
        } catch (err) {
            logger.debug('LP Market Maker init on request:', err.message);
        }
    }
    next();
});

// GET /status — current status + config
router.get('/status', async (req, res) => {
    try {
        const cacheKey = 'lp_mm_status';
        const cached = cache.get(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const status = await retryOperation(() => lpMarketMaker.getStatus(), { retries: 3, context: 'LP MM getStatus' });
        cache.set(cacheKey, status);
        res.json({ success: true, data: status });
    } catch (error) {
        logger.error('LP MM status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /enable — enable with optional config overrides
router.post('/enable', async (req, res) => {
    try {
        cache.flushAll();
        const result = await retryOperation(() => lpMarketMaker.enable(req.body || {}), { retries: 3, context: 'LP MM enable' });
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('LP MM enable error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /disable — close position + disable
router.post('/disable', async (req, res) => {
    try {
        cache.flushAll();
        const result = await retryOperation(() => lpMarketMaker.disable(), { retries: 3, context: 'LP MM disable' });
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('LP MM disable error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /open — open new V3 position
router.post('/open', async (req, res) => {
    try {
        cache.flushAll();
        const result = await retryOperation(() => lpMarketMaker.openPosition(), { retries: 3, context: 'LP MM openPosition' });
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('LP MM open error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /close — close active position
router.post('/close', async (req, res) => {
    try {
        cache.flushAll();
        const result = await retryOperation(() => lpMarketMaker.closePosition(), { retries: 3, context: 'LP MM closePosition' });
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('LP MM close error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /rebalance — manually rebalance
router.post('/rebalance', async (req, res) => {
    try {
        cache.flushAll();
        const result = await retryOperation(() => lpMarketMaker.rebalancePosition(), { retries: 3, context: 'LP MM rebalancePosition' });
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('LP MM rebalance error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /collect — collect accumulated fees
router.post('/collect', async (req, res) => {
    try {
        cache.flushAll();
        const result = await retryOperation(() => lpMarketMaker.collectFees(), { retries: 3, context: 'LP MM collectFees' });
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('LP MM collect error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
