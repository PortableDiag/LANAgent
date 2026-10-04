import { Router } from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import { cryptoLogger as logger } from '../utils/logger.js';
import agentCoordinationService from '../services/crypto/agentCoordinationService.js';
import AgentCoordination from '../models/AgentCoordination.js';

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
 * Coordination history with optional filters, pagination, and sorting.
 *
 * Query parameters:
 *   - status: filter by status
 *   - type: filter by coordinationType
 *   - limit: number of records per page (default 50, max 200)
 *   - offset: number of records to skip (default 0)
 *   - sortBy: field to sort by (allowed: createdAt, status, coordinationType, updatedAt; default createdAt)
 *   - sortOrder: 'asc' or 'desc' (default desc)
 */
router.get('/history', async (req, res) => {
    try {
        // Coerce to strings: a query like ?status[$ne]=x arrives as an object and would
        // otherwise be passed to Mongo as an operator.
        const filters = {};
        if (req.query.status) filters.status = String(req.query.status);
        if (req.query.type) filters.coordinationType = String(req.query.type);

        // Pagination and sorting parameters
        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 50;
        if (limit > 200) limit = 200;

        let offset = parseInt(req.query.offset, 10);
        if (isNaN(offset) || offset < 0) offset = 0;

        const allowedSortFields = ['createdAt', 'status', 'coordinationType', 'updatedAt'];
        const sortBy = allowedSortFields.includes(req.query.sortBy) ? req.query.sortBy : 'createdAt';
        const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

        // Query the database directly for efficient pagination
        const [total, history] = await Promise.all([
            AgentCoordination.countDocuments(filters),
            AgentCoordination.find(filters)
                .sort({ [sortBy]: sortOrder })
                .skip(offset)
                .limit(limit)
                .lean()
        ]);

        res.json({
            success: true,
            history,
            pagination: {
                total,
                limit,
                offset,
                sortBy,
                sortOrder: sortOrder === 1 ? 'asc' : 'desc'
            }
        });
    } catch (err) {
        logger.error('Get coordination history error:', err);
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
 * GET /api/coordination/participants/:participantId/reputation
 * Get reputation score and reliability metrics for a coordination participant
 */
router.get('/participants/:participantId/reputation', async (req, res) => {
    try {
        const { participantId } = req.params;
        const reputation = await agentCoordinationService.calculateParticipantReputation(participantId);
        res.json({ success: true, reputation });
    } catch (err) {
        logger.error('Get participant reputation error:', err);
        res.status(err.statusCode || 500).json({ success: false, error: err.message });
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
 * POST /api/coordination/validate
 * Validate a coordination intent without creating it on-chain (dry run)
 */
router.post('/validate', async (req, res) => {
    try {
        const { type, participants, payload, expiryHours } = req.body;
        if (!type || !participants?.length) {
            return res.status(400).json({ success: false, error: 'type and participants are required' });
        }
        const validation = await agentCoordinationService.validateCoordination(
            type, participants, payload || {}, expiryHours
        );
        res.json({ success: true, ...validation });
    } catch (err) {
        logger.error('Validate coordination error:', err);
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
