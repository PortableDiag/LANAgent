import mongoose from 'mongoose';

const agenticCommerceJobSchema = new mongoose.Schema({
    jobId: { type: Number, required: true, unique: true },
    txHash: { type: String, default: '' },
    client: { type: String, required: true },
    provider: { type: String, required: true },
    evaluator: { type: String, default: '' },
    serviceType: { type: String, required: true },
    serviceParams: { type: Object, default: {} },
    paymentToken: { type: String, default: 'BNB' },
    budget: { type: String, default: '0' },
    budgetFormatted: { type: Number, default: 0 },
    expiredAt: { type: Date },
    status: {
        type: String,
        enum: ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'],
        default: 'Open'
    },
    mode: { type: String, enum: ['A', 'B'], default: 'A' },
    deliverableHash: { type: String, default: '' },
    deliverableType: { type: String, enum: ['file', 'json', 'ipfs', ''], default: '' },
    deliverableData: { type: Object, default: {} },
    reason: { type: String, default: '' },
    executionStarted: { type: Date },
    executionCompleted: { type: Date },
    revenueTracked: { type: Boolean, default: false },
    hookAddress: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
    priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' }
}, { timestamps: true });

agenticCommerceJobSchema.index({ client: 1 });
agenticCommerceJobSchema.index({ status: 1 });
agenticCommerceJobSchema.index({ serviceType: 1 });
agenticCommerceJobSchema.index({ createdAt: -1 });
agenticCommerceJobSchema.index({ priority: 1 });

agenticCommerceJobSchema.statics.getActiveJobs = function () {
    return this.find({ status: { $in: ['Open', 'Funded', 'Submitted'] } })
        .sort({ priority: 1, createdAt: -1 });
};

agenticCommerceJobSchema.statics.getJobHistory = function (filters = {}, limit = 50) {
    const query = {};
    if (filters.status) query.status = filters.status;
    if (filters.serviceType) query.serviceType = filters.serviceType;
    if (filters.client) query.client = filters.client;
    return this.find(query).sort({ createdAt: -1 }).limit(limit);
};

agenticCommerceJobSchema.statics.getRevenueStats = function (since) {
    const match = { status: 'Completed', revenueTracked: true };
    if (since) match.createdAt = { $gte: since };
    return this.aggregate([
        { $match: match },
        { $group: {
            _id: '$serviceType',
            count: { $sum: 1 },
            totalRevenue: { $sum: '$budgetFormatted' },
            avgRevenue: { $avg: '$budgetFormatted' }
        }}
    ]);
};

const AgenticCommerceJob = mongoose.model('AgenticCommerceJob', agenticCommerceJobSchema);
export default AgenticCommerceJob;
