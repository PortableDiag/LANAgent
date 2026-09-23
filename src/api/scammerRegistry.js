import express from 'express';
import { ethers } from 'ethers';
import compression from 'compression';
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
router.use(compression());

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

const MAX_BATCH_SCREEN = 50;

/**
 * Screen one address against the registry.
 *
 * Single source of truth for /check/:address and /batch-screen — both used to
 * carry their own copy of the isScammer + getReport pair.
 *
 * Results are memoised in the module cache (flushed by every write route), so
 * a batch containing repeats, or a repeat of a recent batch, does not re-issue
 * the on-chain reads.
 *
 * @param {string} address
 * @returns {Promise<{address: string, flagged: boolean, riskLevel: string, report?: object}>}
 */
async function screenAddress(address) {
    if (typeof address !== 'string' || !ethers.isAddress(address)) {
        const err = new Error(`Invalid address: ${address}`);
        err.statusCode = 400;
        throw err;
    }

    const key = `screen_${address.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const flagged = await scammerRegistryService.isScammer(address);
    let result;

    if (flagged) {
        const report = await scammerRegistryService.getReport(address);
        result = {
            address,
            flagged: true,
            // An inactive (revoked) report is a flag the chain no longer stands behind.
            riskLevel: report?.active === false ? 'cleared' : 'high',
            category: report?.category ?? null,
            categoryName: report?.categoryName ?? 'Unknown',
            report
        };
    } else {
        result = { address, flagged: false, riskLevel: 'low', category: null, categoryName: null };
    }

    cache.set(key, result);
    return result;
}

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
        const result = await screenAddress(req.params.address);
        res.json({ success: true, data: result });
    } catch (error) {
        if (error.statusCode === 400) {
            return res.status(400).json({ success: false, error: error.message });
        }
        logger.error('Failed to check address:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/scammer-registry/immunity/:address
router.get('/immunity/:address', async (req, res) => {
    try {
        // Validate before any on-chain read — an unchecked string reaches a contract
        // call, and a typo used to come back as a clean answer rather than an error.
        if (!ethers.isAddress(req.params.address)) {
            return res.status(400).json({ success: false, error: 'Invalid address' });
        }
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

// GET /api/scammer-registry/report-history/:address
router.get('/report-history/:address', async (req, res) => {
    try {
        const { address } = req.params;
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ success: false, error: 'Invalid address' });
        }
        const reportHistory = await scammerRegistryService.getReportHistory(address);
        res.json({ success: true, data: reportHistory });
    } catch (error) {
        logger.error('Failed to fetch report history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/scammer-registry/batch-screen
 *
 * Screen up to MAX_BATCH_SCREEN addresses in one call. Addresses are validated
 * up front and the whole batch is rejected if any entry is malformed, so a typo
 * cannot silently produce a "not flagged" verdict for an address that was never
 * actually looked up.
 *
 * Body: { addresses: string[] }
 */
router.post('/batch-screen', async (req, res) => {
    try {
        const { addresses } = req.body;

        if (!Array.isArray(addresses) || addresses.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Addresses array required with at least one address'
            });
        }

        if (addresses.length > MAX_BATCH_SCREEN) {
            return res.status(400).json({
                success: false,
                error: `Maximum ${MAX_BATCH_SCREEN} addresses allowed per batch`
            });
        }

        const invalid = addresses.filter(a => typeof a !== 'string' || !ethers.isAddress(a));
        if (invalid.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Invalid address(es): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` (+${invalid.length - 5} more)` : ''}`
            });
        }

        const results = [];
        let failed = 0;

        // Bounded concurrency: the reads go on-chain, so do not fan out the
        // whole batch at once.
        const chunkSize = 10;
        for (let i = 0; i < addresses.length; i += chunkSize) {
            const chunk = addresses.slice(i, i + chunkSize);
            const chunkResults = await Promise.all(chunk.map(async (address) => {
                try {
                    return await screenAddress(address);
                } catch (err) {
                    logger.error(`Error screening address ${address}:`, err);
                    failed++;
                    // 'unknown' is NOT a clean bill of health — the caller must
                    // be able to tell a miss from a real "not flagged".
                    return { address, flagged: null, riskLevel: 'unknown', error: err.message };
                }
            }));
            results.push(...chunkResults);
        }

        res.json({
            success: true,
            data: {
                total: addresses.length,
                screened: results.length - failed,
                failed,
                flagged: results.filter(r => r.flagged === true).length,
                results
            }
        });
    } catch (error) {
        logger.error('Failed to batch screen addresses:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export { screenAddress, MAX_BATCH_SCREEN };
export default router;
