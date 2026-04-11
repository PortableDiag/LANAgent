import mongoose from 'mongoose';

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
  }
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

export const P2PPeer = mongoose.model('P2PPeer', p2pPeerSchema);
