import mongoose from 'mongoose';

const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 1000;

/** How many price observations to keep for a watch (its historyLimit, clamped). */
export function priceHistoryLimit(watch) {
  const n = Number(watch?.historyLimit);
  return Number.isInteger(n) ? Math.min(MAX_HISTORY_LIMIT, Math.max(1, n)) : DEFAULT_HISTORY_LIMIT;
}

/**
 * Something the agent checks on a schedule and reports changes in: a feed (new items) or a
 * product page (price). One collection for both, so one job checks everything.
 */
const webWatchSchema = new mongoose.Schema({
  kind: { type: String, enum: ['feed', 'price'], required: true, index: true },
  url: { type: String, required: true },
  name: { type: String, default: '' },
  active: { type: Boolean, default: true, index: true },
  intervalMin: { type: Number, default: 60, min: 15 },
  // feed: ids of items already seen (newest first, capped) — only unseen ones are reported
  seen: { type: [String], default: [] },
  keywords: { type: [String], default: [] },
  // price
  selector: { type: String, default: '' },
  targetPrice: { type: Number, default: null },
  lastPrice: { type: Number, default: null },
  lowestPrice: { type: Number, default: null },
  currency: { type: String, default: null },
  // Price observations, oldest first, trimmed to historyLimit. Appended by
  // WebWatchService.checkOne in the same update that sets lastPrice.
  priceHistory: {
    type: [{
      _id: false,
      price: { type: Number, required: true },
      checkedAt: { type: Date, required: true }
    }],
    default: []
  },
  historyLimit: {
    type: Number,
    default: DEFAULT_HISTORY_LIMIT,
    min: 1,
    max: MAX_HISTORY_LIMIT
  },
  // alert when the price moves by at least this many percent, target or not (0 = never)
  changePct: { type: Number, default: 0 },
  alertedTarget: { type: Boolean, default: false },
  lastCheckedAt: { type: Date, default: null },
  lastChangeAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  failCount: { type: Number, default: 0 }
}, { timestamps: true });

webWatchSchema.index({ kind: 1, url: 1 }, { unique: true });

/**
 * Calculate price movement over the most recent observations for a watch.
 *
 * @param {mongoose.Types.ObjectId|string} watchId
 * @param {number} [window] Maximum number of recent observations to include.
 * @returns {Promise<Object|null>} Trend metrics, or null when the watch does not exist.
 */
webWatchSchema.statics.getPriceTrend = async function getPriceTrend(watchId, window) {
  const watch = await this.findOne({ _id: watchId, kind: 'price' })
    .select('priceHistory historyLimit')
    .lean();

  if (!watch) return null;

  const observations = (watch.priceHistory || [])
    .filter((observation) => (
      observation &&
      Number.isFinite(Number(observation.price)) &&
      observation.checkedAt &&
      !Number.isNaN(new Date(observation.checkedAt).getTime())
    ))
    .map((observation) => ({
      price: Number(observation.price),
      checkedAt: new Date(observation.checkedAt)
    }))
    .sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime());

  let selected = observations;
  if (window !== undefined && window !== null) {
    const count = Number(window);
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError('Trend window must be a positive integer');
    }
    selected = observations.slice(-count);
  }

  if (selected.length === 0) {
    return {
      absoluteChange: null,
      percentageChange: null,
      minimum: null,
      maximum: null,
      direction: 'unchanged',
      observations: []
    };
  }

  const firstPrice = selected[0].price;
  const latestPrice = selected[selected.length - 1].price;
  const absoluteChange = latestPrice - firstPrice;
  const percentageChange = firstPrice === 0
    ? (latestPrice === 0 ? 0 : null)
    : (absoluteChange / firstPrice) * 100;

  return {
    absoluteChange,
    percentageChange,
    minimum: Math.min(...selected.map((observation) => observation.price)),
    maximum: Math.max(...selected.map((observation) => observation.price)),
    direction: absoluteChange > 0 ? 'up' : absoluteChange < 0 ? 'down' : 'unchanged',
    observations: selected
  };
};

const WebWatch = mongoose.models.WebWatch || mongoose.model('WebWatch', webWatchSchema);
export default WebWatch;
