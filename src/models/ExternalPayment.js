import mongoose from 'mongoose';

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

externalPaymentSchema.index({ callerAgentId: 1, createdAt: -1 });
externalPaymentSchema.index({ serviceId: 1, createdAt: -1 });

const ExternalPayment = mongoose.model('ExternalPayment', externalPaymentSchema);
export default ExternalPayment;
