import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import skynetStakingService from '../services/crypto/skynetStakingService.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60, checkperiod: 30 });
let initialized = false;

router.use(authenticateToken);

// Lazy-initialize staking service on first request
router.use(async (req, res, next) => {
    if (!initialized) {
        try {
            await skynetStakingService.initialize();
            initialized = true;
        } catch (err) {
            logger.debug('Staking service init on request:', err.message);
        }
    }
    next();
});

function getCached(key) {
    return cache.get(key);
}

function setCache(key, data) {
    cache.set(key, data);
}

// GET /api/staking/info — current user's stake position
router.get('/info', async (req, res) => {
    try {
        const cacheKey = 'staking_info';
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const info = await skynetStakingService.getFullStakeInfo();
        if (info.available) setCache(cacheKey, info);
        res.json({ success: true, data: info });
    } catch (error) {
        logger.error('Failed to get staking info:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/staking/stats — contract-wide stats
router.get('/stats', async (req, res) => {
    try {
        const cacheKey = 'staking_stats';
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const stats = await skynetStakingService.getContractStats();
        if (stats.available) setCache(cacheKey, stats);
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Failed to get staking stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/staking/stake — stake SKYNET tokens with optional lock tier
router.post('/stake', async (req, res) => {
    try {
        const { amount, tierId } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid amount required' });
        }
        const result = await skynetStakingService.stake(amount, tierId || 0);
        cache.del('staking_info');
        cache.del('staking_stats');
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to stake:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/staking/tiers — available lock tiers
router.get('/tiers', async (req, res) => {
    try {
        const cacheKey = 'staking_tiers';
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const tiers = await skynetStakingService.getLockTiers();
        if (tiers.length > 0) setCache(cacheKey, tiers);
        res.json({ success: true, data: tiers });
    } catch (error) {
        logger.error('Failed to get lock tiers:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/staking/unstake — unstake SKYNET tokens
router.post('/unstake', async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid amount required' });
        }
        const result = await skynetStakingService.unstake(amount);
        cache.del('staking_info');
        cache.del('staking_stats');
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to unstake:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/staking/claim — claim pending rewards
router.post('/claim', async (req, res) => {
    try {
        // Get pending amount before claiming
        const info = await skynetStakingService.getStakeInfo();
        const pendingAmount = info.pendingRewards || 0;

        const result = await skynetStakingService.claimRewards();
        cache.del('staking_info');

        // Log to historical transactions
        try {
            const mongoose = (await import('mongoose')).default;
            const HistoricalTransaction = mongoose.model('HistoricalTransaction');
            await new HistoricalTransaction({
                transactionType: 'stakingClaim',
                category: 'staking',
                amount: pendingAmount,
                txHash: result.txHash,
                network: 'bsc',
                description: `Manual claim: ${pendingAmount.toFixed(2)} SKYNET staking rewards`
            }).save();
        } catch { /* non-critical */ }

        res.json({ success: true, data: { ...result, claimedAmount: pendingAmount } });
    } catch (error) {
        logger.error('Failed to claim rewards:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/staking/fund — fund reward epoch (owner only)
router.post('/fund', async (req, res) => {
    try {
        const { amount, duration } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid amount required' });
        }
        const result = await skynetStakingService.fundRewards(amount, duration);
        cache.del('staking_info');
        cache.del('staking_stats');
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to fund rewards:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/staking/history — staking transaction history
router.get('/history', async (req, res) => {
    try {
        const cacheKey = 'staking_history';
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        // Pull staking-related transactions from ledger history
        let history = [];
        try {
            const SkynetTokenLedger = (await import('../models/SkynetTokenLedger.js')).default;
            const limit = parseInt(req.query.limit) || 50;
            history = await SkynetTokenLedger.getHistoricalTransactions({
                category: 'staking',
            });
            // Also include stakingClaim/stakingFund and fee routing transactions
            const mongoose = (await import('mongoose')).default;
            const HistoricalTransaction = mongoose.model('HistoricalTransaction');
            history = await HistoricalTransaction.find({
                $or: [
                    { category: 'staking' },
                    { transactionType: { $in: ['stakingClaim', 'stakingFund', 'feeDebit'] } }
                ]
            }).sort({ date: -1 }).limit(limit).lean();
        } catch (err) {
            logger.debug('Staking history query:', err.message);
        }

        setCache(cacheKey, history);
        res.json({ success: true, data: history });
    } catch (error) {
        logger.error('Failed to get staking history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/staking/fee-routing — get fee-to-staking routing settings and fee balance
router.get('/fee-routing', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const SkynetTokenLedger = (await import('../models/SkynetTokenLedger.js')).default;
        const [enabled, threshold, percent, duration, feeBalance] = await Promise.all([
            SystemSettings.getSetting('crypto.stakingFeeRouting', true),
            SystemSettings.getSetting('crypto.stakingFeeThreshold', 500000),
            SystemSettings.getSetting('crypto.stakingFeePercent', 100),
            SystemSettings.getSetting('crypto.stakingEpochDuration', 604800),
            SkynetTokenLedger.getRegistryFeeBalance()
        ]);
        res.json({
            success: true,
            data: { enabled, threshold, percent, epochDuration: duration, feeBalance }
        });
    } catch (error) {
        logger.error('Failed to get fee routing settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/staking/fee-routing — update fee-to-staking routing settings
router.post('/fee-routing', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const { enabled, threshold, percent, epochDuration } = req.body;

        if (enabled !== undefined) await SystemSettings.setSetting('crypto.stakingFeeRouting', !!enabled);
        if (threshold !== undefined && threshold > 0) await SystemSettings.setSetting('crypto.stakingFeeThreshold', Number(threshold));
        if (percent !== undefined && percent > 0 && percent <= 100) await SystemSettings.setSetting('crypto.stakingFeePercent', Number(percent));
        if (epochDuration !== undefined && epochDuration >= 86400) await SystemSettings.setSetting('crypto.stakingEpochDuration', Number(epochDuration));

        const settings = {
            enabled: await SystemSettings.getSetting('crypto.stakingFeeRouting', true),
            threshold: await SystemSettings.getSetting('crypto.stakingFeeThreshold', 500000),
            percent: await SystemSettings.getSetting('crypto.stakingFeePercent', 100),
            epochDuration: await SystemSettings.getSetting('crypto.stakingEpochDuration', 604800)
        };
        res.json({ success: true, data: settings });
    } catch (error) {
        logger.error('Failed to update fee routing settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── LP Staking Routes ────────────────────────────────────────────────────────

router.get('/lp/info', async (req, res) => {
    try {
        const cacheKey = 'lp_staking_info';
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const info = await skynetStakingService.getLPStakeInfo();
        if (info.available) setCache(cacheKey, info);
        res.json({ success: true, data: info });
    } catch (error) {
        logger.error('Failed to get LP staking info:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/lp/tiers', async (req, res) => {
    try {
        const cacheKey = 'lp_staking_tiers';
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const tiers = await skynetStakingService.getLPStakingTiers();
        if (tiers.length > 0) setCache(cacheKey, tiers);
        res.json({ success: true, data: tiers });
    } catch (error) {
        logger.error('Failed to get LP lock tiers:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lp/stake', async (req, res) => {
    try {
        const { amount, tierId } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid amount required' });
        }
        const result = await skynetStakingService.stakeLP(amount, tierId || 0);
        cache.del('lp_staking_info');
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to stake LP:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lp/unstake', async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid amount required' });
        }
        const result = await skynetStakingService.unstakeLP(amount);
        cache.del('lp_staking_info');
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to unstake LP:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lp/claim', async (req, res) => {
    try {
        const result = await skynetStakingService.claimLPRewards();
        cache.del('lp_staking_info');
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to claim LP rewards:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Treasury Pool Views ──────────────────────────────────────────────────────

router.get('/treasury', async (req, res) => {
    try {
        const pools = await skynetStakingService.getTreasuryPools();
        res.json({ success: true, data: pools });
    } catch (error) {
        logger.error('Failed to get treasury pools:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Vault ───────────────────────────────────────────────────────────────────

router.get('/vault/stats', async (req, res) => {
    try {
        const stats = await skynetStakingService.getVaultStats();
        if (!stats) return res.json({ success: false, error: 'Vault not configured' });
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/vault/compound', async (req, res) => {
    try {
        const result = await skynetStakingService.vaultCompound();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/vault/compound-lp', async (req, res) => {
    try {
        const result = await skynetStakingService.vaultCompoundLP();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/vault/address', async (req, res) => {
    try {
        const address = await skynetStakingService.getVaultAddress();
        res.json({ success: true, data: { address } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
