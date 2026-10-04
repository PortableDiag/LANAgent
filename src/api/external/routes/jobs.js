import { Router } from 'express';
import path from 'path';
import { logger } from '../../../utils/logger.js';
import agenticCommerceService from '../../../services/crypto/agenticCommerceService.js';
import { adminKeyAuth } from '../middleware/adminKeyAuth.js';
import rateLimit from 'express-rate-limit';

/**
 * Paid on-chain jobs (agenticCommerceService). The client creates and funds the job on-chain
 * from its own wallet; this agent never spends gas on a request. Every route that leads to
 * work re-verifies the job on-chain, so nothing a caller claims is taken on trust.
 */
const router = Router();

// The job handlers run the agent's plugins; give the service the agent on every request.
router.use((req, res, next) => {
    agenticCommerceService.setAgent(req.app.locals.agent);
    next();
});

router.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { success: false, error: 'Too many requests, please try again later.' }
}));

// Requests through api.lanagent.net all arrive from the gateway's address, so this is an
// agent-wide ceiling; the gateway limits each client.
const quoteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    message: { success: false, error: 'Too many quotes, please try again later.' }
});

const MAX_BATCH_SIZE = 50;

const jobIdOf = (req) => {
    const id = Number(req.params.jobId);
    return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * POST /api/external/jobs/batch/status
 * Body: { jobIds: [1, 2, 3] }
 * Returns public status data for up to 50 distinct jobs without exposing deliverables.
 */
const batchStatus = async (req, res) => {
    const { jobIds } = req.body || {};

    if (!Array.isArray(jobIds) || jobIds.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'jobIds must be a non-empty array of positive integer IDs',
            errorCode: 'invalid_job_ids'
        });
    }

    if (jobIds.length > MAX_BATCH_SIZE) {
        return res.status(400).json({
            success: false,
            error: `A maximum of ${MAX_BATCH_SIZE} job IDs is allowed per request`,
            errorCode: 'batch_too_large'
        });
    }

    if (jobIds.some((jobId) => !Number.isInteger(jobId) || jobId <= 0)) {
        return res.status(400).json({
            success: false,
            error: 'jobIds must contain only positive integer IDs',
            errorCode: 'invalid_job_ids'
        });
    }

    const uniqueJobIds = [...new Set(jobIds)];

    // One database read for the whole batch, never a chain call per id (see getJobStatuses).
    let found;
    try {
        found = await agenticCommerceService.getJobStatuses(uniqueJobIds);
    } catch (err) {
        logger.warn(`POST /jobs/batch/status lookup failed: ${err.message}`);
        return res.status(500).json({ success: false, error: 'Status lookup failed', errorCode: 'status_lookup_failed' });
    }

    const results = uniqueJobIds.map((jobId) => found.has(jobId)
        ? { jobId, status: 'found', job: found.get(jobId) }
        : {
            jobId,
            status: 'not_found',
            error: 'job_not_found',
            errorCode: 'job_not_found',
            hint: `Not a job this agent has accepted. GET /api/external/jobs/${jobId} also checks the chain.`
        });

    return res.json({ success: true, results });
};

// Keep the batch route before the parameterized job route.
router.post('/batch/status', batchStatus);

// --- Public ---

router.get('/health', (req, res) => {
    res.json({ success: true, status: 'ok', enabled: agenticCommerceService._initialized, timestamp: new Date().toISOString() });
});

/** GET /api/external/jobs/services — services and prices (BNB) */
router.get('/services', (req, res) => {
    res.json({
        success: true,
        enabled: agenticCommerceService._initialized,
        contract: agenticCommerceService.contractAddress,
        provider: agenticCommerceService.providerAddress,
        services: agenticCommerceService.getAvailableServices()
    });
});

/**
 * POST /api/external/jobs/create  (alias: /quote)
 * Body: { service, params, clientAddress? }
 * Returns the createJob/fundJob calls to make on-chain. Stores the params, spends nothing.
 */
const quote = async (req, res) => {
    try {
        const { service, params, clientAddress } = req.body || {};
        if (!service) return res.status(400).json({ success: false, error: 'Missing required field: service' });
        const result = await agenticCommerceService.quoteJob(service, params || {}, clientAddress);
        res.json({ success: true, ...result });
    } catch (err) {
        const disabled = /not enabled/.test(err.message);
        res.status(disabled ? 503 : 400).json({ success: false, error: err.message });
    }
};
router.post('/create', quoteLimiter, quote);
router.post('/quote', quoteLimiter, quote);

/** GET /api/external/jobs/:jobId — public status (never the deliverable) */
router.get('/:jobId', async (req, res) => {
    try {
        const jobId = jobIdOf(req);
        if (!jobId) return res.status(400).json({ success: false, error: 'Invalid job ID' });
        const job = await agenticCommerceService.getJobStatus(jobId);
        if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
        res.json({ success: true, job });
    } catch (err) {
        logger.error(`GET /jobs/${req.params.jobId} error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Status lookup failed' });
    }
});

/**
 * POST /api/external/jobs/:jobId/fund
 * "I funded it": starts the on-chain check now instead of at the next poll. Answers at once;
 * the job is verified on-chain before any work or gas.
 */
router.post('/:jobId/fund', async (req, res) => {
    const jobId = jobIdOf(req);
    if (!jobId) return res.status(400).json({ success: false, error: 'Invalid job ID' });
    if (!agenticCommerceService._initialized) return res.status(503).json({ success: false, error: 'Paid jobs are not enabled on this agent' });
    agenticCommerceService.processFundedJob(jobId, { source: 'api' })
        .then(r => logger.info(`Job #${jobId} fund notice: ${r.status}${r.reason ? ` (${r.reason})` : ''}`))
        .catch(err => logger.warn(`Job #${jobId} fund notice failed: ${err.message}`));
    res.status(202).json({ success: true, jobId, status: 'checking', poll: `/api/external/jobs/${jobId}` });
});

async function requireClient(req, res) {
    const jobId = jobIdOf(req);
    if (!jobId) { res.status(400).json({ success: false, error: 'Invalid job ID' }); return null; }
    const signature = req.query.signature || req.headers['x-job-signature'];
    if (!(await agenticCommerceService.verifyClientSignature(jobId, signature))) {
        res.status(403).json({ success: false, error: `Sign "LANAgent job ${jobId} deliverable" with the wallet that created the job and pass it as ?signature=` });
        return null;
    }
    return jobId;
}

/** GET /api/external/jobs/:jobId/deliverable?signature=… — the result, for the job's client only */
router.get('/:jobId/deliverable', async (req, res) => {
    try {
        const jobId = await requireClient(req, res);
        if (!jobId) return;
        const d = await agenticCommerceService.getDeliverable(jobId);
        if (!d) return res.status(400).json({ success: false, error: 'Job is not completed' });
        res.json({ success: true, ...d });
    } catch (err) {
        logger.error(`GET /jobs/${req.params.jobId}/deliverable error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Deliverable lookup failed' });
    }
});

/** GET /api/external/jobs/:jobId/file/:index?signature=… — a file deliverable, for the job's client only */
router.get('/:jobId/file/:index', async (req, res) => {
    try {
        const jobId = await requireClient(req, res);
        if (!jobId) return;
        const file = await agenticCommerceService.getDeliverableFile(jobId, req.params.index);
        if (!file) return res.status(404).json({ success: false, error: 'No such file (or the job is not completed)' });
        res.download(path.resolve(file.path), file.name, (err) => {
            if (err && !res.headersSent) res.status(410).json({ success: false, error: 'The file is no longer available' });
        });
    } catch (err) {
        logger.error(`GET /jobs/${req.params.jobId}/file error: ${err.message}`);
        res.status(500).json({ success: false, error: 'File lookup failed' });
    }
});

// --- Operator (X-Admin-Key) ---

router.get('/admin/all', adminKeyAuth, async (req, res) => {
    try {
        const active = await agenticCommerceService.getActiveJobs();
        const history = await agenticCommerceService.getJobHistory({}, 20);
        res.json({ success: true, active, history });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/admin/stats', adminKeyAuth, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        res.json({ success: true, stats: await agenticCommerceService.getRevenueStats(days), period: `${days} days` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/admin/performance', adminKeyAuth, async (req, res) => {
    try {
        res.json({ success: true, stats: await agenticCommerceService.getExecutionPerformanceStats() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/admin/trends', adminKeyAuth, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        res.json({ success: true, trends: await agenticCommerceService.getCompletionTrends(days), period: `${days} days` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
