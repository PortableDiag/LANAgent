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

    const { threshold, authorizedSigners = [] } = coordination.multisigRequirements;
    
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
        const { threshold, authorizedSigners = [] } = coordination.multisigRequirements;
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

const allowedTransitions = {
    None: new Set(['Proposed', 'Cancelled']),
    Proposed: new Set(['Ready', 'Cancelled', 'Expired']),
    Ready: new Set(['Executed', 'Cancelled', 'Expired']),
    Executed: new Set(),
    Cancelled: new Set(),
    Expired: new Set()
};

function quorumMet(coordination) {
    const requirements = coordination.multisigRequirements;
    if (!requirements || !requirements.threshold) return true;

    const authorized = new Set(requirements.authorizedSigners || []);
    const accepted = coordination.participants.filter(
        participant => participant.accepted && authorized.has(participant.address)
    ).length;

    return accepted >= requirements.threshold;
}

/**
 * Atomically transition a coordination status using optimistic concurrency.
 *
 * No multi-document transaction: production MongoDB is a standalone server
 * (transactions need a replica set). Atomicity comes from the conditional
 * findOneAndUpdate — the write only lands if status and updatedAt are still what
 * was read, so a concurrent writer makes this return null instead of clobbering.
 *
 * @param {string} intentHash - Coordination identifier
 * @param {string} nextStatus - Desired status
 * @param {{executionResults?: Array<{address: string, executionResult: object}>, session?: object}} options
 * @returns {Promise<object>} Updated coordination, or the already-applied coordination.
 */
agentCoordinationSchema.statics.transitionStatus = async function (intentHash, nextStatus, options = {}) {
    if (!intentHash) throw new Error('intentHash is required');
    if (!Object.prototype.hasOwnProperty.call(allowedTransitions, nextStatus)) {
        throw new Error(`Invalid coordination status: ${nextStatus}`);
    }

    const session = options.session;
    const findCurrent = () => {
        const q = this.findOne({ intentHash });
        return session && typeof q.session === 'function' ? q.session(session) : q;
    };

    const coordination = await findCurrent();
    if (!coordination) throw new Error('Coordination not found');

    if (coordination.status === nextStatus) return coordination;

    if (!allowedTransitions[coordination.status]?.has(nextStatus)) {
        throw new Error(`Invalid transition from ${coordination.status} to ${nextStatus}`);
    }

    if (coordination.expiry && coordination.expiry <= new Date() && nextStatus !== 'Expired') {
        throw new Error('Coordination has expired');
    }

    if (['Ready', 'Executed'].includes(nextStatus) && !quorumMet(coordination)) {
        throw new Error('Multisig quorum has not been met');
    }

    const filter = {
        intentHash,
        status: coordination.status,
        updatedAt: coordination.updatedAt
    };
    const set = { status: nextStatus };
    const arrayFilters = [];

    // arrayFilters identifiers must start with a lowercase letter and be
    // alphanumeric — an address (0x…, mixed-case checksum) cannot be embedded in
    // one, so identifiers are positional (p0, p1, …).
    (options.executionResults || []).forEach((update, i) => {
        set[`participants.$[p${i}].executionResult`] = update.executionResult;
        arrayFilters.push({ [`p${i}.address`]: update.address });
    });

    const updateOptions = { new: true };
    if (arrayFilters.length) updateOptions.arrayFilters = arrayFilters;
    if (session) updateOptions.session = session;

    const updated = await this.findOneAndUpdate(filter, { $set: set }, updateOptions);
    if (updated) {
        logger.info(`Coordination ${intentHash.slice(0, 10)}... transitioned to ${nextStatus}`);
        return updated;
    }

    // Lost the race. If the other writer already moved it where we wanted, that's success.
    const current = await findCurrent();
    if (current?.status === nextStatus) return current;
    throw new Error('Coordination changed concurrently');
};

/**
 * Transition a coordination to Ready when its quorum has been satisfied.
 * @param {string} intentHash - Coordination identifier
 * @returns {Promise<object>} Updated coordination, or the existing document when not ready.
 */
agentCoordinationSchema.statics.finalizeIfReady = async function (intentHash) {
    if (!intentHash) throw new Error('intentHash is required');

    const coordination = await this.findOne({ intentHash });
    if (!coordination) throw new Error('Coordination not found');
    if (coordination.status === 'Ready') return coordination;
    if (coordination.status !== 'Proposed') return coordination;

    if (coordination.expiry && coordination.expiry <= new Date()) {
        return this.transitionStatus(intentHash, 'Expired');
    }

    if (!quorumMet(coordination)) return coordination;
    return this.transitionStatus(intentHash, 'Ready');
};

const AgentCoordination = mongoose.model('AgentCoordination', agentCoordinationSchema);
export default AgentCoordination;
