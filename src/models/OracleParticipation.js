import mongoose from 'mongoose';

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

const OracleParticipation = mongoose.model('OracleParticipation', oracleParticipationSchema);
export default OracleParticipation;
