import mongoose from 'mongoose';

/**
 * SkynetPayment - Tracks SKYNET token payments between Skynet peers.
 *
 * Follows the ExternalPayment pattern but for BEP-20 SKYNET token transfers
 * instead of native BNB transfers.
 */
const skynetPaymentSchema = new mongoose.Schema({
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
  fromFingerprint: {
    type: String,
    required: true
  },
  fromAddress: {
    type: String,
    required: true
  },
  toAddress: {
    type: String,
    required: true
  },
  amount: {
    type: String,
    required: true
  },
  tokenAddress: {
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
  consumed: {
    type: Boolean,
    default: false
  },
  consumedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

skynetPaymentSchema.index({ fromFingerprint: 1, createdAt: -1 });
skynetPaymentSchema.index({ serviceId: 1, createdAt: -1 });

const SkynetPayment = mongoose.model('SkynetPayment', skynetPaymentSchema);
export default SkynetPayment;
