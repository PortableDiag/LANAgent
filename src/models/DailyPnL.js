import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

// 5-minute cache for aggregation/trend results keyed by query params
const pnlAggregationCache = new NodeCache({ stdTTL: 300 });

const dailyPnLSchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD
    realizedPnL: { type: Number, default: 0 },
    gasCost: { type: Number, default: 0 },
    dailyNet: { type: Number, default: 0 },    // realizedPnL - gasCost
    cumulativePnL: { type: Number, default: 0 },
    buyCount: { type: Number, default: 0 },
    sellCount: { type: Number, default: 0 },
    buyVolume: { type: Number, default: 0 },
    sellVolume: { type: Number, default: 0 },
    source: { type: String, enum: ['live', 'backfill'], default: 'live' }
}, { timestamps: true });

dailyPnLSchema.index({ date: 1 });

/**
 * Aggregate PnL across days, weeks, months, or quarters in a date range.
 * @param {Object} opts
 * @param {'daily'|'weekly'|'monthly'|'quarterly'} [opts.groupBy='daily']
 * @param {string} [opts.startDate] - YYYY-MM-DD inclusive
 * @param {string} [opts.endDate]   - YYYY-MM-DD inclusive
 */
dailyPnLSchema.statics.getAggregatedPnL = async function({ groupBy = 'daily', startDate, endDate } = {}) {
    const cacheKey = `agg:${groupBy}:${startDate || ''}:${endDate || ''}`;
    const cached = pnlAggregationCache.get(cacheKey);
    if (cached) return cached;

    const match = {};
    if (startDate || endDate) {
        match.date = {};
        if (startDate) match.date.$gte = startDate;
        if (endDate) match.date.$lte = endDate;
    }

    const dateFromString = { $dateFromString: { dateString: '$date' } };
    let groupId;
    switch (groupBy) {
        case 'weekly':
            groupId = { $dateToString: { format: '%G-W%V', date: dateFromString } };
            break;
        case 'monthly':
            groupId = { $dateToString: { format: '%Y-%m', date: dateFromString } };
            break;
        case 'quarterly':
            groupId = {
                $concat: [
                    { $dateToString: { format: '%Y', date: dateFromString } },
                    '-Q',
                    { $toString: { $ceil: { $divide: [{ $month: dateFromString }, 3] } } }
                ]
            };
            break;
        default:
            groupId = '$date';
    }

    const pipeline = [
        { $match: match },
        { $group: {
            _id: groupId,
            realizedPnL: { $sum: '$realizedPnL' },
            gasCost: { $sum: '$gasCost' },
            dailyNet: { $sum: '$dailyNet' },
            buyCount: { $sum: '$buyCount' },
            sellCount: { $sum: '$sellCount' },
            buyVolume: { $sum: '$buyVolume' },
            sellVolume: { $sum: '$sellVolume' },
            count: { $sum: 1 }
        }},
        { $project: {
            _id: 0,
            period: '$_id',
            realizedPnL: 1, gasCost: 1, dailyNet: 1,
            buyCount: 1, sellCount: 1, buyVolume: 1, sellVolume: 1, count: 1
        }},
        { $sort: { period: 1 } }
    ];

    const result = await this.aggregate(pipeline);
    pnlAggregationCache.set(cacheKey, result);
    return result;
};

/**
 * Compute a trailing moving-average trend for a single metric over the full
 * available date range. Returns one entry per day with the day's value, the
 * window's MA, and whether the day is above/below MA.
 * @param {Object} opts
 * @param {number} [opts.windowSize=7]
 * @param {'realizedPnL'|'dailyNet'|'buyVolume'|'sellVolume'|'gasCost'} [opts.metric='dailyNet']
 */
dailyPnLSchema.statics.analyzeTrends = async function({ windowSize = 7, metric = 'dailyNet' } = {}) {
    const validMetrics = ['realizedPnL', 'dailyNet', 'buyVolume', 'sellVolume', 'gasCost'];
    if (!validMetrics.includes(metric)) {
        throw new Error(`Invalid metric: ${metric}. Must be one of ${validMetrics.join(', ')}`);
    }

    const cacheKey = `trend:${windowSize}:${metric}`;
    const cached = pnlAggregationCache.get(cacheKey);
    if (cached) return cached;

    const data = await this.find({}, { date: 1, [metric]: 1 }).sort({ date: 1 }).lean();
    if (data.length < windowSize) {
        // Return what we have rather than throwing — caller can decide.
        logger.debug(`analyzeTrends: only ${data.length} points available (window=${windowSize})`);
        return [];
    }

    const results = [];
    for (let i = windowSize - 1; i < data.length; i++) {
        const window = data.slice(i - windowSize + 1, i + 1);
        const sum = window.reduce((acc, d) => acc + (Number(d[metric]) || 0), 0);
        const ma = sum / windowSize;
        const value = Number(data[i][metric]) || 0;
        const delta = ma === 0 ? 0 : ((value - ma) / Math.abs(ma)) * 100;
        results.push({
            date: data[i].date,
            value,
            movingAverage: ma,
            deltaPct: Number(delta.toFixed(2)),
            trend: value > ma ? 'up' : value < ma ? 'down' : 'flat'
        });
    }

    pnlAggregationCache.set(cacheKey, results);
    return results;
};

export default mongoose.model('DailyPnL', dailyPnLSchema);
