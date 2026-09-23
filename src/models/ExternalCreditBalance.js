import mongoose from 'mongoose';

const apiKeySchema = new mongoose.Schema({
  // key: indexed via externalCreditBalanceSchema.index({'apiKeys.key':1}) below.
  // unique/index on a subdocument field doesn't enforce uniqueness across the
  // outer collection anyway (Mongoose builds a multikey index, not a unique one).
  key: {
    type: String,
    required: true
  },
  name: {
    type: String,
    default: 'Default'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastUsed: {
    type: Date,
    default: null
  },
  revoked: {
    type: Boolean,
    default: false
  },
  category: {
    type: String,
    default: 'general'
  },
  tags: {
    type: [String],
    default: []
  }
}, { _id: false });

const transactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['debit', 'refund'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  category: {
    type: String,
    default: 'general'
  },
  tags: {
    type: [String],
    default: []
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  description: {
    type: String,
    default: ''
  }
}, { _id: false });

// Transactions live inline on the balance document, so the array has to be
// bounded: a 16 MB document cap turns "unbounded history" into a hard failure
// of debitCredits() for that wallet — i.e. a paying customer who can no longer
// spend. $slice keeps the most recent N and discards the tail on every write.
export const TRANSACTION_HISTORY_LIMIT = 500;

const externalCreditBalanceSchema = new mongoose.Schema({
  wallet: {
    type: String,
    required: true,
    unique: true,
    index: true,
    lowercase: true
  },
  credits: {
    type: Number,
    default: 0,
    min: 0
  },
  totalPurchased: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  totalRefunded: {
    type: Number,
    default: 0
  },
  apiKeys: {
    type: [apiKeySchema],
    default: []
  },
  transactions: {
    type: [transactionSchema],
    default: []
  },
  lastPurchase: {
    type: Date,
    default: null
  },
  lastUsed: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for API key lookup
externalCreditBalanceSchema.index({ 'apiKeys.key': 1 });

/**
 * Find account by wallet address
 */
externalCreditBalanceSchema.statics.findByWallet = function (wallet) {
  return this.findOne({ wallet: wallet.toLowerCase() });
};

/**
 * Find account by active (non-revoked) API key
 */
externalCreditBalanceSchema.statics.findByApiKey = function (key) {
  return this.findOne({
    'apiKeys.key': key,
    'apiKeys': { $elemMatch: { key, revoked: false } }
  });
};

/**
 * Debit credits atomically. Returns updated doc or null if insufficient.
 */
externalCreditBalanceSchema.statics.debitCredits = async function (wallet, amount, options = {}) {
  const { category = 'general', tags = [], description = '' } = options;
  
  const result = await this.findOneAndUpdate(
    { wallet: wallet.toLowerCase(), credits: { $gte: amount } },
    {
      $inc: { credits: -amount, totalSpent: amount },
      $set: { lastUsed: new Date() },
      $push: {
        transactions: {
          $each: [{ type: 'debit', amount, category, tags, description, timestamp: new Date() }],
          $slice: -TRANSACTION_HISTORY_LIMIT
        }
      }
    },
    { new: true }
  );
  return result;
};

/**
 * Refund credits atomically.
 */
externalCreditBalanceSchema.statics.refundCredits = async function (wallet, amount, options = {}) {
  const { category = 'general', tags = [], description = '' } = options;
  
  const result = await this.findOneAndUpdate(
    { wallet: wallet.toLowerCase() },
    {
      $inc: { credits: amount, totalRefunded: amount, totalSpent: -amount },
      $push: {
        transactions: {
          $each: [{ type: 'refund', amount, category, tags, description, timestamp: new Date() }],
          $slice: -TRANSACTION_HISTORY_LIMIT
        }
      }
    },
    { new: true }
  );
  return result;
};

/**
 * Get credit balance analytics for a wallet
 */
externalCreditBalanceSchema.statics.getCreditAnalytics = async function (wallet) {
  const balance = await this.findByWallet(wallet);
  if (!balance) {
    throw new Error('Wallet not found');
  }

  // Calculate credit utilization ratio
  const creditUtilizationRatio = balance.totalPurchased > 0 
    ? balance.totalSpent / balance.totalPurchased 
    : 0;

  // Calculate remaining credits percentage
  const remainingCreditsPercentage = balance.totalPurchased > 0 
    ? (balance.credits / balance.totalPurchased) * 100 
    : 0;

  // Calculate refund ratio
  const refundRatio = balance.totalSpent > 0 
    ? balance.totalRefunded / balance.totalSpent 
    : 0;

  return {
    wallet: balance.wallet,
    currentBalance: balance.credits,
    totalPurchased: balance.totalPurchased,
    totalSpent: balance.totalSpent,
    totalRefunded: balance.totalRefunded,
    creditUtilizationRatio: parseFloat(creditUtilizationRatio.toFixed(4)),
    remainingCreditsPercentage: parseFloat(remainingCreditsPercentage.toFixed(2)),
    refundRatio: parseFloat(refundRatio.toFixed(4)),
    lastPurchase: balance.lastPurchase,
    lastUsed: balance.lastUsed,
    createdAt: balance.createdAt,
    updatedAt: balance.updatedAt
  };
};

/**
 * Get transaction history with optional filtering.
 *
 * Returns at most the last TRANSACTION_HISTORY_LIMIT transactions — the array is
 * capped at write time, so this is recent history, not an audit log. Filters are
 * applied in memory, which is fine against a bounded array.
 */
externalCreditBalanceSchema.statics.getTransactionHistory = async function (wallet, filters = {}) {
  const { category, tags, dateRange } = filters;
  const balance = await this.findByWallet(wallet);
  
  if (!balance) {
    throw new Error('Wallet not found');
  }
  
  let transactions = [...(balance.transactions || [])];
  
  // Apply category filter
  if (category) {
    transactions = transactions.filter(tx => tx.category === category);
  }
  
  // Apply tags filter
  if (tags && Array.isArray(tags) && tags.length > 0) {
    transactions = transactions.filter(tx =>
      tags.some(tag => (tx.tags || []).includes(tag))
    );
  }
  
  // Apply date range filter
  if (dateRange) {
    const { start, end } = dateRange;
    if (start) {
      const from = new Date(start);
      transactions = transactions.filter(tx => tx.timestamp >= from);
    }
    if (end) {
      const to = new Date(end);
      transactions = transactions.filter(tx => tx.timestamp <= to);
    }
  }
  
  // Sort by timestamp descending
  transactions.sort((a, b) => b.timestamp - a.timestamp);
  
  return transactions;
};

const ExternalCreditBalance = mongoose.model('ExternalCreditBalance', externalCreditBalanceSchema);
export default ExternalCreditBalance;
