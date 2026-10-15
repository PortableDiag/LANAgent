import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

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
    // 'completed' = an OUTGOING transfer whose chunks were all sent (pluginSharing
    // sets it). It was missing here, so that save() threw and a successful send
    // was logged as "P2P failed to send plugin".
    enum: ['pending', 'transferring', 'awaiting_approval', 'approved', 'rejected', 'installed', 'failed', 'completed', 'cancelled'],
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
 * Allowed status transitions, matching what pluginSharing actually does:
 * transfers are created 'transferring'; an outgoing one ends 'completed'; an
 * incoming one goes to 'awaiting_approval', or straight to 'approved' when the
 * peer is trusted for auto-install; an install can still fail after approval.
 * A failed transfer is retried by re-requesting it (a NEW doc), so 'failed' is
 * terminal. Cancel exists for transfers stuck mid-flight or never acted on.
 */
p2pTransferSchema.statics.transitionMap = {
  pending: ['transferring', 'failed', 'cancelled'],
  transferring: ['awaiting_approval', 'approved', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'rejected', 'failed', 'cancelled'],
  approved: ['installed', 'failed'],
  completed: [],
  rejected: [],
  installed: [],
  failed: [],
  cancelled: []
};

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
 * Lean fetch for the progress endpoint — selects only the fields
 * needed by the progress methods, returning a hydrated doc so the
 * instance methods are callable.
 */
p2pTransferSchema.statics.getTransferProgress = function(transferId) {
  return this.findById(transferId)
    .select('peerFingerprint pluginName direction status totalChunks receivedChunks totalSize startedAt completedAt');
};

/**
 * Atomically transition a transfer to a new status.
 * Uses findOneAndUpdate with a condition on the current status to ensure
 * only valid transitions are performed. Returns the updated document or
 * null if the transition is invalid (current status not in allowed set).
 *
 * @param {string} transferId - The transfer document ID
 * @param {string} newStatus - The target status
 * @param {object} [additionalFields={}] - Additional fields to set (e.g., { error: 'reason' })
 * @returns {Promise<object|null>} The updated transfer document, or null if transition failed
 */
p2pTransferSchema.statics.transitionStatus = async function(transferId, newStatus, additionalFields = {}) {
  // Validate newStatus is a valid enum value
  const validStatuses = this.schema.path('status').enumValues;
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Must be one of: ${validStatuses.join(', ')}`);
  }

  // Determine which current statuses allow transition to newStatus
  const allowedCurrentStatuses = Object.keys(this.transitionMap).filter(
    currentStatus => this.transitionMap[currentStatus].includes(newStatus)
  );

  if (allowedCurrentStatuses.length === 0) {
    logger.warn(`No transitions lead to status '${newStatus}'. Transfer ${transferId} cannot be updated.`);
    return null;
  }

  // For approved/installed, verify payload integrity before attempting transition
  if (['approved', 'installed'].includes(newStatus)) {
    const doc = await this.findById(transferId);
    if (!doc) {
      logger.warn(`Transfer ${transferId} not found for integrity check`);
      return null;
    }
    const verification = doc.verifyPayloadIntegrity();
    if (!verification.verified) {
      logger.warn(`Payload integrity check failed for transfer ${transferId} transitioning to ${newStatus}: ${verification.reason}`);
      return null;
    }
  }

  // Build the update object
  const update = { $set: { status: newStatus, ...additionalFields } };
  if (['cancelled', 'failed', 'rejected', 'installed', 'completed'].includes(newStatus)) {
    update.$set.completedAt = new Date();
  }
  // A cancelled or rejected transfer must not keep unreviewed code in the DB
  if (['cancelled', 'rejected'].includes(newStatus)) {
    update.$set.assembledSource = '';
  }

  // Atomic update with retry for transient database errors
  const updateFn = async () => {
    return this.findOneAndUpdate(
      { _id: transferId, status: { $in: allowedCurrentStatuses } },
      update,
      { new: true, runValidators: true }
    );
  };

  try {
    const updated = await retryOperation(updateFn, { retries: 3, minTimeout: 100, maxTimeout: 500 });
    if (updated) {
      logger.info(`Transfer ${transferId} status transitioned to '${newStatus}'`);
    } else {
      logger.warn(`Transfer ${transferId} status transition to '${newStatus}' failed: current status not in allowed set or document not found`);
    }
    return updated;
  } catch (error) {
    logger.error(`Error transitioning transfer ${transferId} to ${newStatus}: ${error.message}`);
    throw error;
  }
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

/**
 * Verify the assembled payload against its stored SHA-256 digest.
 * The digest comparison is timing-safe when the stored value is valid hex.
 */
p2pTransferSchema.methods.verifyPayloadIntegrity = function() {
  const actualHash = crypto
    .createHash('sha256')
    .update(typeof this.assembledSource === 'string' ? this.assembledSource : '')
    .digest('hex');
  const expectedHash = typeof this.sha256 === 'string' ? this.sha256.trim().toLowerCase() : '';
  const expectedBuffer = /^[a-f0-9]{64}$/.test(expectedHash)
    ? Buffer.from(expectedHash, 'hex')
    : null;
  const actualBuffer = Buffer.from(actualHash, 'hex');
  const valid = Boolean(
    expectedBuffer &&
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );

  return {
    verified: valid,
    expectedSha256: expectedHash,
    actualSha256: actualHash,
    reason: valid ? null : (
      expectedBuffer
        ? 'Assembled payload SHA-256 does not match the stored digest'
        : 'Stored SHA-256 digest is missing or invalid'
    )
  };
};

/**
 * Cancel this transfer with an optional reason.
 * Calls transitionStatus to atomically move to 'cancelled' and sets the error field.
 *
 * @param {string} [reason] - Reason for cancellation
 * @returns {Promise<object|null>} The updated transfer document, or null if cancellation failed
 */
p2pTransferSchema.methods.cancel = async function(reason) {
  const updated = await this.constructor.transitionStatus(this._id, 'cancelled', { error: reason || 'Cancelled by user' });
  if (updated) {
    // Update local instance to reflect the change
    this.status = updated.status;
    this.error = updated.error;
    this.completedAt = updated.completedAt;
  }
  return updated;
};

// Defence in depth: pluginSharing verifies the hash when chunks are assembled, but
// approveInstall() later installs whatever assembledSource is in the DB. Refuse to
// enter approved/installed if that stored source no longer matches its digest.
p2pTransferSchema.pre('validate', function(next) {
  if (['approved', 'installed'].includes(this.status)) {
    const verification = this.verifyPayloadIntegrity();
    if (!verification.verified) {
      this.invalidate(
        'status',
        `Cannot transition to ${this.status}: payload integrity verification failed: ${verification.reason}`
      );
    }
  }
  next();
});

export const P2PTransfer = mongoose.model('P2PTransfer', p2pTransferSchema);
