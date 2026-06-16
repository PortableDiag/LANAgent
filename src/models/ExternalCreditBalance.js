import mongoose from 'mongoose';

const apiKeySchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true
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
  }
}, { _id: false });

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
externalCreditBalanceSchema.statics.debitCredits = async function (wallet, amount) {
  const result = await this.findOneAndUpdate(
    { wallet: wallet.toLowerCase(), credits: { $gte: amount } },
    {
      $inc: { credits: -amount, totalSpent: amount },
      $set: { lastUsed: new Date() }
    },
    { new: true }
  );
  return result;
};

/**
 * Refund credits atomically.
 */
externalCreditBalanceSchema.statics.refundCredits = async function (wallet, amount) {
  const result = await this.findOneAndUpdate(
    { wallet: wallet.toLowerCase() },
    {
      $inc: { credits: amount, totalRefunded: amount, totalSpent: -amount }
    },
    { new: true }
  );
  return result;
};

const ExternalCreditBalance = mongoose.model('ExternalCreditBalance', externalCreditBalanceSchema);
export default ExternalCreditBalance;
