import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const trustAttestationSchema = new mongoose.Schema({
    trustorNode: { type: String, required: true },
    trustorName: { type: String, default: '' },
    trusteeNode: { type: String, required: true },
    trusteeName: { type: String, default: '' },
    level: {
        type: String,
        enum: ['Unknown', 'None', 'Marginal', 'Full'],
        default: 'Unknown'
    },
    scope: { type: String, default: '0x0000000000000000000000000000000000000000000000000000000000000000' },
    scopeName: { type: String, default: 'universal' },
    expiry: { type: Date, default: null },
    nonce: { type: Number, default: 0 },
    txHash: { type: String, default: '' },
    reasonCode: { type: String, default: '' },
    source: {
        type: String,
        enum: ['manual', 'p2p-auto', 'scammer-sync', 'job-completion'],
        default: 'manual'
    },
    jobCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 }
}, { timestamps: true });

trustAttestationSchema.index({ trustorNode: 1, trusteeNode: 1, scope: 1 }, { unique: true });
trustAttestationSchema.index({ trusteeNode: 1 });
trustAttestationSchema.index({ level: 1 });
trustAttestationSchema.index({ source: 1 });

const cache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

trustAttestationSchema.statics.getTrustLevel = async function (trustorNode, trusteeNode, scope) {
    const query = { trustorNode, trusteeNode };
    if (scope) query.scope = scope;

    const cacheKey = `trustLevel:${trustorNode}:${trusteeNode}:${scope || 'default'}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
        return cachedResult;
    }

    try {
        const result = await retryOperation(() => this.findOne(query).sort({ updatedAt: -1 }), { retries: 3 });
        cache.set(cacheKey, result);
        return result;
    } catch (error) {
        logger.error('Error fetching trust level:', error);
        throw error;
    }
};

trustAttestationSchema.statics.getTrustGraph = async function () {
    try {
        return await retryOperation(() => this.find({ level: { $ne: 'Unknown' } })
            .select('trustorName trusteeName level scopeName source')
            .sort({ updatedAt: -1 }), { retries: 3 });
    } catch (error) {
        logger.error('Error fetching trust graph:', error);
        throw error;
    }
};

trustAttestationSchema.statics.getBySource = async function (source, limit = 50) {
    try {
        return await retryOperation(() => this.find({ source }).sort({ updatedAt: -1 }).limit(limit), { retries: 3 });
    } catch (error) {
        logger.error('Error fetching attestations by source:', error);
        throw error;
    }
};

/**
 * Get distribution of trust levels across all attestations
 * @returns {Promise<Object>} Object with trust level counts
 */
trustAttestationSchema.statics.getTrustLevelDistribution = async function () {
    try {
        const results = await retryOperation(() =>
            this.aggregate([
                {
                    $group: {
                        _id: "$level",
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        level: "$_id",
                        count: 1
                    }
                }
            ]), { retries: 3 }
        );

        // Convert array to object for easier consumption
        const distribution = {};
        results.forEach(item => {
            distribution[item.level] = item.count;
        });

        return distribution;
    } catch (error) {
        logger.error('Error fetching trust level distribution:', error);
        throw error;
    }
};

/**
 * Get trust trends over time
 * @param {number} hours - Number of hours to look back (default: 24)
 * @returns {Promise<Array>} Array of trust level changes over time
 */
trustAttestationSchema.statics.getTrustTrends = async function (hours = 24) {
    try {
        const since = new Date(Date.now() - (hours * 60 * 60 * 1000));

        const results = await retryOperation(() =>
            this.aggregate([
                {
                    $match: {
                        createdAt: { $gte: since }
                    }
                },
                {
                    $project: {
                        hour: { $dateToString: { format: "%Y-%m-%d %H:00", date: "$createdAt" } },
                        level: 1
                    }
                },
                {
                    $group: {
                        _id: {
                            hour: "$hour",
                            level: "$level"
                        },
                        count: { $sum: 1 }
                    }
                },
                {
                    $sort: {
                        "_id.hour": 1,
                        "_id.level": 1
                    }
                },
                {
                    $group: {
                        _id: "$_id.hour",
                        levels: {
                            $push: {
                                level: "$_id.level",
                                count: "$count"
                            }
                        }
                    }
                },
                {
                    $sort: {
                        "_id": 1
                    }
                },
                {
                    $project: {
                        _id: 0,
                        hour: "$_id",
                        levels: 1
                    }
                }
            ]), { retries: 3 }
        );

        return results;
    } catch (error) {
        logger.error('Error fetching trust trends:', error);
        throw error;
    }
};

/**
 * Get top trustors by number of attestations issued
 * @param {number} limit - Maximum number of trustors to return (default: 10)
 * @returns {Promise<Array>} Array of top trustors
 */
trustAttestationSchema.statics.getTopTrustors = async function (limit = 10) {
    try {
        const results = await retryOperation(() =>
            this.aggregate([
                {
                    $group: {
                        _id: {
                            trustorNode: "$trustorNode",
                            trustorName: "$trustorName"
                        },
                        count: { $sum: 1 }
                    }
                },
                {
                    $sort: {
                        count: -1
                    }
                },
                {
                    $limit: limit
                },
                {
                    $project: {
                        _id: 0,
                        trustorNode: "$_id.trustorNode",
                        trustorName: "$_id.trustorName",
                        count: 1
                    }
                }
            ]), { retries: 3 }
        );

        return results;
    } catch (error) {
        logger.error('Error fetching top trustors:', error);
        throw error;
    }
};

const TrustAttestation = mongoose.model('TrustAttestation', trustAttestationSchema);
export default TrustAttestation;
