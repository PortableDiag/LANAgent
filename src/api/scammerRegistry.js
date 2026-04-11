import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import scammerRegistryService from '../services/crypto/scammerRegistryService.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
let initialized = false;

// Rate limiter to prevent abuse of on-chain lookups
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

router.use(authenticateToken);
router.use(limiter);

router.use(async (req, res, next) => {
    if (!initialized) {
        try {
            await scammerRegistryService.initialize();
            initialized = true;
        } catch (err) {
            logger.debug('Scammer registry init on request:', err.message);
        }
    }
    next();
});

// GET /api/scammer-registry/stats
router.get('/stats', async (req, res) => {
    try {
        const cached = cache.get('registry_stats');
        if (cached) return res.json({ success: true, data: cached });

        const stats = await scammerRegistryService.getStats();
        cache.set('registry_stats', stats);
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Failed to get registry stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/scammer-registry/check/:address
router.get('/check/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const flagged = await scammerRegistryService.isScammer(address);
        const result = { address, flagged };
        if (flagged) {
            result.report = await scammerRegistryService.getReport(address);
        }
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to check address:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/scammer-registry/immunity/:address
router.get('/immunity/:address', async (req, res) => {
    try {
        const immune = await scammerRegistryService.checkImmunity(req.params.address);
        res.json({ success: true, data: { address: req.params.address, immune } });
    } catch (error) {
        logger.error('Failed to check immunity:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/scammer-registry/list
router.get('/list', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const cached = cache.get(`registry_list_${limit}`);
        if (cached) return res.json({ success: true, data: cached });

        const list = await scammerRegistryService.listScammers(limit);
        cache.set(`registry_list_${limit}`, list);
        res.json({ success: true, data: list });
    } catch (error) {
        logger.error('Failed to list scammers:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/scammer-registry/categories
router.get('/categories', (req, res) => {
    res.json({ success: true, data: scammerRegistryService.getCategories() });
});

// GET /api/scammer-registry/cache-stats
router.get('/cache-stats', (req, res) => {
    res.json({ success: true, data: scammerRegistryService.getCacheStats() });
});

// POST /api/scammer-registry/report
router.post('/report', async (req, res) => {
    try {
        const { address, category, evidenceTxHash, reason } = req.body;
        if (!address) return res.status(400).json({ success: false, error: 'Address required' });
        if (!category) return res.status(400).json({ success: false, error: 'Category required (1-7)' });

        const result = await scammerRegistryService.reportScammer(address, category, evidenceTxHash, reason);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to report scammer:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/scammer-registry/batch-report
router.post('/batch-report', async (req, res) => {
    try {
        const { reports } = req.body;
        if (!reports || !Array.isArray(reports) || reports.length === 0) {
            return res.status(400).json({ success: false, error: 'Reports array required' });
        }
        const result = await scammerRegistryService.batchReportScammer(reports);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to batch report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/scammer-registry/remove
router.post('/remove', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ success: false, error: 'Address required' });
        const result = await scammerRegistryService.removeScammer(address);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to remove scammer:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/scammer-registry/set-fee
router.post('/set-fee', async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Valid amount required' });
        const result = await scammerRegistryService.setReportFee(amount);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to set fee:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/scammer-registry/set-immunity-threshold
router.post('/set-immunity-threshold', async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Valid amount required' });
        const result = await scammerRegistryService.setImmunityThreshold(amount);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to set threshold:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
