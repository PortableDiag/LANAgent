import mongoose from 'mongoose';

/**
 * One record per SELL fill, with the reason it fired and what the price did afterwards.
 *
 * Written because the question "is the trailing stop earning its keep, or is it selling
 * lows into chop?" could not be answered on 2026-08-22: crypto.log retains ~32h with no
 * rotation, cryptowallets.transactions is capped at 100 entries, and dailypnls stores
 * daily aggregates. NONE of them record WHY an exit fired. Every proposal to retune the
 * stop was therefore guesswork dressed up as a fix.
 *
 * The outcome horizons are the whole point. A stop that exits at X is vindicated if price
 * keeps falling and indicted if price recovers above X shortly after — and only a
 * post-exit price sample can tell those apart. Horizons are stamped lazily by
 * backfillExitHorizons() off the price the heartbeat already fetches; nothing new is polled.
 */
const cryptoExitRecordSchema = new mongoose.Schema({
    date: { type: String, required: true, index: true },   // YYYY-MM-DD
    exitedAt: { type: Date, required: true, index: true },

    tokenSymbol: { type: String, required: true, index: true },
    tokenAddress: { type: String },
    network: { type: String },

    // WHY it fired. `trigger` is the classified bucket used for aggregation; `reason` is
    // the raw human string, kept verbatim so a future question we have not thought of yet
    // is still answerable without another migration.
    trigger: {
        type: String,
        required: true,
        index: true,
        enum: ['trailing_stop', 'downtrend_exit', 'stop_loss', 'tranche_scalp',
               'scale_out', 'grid_sell', 'emergency', 'dump', 'other']
    },
    reason: { type: String },

    // The fill.
    exitPrice: { type: Number, required: true },
    tokensSold: { type: Number },
    proceeds: { type: Number },
    pnl: { type: Number },
    gasCostUsd: { type: Number, default: 0 },

    // Position context AT the moment of exit, captured before recordSell mutates state.
    avgEntryAtExit: { type: Number },
    peakPriceAtExit: { type: Number },
    trailingStopAtExit: { type: Number },
    regimeAtExit: { type: String },
    tokensRemainingAfter: { type: Number },
    fullExit: { type: Boolean, default: false },

    // What the price did next. null until the horizon elapses and a tick stamps it.
    priceAfter1h: { type: Number, default: null },
    priceAfter4h: { type: Number, default: null },
    priceAfter24h: { type: Number, default: null },
    // WHEN each sample was actually taken. The backfill stamps the price of the first tick
    // AFTER a horizon elapses, which is within ~10min for a live record but can be hours
    // late for a backlogged one — on 2026-08-22 two records were stamped at 11:09 for a 1h
    // horizon that fell at 09:26, so the "1h" column held a 2h43m price. Without the sample
    // time that error is invisible and silently poisons the average.
    priceAfter1hAt: { type: Date, default: null },
    priceAfter4hAt: { type: Date, default: null },
    priceAfter24hAt: { type: Date, default: null },
    horizonsComplete: { type: Boolean, default: false, index: true }
}, { timestamps: true });

cryptoExitRecordSchema.index({ tokenSymbol: 1, trigger: 1, exitedAt: -1 });

/**
 * Was the exit right? Positive = the exit beat holding (price fell after), negative = the
 * exit sold a low that recovered. Expressed in percent of the exit price so exits of
 * different sizes and prices are comparable.
 */
const HORIZON_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '24h': 24 * 3600e3 };
// A sample taken far past its horizon measures a different question than the one asked.
// Allow the horizon + 50%, floored at 20min of slack for the short window.
function sampleIsHonest(rec, horizon) {
    const want = HORIZON_MS[horizon];
    if (!want) return false;
    const at = rec[`priceAfter${horizon}At`];
    if (!at) return true;   // pre-existing rows without a sample time: trust, cannot verify
    const lag = new Date(at).getTime() - new Date(rec.exitedAt).getTime();
    return lag <= want + Math.max(want * 0.5, 20 * 60e3);
}

cryptoExitRecordSchema.methods.edgeAt = function (horizon) {
    const after = this[`priceAfter${horizon}`];
    if (!(after > 0) || !(this.exitPrice > 0)) return null;
    if (!sampleIsHonest(this, horizon)) return null;
    return ((this.exitPrice - after) / this.exitPrice) * 100;
};

/**
 * Aggregate exit quality by trigger. This is the report the retune decision needs:
 * for each trigger, how often it fired, what it booked, and whether price was lower
 * (vindicated) or higher (whipsawed) at each horizon.
 */
cryptoExitRecordSchema.statics.analyzeByTrigger = async function (opts = {}) {
    const q = {};
    if (opts.tokenSymbol) q.tokenSymbol = opts.tokenSymbol;
    if (opts.since) q.exitedAt = { $gte: new Date(opts.since) };

    const rows = await this.find(q).lean();
    const byTrigger = {};

    for (const r of rows) {
        const t = r.trigger || 'other';
        const b = byTrigger[t] || (byTrigger[t] = {
            trigger: t, fills: 0, totalPnl: 0, gas: 0, wins: 0, losses: 0,
            horizons: { '1h': { n: 0, vindicated: 0, edgeSum: 0, stale: 0 },
                        '4h': { n: 0, vindicated: 0, edgeSum: 0, stale: 0 },
                        '24h': { n: 0, vindicated: 0, edgeSum: 0, stale: 0 } }
        });
        b.fills++;
        b.totalPnl += r.pnl || 0;
        b.gas += r.gasCostUsd || 0;
        if ((r.pnl || 0) > 0) b.wins++; else if ((r.pnl || 0) < 0) b.losses++;

        for (const h of ['1h', '4h', '24h']) {
            const after = r[`priceAfter${h}`];
            if (!(after > 0) || !(r.exitPrice > 0)) continue;
            // Drop samples taken so late they answer a different question.
            if (!sampleIsHonest(r, h)) { b.horizons[h].stale++; continue; }
            const edge = ((r.exitPrice - after) / r.exitPrice) * 100;
            const slot = b.horizons[h];
            slot.n++;
            slot.edgeSum += edge;
            if (edge > 0) slot.vindicated++;   // price fell after the exit → selling was right
        }
    }

    return Object.values(byTrigger).map(b => ({
        trigger: b.trigger,
        fills: b.fills,
        totalPnl: parseFloat(b.totalPnl.toFixed(4)),
        avgPnl: parseFloat((b.totalPnl / b.fills).toFixed(4)),
        gas: parseFloat(b.gas.toFixed(4)),
        wins: b.wins,
        losses: b.losses,
        horizons: Object.fromEntries(Object.entries(b.horizons).map(([h, s]) => [h, {
            sampled: s.n,
            staleDropped: s.stale,
            // % of exits where price was LOWER later — the exit avoided a further fall
            vindicatedPct: s.n ? parseFloat(((s.vindicated / s.n) * 100).toFixed(1)) : null,
            // mean % better/worse than holding. Negative = the exit sold lows that recovered.
            avgEdgePct: s.n ? parseFloat((s.edgeSum / s.n).toFixed(3)) : null
        }]))
    })).sort((a, b) => b.fills - a.fills);
};

/**
 * The book. analyzeByTrigger() reports each trigger on its own, and every trigger can
 * look defensible while the book loses: a series can show a large majority of winning
 * exits, every stop vindicated at its own 1h/4h/24h horizon, and still net a loss,
 * because the average loser is many times the average winner. Nothing summed the
 * column, so tuning optimised per-exit vindication
 * — a metric that cannot see a payoff ratio — instead of expectancy.
 *
 * breakEvenWinRate is the share of fills the current payoff ratio needs just to reach
 * zero. Above the actual win rate means the shape cannot pay, whatever the hit rate.
 */
cryptoExitRecordSchema.statics.analyzeBook = async function (opts = {}) {
    const q = {};
    if (opts.tokenSymbol) q.tokenSymbol = opts.tokenSymbol;
    if (opts.since) q.exitedAt = { $gte: new Date(opts.since) };

    const rows = await this.find(q).lean();
    if (!rows.length) return null;

    let winners = 0, losers = 0, winUsd = 0, lossUsd = 0, gas = 0;
    for (const r of rows) {
        const pnl = r.pnl || 0;
        gas += r.gasCostUsd || 0;
        if (pnl > 0) { winners++; winUsd += pnl; }
        else if (pnl < 0) { losers++; lossUsd += Math.abs(pnl); }
    }
    const net = winUsd - lossUsd;
    const avgWin = winners ? winUsd / winners : 0;
    const avgLoss = losers ? lossUsd / losers : 0;
    const payoffRatio = avgWin > 0 ? avgLoss / avgWin : null;
    const scored = winners + losers;

    return {
        fills: rows.length,
        winners,
        losers,
        winRatePct: scored ? parseFloat(((winners / scored) * 100).toFixed(1)) : null,
        grossWinUsd: parseFloat(winUsd.toFixed(2)),
        grossLossUsd: parseFloat(lossUsd.toFixed(2)),
        netUsd: parseFloat(net.toFixed(2)),
        gasUsd: parseFloat(gas.toFixed(3)),
        avgWinUsd: parseFloat(avgWin.toFixed(2)),
        avgLossUsd: parseFloat(avgLoss.toFixed(2)),
        // how many dollars lost per dollar won, on the average fill
        lossToWinRatio: payoffRatio === null ? null : parseFloat(payoffRatio.toFixed(1)),
        expectancyUsd: scored ? parseFloat((net / scored).toFixed(4)) : null,
        breakEvenWinRatePct: payoffRatio === null ? null
            : parseFloat(((payoffRatio / (1 + payoffRatio)) * 100).toFixed(1)),
        verdict: net >= 0 ? 'book is positive' : 'BOOK IS NEGATIVE — the payoff ratio, not the hit rate'
    };
};

const CryptoExitRecord = mongoose.models.CryptoExitRecord
    || mongoose.model('CryptoExitRecord', cryptoExitRecordSchema);

export default CryptoExitRecord;
