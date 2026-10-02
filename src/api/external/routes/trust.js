import { Router } from 'express';
import { logger } from '../../../utils/logger.js';
import trustRegistryService from '../../../services/crypto/trustRegistryService.js';
import TrustAttestation from '../../../models/TrustAttestation.js';
import rateLimit from 'express-rate-limit';

const router = Router();

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many requests, please try again later.'
});

// Each entry is one on-chain read; keep a batch small so one rate-limited
// request cannot fan out into hundreds of RPC calls.
const MAX_BATCH_SIZE = 20;
const BATCH_CONCURRENCY = 5;
// Scope names the trust registry understands (see SCOPES in trustRegistryService).
const BATCH_SCOPES = new Set(['universal', 'commerce', 'p2p', 'oracle', 'network']);

router.use(limiter);

// --- External Routes (public / ERC-8004 auth) ---

/**
 * POST /api/external/trust/batch/level
 * Check trust levels for multiple agents with bounded concurrency.
 * Body: { agents: [{ agent, scope? }] } or { agents: ['agent1.eth', 'agent2.eth'] }
 */
router.post('/batch/level', async (req, res) => {
    const agents = req.body?.agents;

    if (!Array.isArray(agents)) {
        return res.status(400).json({
            success: false,
            error: 'agents must be an array'
        });
    }

    if (agents.length === 0 || agents.length > MAX_BATCH_SIZE) {
        return res.status(400).json({
            success: false,
            error: `agents must contain between 1 and ${MAX_BATCH_SIZE} entries`
        });
    }

    const results = new Array(agents.length);
    let nextIndex = 0;

    const resolveEntry = async (entry, index) => {
        let agent;
        let scope = 'universal';

        if (typeof entry === 'string') {
            agent = entry;
        } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            agent = entry.agent;
            if (entry.scope !== undefined && entry.scope !== null) {
                scope = entry.scope;
            }
        }

        if (typeof agent !== 'string' || !agent.trim()) {
            results[index] = {
                success: false,
                agent: agent ?? null,
                scope,
                error: 'Each entry must contain a non-empty agent identifier'
            };
            return;
        }

        if (typeof scope !== 'string') {
            results[index] = {
                success: false,
                agent,
                scope: 'universal',
                error: 'scope must be a string when provided'
            };
            return;
        }

        scope = scope.trim().toLowerCase() || 'universal';
        agent = agent.trim();

        if (!BATCH_SCOPES.has(scope)) {
            results[index] = {
                success: false,
                agent,
                scope,
                error: `Unknown scope; expected one of: ${[...BATCH_SCOPES].join(', ')}`
            };
            return;
        }

        try {
            const level = await trustRegistryService.getTrustLevel(agent, scope);
            results[index] = {
                success: true,
                agent,
                level,
                scope
            };
        } catch (err) {
            logger.error(`POST /trust/batch/level entry error for ${agent}: ${err.message}`);
            results[index] = {
                success: false,
                agent,
                scope,
                error: err.message
            };
        }
    };

    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= agents.length) {
                return;
            }

            await resolveEntry(agents[index], index);
        }
    };

    const workerCount = Math.min(BATCH_CONCURRENCY, agents.length);
    await Promise.all(
        Array.from({ length: workerCount }, () => worker())
    );

    res.json({ success: true, results });
});

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

/**
 * GET /api/external/trust/level/stats
 * Aggregate distribution of trust levels (and sources) across attestations.
 */
router.get('/level/stats', async (req, res) => {
    try {
        const stats = await trustRegistryService.getTrustStats();
        res.json({ success: true, stats });
    } catch (err) {
        logger.error(`GET /trust/level/stats error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/trust/analytics/revocations
 * Get trust revocation analytics including reasons, frequency over time, and top revoking entities
 */
router.get('/analytics/revocations', async (req, res) => {
    try {
        const analytics = await TrustAttestation.getRevocationAnalytics();
        res.json({ success: true, analytics });
    } catch (err) {
        logger.error(`GET /trust/analytics/revocations error: ${err.message}`);
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

/**
 * GET /api/external/trust/analytics/distribution
 * Distribution of trust levels across all attestations
 */
router.get('/analytics/distribution', async (req, res) => {
    try {
        const distribution = await TrustAttestation.getTrustLevelDistribution();
        res.json({ success: true, distribution });
    } catch (err) {
        logger.error(`GET /trust/analytics/distribution error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/trust/analytics/trends?hours=24
 * Trust attestation trends over time, bucketed hourly
 */
router.get('/analytics/trends', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const trends = await TrustAttestation.getTrustTrends(hours);
        res.json({ success: true, trends });
    } catch (err) {
        logger.error(`GET /trust/analytics/trends error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/external/trust/analytics/top-trustors?limit=10
 * Top trustors by number of attestations issued
 */
router.get('/analytics/top-trustors', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const topTrustors = await TrustAttestation.getTopTrustors(limit);
        res.json({ success: true, topTrustors });
    } catch (err) {
        logger.error(`GET /trust/analytics/top-trustors error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
