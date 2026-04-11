import mongoose from 'mongoose';

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
    executionResult: { type: Object, default: null }
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

const AgentCoordination = mongoose.model('AgentCoordination', agentCoordinationSchema);
export default AgentCoordination;
