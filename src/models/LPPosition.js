import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * LPPosition - Tracks liquidity provider positions across DEX pools.
 * Supports V2 constant-product pools. V3/V4 concentrated liquidity in future.
 */
const lpPositionSchema = new mongoose.Schema({
  pairAddress: {
    type: String,
    required: true,
    index: true
  },
  network: {
    type: String,
    required: true,
    default: 'bsc'
  },
  tokenA: {
    address: { type: String, required: true },
    symbol: { type: String, default: '' },
    decimals: { type: Number, default: 18 }
  },
  tokenB: {
    address: { type: String, required: true },
    symbol: { type: String, default: '' },
    decimals: { type: Number, default: 18 }
  },
  protocol: {
    type: String,
    enum: ['v2', 'v3', 'v4'],
    default: 'v2'
  },
  // LP token balance
  lpBalance: {
    type: String,
    default: '0'
  },
  // Last known reserves
  reserveA: { type: String, default: '0' },
  reserveB: { type: String, default: '0' },
  totalSupply: { type: String, default: '0' },
  // Our share of the pool
  sharePercent: { type: Number, default: 0 },
  // Value tracking
  initialValueBNB: { type: Number, default: 0 },
  currentValueBNB: { type: Number, default: 0 },
  // V3 concentrated liquidity fields
  v3: {
    tokenId: { type: String, default: null },       // NFT position token ID
    tickLower: { type: Number, default: null },
    tickUpper: { type: Number, default: null },
    liquidity: { type: String, default: '0' },       // Position liquidity
    feeTier: { type: Number, default: null },         // 100, 500, 2500, 10000 bps
    feeGrowth0: { type: String, default: '0' },       // Fees earned token0
    feeGrowth1: { type: String, default: '0' },       // Fees earned token1
    collectedFees0: { type: String, default: '0' },   // Total collected fees token0
    collectedFees1: { type: String, default: '0' },   // Total collected fees token1
    inRange: { type: Boolean, default: true },         // Is current price in range
    lastRebalance: { type: Date, default: null }
  },
  // Optimization preferences for yield recommendations
  optimizationPreferences: {
    maxSlippage: { type: Number, default: 0.5 },      // Maximum acceptable slippage percentage
    preferredFeeTiers: [{ type: Number }],            // Preferred fee tiers for migration
    rebalanceThreshold: { type: Number, default: 10 }, // Percentage gain threshold to trigger rebalance
    autoCompound: { type: Boolean, default: false },   // Whether to automatically compound earnings
    riskTolerance: { 
      type: String, 
      enum: ['low', 'medium', 'high'], 
      default: 'medium' 
    }
  },
  // Status
  active: {
    type: Boolean,
    default: true
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  // Transaction history
  transactions: [{
    type: { type: String, enum: ['add', 'remove', 'collect', 'rebalance'] },
    txHash: String,
    lpAmount: String,
    amountA: String,
    amountB: String,
    timestamp: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

lpPositionSchema.index({ active: 1 });
lpPositionSchema.index({ network: 1, pairAddress: 1 }, { unique: true });

// Cache for active positions queries
const positionCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Get all active positions with caching and retry logic
 */
lpPositionSchema.statics.getActivePositions = async function() {
  const cacheKey = 'activePositions';
  const cachedData = positionCache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  const activePositions = await retryOperation(
    () => this.find({ active: true }).sort({ updatedAt: -1 }),
    { retries: 3, context: 'LPPosition.getActivePositions' }
  );
  positionCache.set(cacheKey, activePositions);
  return activePositions;
};

/**
 * Find position by pair
 */
lpPositionSchema.statics.findByPair = function(pairAddress, network = 'bsc') {
  return this.findOne({ pairAddress: pairAddress.toLowerCase(), network });
};

/**
 * Record a liquidity add/remove
 */
lpPositionSchema.methods.recordTransaction = function(type, txHash, lpAmount, amountA, amountB) {
  this.transactions.push({ type, txHash, lpAmount, amountA, amountB });
  positionCache.del('activePositions'); // Invalidate cache on position changes
  return this.save();
};

/**
 * Calculate ROI (Return on Investment) for the position
 * @returns {number} ROI as a percentage
 */
lpPositionSchema.methods.calculateROI = function() {
  if (this.initialValueBNB <= 0) return 0;
  return ((this.currentValueBNB - this.initialValueBNB) / this.initialValueBNB) * 100;
};

/**
 * Calculate impermanent loss for the position
 * @param {number} priceRatioChange - Ratio of current price to initial price
 * @returns {number} Impermanent loss as a percentage
 */
lpPositionSchema.methods.calculateImpermanentLoss = function(priceRatioChange) {
  if (priceRatioChange <= 0) return 0;
  
  // For simplicity, assuming equal initial value in both tokens
  const sqrtPriceRatio = Math.sqrt(priceRatioChange);
  const impermanentLoss = 2 * (sqrtPriceRatio / (1 + priceRatioChange)) - 1;
  return impermanentLoss * 100;
};

/**
 * Collected fees, per token. collectedFees0 and collectedFees1 are amounts of
 * two DIFFERENT tokens (with independent decimals), so they can't be summed into
 * a single figure without a price oracle for each — which the position doesn't
 * store. Return them separately rather than fabricating a meaningless total.
 * @returns {{collectedFees0: number, collectedFees1: number}}
 */
lpPositionSchema.methods.calculateFeeYield = function() {
  return {
    collectedFees0: parseFloat(this.v3?.collectedFees0) || 0,
    collectedFees1: parseFloat(this.v3?.collectedFees1) || 0
  };
};

/**
 * Calculate time-weighted performance metrics
 * @returns {object} Performance metrics including TWRR (Time-Weighted Rate of Return)
 */
lpPositionSchema.methods.calculateTimeWeightedPerformance = function() {
  if (!this.initialValueBNB || this.initialValueBNB <= 0) {
    return {
      twrr: 0,
      holdingPeriodReturn: 0,
      durationDays: 0
    };
  }

  // Get all transaction timestamps and sort them
  const sortedTransactions = [...this.transactions]
    .filter(tx => tx.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  let startDate = this.createdAt ? new Date(this.createdAt) : new Date();
  if (sortedTransactions.length > 0) {
    startDate = new Date(sortedTransactions[0].timestamp);
  }
  
  const endDate = new Date();
  const durationMs = endDate - startDate;
  const durationDays = durationMs / (1000 * 60 * 60 * 24);
  
  // Calculate holding period return
  const holdingPeriodReturn = ((this.currentValueBNB - this.initialValueBNB) / this.initialValueBNB) * 100;
  
  // Calculate time-weighted rate of return (simplified version)
  // In a more complex implementation, we would calculate sub-period returns between cash flows
  let twrr = 0;
  if (durationDays > 0) {
    // Compound annual growth rate approach for time-weighted return
    const years = durationDays / 365;
    twrr = (Math.pow(this.currentValueBNB / this.initialValueBNB, 1 / years) - 1) * 100;
  }
  
  return {
    twrr,
    holdingPeriodReturn,
    durationDays
  };
};

/**
 * Get comprehensive performance metrics for the position.
 * Impermanent loss requires the pooled pair's price ratio (current price /
 * initial price), which the position doesn't store — pass it in when a caller
 * has it (e.g. from a price oracle). When omitted, impermanentLoss is null
 * rather than a misleading 0.
 * @param {number} [priceRatioChange] - current/initial price ratio of the pair
 * @returns {object} ROI, impermanent loss, per-token fee yield, and time-weighted returns
 */
lpPositionSchema.methods.getPerformanceMetrics = function(priceRatioChange = null) {
  const roi = this.calculateROI();
  const feeYield = this.calculateFeeYield();
  const timeWeightedMetrics = this.calculateTimeWeightedPerformance();

  const impermanentLoss = (typeof priceRatioChange === 'number' && priceRatioChange > 0)
    ? this.calculateImpermanentLoss(priceRatioChange)
    : null;

  return {
    roi,
    impermanentLoss,
    feeYield,
    currentValue: this.currentValueBNB,
    initialValue: this.initialValueBNB,
    ...timeWeightedMetrics
  };
};

/**
 * Analyze fee growth patterns and suggest optimization opportunities
 * @returns {object} Optimization recommendations including rebalancing or fee tier migration
 */
lpPositionSchema.methods.recommendOptimization = function() {
  // Check if this is a V3 position with necessary data
  if (this.protocol !== 'v3' || !this.v3) {
    return {
      action: 'none',
      reason: 'Only V3 positions support optimization recommendations',
      details: {}
    };
  }

  const recommendations = {
    action: 'none',
    reason: 'No optimization opportunities found',
    details: {}
  };

  // Analyze fee growth patterns
  const feeGrowth0 = parseFloat(this.v3.feeGrowth0) || 0;
  const feeGrowth1 = parseFloat(this.v3.feeGrowth1) || 0;
  const collectedFees0 = parseFloat(this.v3.collectedFees0) || 0;
  const collectedFees1 = parseFloat(this.v3.collectedFees1) || 0;
  
  // Calculate total potential fees (uncollected + collected)
  const totalPotentialFees0 = feeGrowth0 + collectedFees0;
  const totalPotentialFees1 = feeGrowth1 + collectedFees1;
  
  // Check if there are significant uncollected fees
  if (feeGrowth0 > 0 || feeGrowth1 > 0) {
    // Guard the divisor: only one of the two tokens may have accrued fees, and
    // 0/0 is NaN rather than 0. NaN compares false so it would not misfire, but
    // it must not reach the ratio either.
    const uncollectedRatio0 = totalPotentialFees0 > 0 ? feeGrowth0 / totalPotentialFees0 : 0;
    const uncollectedRatio1 = totalPotentialFees1 > 0 ? feeGrowth1 / totalPotentialFees1 : 0;

    // If uncollected fees represent more than 30% of potential fees, suggest collecting
    if (uncollectedRatio0 > 0.3 || uncollectedRatio1 > 0.3) {
      recommendations.action = 'collect_fees';
      recommendations.reason = 'Significant uncollected fees detected';
      recommendations.details = {
        uncollectedFees0: feeGrowth0,
        uncollectedFees1: feeGrowth1,
        collectedFees0: collectedFees0,
        collectedFees1: collectedFees1
      };
      return recommendations;
    }
  }
  
  // Analyze current fee tier performance
  const currentFeeTier = this.v3.feeTier;
  const preferredFeeTiers = this.optimizationPreferences.preferredFeeTiers || [];
  
  // If current fee tier is not in preferred tiers, suggest migration
  if (currentFeeTier && preferredFeeTiers.length > 0 && !preferredFeeTiers.includes(currentFeeTier)) {
    // Find the closest preferred fee tier
    const closestTier = preferredFeeTiers.reduce((prev, curr) => {
      return Math.abs(curr - currentFeeTier) < Math.abs(prev - currentFeeTier) ? curr : prev;
    });
    
    recommendations.action = 'migrate_fee_tier';
    recommendations.reason = 'Current fee tier not aligned with preferences';
    recommendations.details = {
      currentFeeTier,
      suggestedFeeTier: closestTier,
      preferredFeeTiers
    };
    return recommendations;
  }
  
  // Position is out of range and has not been rebalanced recently.
  //
  // Note the metric this actually measures: nothing records WHEN the position
  // left its range, so time-out-of-range is not derivable from the schema. What
  // is available is the age of the last rebalance, which is a different quantity
  // — a position that drifted out an hour ago but was last rebalanced a month
  // ago has a one-hour excursion and a 30-day rebalance age. Naming the field
  // for the number actually computed keeps the recommendation honest.
  if (this.v3.inRange === false) {
    const lastRebalance = this.v3.lastRebalance ? new Date(this.v3.lastRebalance) : null;
    const now = new Date();
    const daysSinceLastRebalance = lastRebalance
      ? (now - lastRebalance) / (1000 * 60 * 60 * 24)
      : Infinity;

    // Out of range, and untouched for more than 7 days (or never rebalanced).
    if (daysSinceLastRebalance > 7) {
      recommendations.action = 'rebalance_position';
      recommendations.reason = lastRebalance
        ? 'Position is out of range and has not been rebalanced in over 7 days'
        : 'Position is out of range and has never been rebalanced';
      recommendations.details = {
        daysSinceLastRebalance: Number.isFinite(daysSinceLastRebalance)
          ? Math.round(daysSinceLastRebalance)
          : null,
        currentInRange: this.v3.inRange,
        lastRebalance
      };
      return recommendations;
    }
  }
  
  // Check ROI against rebalance threshold
  const roi = this.calculateROI();
  const rebalanceThreshold = this.optimizationPreferences.rebalanceThreshold || 10;
  
  if (roi > rebalanceThreshold) {
    recommendations.action = 'rebalance_for_compounding';
    recommendations.reason = `ROI (${roi.toFixed(2)}%) exceeds compounding threshold`;
    recommendations.details = {
      currentRoi: roi,
      rebalanceThreshold,
      currentValue: this.currentValueBNB,
      initialValue: this.initialValueBNB
    };
    return recommendations;
  }

  return recommendations;
};

const LPPosition = mongoose.model('LPPosition', lpPositionSchema);
export default LPPosition;
