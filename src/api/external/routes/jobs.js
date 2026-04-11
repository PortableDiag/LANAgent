import { Router } from 'express';
import { logger } from '../../../utils/logger.js';
import agenticCommerceService from '../../../services/crypto/agenticCommerceService.js';
import rateLimit from 'express-rate-limit';

const router = Router();

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many requests, please try again later.'
});

router.use(limiter);

// --- Public Routes ---

/**
 * GET /api/external/jobs/services
 * List available services with ERC-8183 pricing
 */
router.get('/services', (req, res) => {
    try {
        const services = agenticCommerceService.getAvailableServices();
        res.json({ success: true, services });
    } catch (err) {
        logger.error(`GET /jobs/services error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Authenticated Routes (ERC-8004 or API key) ---

/**
 * POST /api/external/jobs/create
 * Create a new job (Mode A — API-initiated)
 * Body: { service, params, clientAddress }
 */
router.post('/create', async (req, res) => {
    try {
        const { service, params, clientAddress, expiryHours } = req.body;

        if (!service || !clientAddress) {
            return res.status(400).json({ success: false, error: 'Missing required fields: service, clientAddress' });
        }

        const pricing = agenticCommerceService.getServicePrice(service);
        if (!pricing) {
            return res.status(400).json({ success: false, error: `Unknown service type: ${service}` });
        }

        const result = await agenticCommerceService.createJobForClient(
            clientAddress, service, params || {}, expiryHours || 24
        );

        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`POST /jobs/create error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/jobs/:jobId
 * Get job status
 */
router.get('/:jobId', async (req, res) => {
    try {
        const jobId = parseInt(req.params.jobId);
        if (isNaN(jobId)) {
            return res.status(400).json({ success: false, error: 'Invalid job ID' });
        }

        const job = await agenticCommerceService.getJobStatus(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }

        res.json({ success: true, job });
    } catch (err) {
        logger.error(`GET /jobs/${req.params.jobId} error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/external/jobs/:jobId/fund
 * Confirm funding tx hash — triggers execution
 * Body: { txHash }
 */
router.post('/:jobId/fund', async (req, res) => {
    try {
        const jobId = parseInt(req.params.jobId);
        if (isNaN(jobId)) {
            return res.status(400).json({ success: false, error: 'Invalid job ID' });
        }

        const result = await agenticCommerceService.handleJobFunded(jobId);
        res.json({ success: true, jobId, result });
    } catch (err) {
        logger.error(`POST /jobs/${req.params.jobId}/fund error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/jobs/:jobId/deliverable
 * Get deliverable data (if completed)
 */
router.get('/:jobId/deliverable', async (req, res) => {
    try {
        const jobId = parseInt(req.params.jobId);
        const job = await agenticCommerceService.getJobStatus(jobId);

        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }
        if (job.status !== 'Completed') {
            return res.status(400).json({ success: false, error: `Job is ${job.status}, not completed` });
        }

        res.json({
            success: true,
            jobId,
            deliverableHash: job.deliverableHash,
            deliverableType: job.deliverableType,
            deliverableData: job.deliverableData
        });
    } catch (err) {
        logger.error(`GET /jobs/${req.params.jobId}/deliverable error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Admin Routes (JWT auth) ---

/**
 * GET /api/external/admin/jobs
 * All jobs dashboard
 */
router.get('/admin/all', async (req, res) => {
    try {
        const active = await agenticCommerceService.getActiveJobs();
        const history = await agenticCommerceService.getJobHistory({}, 20);
        res.json({ success: true, active, history });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/admin/jobs/stats
 * Revenue and completion statistics
 */
router.get('/admin/stats', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const stats = await agenticCommerceService.getRevenueStats(days);
        res.json({ success: true, stats, period: `${days} days` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
