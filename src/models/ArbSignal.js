import mongoose from 'mongoose';

const arbSignalSchema = new mongoose.Schema({
  senderFingerprint: { type: String, required: true },
  token: { type: String, required: true },
  symbol: { type: String, required: true },
  network: { type: String, default: 'bsc' },
  spread: { type: Number, required: true },
  buyProtocol: { type: String, default: '' },
  sellProtocol: { type: String, default: '' },
  netProfit: { type: Number, default: 0 },
  gasCostUsd: { type: Number, default: 0 },
  senderTrustScore: { type: Number, default: 0 },
  expired: { type: Boolean, default: false }
}, { timestamps: true });

arbSignalSchema.index({ createdAt: -1 });
arbSignalSchema.index({ symbol: 1, createdAt: -1 });

arbSignalSchema.statics.getRecentSignals = function (limit = 20) {
  return this.find({ expired: false, createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } })
    .sort({ createdAt: -1 }).limit(limit);
};

const ArbSignal = mongoose.model('ArbSignal', arbSignalSchema);
export default ArbSignal;
