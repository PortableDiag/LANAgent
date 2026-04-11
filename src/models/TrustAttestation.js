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

const TrustAttestation = mongoose.model('TrustAttestation', trustAttestationSchema);
export default TrustAttestation;
