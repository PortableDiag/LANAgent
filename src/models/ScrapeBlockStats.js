import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * Daily counters for scrape block handling and VPN exit rotation.
 *
 * Exists because there was no trustworthy denominator for "how often does the
 * auto-connect pin actually cost us a scrape?". Counting the log lines does not
 * work: retention on the production box is wildly uneven (all-activity.log ~2
 * days, api-web.log ~5 months), so any rate derived from a `logs/*.log` glob is
 * summed over incomparable spans. These counters survive both log rotation and
 * a process restart, so a rate taken from them is real.
 *
 * One document per UTC day per tier. Written fire-and-forget — telemetry must
 * never fail a customer scrape.
 */
const scrapeBlockStatsSchema = new mongoose.Schema({
  // UTC date bucket, 'YYYY-MM-DD'. Paired with tier as the upsert key.
  day: {
    type: String,
    required: true
  },
  tier: {
    type: String,
    required: true
  },
  // Reached the rotation entry point: not basic tier, scrape failed, and the
  // failure looked like a block. This is the denominator.
  blocksDetected: {
    type: Number,
    default: 0
  },
  // The cost of the auto-connect hardening: a block that rotation was supposed
  // to recover, refused because the exit is pinned. This is the numerator.
  rotationRefusedAutoConnect: {
    type: Number,
    default: 0
  },
  // A rotation was actually carried out (exit changed, scrape retried).
  rotationAttempted: {
    type: Number,
    default: 0
  },
  // A rotation recovered the scrape. Against rotationAttempted this says what
  // the mechanism is worth when it is allowed to run at all.
  rotationRecovered: {
    type: Number,
    default: 0
  },
  // Block detected but the VPN plugin was not resolvable.
  vpnUnavailable: {
    type: Number,
    default: 0
  },
  // Rotation stopped early because the overall scrape budget was spent.
  rotationBudgetExhausted: {
    type: Number,
    default: 0
  },
  // Every candidate exit in the pool was tried without recovering.
  rotationPoolExhausted: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

scrapeBlockStatsSchema.index({ day: 1, tier: 1 }, { unique: true });

const ScrapeBlockStats = mongoose.model('ScrapeBlockStats', scrapeBlockStatsSchema);

/**
 * Increment one counter for today's bucket. Never throws and never blocks the
 * caller — a telemetry write must not be able to fail a scrape.
 *
 * @param {string} field - counter field name on the schema
 * @param {string} tier - scrape tier the event belongs to
 */
export function recordBlockEvent(field, tier) {
  if (!Object.prototype.hasOwnProperty.call(ScrapeBlockStats.schema.paths, field)) {
    logger.warn(`[ScrapeBlockStats] Ignoring unknown counter '${field}'`);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  // Both arms are needed. `.catch()` covers the rejected query; the try/catch
  // covers Mongoose throwing *synchronously*, which is what it does when the
  // connection pool is destroyed mid-call — a bare `.catch()` would let that
  // one escape into the scrape's call stack.
  try {
    ScrapeBlockStats.updateOne(
      { day, tier: tier || 'unknown' },
      { $inc: { [field]: 1 } },
      { upsert: true }
    ).catch(err => {
      logger.debug(`[ScrapeBlockStats] Counter write failed (${field}): ${err.message}`);
    });
  } catch (err) {
    logger.debug(`[ScrapeBlockStats] Counter write threw (${field}): ${err.message}`);
  }
}

/**
 * Get aggregated statistics over a specified number of days with trend analysis
 * 
 * @param {Object} options - Aggregation options
 * @param {number} options.days - Number of days to aggregate (default: 30)
 * @param {string|null} options.tier - Tier filter (default: null for all tiers)
 * @returns {Promise<Object>} Aggregated statistics with trends
 */
ScrapeBlockStats.getAggregatedStats = async function ({ days = 30, tier = null } = {}) {
  // `day` is a UTC bucket ('YYYY-MM-DD', per the schema comment above), so the window
  // has to be computed in UTC too. Mixing setDate() (local) with toISOString() (UTC)
  // shifts the boundary by a day for anyone west of Greenwich for part of each day.
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - (Math.max(1, days) - 1) * 86400000);
  
  const matchConditions = {
    day: {
      $gte: startDate.toISOString().slice(0, 10),
      $lte: endDate.toISOString().slice(0, 10)
    }
  };
  
  if (tier) {
    matchConditions.tier = tier;
  }
  
  // First get the aggregated data
  const aggregationResult = await retryOperation(async () => {
    return await this.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: null,
          totalBlocksDetected: { $sum: '$blocksDetected' },
          totalRotationRefusedAutoConnect: { $sum: '$rotationRefusedAutoConnect' },
          totalRotationAttempted: { $sum: '$rotationAttempted' },
          totalRotationRecovered: { $sum: '$rotationRecovered' },
          totalVpnUnavailable: { $sum: '$vpnUnavailable' },
          totalRotationBudgetExhausted: { $sum: '$rotationBudgetExhausted' },
          totalRotationPoolExhausted: { $sum: '$rotationPoolExhausted' },
          earliestDate: { $min: '$day' },
          latestDate: { $max: '$day' },
          tiers: { $addToSet: '$tier' }
        }
      }
    ]).exec();
  });
  
  if (!aggregationResult || aggregationResult.length === 0) {
    return {
      period: { days, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) },
      totals: {
        blocksDetected: 0,
        rotationRefusedAutoConnect: 0,
        rotationAttempted: 0,
        rotationRecovered: 0,
        vpnUnavailable: 0,
        rotationBudgetExhausted: 0,
        rotationPoolExhausted: 0
      },
      // null, not 0. An empty window has no rate; reporting 0% would read as
      // "the auto-connect pin costs nothing", which is the same unknown-vs-zero
      // conflation the sibling /block-stats route carries an explicit guard against.
      rates: {
        autoConnectRefusalRate: null,
        recoveryRate: null,
        vpnUnavailableRate: null
      },
      trends: {},
      metadata: {
        tiers: [],
        dataPoints: 0
      }
    };
  }
  
  const data = aggregationResult[0];
  
  // Calculate rates
  const totals = {
    blocksDetected: data.totalBlocksDetected,
    rotationRefusedAutoConnect: data.totalRotationRefusedAutoConnect,
    rotationAttempted: data.totalRotationAttempted,
    rotationRecovered: data.totalRotationRecovered,
    vpnUnavailable: data.totalVpnUnavailable,
    rotationBudgetExhausted: data.totalRotationBudgetExhausted,
    rotationPoolExhausted: data.totalRotationPoolExhausted
  };
  
  // Same contract as GET /block-stats: a zero denominator yields null, never 0.
  const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(2)) : null);
  const rates = {
    autoConnectRefusalRate: pct(data.totalRotationRefusedAutoConnect, data.totalBlocksDetected),
    recoveryRate: pct(data.totalRotationRecovered, data.totalRotationAttempted),
    vpnUnavailableRate: pct(data.totalVpnUnavailable, data.totalBlocksDetected)
  };
  
  // Now get time-series data for trend analysis
  const timeSeriesResult = await retryOperation(async () => {
    return await this.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: '$day',
          blocksDetected: { $sum: '$blocksDetected' },
          rotationRefusedAutoConnect: { $sum: '$rotationRefusedAutoConnect' },
          rotationAttempted: { $sum: '$rotationAttempted' },
          rotationRecovered: { $sum: '$rotationRecovered' },
          vpnUnavailable: { $sum: '$vpnUnavailable' }
        }
      },
      { $sort: { _id: 1 } }
    ]).exec();
  });
  
  // Trend: compare the mean of the window's second half against its first.
  //
  // A dead band is required. The original compared the two means with bare > and <,
  // so 'stable' occurred only on exact float equality — which essentially never
  // happens — and a difference of one event across fifteen days was reported as
  // "increasing". A direction nobody can act on is worse than no direction, because
  // it reads as a finding.
  const TREND_FIELDS = ['blocksDetected', 'rotationRefusedAutoConnect',
    'rotationAttempted', 'rotationRecovered', 'vpnUnavailable'];
  const TREND_DEAD_BAND = 0.10; // 10% of the earlier mean

  const trends = {};
  if (timeSeriesResult.length > 1) {
    const mid = Math.floor(timeSeriesResult.length / 2);
    const firstHalf = timeSeriesResult.slice(0, mid);
    const secondHalf = timeSeriesResult.slice(mid);
    const mean = (rows, field) => rows.reduce((sum, row) => sum + (row[field] || 0), 0) / rows.length;

    for (const field of TREND_FIELDS) {
      const before = mean(firstHalf, field);
      const after = mean(secondHalf, field);
      const delta = after - before;
      // Against a zero baseline any activity at all is a real change, so fall back
      // to an absolute threshold rather than dividing by zero.
      const band = before > 0 ? before * TREND_DEAD_BAND : 0.5;
      trends[field] = {
        value: Number(after.toFixed(2)),
        previous: Number(before.toFixed(2)),
        changePct: before > 0 ? Number(((delta / before) * 100).toFixed(1)) : null,
        trend: Math.abs(delta) <= band ? 'stable' : (delta > 0 ? 'increasing' : 'decreasing')
      };
    }
  }

  return {
    period: { 
      days, 
      startDate: data.earliestDate || startDate.toISOString().slice(0, 10), 
      endDate: data.latestDate || endDate.toISOString().slice(0, 10) 
    },
    totals,
    rates,
    trends,
    metadata: {
      tiers: data.tiers,
      dataPoints: timeSeriesResult.length
    }
  };
};

export default ScrapeBlockStats;
