import mongoose from 'mongoose';

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
  // alert when the price moves by at least this many percent, target or not (0 = never)
  changePct: { type: Number, default: 0 },
  alertedTarget: { type: Boolean, default: false },
  lastCheckedAt: { type: Date, default: null },
  lastChangeAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  failCount: { type: Number, default: 0 }
}, { timestamps: true });

webWatchSchema.index({ kind: 1, url: 1 }, { unique: true });

const WebWatch = mongoose.models.WebWatch || mongoose.model('WebWatch', webWatchSchema);
export default WebWatch;
