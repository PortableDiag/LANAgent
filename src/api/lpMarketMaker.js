import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import lpMarketMaker from '../services/crypto/lpMarketMaker.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60, checkperiod: 30 });
let initialized = false;

// Dedicated cache for idempotency keys. Short TTL prevents unbounded growth while
// covering typical client retry windows. We namespace keys per operation to avoid
// cross-operation collisions.
const IDEMPOTENCY_TTL_SECONDS = Number(process.env.LP_MM_IDEMPOTENCY_TTL_SECONDS || 600); // default 10 minutes
const idempotencyCache = new NodeCache({ stdTTL: IDEMPOTENCY_TTL_SECONDS, checkperiod: Math.min(60, IDEMPOTENCY_TTL_SECONDS) });

/**
 * Extract an idempotency key from headers or body and build a namespaced cache key.
 * Falls back to null if not provided.
 * @param {express.Request} req
 * @param {string} operation
 * @returns {{rawKey: string|null, cacheKey: string|null}}
 */
function getIdempotencyKeys(req, operation) {
    const headerKey = req.get('Idempotency-Key') || req.get('Idempotency-key') || req.get('idempotency-key');
    const bodyKey = req.body && (req.body.idempotencyKey || req.body.idempotency_key);
    const rawKey = (headerKey || bodyKey || '').toString().trim() || null;
    return {
        rawKey,
        cacheKey: rawKey ? `lpmm:${operation}:${rawKey}` : null
    };
}

/**
 * Handle idempotent execution for mutating operations. If a key is provided and the
 * result is cached, short-circuit and return cached payload. Otherwise execute, cache,
 * and return. On error, do not cache (or invalidate if set).
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {string} operation
 * @param {() => Promise<any>} execFn
 */
async function handleIdempotentMutation(req, res, operation, execFn) {
    const { rawKey, cacheKey } = getIdempotencyKeys(req, operation);

    if (cacheKey) {
        const cached = idempotencyCache.get(cacheKey);
        if (cached) {
            logger.debug(`LP MM ${operation}: returning cached response for idempotency key`);
            return res.json(cached);
        }
    }

    try {
        // Invalidate read cache before executing any mutating operation
        cache.flushAll();

        const result = await retryOperation(() => execFn(), { retries: 3, context: `LP MM ${operation}` });

        const responsePayload = { success: true, data: result };

        if (cacheKey) {
            idempotencyCache.set(cacheKey, responsePayload);
        }

        return res.json(responsePayload);
    } catch (error) {
        logger.error(`LP MM ${operation} error:`, error);
        if (cacheKey) {
            // Ensure no stale/partial error entries remain
            idempotencyCache.del(cacheKey);
        }
        return res.status(500).json({ success: false, error: error.message });
    }
}

// Public liveness probe — must be mounted BEFORE the auth middleware so it
// can serve as an unauthenticated health check. Reports whether the LP market
// maker service can load its config (a soft signal for "the route + service
// wiring is functional"). Doesn't leak position details.
router.get('/health', async (req, res) => {
    try {
        const cfg = await lpMarketMaker.getConfig();
        res.json({
            success: true,
            enabled: !!cfg?.enabled,
            initialized
        });
    } catch (err) {
        res.status(503).json({ success: false, error: err.message });
    }
});

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
    await handleIdempotentMutation(req, res, 'enable', async () => lpMarketMaker.enable(req.body || {}));
});

// POST /disable — close position + disable
router.post('/disable', async (req, res) => {
    await handleIdempotentMutation(req, res, 'disable', async () => lpMarketMaker.disable());
});

// POST /open — open new V3 position
router.post('/open', async (req, res) => {
    await handleIdempotentMutation(req, res, 'open', async () => lpMarketMaker.openPosition());
});

// POST /close — close active position
router.post('/close', async (req, res) => {
    await handleIdempotentMutation(req, res, 'close', async () => lpMarketMaker.closePosition());
});

// POST /rebalance — manually rebalance
router.post('/rebalance', async (req, res) => {
    await handleIdempotentMutation(req, res, 'rebalance', async () => lpMarketMaker.rebalancePosition());
});

// POST /collect — collect accumulated fees
router.post('/collect', async (req, res) => {
    await handleIdempotentMutation(req, res, 'collect', async () => lpMarketMaker.collectFees());
});

// ---------------------------------------------------------------------------
// Scheduled operations (Agenda-backed; persisted across restarts)
// ---------------------------------------------------------------------------

const OPERATION_TO_JOB = {
    rebalance: 'lp-mm-rebalance',
    collect:   'lp-mm-collect',
    open:      'lp-mm-open',
    close:     'lp-mm-close'
};

const JOB_HANDLERS = {
    'lp-mm-rebalance': () => lpMarketMaker.rebalancePosition(),
    'lp-mm-collect':   () => lpMarketMaker.collectFees(),
    'lp-mm-open':      () => lpMarketMaker.openPosition(),
    'lp-mm-close':     () => lpMarketMaker.closePosition()
};

let _jobsDefined = false;
function ensureJobsDefined(agenda) {
    if (_jobsDefined) return;
    for (const [jobName, fn] of Object.entries(JOB_HANDLERS)) {
        agenda.define(jobName, async () => {
            try {
                await retryOperation(fn, { retries: 3, context: `Scheduled ${jobName}` });
                logger.info(`Scheduled job completed: ${jobName}`);
            } catch (err) {
                logger.error(`Scheduled job failed: ${jobName}: ${err.message}`);
                throw err;
            }
        });
    }
    _jobsDefined = true;
    logger.debug('LP MM Agenda jobs defined');
}

function getAgenda(req) {
    return req.app.locals.agent?.scheduler?.agenda || null;
}

// Heuristic: a "cron-like" string has at least one space and no time-zone separator.
// ISO dates, plain timestamps, and natural-language strings ("in 5 minutes") go through agenda.schedule.
function looksLikeCron(s) {
    if (typeof s !== 'string') return false;
    const trimmed = s.trim();
    // 5- or 6-field cron, no leading 'T' or timezone, no '-' (which would indicate ISO date)
    return /^[\d*/,\-?LW#]+(\s+[\d*/,\-?LW#a-zA-Z]+){4,5}$/.test(trimmed);
}

// POST /schedule — schedule a one-shot or recurring operation
//   body: { operation: 'rebalance'|'collect'|'open'|'close', when: <ISO date | 'in 5 minutes' | cron expression>, data?: {...}, idempotencyKey?: string }
router.post('/schedule', async (req, res) => {
    const { rawKey, cacheKey } = getIdempotencyKeys(req, 'schedule');
    try {
        if (cacheKey) {
            const cached = idempotencyCache.get(cacheKey);
            if (cached) {
                logger.debug('LP MM schedule: returning cached response for idempotency key');
                return res.json(cached);
            }
        }

        const { operation, when, data: jobData } = req.body || {};
        if (!operation || !when) {
            return res.status(400).json({ success: false, error: 'operation and when are required' });
        }
        const jobName = OPERATION_TO_JOB[operation];
        if (!jobName) {
            return res.status(400).json({ success: false, error: `Invalid operation. Must be one of: ${Object.keys(OPERATION_TO_JOB).join(', ')}` });
        }
        const agenda = getAgenda(req);
        if (!agenda) {
            return res.status(503).json({ success: false, error: 'Scheduler not available' });
        }
        ensureJobsDefined(agenda);

        const job = looksLikeCron(when)
            ? await agenda.every(when, jobName, jobData || {})
            : await agenda.schedule(when, jobName, jobData || {});

        const attrs = job.attrs || job;
        const payload = {
            success: true,
            data: {
                jobId: String(attrs._id),
                name: attrs.name,
                operation,
                schedule: when,
                recurring: looksLikeCron(when),
                nextRunAt: attrs.nextRunAt
            }
        };

        if (cacheKey) {
            idempotencyCache.set(cacheKey, payload);
        }

        res.json(payload);
    } catch (error) {
        logger.error('LP MM schedule error:', error);
        if (cacheKey) idempotencyCache.del(cacheKey);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /schedule — list pending lp-mm jobs
router.get('/schedule', async (req, res) => {
    try {
        const agenda = getAgenda(req);
        if (!agenda) return res.status(503).json({ success: false, error: 'Scheduler not available' });
        const jobs = await agenda.jobs({ name: { $in: Object.values(OPERATION_TO_JOB) } });
        res.json({
            success: true,
            data: jobs.map(j => ({
                jobId: String(j.attrs._id),
                name: j.attrs.name,
                nextRunAt: j.attrs.nextRunAt,
                lastRunAt: j.attrs.lastRunAt,
                lastFinishedAt: j.attrs.lastFinishedAt,
                failCount: j.attrs.failCount || 0,
                failReason: j.attrs.failReason,
                repeatInterval: j.attrs.repeatInterval || null,
                data: j.attrs.data
            }))
        });
    } catch (error) {
        logger.error('LP MM list-schedule error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /schedule/:jobId — cancel a single job
router.delete('/schedule/:jobId', async (req, res) => {
    try {
        const agenda = getAgenda(req);
        if (!agenda) return res.status(503).json({ success: false, error: 'Scheduler not available' });
        const { jobId } = req.params;
        const ObjectId = (await import('mongodb')).ObjectId;
        let filter;
        try {
            filter = { _id: new ObjectId(jobId) };
        } catch {
            return res.status(400).json({ success: false, error: 'Invalid jobId' });
        }
        const numRemoved = await agenda.cancel(filter);
        res.json({ success: true, data: { cancelled: numRemoved } });
    } catch (error) {
        logger.error('LP MM cancel-schedule error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
