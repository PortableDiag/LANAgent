import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

/**
 * SkynetTokenLedger - Internal accounting for SKYNET token allocations.
 *
 * Tracks minted vs bought tokens to enforce trading rules:
 * - Minted tokens (staking, bounty, treasury, reserve) are NOT tradeable
 * - Only tokens with source='bought' can be sold via Token Trader
 * - LP allocation is tracked separately (sent to liquidity pool)
 */
const skynetTokenLedgerSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    unique: true,
    enum: ['lp', 'staking', 'bounty', 'treasury', 'reserve', 'bought'],
    index: true
  },
  amount: {
    type: Number,
    required: true,
    default: 0
  },
  initialAmount: {
    type: Number,
    required: true,
    default: 0
  },
  source: {
    type: String,
    required: true,
    enum: ['minted', 'bought']
  },
  description: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

/**
 * HistoricalTransaction - Schema for logging transactions.
 */
const historicalTransactionSchema = new mongoose.Schema({
  transactionType: {
    type: String,
    required: true,
    enum: ['purchase', 'sale', 'stakingClaim', 'stakingFund']
  },
  category: {
    type: String,
    required: true,
    enum: ['lp', 'staking', 'bounty', 'treasury', 'reserve', 'bought']
  },
  txHash: {
    type: String,
    default: null
  },
  network: {
    type: String,
    default: 'bsc'
  },
  amount: {
    type: Number,
    required: true
  },
  date: {
    type: Date,
    default: Date.now
  },
  description: {
    type: String,
    default: ''
  },
  // Optional idempotency key — when set, the unique partial index below
  // prevents the same (key, transactionType) combination from being persisted twice.
  idempotencyKey: {
    type: String,
    default: null
  }
});

// Idempotency: enforce uniqueness only when an idempotencyKey is actually provided.
historicalTransactionSchema.index(
  { idempotencyKey: 1, transactionType: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } }
  }
);

const HistoricalTransaction = mongoose.model('HistoricalTransaction', historicalTransactionSchema);

/**
 * Try to write a historical transaction. Returns { created: true, doc } on
 * success, or { created: false, doc: null } if the unique index rejected it
 * because the same idempotencyKey + transactionType already exists.
 * The historical log is written BEFORE the ledger mutation so concurrent
 * callers with the same key serialize on the unique index — only the winner
 * proceeds to mutate the ledger.
 */
async function _writeHistoricalIdempotent(doc) {
  try {
    const tx = await HistoricalTransaction.create(doc);
    return { created: true, doc: tx };
  } catch (err) {
    if (err && (err.code === 11000 || /duplicate key/i.test(err.message))) {
      return { created: false, doc: null };
    }
    throw err;
  }
}

/**
 * Log a transaction in the historical transactions collection.
 */
async function logTransaction(transactionType, category, amount, description = '', extra = {}) {
  try {
    const transaction = new HistoricalTransaction({
      transactionType,
      category,
      amount,
      description,
      ...extra
    });
    await transaction.save();
    logger.info(`Logged transaction: ${transactionType} of ${amount} in category ${category}`);
  } catch (error) {
    logger.error(`Failed to log transaction: ${error.message}`);
  }
}

/**
 * Retrieve historical transactions based on filters.
 */
skynetTokenLedgerSchema.statics.getHistoricalTransactions = async function(filters = {}) {
  const { startDate, endDate, transactionType, category } = filters;
  const query = {};

  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = new Date(startDate);
    if (endDate) query.date.$lte = new Date(endDate);
  }
  if (transactionType) query.transactionType = transactionType;
  if (category) query.category = category;

  return HistoricalTransaction.find(query).sort({ date: -1 });
};

/**
 * Get total tradeable balance (only bought tokens)
 */
skynetTokenLedgerSchema.statics.getTradeableBalance = async function() {
  const bought = await this.findOne({ category: 'bought' });
  return bought ? bought.amount : 0;
};

/**
 * Get total minted reserve (non-tradeable)
 */
skynetTokenLedgerSchema.statics.getMintedReserve = async function() {
  const reserves = await this.find({ source: 'minted', category: { $ne: 'lp' } });
  return reserves.reduce((sum, r) => sum + r.amount, 0);
};

/**
 * Record a token purchase (from Token Trader).
 * When idempotencyKey is provided, retries with the same key are no-ops.
 */
skynetTokenLedgerSchema.statics.recordPurchase = async function(amount, { idempotencyKey = null, txHash = null, network = 'bsc' } = {}) {
  if (idempotencyKey) {
    const { created, doc: histTx } = await _writeHistoricalIdempotent({
      transactionType: 'purchase',
      category: 'bought',
      amount,
      description: 'Token purchase from Token Trader',
      idempotencyKey,
      txHash,
      network
    });
    if (!created) {
      logger.info(`Idempotent purchase no-op (key=${idempotencyKey}, amount=${amount})`);
      return await this.findOne({ category: 'bought' });
    }
    try {
      const result = await this.findOneAndUpdate(
        { category: 'bought' },
        { $inc: { amount } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      logger.info(`Logged purchase ${amount} SKYNET (key=${idempotencyKey})`);
      return result;
    } catch (err) {
      // Rollback the historical record so a future retry can actually execute.
      await HistoricalTransaction.deleteOne({ _id: histTx._id }).catch(() => {});
      throw err;
    }
  }

  // Non-idempotent path (backward compatible)
  const result = await this.findOneAndUpdate(
    { category: 'bought' },
    { $inc: { amount } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  await logTransaction('purchase', 'bought', amount, 'Token purchase from Token Trader', { txHash, network });
  return result;
};

/**
 * Record a token sale (from bought category only).
 * Atomic balance check + decrement via findOneAndUpdate with $gte guard —
 * race-safe without requiring MongoDB transactions / replica set.
 * When idempotencyKey is provided, retries with the same key are no-ops.
 */
skynetTokenLedgerSchema.statics.recordSale = async function(amount, { idempotencyKey = null, txHash = null, network = 'bsc' } = {}) {
  if (idempotencyKey) {
    const { created, doc: histTx } = await _writeHistoricalIdempotent({
      transactionType: 'sale',
      category: 'bought',
      amount,
      description: 'Token sale',
      idempotencyKey,
      txHash,
      network
    });
    if (!created) {
      logger.info(`Idempotent sale no-op (key=${idempotencyKey}, amount=${amount})`);
      return await this.findOne({ category: 'bought' });
    }
    const result = await this.findOneAndUpdate(
      { category: 'bought', amount: { $gte: amount } },
      { $inc: { amount: -amount } },
      { new: true }
    );
    if (!result) {
      // Insufficient balance — rollback log so future retries can execute.
      await HistoricalTransaction.deleteOne({ _id: histTx._id }).catch(() => {});
      const bought = await this.findOne({ category: 'bought' });
      throw new Error(`Cannot sell ${amount} SKYNET: only ${bought?.amount || 0} tradeable tokens available`);
    }
    return result;
  }

  // Non-idempotent path: still atomic + race-safe.
  const result = await this.findOneAndUpdate(
    { category: 'bought', amount: { $gte: amount } },
    { $inc: { amount: -amount } },
    { new: true }
  );
  if (!result) {
    const bought = await this.findOne({ category: 'bought' });
    throw new Error(`Cannot sell ${amount} SKYNET: only ${bought?.amount || 0} tradeable tokens available`);
  }
  await logTransaction('sale', 'bought', amount, 'Token sale', { txHash, network });
  return result;
};

/**
 * Initialize ledger with post-deployment allocations
 */
skynetTokenLedgerSchema.statics.initializeAllocations = async function() {
  const allocations = [
    { category: 'lp', amount: 50_000_000, initialAmount: 50_000_000, source: 'minted', description: 'PancakeSwap SKYNET/BNB liquidity pool' },
    { category: 'staking', amount: 20_000_000, initialAmount: 20_000_000, source: 'minted', description: 'Reputation staking rewards pool' },
    { category: 'bounty', amount: 10_000_000, initialAmount: 10_000_000, source: 'minted', description: 'Bounty system funding' },
    { category: 'treasury', amount: 10_000_000, initialAmount: 10_000_000, source: 'minted', description: 'Development treasury (held by ALICE)' },
    { category: 'reserve', amount: 10_000_000, initialAmount: 10_000_000, source: 'minted', description: 'Future instance airdrops and ecosystem growth' },
    { category: 'bought', amount: 0, initialAmount: 0, source: 'bought', description: 'Tokens acquired via market purchases (tradeable)' }
  ];

  const results = [];
  for (const alloc of allocations) {
    const result = await this.findOneAndUpdate(
      { category: alloc.category },
      alloc,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    results.push(result);
  }
  return results;
};

/**
 * Get full ledger summary
 */
skynetTokenLedgerSchema.statics.getSummary = async function() {
  const entries = await this.find({}).sort({ category: 1 });
  const summary = {
    entries: entries.map(e => ({
      category: e.category,
      amount: e.amount,
      initialAmount: e.initialAmount,
      source: e.source,
      description: e.description
    })),
    totalMinted: entries.filter(e => e.source === 'minted').reduce((s, e) => s + e.amount, 0),
    totalBought: entries.filter(e => e.source === 'bought').reduce((s, e) => s + e.amount, 0),
    totalTradeable: entries.filter(e => e.category === 'bought').reduce((s, e) => s + e.amount, 0)
  };
  return summary;
};

const SkynetTokenLedger = mongoose.model('SkynetTokenLedger', skynetTokenLedgerSchema);
export default SkynetTokenLedger;
