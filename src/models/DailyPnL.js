import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

// 5-minute cache for aggregation/trend results keyed by query params
const pnlAggregationCache = new NodeCache({ stdTTL: 300 });

const dailyPnLSchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD
    // realizedPnL / cumulativePnL cover the TOKEN TRADER only — that is what they
    // have always meant, and every existing consumer (revenue reports, risk metrics,
    // the dashboard) reads them that way. Their meaning is deliberately left alone.
    realizedPnL: { type: Number, default: 0 },
    gasCost: { type: Number, default: 0 },
    dailyNet: { type: Number, default: 0 },    // realizedPnL - gasCost
    cumulativePnL: { type: Number, default: 0 },
    // DollarMaximizer, tracked alongside rather than folded in. Before this it had
    // no per-day record at all: its P&L existed only as a lifetime running total plus
    // a `pnlHistory` array that the agent wrote ONLY after a successful Telegram send
    // and capped at 60 days, so a failed send silently lost a day and no aggregation
    // could see DM at all. Asking "what did the agent make this month" could only be
    // answered for one of its two strategies.
    // NOTE ON MEANING: DM books a round trip on the BUY-BACK — the extra native it
    // reacquires versus what the proceeds would have bought at the sell price. A sell
    // with no buy-back yet is an OPEN leg and is deliberately not counted here; adding
    // the sell side too would double-count the same cycle.
    dmRealizedPnL: { type: Number, default: 0 },
    dmCumulativePnL: { type: Number, default: 0 },
    buyCount: { type: Number, default: 0 },
    sellCount: { type: Number, default: 0 },
    buyVolume: { type: Number, default: 0 },
    sellVolume: { type: Number, default: 0 },
    source: { type: String, enum: ['live', 'backfill'], default: 'live' }
}, { timestamps: true });

// date: unique on the field-level decl already creates the {date:1} index

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
            dmRealizedPnL: { $sum: '$dmRealizedPnL' },
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
            realizedPnL: [redacted], dmRealizedPnL: 1, gasCost: 1, dailyNet: 1,
            // Both strategies together — the figure "what did the agent make this
            // period" actually wants, and which no caller could compute before.
            combinedRealizedPnL: { $add: ['$realizedPnL', '$dmRealizedPnL'] },
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

/**
 * Risk metrics over a series of daily net PnL values (DOLLARS, not rates).
 * Pure function, exported for tests.
 *
 * Semantics for a dollar-PnL series (there is no capital base to express
 * returns as percentages against):
 *  - sharpeRatio: mean daily $PnL / sample stdDev of daily $PnL. The
 *    conventional risk-free term is omitted — subtracting a rate from a
 *    dollar amount mixes units. This is the standard "PnL Sharpe" used for
 *    trading bots.
 *  - sharpeAnnualized: sharpeRatio * sqrt(365) (crypto trades every day).
 *  - sortinoRatio: mean daily $PnL / downside deviation vs a 0-dollar
 *    target (MAR=0): sqrt(mean(min(0, r)^2)).
 *  - maxDrawdown: largest peak-to-trough fall of the cumulative $PnL curve,
 *    in dollars (a percentage against a curve that starts at $0 and can go
 *    negative is undefined).
 *  - profitFactor: gross profit / gross loss; null when there are no losing
 *    days (Infinity does not survive JSON).
 */
export function computeRiskMetrics(dailyNets) {
    const returns = (dailyNets || []).map(Number).filter(n => Number.isFinite(n));
    const count = returns.length;
    const zero = {
        sharpeRatio: 0, sharpeAnnualized: 0, sortinoRatio: 0,
        meanDaily: 0, stdDev: 0, downsideDeviation: 0,
        totalNet: 0, maxDrawdown: 0, winRate: 0, profitFactor: null, count
    };
    if (count === 0) return zero;

    const totalNet = returns.reduce((s, r) => s + r, 0);
    const meanDaily = totalNet / count;

    const stdDev = count > 1
        ? Math.sqrt(returns.reduce((s, r) => s + (r - meanDaily) ** 2, 0) / (count - 1))
        : 0;

    const downsideDeviation = Math.sqrt(
        returns.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / count
    );

    const sharpeRatio = stdDev === 0 ? 0 : meanDaily / stdDev;
    const sortinoRatio = downsideDeviation === 0 ? 0 : meanDaily / downsideDeviation;

    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const r of returns) {
        cumulative += r;
        if (cumulative > peak) peak = cumulative;
        maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    }

    const wins = returns.filter(r => r > 0);
    const losses = returns.filter(r => r < 0);
    const grossProfit = wins.reduce((s, r) => s + r, 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));

    const round = n => Number(n.toFixed(4));
    return {
        sharpeRatio: round(sharpeRatio),
        sharpeAnnualized: round(sharpeRatio * Math.sqrt(365)),
        sortinoRatio: round(sortinoRatio),
        meanDaily: round(meanDaily),
        stdDev: round(stdDev),
        downsideDeviation: round(downsideDeviation),
        totalNet: round(totalNet),
        maxDrawdown: round(maxDrawdown),
        winRate: round(wins.length / count),
        profitFactor: grossLoss === 0 ? null : round(grossProfit / grossLoss),
        count
    };
}

/**
 * Risk-adjusted performance over a date range (cached 5 min like the other
 * aggregations). Dates are YYYY-MM-DD strings — lexicographic compare is
 * chronological for this schema.
 * @param {Object} opts
 * @param {string} [opts.startDate] - YYYY-MM-DD inclusive
 * @param {string} [opts.endDate]   - YYYY-MM-DD inclusive
 */
dailyPnLSchema.statics.getRiskAdjustedPerformance = async function({ startDate, endDate } = {}) {
    const cacheKey = `risk:${startDate || ''}:${endDate || ''}`;
    const cached = pnlAggregationCache.get(cacheKey);
    if (cached) return cached;

    const match = {};
    if (startDate || endDate) {
        match.date = {};
        if (startDate) match.date.$gte = startDate;
        if (endDate) match.date.$lte = endDate;
    }

    const data = await this.find(match, { date: 1, dailyNet: 1 }).sort({ date: 1 }).lean();
    const result = {
        startDate: data[0]?.date || null,
        endDate: data[data.length - 1]?.date || null,
        ...computeRiskMetrics(data.map(d => d.dailyNet))
    };

    pnlAggregationCache.set(cacheKey, result);
    return result;
};

export default mongoose.model('DailyPnL', dailyPnLSchema);
