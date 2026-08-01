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

/**
 * Progress percentage clamped to 0..100.
 * Returns 0 when totalChunks is unknown.
 */
p2pTransferSchema.methods.getProgressPercentage = function() {
  if (!this.totalChunks || this.totalChunks <= 0) return 0;
  const pct = (this.receivedChunks / this.totalChunks) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
};

/**
 * Average transfer speed in bytes/second since `startedAt`.
 * Uses (totalSize * progressFraction) / elapsed so it doesn't rely on
 * uniform chunk size — the last chunk is typically smaller, so
 * (receivedChunks * avgChunkBytes) over-counts mildly on the final
 * stretch. Returns 0 when speed can't be meaningfully computed.
 */
p2pTransferSchema.methods.getTransferSpeed = function() {
  if (!this.startedAt) return 0;
  if (!this.totalSize || this.totalSize <= 0) return 0;
  if (!this.totalChunks || this.totalChunks <= 0) return 0;
  if (this.receivedChunks <= 0) return 0;
  const elapsedSec = (Date.now() - this.startedAt.getTime()) / 1000;
  if (elapsedSec <= 0) return 0;
  const fraction = Math.min(1, this.receivedChunks / this.totalChunks);
  const bytesTransferred = this.totalSize * fraction;
  return Math.round(bytesTransferred / elapsedSec);
};

/**
 * Estimated seconds until completion at current average rate.
 * Returns 0 when already complete, null when insufficient data
 * (so the caller can render "calculating…" rather than misleading 0).
 */
p2pTransferSchema.methods.getETA = function() {
  if (!this.startedAt) return null;
  if (!this.totalChunks || this.totalChunks <= 0) return null;
  if (this.receivedChunks <= 0) return null;
  if (this.receivedChunks >= this.totalChunks) return 0;
  const elapsedSec = (Date.now() - this.startedAt.getTime()) / 1000;
  if (elapsedSec <= 0) return null;
  const progress = this.receivedChunks / this.totalChunks;
  const projectedTotalSec = elapsedSec / progress;
  return Math.max(0, Math.round(projectedTotalSec - elapsedSec));
};

/**
 * Composite progress snapshot for /api/p2p/transfers/:id/progress.
 */
p2pTransferSchema.methods.getProgressInfo = function() {
  return {
    transferId: this._id,
    pluginName: this.pluginName,
    direction: this.direction,
    status: this.status,
    totalChunks: this.totalChunks,
    receivedChunks: this.receivedChunks,
    totalSize: this.totalSize,
    progressPercentage: this.getProgressPercentage(),
    transferSpeedBytesPerSec: this.getTransferSpeed(),
    etaSeconds: this.getETA(),
    startedAt: this.startedAt,
    completedAt: this.completedAt
  };
};

/**
 * Lean fetch for the progress endpoint — selects only the fields
 * needed by the progress methods, returning a hydrated doc so the
 * instance methods are callable.
 */
p2pTransferSchema.statics.getTransferProgress = function(transferId) {
  return this.findById(transferId)
    .select('peerFingerprint pluginName direction status totalChunks receivedChunks totalSize startedAt completedAt');
};

/**
 * Whether this transfer can be retried. Only failed INCOMING transfers
 * qualify: a retry re-requests the plugin from the peer, and outgoing
 * transfers are peer-initiated (the peer must re-request, we can't force
 * it). In-flight/pending transfers are not retryable — they haven't failed.
 * Retrying creates a fresh transfer via the normal request flow; the
 * failed record is left untouched as the audit trail.
 */
p2pTransferSchema.methods.isRetryable = function() {
  return this.status === 'failed' && this.direction === 'incoming';
};

export const P2PTransfer = mongoose.model('P2PTransfer', p2pTransferSchema);
