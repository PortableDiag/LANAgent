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
    enum: ['lp', 'staking', 'bounty', 'treasury', 'reserve', 'bought', 'registryFees'],
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
    enum: ['purchase', 'sale', 'feeIncome', 'feeDebit', 'stakingClaim', 'stakingFund']
  },
  category: {
    type: String,
    required: true,
    enum: ['lp', 'staking', 'bounty', 'treasury', 'reserve', 'bought', 'registryFees']
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
  }
});

const HistoricalTransaction = mongoose.model('HistoricalTransaction', historicalTransactionSchema);

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
 * Record a token purchase (from Token Trader)
 */
skynetTokenLedgerSchema.statics.recordPurchase = async function(amount) {
  const result = await this.findOneAndUpdate(
    { category: 'bought' },
    { $inc: { amount: amount } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  await logTransaction('purchase', 'bought', amount, 'Token purchase from Token Trader');
  return result;
};

/**
 * Record a token sale (only from bought category)
 */
skynetTokenLedgerSchema.statics.recordSale = async function(amount) {
  const bought = await this.findOne({ category: 'bought' });
  if (!bought || bought.amount < amount) {
    throw new Error(`Cannot sell ${amount} SKYNET: only ${bought?.amount || 0} tradeable tokens available`);
  }
  bought.amount -= amount;
  await bought.save();
  await logTransaction('sale', 'bought', amount, 'Token sale');
  return bought;
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
 * Record registry fee income (fees returned to genesis wallet after reporting)
 */
skynetTokenLedgerSchema.statics.recordFeeIncome = async function(amount) {
  const result = await this.findOneAndUpdate(
    { category: 'registryFees' },
    { $inc: { amount: amount }, $setOnInsert: { initialAmount: 0, source: 'minted', description: 'Scammer registry fee income (routable to staking)' } },
    { new: true, upsert: true }
  );
  await logTransaction('feeIncome', 'registryFees', amount, 'Registry fee income');
  return result;
};

/**
 * Debit registry fees when routed to staking rewards
 */
skynetTokenLedgerSchema.statics.debitFeesForStaking = async function(amount) {
  const fees = await this.findOne({ category: 'registryFees' });
  if (!fees || fees.amount < amount) {
    throw new Error(`Cannot route ${amount} SKYNET: only ${fees?.amount || 0} in registry fee balance`);
  }
  fees.amount -= amount;
  await fees.save();
  await logTransaction('feeDebit', 'registryFees', amount, 'Debit fees for staking');
  return fees;
};

/**
 * Get available registry fee balance (unrouted)
 */
skynetTokenLedgerSchema.statics.getRegistryFeeBalance = async function() {
  const fees = await this.findOne({ category: 'registryFees' });
  return fees ? fees.amount : 0;
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
