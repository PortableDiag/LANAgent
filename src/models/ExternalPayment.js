import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const externalPaymentSchema = new mongoose.Schema({
  txHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  chain: {
    type: String,
    required: true,
    default: 'bsc'
  },
  serviceId: {
    type: String,
    required: true
  },
  callerAgentId: {
    type: String,
    required: true
  },
  amount: {
    type: String,
    required: true
  },
  recipientAddress: {
    type: String,
    required: true
  },
  blockNumber: {
    type: Number,
    default: 0
  },
  confirmations: {
    type: Number,
    default: 0
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  // Confirmation threshold for finality. If null, falls back to per-chain default.
  finalityRequired: {
    type: Number,
    default: null
  },
  // Set once confirmations >= the resolved finality threshold.
  finalizedAt: {
    type: Date,
    default: null
  },
  consumed: {
    type: Boolean,
    default: false
  },
  consumedAt: {
    type: Date,
    default: null
  },
  // Credit-purchase records (serviceId === 'credit-purchase') populate these so
  // the payment row alone tells the full story without joining to the balance.
  currency: { type: String, default: null },
  creditsIssued: { type: Number, default: null },
  bonusCredits: { type: Number, default: 0 },
  promotion: { type: String, default: null },
  usdValue: { type: Number, default: null }
}, {
  timestamps: true
});

externalPaymentSchema.index({ callerAgentId: 1, createdAt: -1 });
externalPaymentSchema.index({ serviceId: 1, createdAt: -1 });

// Queue-oriented compound indexes for atomic "next verified, unconsumed" scans.
externalPaymentSchema.index({ consumed: 1, verifiedAt: 1, serviceId: 1, createdAt: 1 });
externalPaymentSchema.index({ serviceId: 1, consumed: 1, createdAt: -1 });

/**
 * Atomically claim the next verified+unconsumed payment for a service. Uses
 * findOneAndUpdate with sort:{createdAt:1} to enforce FIFO + exactly-once.
 */
externalPaymentSchema.statics.acquireNextVerified = async function acquireNextVerified(serviceId, opts = {}) {
  if (!serviceId) {
    logger.error('ExternalPayment.acquireNextVerified called without serviceId');
    throw new Error('serviceId is required');
  }
  const retries = Number.isInteger(opts.retries) ? opts.retries : 3;
  return retryOperation(async () => {
    const doc = await this.findOneAndUpdate(
      { serviceId, verifiedAt: { $ne: null }, consumed: false },
      { $set: { consumed: true, consumedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: 'after', new: true }
    );
    if (doc) {
      logger.debug('ExternalPayment.acquireNextVerified acquired', { serviceId, id: doc._id?.toString?.(), txHash: doc.txHash });
    }
    return doc;
  }, { retries });
};

/**
 * Idempotently mark a specific payment doc consumed if not already.
 * Safe to call repeatedly; returns true if newly consumed OR already consumed,
 * false only when the document is missing.
 */
externalPaymentSchema.statics.consumeIfUnconsumed = async function consumeIfUnconsumed(id, opts = {}) {
  if (!id) {
    logger.error('ExternalPayment.consumeIfUnconsumed called without id');
    throw new Error('id is required');
  }
  const retries = Number.isInteger(opts.retries) ? opts.retries : 3;
  return retryOperation(async () => {
    const updated = await this.findOneAndUpdate(
      { _id: id, consumed: false },
      { $set: { consumed: true, consumedAt: new Date() } },
      { returnDocument: 'after', new: true }
    );
    if (updated) {
      logger.info('ExternalPayment.consumeIfUnconsumed consumed', { id: updated._id?.toString?.(), txHash: updated.txHash });
      return true;
    }
    const existing = await this.findById(id, { _id: 1, consumed: 1 }).lean();
    if (existing && existing.consumed) {
      logger.debug('ExternalPayment.consumeIfUnconsumed already consumed', { id: id.toString() });
      return true;
    }
    logger.warn('ExternalPayment.consumeIfUnconsumed document not found', { id: id.toString() });
    return false;
  }, { retries });
};

/**
 * Mark a payment as verified by tx hash — updates verification fields only,
 * does not touch consumption state.
 */
externalPaymentSchema.statics.markVerifiedByTx = async function markVerifiedByTx(txHash, fields = {}, opts = {}) {
  if (!txHash) {
    logger.error('ExternalPayment.markVerifiedByTx called without txHash');
    throw new Error('txHash is required');
  }
  const retries = Number.isInteger(opts.retries) ? opts.retries : 3;
  const payload = {};
  if (typeof fields.blockNumber === 'number') payload.blockNumber = fields.blockNumber;
  if (typeof fields.confirmations === 'number') payload.confirmations = fields.confirmations;
  if (fields.verifiedAt) payload.verifiedAt = new Date(fields.verifiedAt);

  return retryOperation(async () => {
    const updated = await this.findOneAndUpdate(
      { txHash },
      { $set: payload },
      { returnDocument: 'after', new: true }
    );
    if (!updated) {
      logger.warn('ExternalPayment.markVerifiedByTx not found for txHash', { txHash });
      return null;
    }
    logger.info('ExternalPayment.markVerifiedByTx updated', {
      txHash, blockNumber: updated.blockNumber, confirmations: updated.confirmations, verifiedAt: updated.verifiedAt
    });
    return updated;
  }, { retries });
};

// Per-chain confirmation defaults for finality. Tuned to widely-cited reorg
// resistance thresholds for each network; override per-row via finalityRequired.
const CHAIN_FINALITY_DEFAULTS = {
  bsc: 15, eth: 12, ethereum: 12, polygon: 100, matic: 100,
  avalanche: 20, avax: 20, arbitrum: 12, optimism: 12, base: 12
};

/**
 * Update confirmations/blockNumber for a tx and auto-set verifiedAt /
 * finalizedAt when their thresholds are met. Race-safe: uses atomic $max for
 * monotonic fields and conditional $set with filter guards for the
 * once-only timestamp fields.
 *
 * @param {string} txHash
 * @param {Object} fields
 * @param {number} [fields.confirmations]
 * @param {number} [fields.blockNumber]
 * @param {number} [fields.finalityRequired] - per-row override
 * @param {Date|string|number} [fields.verifiedAt] - explicit verifiedAt override
 * @param {Object} [opts] - { retries }
 */
externalPaymentSchema.statics.updateConfirmationsByTx = async function updateConfirmationsByTx(txHash, fields = {}, opts = {}) {
  if (!txHash) throw new Error('txHash is required');
  const retries = Number.isInteger(opts.retries) ? opts.retries : 3;

  return retryOperation(async () => {
    const existing = await this.findOne(
      { txHash },
      { txHash: 1, chain: 1, confirmations: 1, blockNumber: 1, verifiedAt: 1, finalizedAt: 1, finalityRequired: 1 }
    );
    if (!existing) {
      logger.warn('ExternalPayment.updateConfirmationsByTx not found for txHash', { txHash });
      return null;
    }

    const incomingConf = typeof fields.confirmations === 'number'
      ? Math.max(0, Math.floor(fields.confirmations)) : null;
    const incomingBlock = typeof fields.blockNumber === 'number'
      ? Math.floor(fields.blockNumber) : null;
    const explicitVerifiedAt = fields.verifiedAt ? new Date(fields.verifiedAt) : null;

    const newFinalityRequired = (typeof fields.finalityRequired === 'number' && fields.finalityRequired > 0)
      ? Math.floor(fields.finalityRequired) : null;

    const effectiveFinalityRequired = newFinalityRequired ?? existing.finalityRequired;
    const chainKey = String(existing.chain || '').toLowerCase();
    const threshold = (typeof effectiveFinalityRequired === 'number' && effectiveFinalityRequired > 0)
      ? effectiveFinalityRequired
      : (CHAIN_FINALITY_DEFAULTS[chainKey] ?? 12);

    const effectiveConf = incomingConf != null
      ? Math.max(existing.confirmations || 0, incomingConf)
      : (existing.confirmations || 0);

    const set = {};
    const max = {};
    if (incomingConf != null) max.confirmations = incomingConf;
    if (incomingBlock != null) max.blockNumber = incomingBlock;
    if (newFinalityRequired != null && existing.finalityRequired !== newFinalityRequired) {
      set.finalityRequired = newFinalityRequired;
    }
    if (explicitVerifiedAt && !isNaN(explicitVerifiedAt.getTime())) {
      if (!existing.verifiedAt || existing.verifiedAt.getTime() !== explicitVerifiedAt.getTime()) {
        set.verifiedAt = explicitVerifiedAt;
      }
    } else if (!existing.verifiedAt && effectiveConf >= 1) {
      set.verifiedAt = new Date();
    }
    if (!existing.finalizedAt && effectiveConf >= threshold) {
      set.finalizedAt = new Date();
    }

    const updateDoc = {};
    if (Object.keys(set).length) updateDoc.$set = set;
    if (Object.keys(max).length) updateDoc.$max = max;

    if (Object.keys(updateDoc).length === 0) return existing;

    const updated = await this.findOneAndUpdate({ txHash }, updateDoc, { new: true });
    if (!updated) return null;

    logger.info('ExternalPayment.updateConfirmationsByTx', {
      txHash, chain: existing.chain, threshold,
      confirmations: { from: existing.confirmations, to: updated.confirmations },
      verifiedAt: { from: existing.verifiedAt, to: updated.verifiedAt },
      finalizedAt: { from: existing.finalizedAt, to: updated.finalizedAt }
    });
    return updated;
  }, { retries });
};

const ExternalPayment = mongoose.model('ExternalPayment', externalPaymentSchema);
export default ExternalPayment;
