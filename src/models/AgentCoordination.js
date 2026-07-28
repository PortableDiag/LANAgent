import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const participantSchema = new mongoose.Schema({
    address: { type: String, required: true },
    ensName: { type: String, default: '' },
    accepted: { type: Boolean, default: false },
    acceptedAt: { type: Date },
    acceptanceTxHash: { type: String, default: '' },
    executionResult: { type: Object, default: null }
}, { _id: false });

const agentCoordinationSchema = new mongoose.Schema({
    intentHash: { type: String, required: true, unique: true },
    proposer: { type: String, required: true },
    proposerENS: { type: String, default: '' },
    coordinationType: { type: String, required: true },
    coordinationTypeName: { type: String, default: '' },
    participants: [participantSchema],
    payload: {
        version: { type: String, default: '' },
        coordinationData: { type: Object, default: {} },
        conditionsHash: { type: String, default: '' }
    },
    coordinationValue: { type: String, default: '0' },
    expiry: { type: Date },
    status: {
        type: String,
        enum: ['None', 'Proposed', 'Ready', 'Executed', 'Cancelled', 'Expired'],
        default: 'None'
    },
    role: { type: String, enum: ['proposer', 'participant'], default: 'participant' },
    autoAccepted: { type: Boolean, default: false },
    proposeTxHash: { type: String, default: '' },
    executeTxHash: { type: String, default: '' },
    executionResult: { type: Object, default: null },
    multisigRequirements: {
        threshold: { type: Number, default: 1 },
        authorizedSigners: [{ type: String }]
    }
}, { timestamps: true });

agentCoordinationSchema.index({ status: 1 });
agentCoordinationSchema.index({ coordinationType: 1 });
agentCoordinationSchema.index({ proposer: 1 });
agentCoordinationSchema.index({ createdAt: -1 });

agentCoordinationSchema.statics.getActive = function () {
    return this.find({ status: { $in: ['Proposed', 'Ready'] } })
        .sort({ createdAt: -1 });
};

agentCoordinationSchema.statics.getHistory = function (filters = {}, limit = 50) {
    const query = {};
    if (filters.status) query.status = filters.status;
    if (filters.coordinationType) query.coordinationType = filters.coordinationType;
    return this.find(query).sort({ createdAt: -1 }).limit(limit);
};

/**
 * Mark multiple participants as accepted in a single coordination.
 * @param {string} intentHash - Coordination identifier
 * @param {Array<{address: string, acceptanceTxHash?: string}>} accepts
 * @returns {Promise<{matchedCount?: number, modifiedCount?: number}>}
 */
agentCoordinationSchema.statics.bulkAcceptParticipants = async function (intentHash, accepts) {
    if (!intentHash) throw new Error('intentHash is required');
    if (!Array.isArray(accepts) || accepts.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    const acceptedAt = new Date();
    const bulkOps = accepts.map(a => ({
        updateOne: {
            filter: { intentHash },
            update: {
                $set: {
                    'participants.$[p].accepted': true,
                    'participants.$[p].acceptedAt': acceptedAt,
                    ...(a.acceptanceTxHash ? { 'participants.$[p].acceptanceTxHash': a.acceptanceTxHash } : {})
                }
            },
            arrayFilters: [{ 'p.address': a.address }]
        }
    }));

    try {
        const result = await retryOperation(() => this.bulkWrite(bulkOps), { retries: 3 });
        logger.info(`bulkAcceptParticipants(${intentHash.slice(0, 10)}...): ${accepts.length} participant(s)`);
        return result;
    } catch (error) {
        logger.error('bulkAcceptParticipants failed:', error);
        throw error;
    }
};

/**
 * Update execution results for multiple participants within a single coordination.
 * @param {string} intentHash - Coordination identifier
 * @param {Array<{address: string, executionResult: object}>} updates
 * @returns {Promise<{matchedCount?: number, modifiedCount?: number}>}
 */
agentCoordinationSchema.statics.batchUpdateExecutionResults = async function (intentHash, updates) {
    if (!intentHash) throw new Error('intentHash is required');
    if (!Array.isArray(updates) || updates.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    const bulkOps = updates.map(u => ({
        updateOne: {
            filter: { intentHash },
            update: { $set: { 'participants.$[p].executionResult': u.executionResult } },
            arrayFilters: [{ 'p.address': u.address }]
        }
    }));

    try {
        const result = await retryOperation(() => this.bulkWrite(bulkOps), { retries: 3 });
        logger.info(`batchUpdateExecutionResults(${intentHash.slice(0, 10)}...): ${updates.length} participant(s)`);
        return result;
    } catch (error) {
        logger.error('batchUpdateExecutionResults failed:', error);
        throw error;
    }
};

/**
 * Validate if multisig requirements are met for a coordination
 * @param {string} intentHash - Coordination identifier
 * @returns {Promise<boolean>}
 */
agentCoordinationSchema.statics.validateMultisigCompletion = async function (intentHash) {
    if (!intentHash) throw new Error('intentHash is required');

    const coordination = await this.findOne({ intentHash });
    if (!coordination) throw new Error('Coordination not found');

    // If no multisig requirements, consider it valid
    if (!coordination.multisigRequirements || !coordination.multisigRequirements.threshold) {
        return true;
    }

    const { threshold, authorizedSigners } = coordination.multisigRequirements;
    
    // Count accepted participants who are authorized signers
    const acceptedAuthorizedParticipants = coordination.participants.filter(participant => 
        participant.accepted && authorizedSigners.includes(participant.address)
    );

    return acceptedAuthorizedParticipants.length >= threshold;
};

/**
 * Get detailed status including multisig progress
 * @param {string} intentHash - Coordination identifier
 * @returns {Promise<object>}
 */
agentCoordinationSchema.statics.getStatus = async function (intentHash) {
    if (!intentHash) throw new Error('intentHash is required');

    const coordination = await this.findOne({ intentHash });
    if (!coordination) throw new Error('Coordination not found');

    const baseStatus = {
        intentHash: coordination.intentHash,
        status: coordination.status,
        coordinationType: coordination.coordinationType,
        proposer: coordination.proposer,
        participants: coordination.participants,
        createdAt: coordination.createdAt,
        updatedAt: coordination.updatedAt
    };

    // Add multisig information if applicable
    if (coordination.multisigRequirements) {
        const { threshold, authorizedSigners } = coordination.multisigRequirements;
        const acceptedAuthorizedParticipants = coordination.participants.filter(participant => 
            participant.accepted && authorizedSigners.includes(participant.address)
        );
        
        baseStatus.multisigProgress = {
            threshold,
            authorizedSigners,
            acceptedCount: acceptedAuthorizedParticipants.length,
            requiredSigners: acceptedAuthorizedParticipants.map(p => p.address),
            isCompleted: acceptedAuthorizedParticipants.length >= threshold
        };
    }

    return baseStatus;
};

const AgentCoordination = mongoose.model('AgentCoordination', agentCoordinationSchema);
export default AgentCoordination;
