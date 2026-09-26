import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

// Correlation results are derived from a rolling window of signals, so a short
// TTL keeps repeated dashboard/API polls off the aggregation pipeline without
// hiding newly arrived signals for long.
const correlationCache = new NodeCache({ stdTTL: 60, checkperiod: 120, useClones: false });

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
  // 'peer' = received over P2P from another agent; 'local' = detected by this
  // agent's own scanner. Defaults to 'peer' so pre-existing documents, which
  // could only ever have come from a peer, keep their correct provenance.
  origin: { type: String, enum: ['peer', 'local'], default: 'peer' },
  expired: { type: Boolean, default: false }
}, { timestamps: true });

arbSignalSchema.index({ createdAt: -1 });
arbSignalSchema.index({ symbol: 1, createdAt: -1 });
arbSignalSchema.index({ network: 1, createdAt: -1 });
arbSignalSchema.index({ netProfit: 1 });
// Nothing ever flipped `expired` or pruned this collection, so it grew without
// bound. That was invisible while only peer signals were stored (there were
// none); recording this agent's own signals makes it a real growth path.
// 30 days comfortably covers the correlation lookback window.
arbSignalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/**
 * Persist an arbitrage signal detected by this agent's own scanner.
 *
 * Signals used to be written only on the RECEIVING side of a P2P message, so an
 * agent broadcast its own opportunities to peers but never kept them. With no
 * peer running an arbitrage scanner there was nothing to receive either, which
 * left the collection permanently empty and every derived statistic blank.
 * Recording locally also means the analysis works with P2P disabled entirely.
 *
 * Best-effort by design: a storage failure must never disturb the scanner.
 *
 * @param {Object} signal - { token, symbol, network, spread, buyProtocol, sellProtocol, netProfit, gasCostUsd }
 * @param {string} [senderFingerprint='local'] - This agent's own P2P fingerprint when available
 * @returns {Promise<Object|null>} The created document, or null if it was rejected/failed
 */
arbSignalSchema.statics.recordLocalSignal = async function (signal, senderFingerprint = 'local') {
  if (!signal || !signal.token || !signal.symbol) return null;
  try {
    return await this.create({
      senderFingerprint: senderFingerprint || 'local',
      token: signal.token,
      symbol: signal.symbol,
      network: signal.network || 'bsc',
      spread: signal.spread || 0,
      buyProtocol: signal.buyProtocol || '',
      sellProtocol: signal.sellProtocol || '',
      netProfit: signal.netProfit || 0,
      gasCostUsd: signal.gasCostUsd || 0,
      // Our own scanner is the most trusted source we have.
      senderTrustScore: 100,
      origin: 'local'
    });
  } catch {
    return null;
  }
};

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

/**
 * True when a numeric series carries no real variation. Uses a relative
 * tolerance because floating-point means leave residual ~1e-18 spreads on a
 * genuinely constant series, which would otherwise produce a meaningless
 * correlation from pure rounding noise.
 * @param {number[]} values
 * @returns {boolean}
 */
function isEffectivelyConstant(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const scale = Math.max(Math.abs(min), Math.abs(max), 1e-12);
  return (max - min) <= scale * 1e-9;
}

/**
 * Pearson correlation coefficient over two equal-length numeric series.
 * Returns null when either series has no variance (correlation undefined).
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number|null}
 */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  if (isEffectivelyConstant(xs) || isEffectivelyConstant(ys)) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const denom = Math.sqrt(varX) * Math.sqrt(varY);
  if (!Number.isFinite(denom) || denom === 0) return null;
  const r = cov / denom;
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}

/**
 * Bucket arbitrage signals into fixed time bins and aggregate per symbol.
 * Kept separate from findCorrelatedSignals so the aggregation stays one
 * compact $group (one row per symbol per bucket) instead of a per-document
 * $lookup fan-out.
 * @param {Object} match - Mongo match stage
 * @param {number} bucketMs - Bucket width in milliseconds
 * @returns {Promise<Array>} Rows of { symbol, bucket, avgSpread, avgProfit, count }
 */
arbSignalSchema.statics.getSignalBuckets = function (match, bucketMs) {
  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          symbol: '$symbol',
          bucket: { $floor: { $divide: [{ $toLong: '$createdAt' }, bucketMs] } }
        },
        avgSpread: { $avg: '$spread' },
        avgProfit: { $avg: '$netProfit' },
        count: { $sum: 1 }
      }
    },
    {
      $project: {
        _id: 0,
        symbol: '$_id.symbol',
        bucket: '$_id.bucket',
        avgSpread: 1,
        avgProfit: 1,
        count: 1
      }
    }
  ]);
};

/**
 * Find symbols whose arbitrage signals co-occur — and whose spreads co-move —
 * with the given symbol.
 *
 * Signals are binned into `timeWindow`-minute buckets; a bucket in which both
 * symbols produced at least one signal counts as a co-occurrence. The
 * correlation coefficient is the Pearson correlation of the two symbols'
 * mean spread across those shared buckets, so it measures actual spread
 * co-movement rather than clock proximity.
 *
 * @param {string} symbol - Symbol to analyse correlations for
 * @param {string} [network] - Network to filter by (omit for all networks)
 * @param {number} [timeWindow=60] - Bucket width in minutes
 * @param {Object} [options]
 * @param {number} [options.lookbackHours=24] - How far back to look
 * @param {number} [options.minOverlap=3] - Minimum shared buckets to report a symbol
 * @param {number} [options.limit=25] - Maximum symbols returned
 * @param {boolean} [options.includeExpired=false] - Include expired signals
 * @param {boolean} [options.noCache=false] - Bypass the result cache
 * @returns {Promise<Array>} Correlated symbols, strongest correlation first
 */
arbSignalSchema.statics.findCorrelatedSignals = async function (symbol, network, timeWindow = 60, options = {}) {
  if (!symbol) return [];

  const windowMinutes = Number(timeWindow);
  const bucketMs = (Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : 60) * 60 * 1000;
  const lookbackHours = Number.isFinite(Number(options.lookbackHours)) && Number(options.lookbackHours) > 0
    ? Number(options.lookbackHours) : 24;
  const minOverlap = Number.isFinite(Number(options.minOverlap)) && Number(options.minOverlap) > 0
    ? Number(options.minOverlap) : 3;
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Number(options.limit) : 25;
  const includeExpired = options.includeExpired === true;

  const cacheKey = [symbol, network || '*', bucketMs, lookbackHours, minOverlap, limit, includeExpired].join('|');
  if (!options.noCache) {
    const hit = correlationCache.get(cacheKey);
    if (hit) return hit;
  }

  const match = { createdAt: { $gte: new Date(Date.now() - lookbackHours * 60 * 60 * 1000) } };
  if (network) match.network = network;
  if (!includeExpired) match.expired = false;

  const rows = await this.getSignalBuckets(match, bucketMs);

  // symbol -> bucket -> aggregate
  const bySymbol = new Map();
  for (const row of rows || []) {
    if (!row || !row.symbol) continue;
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, new Map());
    bySymbol.get(row.symbol).set(Number(row.bucket), row);
  }

  const base = bySymbol.get(symbol);
  if (!base || base.size === 0) {
    if (!options.noCache) correlationCache.set(cacheKey, []);
    return [];
  }

  const results = [];
  for (const [otherSymbol, buckets] of bySymbol) {
    if (otherSymbol === symbol) continue;

    const baseSpreads = [];
    const otherSpreads = [];
    let sumSpread = 0;
    let sumProfit = 0;
    let signalCount = 0;

    for (const [bucket, baseRow] of base) {
      const otherRow = buckets.get(bucket);
      if (!otherRow) continue;
      baseSpreads.push(Number(baseRow.avgSpread) || 0);
      otherSpreads.push(Number(otherRow.avgSpread) || 0);
      sumSpread += Number(otherRow.avgSpread) || 0;
      sumProfit += Number(otherRow.avgProfit) || 0;
      signalCount += Number(otherRow.count) || 0;
    }

    const coOccurrences = baseSpreads.length;
    if (coOccurrences < minOverlap) continue;

    results.push({
      symbol: otherSymbol,
      coOccurrences,
      coOccurrenceRate: Number((coOccurrences / base.size).toFixed(4)),
      signalCount,
      avgSpread: Number((sumSpread / coOccurrences).toFixed(6)),
      avgProfit: Number((sumProfit / coOccurrences).toFixed(6)),
      correlationCoefficient: (() => {
        const r = pearson(baseSpreads, otherSpreads);
        return r === null ? null : Number(r.toFixed(4));
      })()
    });
  }

  // Strongest positive correlation first; undefined correlations sort last,
  // ordered by how often they co-occur.
  results.sort((a, b) => {
    const ra = a.correlationCoefficient;
    const rb = b.correlationCoefficient;
    if (ra === null && rb === null) return b.coOccurrences - a.coOccurrences;
    if (ra === null) return 1;
    if (rb === null) return -1;
    if (rb !== ra) return rb - ra;
    return b.coOccurrences - a.coOccurrences;
  });

  const trimmed = results.slice(0, limit);
  if (!options.noCache) correlationCache.set(cacheKey, trimmed);
  return trimmed;
};

/**
 * Detect anomalous signals using z-score analysis
 * @param {Object} options - Detection options
 * @param {number} options.threshold - Z-score threshold for anomaly detection
 * @param {string} options.timeWindow - Time window for analysis (e.g., '24h')
 * @returns {Promise<Array>} Anomalous signals
 */
arbSignalSchema.statics.detectAnomalousSignals = async function ({ threshold = 2.0, timeWindow = '24h' } = {}) {
  try {
    // '12h' / '7d'; anything unparseable falls back to 24h. Signals carry a 30-day TTL,
    // so a longer window cannot see more than that.
    const m = /^(\d+)([hd])$/.exec(String(timeWindow).trim());
    const timeWindowMs = m && Number(m[1]) > 0
      ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

    const cutoffTime = new Date(Date.now() - timeWindowMs);
    
    // Get recent signals for statistical analysis
    const recentSignals = await this.find({ 
      createdAt: { $gte: cutoffTime },
      expired: false 
    }).select('spread netProfit symbol');

    if (recentSignals.length === 0) {
      return [];
    }

    // Calculate mean and standard deviation for spread
    const spreads = recentSignals.map(s => s.spread);
    const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const stdDevSpread = Math.sqrt(spreads.map(x => Math.pow(x - meanSpread, 2)).reduce((a, b) => a + b, 0) / spreads.length);

    // Calculate mean and standard deviation for profit
    const profits = recentSignals.map(s => s.netProfit);
    const meanProfit = profits.reduce((a, b) => a + b, 0) / profits.length;
    const stdDevProfit = Math.sqrt(profits.map(x => Math.pow(x - meanProfit, 2)).reduce((a, b) => a + b, 0) / profits.length);

    // Identify anomalies based on z-score
    const anomalies = [];
    for (const signal of recentSignals) {
      const spreadZScore = stdDevSpread !== 0 ? Math.abs(signal.spread - meanSpread) / stdDevSpread : 0;
      const profitZScore = stdDevProfit !== 0 ? Math.abs(signal.netProfit - meanProfit) / stdDevProfit : 0;
      
      if (spreadZScore > threshold || profitZScore > threshold) {
        anomalies.push({
          ...signal.toObject(),
          spreadZScore,
          profitZScore
        });
      }
    }

    return anomalies;
  } catch (error) {
    logger.error('Error detecting anomalous signals:', error);
    throw error;
  }
};

/**
 * Get signal patterns using time-series analysis
 * @param {Object} options - Pattern detection options
 * @param {string} options.patternType - Type of pattern to detect (volatility|trend)
 * @param {string|null} options.symbol - Specific symbol to analyze (null for all)
 * @returns {Promise<Array>} Detected patterns
 */
arbSignalSchema.statics.getSignalPatterns = async function ({ patternType = 'volatility', symbol = null } = {}) {
  if (!['volatility', 'trend'].includes(patternType)) {
    throw new Error(`Unknown pattern type: ${patternType}`);
  }
  try {
    const match = { expired: false };
    if (symbol) match.symbol = symbol;
    
    // Get data for the last 7 days
    const cutoffTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    match.createdAt = { $gte: cutoffTime };
    
    const signals = await this.find(match)
      .sort({ createdAt: 1 })
      .select('symbol spread netProfit createdAt');
    
    if (signals.length === 0) {
      return [];
    }
    
    // Group signals by symbol
    const signalsBySymbol = {};
    signals.forEach(signal => {
      if (!signalsBySymbol[signal.symbol]) {
        signalsBySymbol[signal.symbol] = [];
      }
      signalsBySymbol[signal.symbol].push(signal);
    });
    
    const patterns = [];
    
    // Analyze each symbol's data
    for (const sym in signalsBySymbol) {
      const symbolSignals = signalsBySymbol[sym];
      
      switch (patternType) {
        case 'volatility':
          // Calculate rolling volatility (standard deviation of spreads over a window)
          const volatilityPattern = this._calculateVolatilityPattern(symbolSignals);
          if (volatilityPattern) {
            patterns.push({
              symbol: sym,
              patternType: 'volatility',
              ...volatilityPattern
            });
          }
          break;
          
        case 'trend':
          // Calculate trend using linear regression
          const trendPattern = this._calculateTrendPattern(symbolSignals);
          if (trendPattern) {
            patterns.push({
              symbol: sym,
              patternType: 'trend',
              ...trendPattern
            });
          }
          break;
          
        default:
          throw new Error(`Unknown pattern type: ${patternType}`);
      }
    }
    
    return patterns;
  } catch (error) {
    logger.error('Error getting signal patterns:', error);
    throw error;
  }
};

/**
 * Calculate volatility pattern for a series of signals
 * @private
 * @param {Array} signals - Array of signals for a symbol
 * @returns {Object|null} Volatility pattern data
 */
arbSignalSchema.statics._calculateVolatilityPattern = function(signals) {
  if (signals.length < 10) return null;
  
  // Calculate rolling standard deviation over 10-point windows
  const windowSize = Math.min(10, Math.floor(signals.length / 2));
  const volatilities = [];
  
  for (let i = 0; i <= signals.length - windowSize; i++) {
    const window = signals.slice(i, i + windowSize);
    const spreads = window.map(s => s.spread);
    const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const variance = spreads.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / spreads.length;
    const stdDev = Math.sqrt(variance);
    volatilities.push({
      timestamp: window[Math.floor(window.length/2)].createdAt,
      volatility: stdDev
    });
  }
  
  // Calculate overall volatility metrics
  const avgVolatility = volatilities.reduce((a, b) => a + b.volatility, 0) / volatilities.length;
  const maxVolatility = Math.max(...volatilities.map(v => v.volatility));
  const minVolatility = Math.min(...volatilities.map(v => v.volatility));
  
  return {
    avgVolatility,
    maxVolatility,
    minVolatility,
    volatilitySeries: volatilities
  };
};

/**
 * Calculate trend pattern using linear regression
 * @private
 * @param {Array} signals - Array of signals for a symbol
 * @returns {Object|null} Trend pattern data
 */
arbSignalSchema.statics._calculateTrendPattern = function(signals) {
  if (signals.length < 5) return null;
  
  // Convert timestamps to numeric values for regression
  const startTime = signals[0].createdAt.getTime();
  const points = signals.map((s, i) => ({
    x: s.createdAt.getTime() - startTime,
    y: s.netProfit
  }));
  
  // Calculate linear regression
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumXX += point.x * point.x;
  }
  
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;   // every signal at one instant — no time axis to fit
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  
  // Calculate R-squared
  const yMean = sumY / n;
  let totalSS = 0, regressionSS = 0;
  
  for (const point of points) {
    const predictedY = slope * point.x + intercept;
    totalSS += Math.pow(point.y - yMean, 2);
    regressionSS += Math.pow(predictedY - yMean, 2);
  }
  
  const rSquared = totalSS > 0 ? regressionSS / totalSS : 0;
  
  return {
    slope,
    intercept,
    rSquared,
    startPoint: { x: points[0].x, y: points[0].y },
    endPoint: { x: points[points.length - 1].x, y: points[points.length - 1].y }
  };
};

const ArbSignal = mongoose.model('ArbSignal', arbSignalSchema);
export default ArbSignal;
