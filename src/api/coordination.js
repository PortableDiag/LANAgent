import { Router } from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import { cryptoLogger as logger } from '../utils/logger.js';
import agentCoordinationService from '../services/crypto/agentCoordinationService.js';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/coordination/types
 * Available coordination types
 */
router.get('/types', (req, res) => {
    res.json({ success: true, types: agentCoordinationService.getCoordinationTypes() });
});

/**
 * GET /api/coordination/active
 * Active coordination intents
 */
router.get('/active', async (req, res) => {
    try {
        const intents = await agentCoordinationService.getActiveIntents();
        res.json({ success: true, intents });
    } catch (err) {
        logger.error('Get active intents error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/coordination/history
 * Coordination history with optional filters
 */
router.get('/history', async (req, res) => {
    try {
        const filters = {};
        if (req.query.status) filters.status = req.query.status;
        if (req.query.type) filters.coordinationType = req.query.type;
        const history = await agentCoordinationService.getHistory(filters);
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/coordination/stats
 * Coordination statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await agentCoordinationService.getStats();
        res.json({ success: true, ...stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/coordination/propose
 * Propose a new coordination intent
 */
router.post('/propose', async (req, res) => {
    try {
        const { type, participants, payload, expiryHours } = req.body;
        if (!type || !participants?.length) {
            return res.status(400).json({ success: false, error: 'type and participants are required' });
        }
        const result = await agentCoordinationService.proposeCoordination(
            type, participants, payload || {}, expiryHours
        );
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error('Propose coordination error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/coordination/:intentHash/accept
 * Accept a coordination intent
 */
router.post('/:intentHash/accept', async (req, res) => {
    try {
        const { conditions } = req.body;
        const result = await agentCoordinationService.acceptCoordination(
            req.params.intentHash, conditions
        );
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error('Accept coordination error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/coordination/:intentHash/execute
 * Execute a ready coordination
 */
router.post('/:intentHash/execute', async (req, res) => {
    try {
        const result = await agentCoordinationService.executeCoordination(req.params.intentHash);
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error('Execute coordination error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/coordination/:intentHash/cancel
 * Cancel a coordination intent
 */
router.post('/:intentHash/cancel', async (req, res) => {
    try {
        const { reason } = req.body;
        const result = await agentCoordinationService.cancelCoordination(
            req.params.intentHash, reason
        );
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error('Cancel coordination error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
