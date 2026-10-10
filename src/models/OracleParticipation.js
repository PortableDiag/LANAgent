import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const oracleParticipationSchema = new mongoose.Schema({
    requestId: { type: Number, required: true },
    role: { type: String, enum: ['info', 'judge'], required: true },
    query: { type: String, default: '' },
    domain: { type: String, default: '' },
    status: {
        type: String,
        enum: ['monitoring', 'committed', 'revealed', 'won', 'lost', 'judged', 'expired'],
        default: 'monitoring'
    },
    answer: { type: String, default: '' },
    commitment: { type: String, default: '' },
    nonce: { type: String, default: '' },
    bondAmount: { type: String, default: '0' },
    bondToken: { type: String, default: '' },
    rewardAmount: { type: String, default: '0' },
    rewardToken: { type: String, default: '' },
    rewardEarned: { type: String, default: '0' },
    deadline: { type: Date },
    requester: { type: String, default: '' },
    numInfoAgents: { type: Number, default: 0 },
    commitTxHash: { type: String, default: '' },
    revealTxHash: { type: String, default: '' },
    aggregateTxHash: { type: String, default: '' },
    confidence: { type: Number, default: 0 },
    answerSource: { type: String, default: '' },
    revenueTracked: { type: Boolean, default: false }
}, { timestamps: true });

oracleParticipationSchema.index({ requestId: 1 }, { unique: true });
oracleParticipationSchema.index({ status: 1 });
oracleParticipationSchema.index({ role: 1 });
oracleParticipationSchema.index({ createdAt: -1 });
// Add index to optimize cleanup queries
oracleParticipationSchema.index({ status: 1, updatedAt: 1 });

oracleParticipationSchema.statics.getActive = function () {
    return this.find({ status: { $in: ['monitoring', 'committed', 'revealed'] } })
        .sort({ createdAt: -1 });
};

oracleParticipationSchema.statics.getWinRate = function () {
    return this.aggregate([
        { $match: { role: 'info', status: { $in: ['won', 'lost'] } } },
        { $group: {
            _id: null,
            total: { $sum: 1 },
            wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } }
        }},
        { $project: {
            total: 1, wins: 1,
            winRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $divide: ['$wins', '$total'] }] }
        }}
    ]);
};

oracleParticipationSchema.statics.getEarningsStats = function (since) {
    const match = { revenueTracked: true };
    if (since) match.createdAt = { $gte: since };
    return this.aggregate([
        { $match: match },
        { $group: {
            _id: '$role',
            count: { $sum: 1 },
            totalEarned: { $sum: { $toDouble: '$rewardEarned' } }
        }}
    ]);
};

/**
 * Get participation statistics grouped by time periods
 * @param {string} period - Time period grouping ('day', 'week', 'month')
 * @param {Date} since - Start date for statistics
 * @returns {Promise<Array>} Aggregated participation statistics over time
 */
oracleParticipationSchema.statics.getParticipationTrends = function (period = 'day', since) {
    const match = {};
    if (since) match.createdAt = { $gte: since };
    
    // Define date grouping based on period
    let dateFormat;
    switch (period) {
        case 'week':
            dateFormat = { $dateToString: { format: '%Y-%U', date: '$createdAt' } };
            break;
        case 'month':
            dateFormat = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
            break;
        case 'day':
        default:
            dateFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
            break;
    }

    return this.aggregate([
        { $match: match },
        { $group: {
            _id: {
                period: dateFormat,
                role: '$role'
            },
            count: { $sum: 1 },
            totalReward: { $sum: { $toDouble: '$rewardEarned' } }
        }},
        { $sort: { '_id.period': 1 } }
    ]);
};

/**
 * Get comprehensive oracle participation statistics
 * @param {Object} options - Query options
 * @param {string} options.period - Time period for trend analysis ('day', 'week', 'month')
 * @param {Date} options.since - Start date for statistics
 * @returns {Promise<Object>} Combined statistics including win rates, earnings, and participation trends
 */
oracleParticipationSchema.statics.getStatistics = async function (options = {}) {
    try {
        const [winRateResults, earningsResults, trendResults] = await Promise.all([
            this.getWinRate(),
            this.getEarningsStats(options.since),
            this.getParticipationTrends(options.period, options.since)
        ]);

        const winRate = winRateResults.length > 0 ? winRateResults[0] : { total: 0, wins: 0, winRate: 0 };
        const earnings = earningsResults.reduce((acc, item) => {
            acc[item._id] = { count: item.count, totalEarned: item.totalEarned };
            return acc;
        }, {});
        
        const trends = trendResults.reduce((acc, item) => {
            const period = item._id.period;
            if (!acc[period]) {
                acc[period] = { info: { count: 0, totalReward: 0 }, judge: { count: 0, totalReward: 0 } };
            }
            acc[period][item._id.role] = { count: item.count, totalReward: item.totalReward };
            return acc;
        }, {});

        return {
            winRate,
            earnings,
            trends
        };
    } catch (error) {
        logger.error('Failed to get oracle participation statistics', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
};

/**
 * Get performance benchmark comparing user's metrics against network averages
 * @param {string} userAddress - Address of the user to benchmark
 * @returns {Promise<Object>} Performance comparison data
 */
oracleParticipationSchema.statics.getPerformanceBenchmark = async function (userAddress) {
    try {
        // Get user-specific stats
        const userWinRateResult = await this.aggregate([
            { $match: { requester: userAddress, role: 'info', status: { $in: ['won', 'lost'] } } },
            { $group: {
                _id: null,
                total: { $sum: 1 },
                wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } }
            }},
            { $project: {
                total: 1, wins: 1,
                winRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $divide: ['$wins', '$total'] }] }
            }}
        ]);

        const userEarningsResult = await this.aggregate([
            { $match: { requester: userAddress, revenueTracked: true } },
            { $group: {
                _id: null,
                count: { $sum: 1 },
                totalEarned: { $sum: { $toDouble: '$rewardEarned' } }
            }},
            { $project: {
                count: 1,
                totalEarned: 1,
                avgReward: { $cond: [{ $eq: ['$count', 0] }, 0, { $divide: ['$totalEarned', '$count'] }] }
            }}
        ]);

        const userParticipationResult = await this.aggregate([
            { $match: { requester: userAddress } },
            { $group: {
                _id: null,
                totalCount: { $sum: 1 },
                firstParticipation: { $min: '$createdAt' }
            }}
        ]);

        // Get network-wide stats
        const networkWinRateResult = await this.getWinRate();
        const networkEarningsResult = await this.getEarningsStats();
        const networkParticipationResult = await this.aggregate([
            { $group: {
                _id: null,
                totalCount: { $sum: 1 },
                uniqueParticipants: { $addToSet: '$requester' }
            }},
            { $project: {
                totalCount: 1,
                participantCount: { $size: '$uniqueParticipants' }
            }}
        ]);

        // Per-participant activity, so the network frequency can be expressed in
        // the same unit as the user's (participations per day) rather than in
        // participations per participant. See the frequency note below.
        const perParticipant = await this.aggregate([
            { $group: {
                _id: '$requester',
                count: { $sum: 1 },
                firstParticipation: { $min: '$createdAt' }
            }}
        ]);

        // Calculate user metrics
        const userWinRate = userWinRateResult.length > 0 ? userWinRateResult[0].winRate : 0;
        const userTotalEarnings = userEarningsResult.length > 0 ? userEarningsResult[0].totalEarned : 0;
        const userAvgReward = userEarningsResult.length > 0 ? userEarningsResult[0].avgReward : 0;
        const userParticipationCount = userParticipationResult.length > 0 ? userParticipationResult[0].totalCount : 0;
        const userFirstParticipation = userParticipationResult.length > 0 ? userParticipationResult[0].firstParticipation : null;

        // Calculate network metrics
        const networkWinRate = networkWinRateResult.length > 0 ? networkWinRateResult[0].winRate : 0;
        const networkTotalEarnings = networkEarningsResult
            .reduce((sum, item) => sum + item.totalEarned, 0);
        const networkParticipationCount = networkParticipationResult.length > 0 ? 
            networkParticipationResult[0].totalCount : 0;
        const networkParticipantCount = networkParticipationResult.length > 0 ? 
            networkParticipationResult[0].participantCount : 0;
        // Average reward must use the same denominator as the user's, which counts
        // revenue-tracked participations only (getEarningsStats matches on
        // revenueTracked: true). Dividing network earnings by ALL participations
        // instead would understate the network average and make almost every user
        // look above it.
        const networkRewardedCount = networkEarningsResult
            .reduce((sum, item) => sum + (item.count || 0), 0);
        const networkAvgReward = networkRewardedCount > 0 ?
            (networkTotalEarnings / networkRewardedCount) : 0;

        // Participation frequency, in participations per day.
        //
        // Both sides must be the same unit for the comparison below to mean
        // anything. The user figure is a rate over their own active lifetime, so
        // the network figure is the AVERAGE OF THAT SAME RATE across participants
        // — not total participations per participant, which is a count and not a
        // rate at all, and would have been subtracted from a per-day value.
        const ratePerDay = (count, firstAt) => {
            if (!firstAt) return 0;
            const days = (Date.now() - new Date(firstAt).getTime()) / (1000 * 60 * 60 * 24);
            return days > 0 ? count / days : count;
        };

        const userFrequency = ratePerDay(userParticipationCount, userFirstParticipation);

        const networkFrequency = perParticipant.length > 0
            ? perParticipant.reduce((sum, p) => sum + ratePerDay(p.count, p.firstParticipation), 0) / perParticipant.length
            : 0;

        return {
            user: {
                address: userAddress,
                winRate: userWinRate,
                totalEarnings: userTotalEarnings,
                averageReward: userAvgReward,
                participationCount: userParticipationCount,
                participationFrequency: userFrequency
            },
            network: {
                winRate: networkWinRate,
                totalEarnings: networkTotalEarnings,
                averageReward: networkAvgReward,
                participationCount: networkParticipationCount,
                participantCount: networkParticipantCount,
                averageParticipationFrequency: networkFrequency
            },
            comparison: {
                winRateDifference: userWinRate - networkWinRate,
                rewardDifference: userAvgReward - networkAvgReward,
                frequencyDifference: userFrequency - networkFrequency
            }
        };
    } catch (error) {
        logger.error('Failed to get performance benchmark', {
            error: error.message,
            stack: error.stack,
            userAddress
        });
        throw error;
    }
};

/**
 * Cleanup expired oracle participations older than the retention period
 * @param {number} retentionDays - Number of days to retain expired documents (default: 30)
 * @returns {Promise<Object>} Result of the cleanup operation
 */
oracleParticipationSchema.statics.cleanupExpired = async function (retentionDays = 30) {
    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        
        logger.info(`Starting cleanup of expired oracle participations older than ${retentionDays} days`, {
            cutoffDate,
            retentionDays
        });

        const result = await retryOperation(async () => {
            return await this.deleteMany({
                status: 'expired',
                updatedAt: { $lt: cutoffDate }
            });
        }, { retries: 3 });

        logger.info(`Cleanup completed successfully`, {
            deletedCount: result.deletedCount,
            retentionDays
        });

        return {
            success: true,
            deletedCount: result.deletedCount,
            retentionDays
        };
    } catch (error) {
        logger.error('Failed to cleanup expired oracle participations', {
            error: error.message,
            stack: error.stack
        });
        
        throw error;
    }
};

/**
 * Allowed status transitions for oracle participations.
 * Maps current status to the list of statuses it can transition to.
 */
oracleParticipationSchema.statics.transitionMap = {
    monitoring: ['committed', 'expired'],
    committed: ['revealed', 'expired'],
    revealed: ['won', 'lost', 'expired'],
    won: [],
    lost: [],
    judged: [],
    expired: []
};

/**
 * Atomically transition a participation to a new status if the current status allows it.
 * Uses findOneAndUpdate with a $and condition to ensure the transition is valid.
 * Returns the updated document or null if the transition is not allowed.
 *
 * @param {number} requestId - The request ID of the participation
 * @param {string} newStatus - The target status to transition to
 * @returns {Promise<Object|null>} The updated participation document, or null if transition not allowed
 * @throws {Error} If newStatus is not a valid status enum value
 */
oracleParticipationSchema.statics.transitionStatus = async function (requestId, newStatus) {
    // Validate that newStatus is a valid status value
    if (!this.schema.path('status').enumValues.includes(newStatus)) {
        throw new Error(`Invalid status: ${newStatus}`);
    }

    // Determine which current statuses are allowed to transition to newStatus
    const allowedPrevious = Object.keys(this.transitionMap).filter(key =>
        this.transitionMap[key].includes(newStatus)
    );

    if (allowedPrevious.length === 0) {
        logger.warn(`No allowed previous statuses for transition to ${newStatus}`, { requestId });
        return null;
    }

    try {
        const updatedDoc = await retryOperation(async () => {
            return await this.findOneAndUpdate(
                {
                    requestId,
                    status: { $in: allowedPrevious }
                },
                {
                    $set: {
                        status: newStatus,
                        updatedAt: new Date()
                    }
                },
                {
                    new: true,
                    runValidators: true
                }
            );
        }, { retries: 3 });

        if (!updatedDoc) {
            logger.warn(`Status transition not allowed for request ${requestId} to ${newStatus}`, {
                requestId,
                newStatus,
                allowedPrevious
            });
        } else {
            logger.info(`Status transitioned for request ${requestId} to ${newStatus}`, {
                requestId,
                newStatus
            });
        }

        return updatedDoc;
    } catch (error) {
        logger.error(`Failed to transition status for request ${requestId} to ${newStatus}`, {
            error: error.message,
            stack: error.stack,
            requestId,
            newStatus
        });
        throw error;
    }
};

const OracleParticipation = mongoose.model('OracleParticipation', oracleParticipationSchema);
export default OracleParticipation;
