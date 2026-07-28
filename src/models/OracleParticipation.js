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

const OracleParticipation = mongoose.model('OracleParticipation', oracleParticipationSchema);
export default OracleParticipation;
