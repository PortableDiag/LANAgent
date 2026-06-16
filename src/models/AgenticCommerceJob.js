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

/**
 * Get execution performance statistics including average execution times and success rates by serviceType
 * @returns {Promise<Array>} Array of performance statistics grouped by serviceType
 */
agenticCommerceJobSchema.statics.getExecutionPerformanceStats = function () {
    return this.aggregate([
        {
            $match: {
                status: { $in: ['Completed', 'Rejected'] },
                executionStarted: { $exists: true },
                executionCompleted: { $exists: true }
            }
        },
        {
            $addFields: {
                executionTime: {
                    $subtract: ['$executionCompleted', '$executionStarted']
                }
            }
        },
        {
            $group: {
                _id: '$serviceType',
                avgExecutionTime: { $avg: '$executionTime' },
                minExecutionTime: { $min: '$executionTime' },
                maxExecutionTime: { $max: '$executionTime' },
                totalJobs: { $sum: 1 },
                successfulJobs: {
                    $sum: {
                        $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0]
                    }
                },
                successRate: {
                    $multiply: [
                        {
                            $divide: [
                                {
                                    $sum: {
                                        $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0]
                                    }
                                },
                                { $sum: 1 }
                            ]
                        },
                        100
                    ]
                }
            }
        },
        {
            $project: {
                serviceType: '$_id',
                _id: 0,
                avgExecutionTime: 1,
                minExecutionTime: 1,
                maxExecutionTime: 1,
                totalJobs: 1,
                successfulJobs: 1,
                successRate: { $round: ['$successRate', 2] }
            }
        }
    ]);
};

/**
 * Get completion trends for jobs over a specified number of days
 * @param {Object} options - Options object
 * @param {number} [options.days=30] - Number of days to analyze
 * @returns {Promise<Array>} Array of daily completion statistics
 */
agenticCommerceJobSchema.statics.getCompletionTrends = function ({ days = 30 } = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.aggregate([
        {
            $match: {
                status: { $in: ['Completed', 'Rejected'] },
                createdAt: { $gte: startDate }
            }
        },
        {
            $group: {
                _id: {
                    date: {
                        $dateToString: {
                            format: '%Y-%m-%d',
                            date: '$createdAt'
                        }
                    },
                    status: '$status'
                },
                count: { $sum: 1 }
            }
        },
        {
            $group: {
                _id: '$_id.date',
                completions: {
                    $push: {
                        status: '$_id.status',
                        count: '$count'
                    }
                },
                total: { $sum: '$count' }
            }
        },
        {
            $addFields: {
                completed: {
                    $reduce: {
                        input: {
                            $filter: {
                                input: '$completions',
                                cond: { $eq: ['$$this.status', 'Completed'] }
                            }
                        },
                        initialValue: 0,
                        in: { $add: ['$$value', '$$this.count'] }
                    }
                },
                rejected: {
                    $reduce: {
                        input: {
                            $filter: {
                                input: '$completions',
                                cond: { $eq: ['$$this.status', 'Rejected'] }
                            }
                        },
                        initialValue: 0,
                        in: { $add: ['$$value', '$$this.count'] }
                    }
                }
            }
        },
        {
            $project: {
                date: '$_id',
                _id: 0,
                completed: 1,
                rejected: 1,
                total: 1,
                completionRate: {
                    $cond: [
                        { $eq: ['$total', 0] },
                        0,
                        { $round: [{ $multiply: [{ $divide: ['$completed', '$total'] }, 100] }, 2] }
                    ]
                }
            }
        },
        {
            $sort: { date: 1 }
        }
    ]);
};

const AgenticCommerceJob = mongoose.model('AgenticCommerceJob', agenticCommerceJobSchema);
export default AgenticCommerceJob;
