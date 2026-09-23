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

// POST /api/staking/project — calculate projected staking rewards
router.post('/project', async (req, res) => {
    try {
        const { stakeAmount, tierId, duration } = req.body;
        
        if (!stakeAmount || stakeAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid stake amount required' });
        }
        
        if (tierId === undefined || tierId < 0) {
            return res.status(400).json({ success: false, error: 'Valid tier ID required' });
        }
        
        if (!duration || duration <= 0) {
            return res.status(400).json({ success: false, error: 'Valid duration required' });
        }

        const projectedRewards = await calculateProjectedRewards(stakeAmount, tierId, duration);
        res.json({ success: true, data: projectedRewards });
    } catch (error) {
        logger.error('Failed to calculate projected rewards:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Project staking rewards from the contract's actual emission rate.
 *
 * The first version computed `rewardPool / totalStaked` as an APR. getContractStats()
 * has no `rewardPool` field, so that read undefined -> 0 and the endpoint returned a
 * projection of exactly zero for every input. Even with a pool balance it would have
 * been wrong: the remaining pool is not one year's yield, and it swings whenever the
 * pool is topped up, while the contract's own emission schedule says nothing about it.
 *
 * The service already derives APY correctly from `stakingRewardRate()`, the per-second
 * emission rate, so that is what this uses. Three things the original omitted and a
 * staker would feel:
 *
 *  - DILUTION. The projected share must count the new stake in the denominator, or the
 *    figure overstates by more the larger the stake — precisely when it matters most.
 *  - PERIOD END. Emission stops at `periodFinish`. Projecting past `timeUntilEnd`
 *    invents rewards from a period that is not funded.
 *  - The tier multiplier weights the staker's share against everyone else's, rather
 *    than multiplying the whole APR.
 *
 * @param {number} stakeAmount tokens to stake
 * @param {number} tierId lock tier
 * @param {number} duration days
 */
async function calculateProjectedRewards(stakeAmount, tierId, duration) {
    const stats = await skynetStakingService.getContractStats();
    if (!stats?.available) {
        throw new Error('Staking contract is not available');
    }

    const tiers = await skynetStakingService.getLockTiers();
    const tier = (tiers || []).find(t => t.id === tierId);
    if (!tier) {
        throw new Error(`Tier with ID ${tierId} not found`);
    }

    const principal = parseFloat(stakeAmount);
    const totalStaked = parseFloat(stats.totalStaked) || 0;
    const rewardRate = parseFloat(stats.rewardRate) || 0;
    const timeUntilEnd = Number(stats.timeUntilEnd) || 0;
    const tierMultiplier = tier.multiplier || 1;

    // Refuse rather than return zero. "The contract is not currently emitting" and
    // "you would earn nothing" are different answers, and a staker reading a projection
    // of 0 would take it as the second.
    if (rewardRate <= 0 || timeUntilEnd <= 0) {
        return {
            principal,
            projectedRewards: null,
            totalValue: null,
            apr: null,
            tierName: tier.name,
            tierMultiplier,
            duration,
            basis: 'unavailable',
            note: rewardRate <= 0
                ? 'The contract is not currently emitting rewards, so no projection can be made.'
                : 'The current reward period has ended; rewards resume only when it is refunded.'
        };
    }

    const requestedSeconds = duration * 86400;
    const accruingSeconds = Math.min(requestedSeconds, timeUntilEnd);

    // Weighted share, with this stake included in the denominator.
    const effectiveStake = principal * tierMultiplier;
    const projectedShare = effectiveStake / (totalStaked + effectiveStake);
    const projectedRewards = rewardRate * accruingSeconds * projectedShare;

    // Annualised for display, over the same weighted share.
    const secondsInYear = 365.25 * 24 * 3600;
    const apr = principal > 0
        ? (rewardRate * secondsInYear * projectedShare / principal) * 100
        : null;

    return {
        principal,
        projectedRewards: Number(projectedRewards.toFixed(6)),
        totalValue: Number((principal + projectedRewards).toFixed(6)),
        apr: apr === null ? null : Number(apr.toFixed(2)),
        tierName: tier.name,
        tierMultiplier,
        duration,
        // Say what the number rests on. A projection without its assumptions is a promise.
        basis: 'contract_emission_rate',
        assumptions: {
            currentApy: stats.apy,
            totalStakedBeforeThisStake: totalStaked,
            projectedShareOfPool: Number((projectedShare * 100).toFixed(4)),
            rewardRatePerDay: stats.rewardRatePerDay,
            rewardPeriodEnds: stats.periodFinish,
            daysRequested: duration,
            daysActuallyAccruing: Number((accruingSeconds / 86400).toFixed(2)),
            truncatedByPeriodEnd: accruingSeconds < requestedSeconds,
            note: 'Assumes the emission rate and total staked hold constant. Both move as '
                + 'others stake, unstake, or the reward period is refunded.'
        }
    };
}

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

// ── Auto-Staker Routes ───────────────────────────────────────────────────────

router.get('/auto-stake/status', async (req, res) => {
    try {
        const autoStaker = (await import('../services/crypto/skynetAutoStaker.js')).default;
        const status = await autoStaker.getStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        logger.error('Auto-stake status failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/auto-stake/run', async (req, res) => {
    try {
        const autoStaker = (await import('../services/crypto/skynetAutoStaker.js')).default;
        const result = await autoStaker.runOnce();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Auto-stake run failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/auto-stake/settings', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const { enabled, reserveFloor, minIncrement, cooldownMs, tierId } = req.body;

        if (enabled !== undefined) await SystemSettings.setSetting('skynet.autoStake.enabled', !!enabled);
        if (reserveFloor !== undefined) {
            if (reserveFloor === null || reserveFloor === 'auto') {
                await SystemSettings.setSetting('skynet.autoStake.reserveFloor', null);
            } else if (Number.isFinite(Number(reserveFloor)) && Number(reserveFloor) >= 0) {
                await SystemSettings.setSetting('skynet.autoStake.reserveFloor', Number(reserveFloor));
            }
        }
        if (minIncrement !== undefined && Number(minIncrement) >= 100) {
            await SystemSettings.setSetting('skynet.autoStake.minIncrement', Number(minIncrement));
        }
        if (cooldownMs !== undefined && Number(cooldownMs) >= 60000) {
            await SystemSettings.setSetting('skynet.autoStake.cooldownMs', Number(cooldownMs));
        }
        if (tierId !== undefined && Number.isInteger(Number(tierId)) && Number(tierId) >= 0 && Number(tierId) <= 3) {
            await SystemSettings.setSetting('skynet.autoStake.tierId', Number(tierId));
        }

        const autoStaker = (await import('../services/crypto/skynetAutoStaker.js')).default;
        const status = await autoStaker.getStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        logger.error('Auto-stake settings update failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
