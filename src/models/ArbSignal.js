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
arbSignalSchema.index({ network: 1, createdAt: -1 });
arbSignalSchema.index({ netProfit: 1 });

arbSignalSchema.statics.getRecentSignals = function (limit = 20) {
  return this.find({ expired: false, createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } })
    .sort({ createdAt: -1 }).limit(limit);
};

/**
 * Get signals filtered by network
 * @param {string} network - Network to filter by
 * @param {number} limit - Maximum number of signals to return
 * @returns {Promise<Array>} Array of signals
 */
arbSignalSchema.statics.getByNetwork = function (network, limit = 50) {
  return this.find({ network, expired: false })
    .sort({ createdAt: -1 })
    .limit(limit);
};

/**
 * Get signals filtered by symbol
 * @param {string} symbol - Symbol to filter by
 * @param {number} limit - Maximum number of signals to return
 * @returns {Promise<Array>} Array of signals
 */
arbSignalSchema.statics.getBySymbol = function (symbol, limit = 50) {
  return this.find({ symbol, expired: false })
    .sort({ createdAt: -1 })
    .limit(limit);
};

/**
 * Get signals within a profitability range
 * @param {number} minProfit - Minimum profit value
 * @param {number} maxProfit - Maximum profit value
 * @param {number} limit - Maximum number of signals to return
 * @returns {Promise<Array>} Array of signals
 */
arbSignalSchema.statics.getByProfitabilityRange = function (minProfit, maxProfit, limit = 50) {
  return this.find({ 
    netProfit: { $gte: minProfit, $lte: maxProfit }, 
    expired: false 
  })
    .sort({ createdAt: -1 })
    .limit(limit);
};

/**
 * Calculate average spread for a given symbol
 * @param {string} symbol - Symbol to calculate average spread for
 * @returns {Promise<number>} Average spread value
 */
arbSignalSchema.statics.getAverageSpreadBySymbol = function (symbol) {
  return this.aggregate([
    { $match: { symbol, expired: false } },
    { $group: { _id: null, averageSpread: { $avg: '$spread' } } },
    { $project: { _id: 0, averageSpread: 1 } }
  ]).then(result => result.length > 0 ? result[0].averageSpread : 0);
};

/**
 * Calculate profit statistics for a given network
 * @param {string} network - Network to calculate statistics for
 * @returns {Promise<Object>} Profit statistics object
 */
arbSignalSchema.statics.getProfitStatisticsByNetwork = function (network) {
  return this.aggregate([
    { $match: { network, expired: false } },
    {
      $group: {
        _id: null,
        averageProfit: { $avg: '$netProfit' },
        maxProfit: { $max: '$netProfit' },
        minProfit: { $min: '$netProfit' },
        totalSignals: { $sum: 1 }
      }
    },
    {
      $project: {
        _id: 0,
        averageProfit: 1,
        maxProfit: 1,
        minProfit: 1,
        totalSignals: 1
      }
    }
  ]).then(result => result.length > 0 ? result[0] : {
    averageProfit: 0,
    maxProfit: 0,
    minProfit: 0,
    totalSignals: 0
  });
};

const ArbSignal = mongoose.model('ArbSignal', arbSignalSchema);
export default ArbSignal;
