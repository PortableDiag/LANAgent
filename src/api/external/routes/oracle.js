import { Router } from 'express';
import { logger } from '../../../utils/logger.js';
import oracleAgentService from '../../../services/crypto/oracleAgentService.js';
import rateLimit from 'express-rate-limit';

const router = Router();

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many requests, please try again later.'
});

router.use(limiter);

// --- External Routes (public) ---

/**
 * GET /api/external/oracle/capabilities
 * ALICE's oracle domains and capabilities
 */
router.get('/capabilities', (req, res) => {
    res.json({ success: true, capabilities: oracleAgentService.getCapabilities() });
});

/**
 * GET /api/external/oracle/stats
 * Public win rate and participation stats
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await oracleAgentService.getStats();
        // Strip sensitive config before returning publicly
        const { config, ...publicStats } = stats;
        res.json({ success: true, ...publicStats });
    } catch (err) {
        logger.error(`Oracle route error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Admin Routes (JWT auth) ---

/**
 * GET /api/external/oracle/admin/active
 * Currently participating requests
 */
router.get('/admin/active', async (req, res) => {
    try {
        const active = await oracleAgentService.getActiveParticipations();
        res.json({ success: true, participations: active });
    } catch (err) {
        logger.error(`Oracle route error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/oracle/admin/history
 * Past participations
 */
router.get('/admin/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = await oracleAgentService.getHistory(limit);
        res.json({ success: true, history });
    } catch (err) {
        logger.error(`Oracle route error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/oracle/admin/stats
 * Full stats including config
 */
router.get('/admin/stats', async (req, res) => {
    try {
        const stats = await oracleAgentService.getStats();
        res.json({ success: true, ...stats });
    } catch (err) {
        logger.error(`Oracle route error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PUT /api/external/oracle/admin/config
 * Update risk limits, domain filters
 */
router.put('/admin/config', async (req, res) => {
    try {
        const config = await oracleAgentService.updateConfig(req.body);
        res.json({ success: true, config });
    } catch (err) {
        logger.error(`Oracle route error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/external/oracle/admin/pause
 * Pause oracle participation
 */
router.post('/admin/pause', async (req, res) => {
    try {
        await oracleAgentService.pause();
        res.json({ success: true, message: 'Oracle participation paused' });
    } catch (err) {
        logger.error(`Oracle route error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/external/oracle/admin/resume
 * Resume oracle participation
 */
router.post('/admin/resume', async (req, res) => {
    try {
        await oracleAgentService.resume();
        res.json({ success: true, message: 'Oracle participation resumed' });
    } catch (err) {
        logger.error(`Oracle route error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
