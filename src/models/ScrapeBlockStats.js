import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

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

export default ScrapeBlockStats;
