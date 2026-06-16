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

const LPPosition = mongoose.model('LPPosition', lpPositionSchema);
export default LPPosition;
