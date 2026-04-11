import mongoose from 'mongoose';

const p2pTransferSchema = new mongoose.Schema({
  // Which peer the transfer is with
  peerFingerprint: {
    type: String,
    required: true,
    index: true
  },

  // Plugin info
  pluginName: {
    type: String,
    required: true
  },
  pluginVersion: {
    type: String,
    default: '1.0.0'
  },

  // Transfer direction
  direction: {
    type: String,
    enum: ['incoming', 'outgoing'],
    required: true
  },

  // Transfer status
  status: {
    type: String,
    enum: ['pending', 'transferring', 'awaiting_approval', 'approved', 'rejected', 'installed', 'failed'],
    default: 'pending'
  },

  // Chunked transfer progress
  totalChunks: {
    type: Number,
    default: 0
  },
  receivedChunks: {
    type: Number,
    default: 0
  },
  totalSize: {
    type: Number,
    default: 0
  },

  // Verification
  sha256: {
    type: String,
    default: ''
  },
  signatureVerified: {
    type: Boolean,
    default: false
  },
  signerFingerprint: {
    type: String,
    default: ''
  },

  // Plugin manifest (for incoming transfers awaiting approval)
  manifest: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },

  // Assembled source code (stored temporarily until approved/rejected)
  assembledSource: {
    type: String,
    default: ''
  },

  // Error info
  error: {
    type: String,
    default: ''
  },

  // Timestamps
  startedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes
p2pTransferSchema.index({ status: 1 });
p2pTransferSchema.index({ direction: 1, status: 1 });
p2pTransferSchema.index({ createdAt: -1 });

/**
 * Get all transfers awaiting user approval
 */
p2pTransferSchema.statics.getPendingApprovals = function() {
  return this.find({ status: 'awaiting_approval', direction: 'incoming' }).sort({ createdAt: -1 });
};

/**
 * Get transfer history
 */
p2pTransferSchema.statics.getHistory = function(limit = 50) {
  return this.find().sort({ createdAt: -1 }).limit(limit);
};

/**
 * Get transfers for a specific peer
 */
p2pTransferSchema.statics.getForPeer = function(peerFingerprint) {
  return this.find({ peerFingerprint }).sort({ createdAt: -1 });
};

export const P2PTransfer = mongoose.model('P2PTransfer', p2pTransferSchema);
