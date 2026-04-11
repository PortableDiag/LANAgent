import { Router } from 'express';
import { logger } from '../../../utils/logger.js';
import trustRegistryService from '../../../services/crypto/trustRegistryService.js';
import rateLimit from 'express-rate-limit';

const router = Router();

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many requests, please try again later.'
});

router.use(limiter);

// --- External Routes (public / ERC-8004 auth) ---

/**
 * GET /api/external/trust/level?agent=name.eth
 * Check trust level for an agent
 */
router.get('/level', async (req, res) => {
    try {
        const { agent, scope } = req.query;
        if (!agent) {
            return res.status(400).json({ success: false, error: 'Missing agent parameter' });
        }

        const level = await trustRegistryService.getTrustLevel(agent);
        res.json({ success: true, agent, level, scope: scope || 'universal' });
    } catch (err) {
        logger.error(`GET /trust/level error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/trust/path?from=a.eth&to=b.eth
 * Find trust path between two agents
 */
router.get('/path', async (req, res) => {
    try {
        const { from, to, scope, maxDepth } = req.query;
        if (!from || !to) {
            return res.status(400).json({ success: false, error: 'Missing from/to parameters' });
        }

        const result = await trustRegistryService.findTrustPath(
            from, to, parseInt(maxDepth) || 5, scope || 'universal'
        );

        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`GET /trust/path error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/external/trust/attest
 * Submit trust attestation (signed)
 * Body: { trusteeENS, level, scope, expiryDays }
 */
router.post('/attest', async (req, res) => {
    try {
        const { trusteeENS, level, scope, expiryDays } = req.body;
        if (!trusteeENS || !level) {
            return res.status(400).json({ success: false, error: 'Missing trusteeENS or level' });
        }

        const result = await trustRegistryService.setTrust(
            trusteeENS, level, scope || 'universal', expiryDays || 0
        );

        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`POST /trust/attest error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Admin Routes (JWT auth) ---

/**
 * GET /api/external/trust/admin/graph
 * Full trust graph for dashboard
 */
router.get('/admin/graph', async (req, res) => {
    try {
        const graph = await trustRegistryService.getTrustGraph();
        res.json({ success: true, graph });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/external/trust/admin/set
 * Manually set trust for an agent
 */
router.post('/admin/set', async (req, res) => {
    try {
        const { trusteeENS, level, scope, expiryDays } = req.body;
        const result = await trustRegistryService.setTrust(
            trusteeENS, level, scope || 'universal', expiryDays || 0
        );
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/external/trust/admin/revoke
 * Manually revoke trust
 */
router.post('/admin/revoke', async (req, res) => {
    try {
        const { trusteeENS, scope, reason } = req.body;
        const result = await trustRegistryService.revokeTrust(
            trusteeENS, scope || 'universal', reason || 'manual'
        );
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/trust/admin/stats
 * Trust graph statistics
 */
router.get('/admin/stats', async (req, res) => {
    try {
        const stats = await trustRegistryService.getTrustStats();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
