import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const p2pPeerSchema = new mongoose.Schema({
  // Unique identity
  fingerprint: {
    type: String,
    required: true,
    unique: true,
    match: /^[0-9a-f]{32}$/
  },

  // Display name (optional, set by peer)
  displayName: {
    type: String,
    default: ''
  },

  // Peer's Ed25519 signing public key (DER, base64 encoded)
  signPublicKey: {
    type: String,
    required: true
  },

  // Peer's X25519 DH public key (DER, base64 encoded)
  dhPublicKey: {
    type: String,
    required: true
  },

  // Trust level determines auto-install behavior
  trustLevel: {
    type: String,
    enum: ['untrusted', 'trusted'],
    default: 'untrusted'
  },

  // Timestamps
  firstSeen: {
    type: Date,
    default: Date.now
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },

  // Replay protection
  lastSeq: {
    type: Number,
    default: 0
  },

  // Capabilities
  capabilitiesHash: {
    type: String,
    default: ''
  },
  capabilities: [{
    name: String,
    version: String,
    description: String
  }],

  // Transfer stats
  transferCount: {
    type: Number,
    default: 0
  },

  // Cumulative connection time across all sessions, in seconds
  totalConnectionSeconds: {
    type: Number,
    default: 0
  },

  // Total number of times this peer has come online (session count).
  // Increments once per markOnline call.
  sessionCount: {
    type: Number,
    default: 0
  },

  // Number of times this peer reconnected after a prior session (so first-ever
  // connection is not counted; only sessions 2..N). reconnectionCount = sessionCount - 1
  // for any peer that has connected at least once, but stored explicitly so
  // markOnline doesn't have to derive it under race conditions.
  reconnectionCount: {
    type: Number,
    default: 0
  },

  // Optional ERC-8004 NFT verification
  erc8004: {
    verified: { type: Boolean, default: false },
    agentId: { type: Number },
    txHash: { type: String },
    verifiedAt: { type: Date }
  },

  // Skynet service payment info (from capability exchange)
  skynetWallet: {
    type: String,
    default: null
  },
  skynetTokenAddress: {
    type: String,
    default: null
  },
  skynetCatalog: [{
    serviceId: String,
    name: String,
    description: String,
    category: String,
    price: Number,
    rateLimit: mongoose.Schema.Types.Mixed
  }],

  // Reputation staking (Phase 4)
  skynetBalance: {
    type: Number,
    default: 0
  },
  skynetBalanceVerified: {
    type: Boolean,
    default: false
  },
  skynetBalanceVerifiedAt: {
    type: Date,
    default: null
  },

  // Sentinel token (soulbound reputation badge from scammer reporting)
  sentinelBalance: {
    type: Number,
    default: 0
  },
  sentinelBalanceVerified: {
    type: Boolean,
    default: false
  },

  trustScore: {
    type: Number,
    default: 0
  },

  // Online status (transient, not persisted across restarts)
  isOnline: {
    type: Boolean,
    default: false
  },

  // Derived connection-stability metrics, refreshed via calculateConnectionStability().
  // Persisted so reporting endpoints can query them without recomputing.
  averageSessionDuration: { type: Number, default: 0 },
  disconnectionFrequency: { type: Number, default: 0 }
}, {
  timestamps: true
});

// Index for common queries
p2pPeerSchema.index({ trustLevel: 1 });
p2pPeerSchema.index({ lastSeen: -1 });
p2pPeerSchema.index({ isOnline: 1 });

/**
 * Update last seen timestamp
 */
p2pPeerSchema.methods.touch = function() {
  this.lastSeen = new Date();
  return this.save();
};

/**
 * Mark peer as online/offline
 */
p2pPeerSchema.methods.setOnline = function(online) {
  this.isOnline = online;
  if (online) this.lastSeen = new Date();
  return this.save();
};

/**
 * Find peer by fingerprint
 */
p2pPeerSchema.statics.findByFingerprint = function(fingerprint) {
  return this.findOne({ fingerprint });
};

/**
 * Get all trusted peers
 */
p2pPeerSchema.statics.getTrustedPeers = function() {
  return this.find({ trustLevel: 'trusted' });
};

/**
 * Get all online peers
 */
p2pPeerSchema.statics.getOnlinePeers = function() {
  return this.find({ isOnline: true });
};

/**
 * Mark all peers as offline (on startup)
 */
p2pPeerSchema.statics.resetOnlineStatus = async function() {
  await this.updateMany({}, { isOnline: false });
};

/**
 * Calculate trust score based on multiple factors (0-100)
 *
 * Factors:
 * - Manual trust level: +30 (trusted)
 * - ERC-8004 verified: +20
 * - SKYNET token balance: up to +20 (log scale, caps at 1M tokens)
 * - Sentinel tokens (scammer reporting): up to +15 (+5 per token, caps at 3)
 * - Longevity (time since first seen): up to +10 (caps at 30 days)
 * - Activity (transfer count): up to +10 (caps at 50 transfers)
 */
p2pPeerSchema.methods.calculateTrustScore = function() {
  let score = 0;

  // Manual trust: 30 points
  if (this.trustLevel === 'trusted') score += 30;

  // ERC-8004 identity: 20 points
  if (this.erc8004?.verified) score += 20;

  // SKYNET balance: up to 20 points (log scale)
  if (this.skynetBalance > 0) {
    // log10(balance) / log10(1_000_000) * 20, capped at 20
    const balanceScore = Math.min(20, (Math.log10(Math.max(1, this.skynetBalance)) / 6) * 20);
    score += Math.round(balanceScore);
  }

  // Sentinel tokens: up to 15 points (+5 per verified token, caps at 3 tokens)
  if (this.sentinelBalance > 0 && this.sentinelBalanceVerified) {
    score += Math.min(15, this.sentinelBalance * 5);
  }

  // Longevity: up to 10 points (linear, caps at 30 days)
  if (this.firstSeen) {
    const daysSinceFirst = (Date.now() - new Date(this.firstSeen).getTime()) / (1000 * 60 * 60 * 24);
    score += Math.min(10, Math.round((daysSinceFirst / 30) * 10));
  }

  // Activity: up to 10 points (linear, caps at 50 transfers)
  score += Math.min(10, Math.round((this.transferCount / 50) * 10));

  this.trustScore = Math.min(100, score);
  return this.trustScore;
};

/**
 * Get all peers sorted by trust score (highest first)
 */
p2pPeerSchema.statics.getPeersByTrustScore = function() {
  return this.find({}).sort({ trustScore: -1 });
};

/**
 * Atomically accept and advance a peer's lastSeq by fingerprint.
 * Replay protection: only advances when proposed seq is strictly greater than
 * stored lastSeq (or lastSeq is unset). Returns true on accept, false otherwise.
 */
p2pPeerSchema.statics.acceptSeq = async function(fingerprint, seq) {
  if (!fingerprint || typeof seq !== 'number') {
    logger.warn('P2PPeer.acceptSeq invalid params', { fingerprint, seqType: typeof seq });
    return false;
  }
  try {
    const res = await retryOperation(
      () => this.findOneAndUpdate(
        { fingerprint, $or: [{ lastSeq: { $lt: seq } }, { lastSeq: { $exists: false } }] },
        { $set: { lastSeq: seq } },
        { new: true }
      ),
      { retries: 3 }
    );
    const accepted = Boolean(res);
    if (!accepted) logger.debug('Sequence rejected (duplicate/out-of-order)', { fingerprint, seq });
    return accepted;
  } catch (err) {
    logger.error('Error advancing sequence (acceptSeq)', { fingerprint, seq, err });
    return false;
  }
};

/**
 * Instance variant of acceptSeq scoped to this peer's _id. Updates the in-memory
 * lastSeq on success to keep the doc consistent without a round-trip refetch.
 */
p2pPeerSchema.methods.tryAdvanceSeq = async function(seq) {
  if (typeof seq !== 'number') {
    logger.warn('P2PPeer.tryAdvanceSeq non-number seq', { _id: this._id, seqType: typeof seq });
    return false;
  }
  try {
    const updated = await retryOperation(
      () => this.model('P2PPeer').findOneAndUpdate(
        { _id: this._id, $or: [{ lastSeq: { $lt: seq } }, { lastSeq: { $exists: false } }] },
        { $set: { lastSeq: seq } },
        { new: true }
      ),
      { retries: 3 }
    );
    const accepted = Boolean(updated);
    if (accepted) {
      this.lastSeq = seq;
    } else {
      logger.debug('Instance sequence rejected (duplicate/out-of-order)', { _id: this._id, seq, lastSeq: this.lastSeq });
    }
    return accepted;
  } catch (err) {
    logger.error('Error advancing sequence (tryAdvanceSeq)', { _id: this._id, seq, err });
    return false;
  }
};

/**
 * Refresh derived connection-stability metrics from the underlying counters.
 * Does not save — call .save() yourself if you want to persist.
 */
p2pPeerSchema.methods.calculateConnectionStability = function() {
  if (this.sessionCount > 0) {
    this.averageSessionDuration = this.totalConnectionSeconds / this.sessionCount;
    this.disconnectionFrequency = this.reconnectionCount / this.sessionCount;
  } else {
    this.averageSessionDuration = 0;
    this.disconnectionFrequency = 0;
  }
  return {
    averageSessionDuration: this.averageSessionDuration,
    disconnectionFrequency: this.disconnectionFrequency,
    sessionCount: this.sessionCount,
    totalConnectionSeconds: this.totalConnectionSeconds,
    reconnectionCount: this.reconnectionCount
  };
};

export const P2PPeer = mongoose.model('P2PPeer', p2pPeerSchema);
