import mongoose from 'mongoose';

/**
 * SkynetBounty - P2P bounty system where agents post tasks and offer SKYNET rewards.
 */
const skynetBountySchema = new mongoose.Schema({
  bountyId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Who posted the bounty
  posterFingerprint: {
    type: String,
    required: true
  },
  // Bounty details
  title: {
    type: String,
    required: true,
    maxlength: 200
  },
  description: {
    type: String,
    default: '',
    maxlength: 2000
  },
  category: {
    type: String,
    default: 'general'
  },
  // Reward
  reward: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'SKYNET'
  },
  // Status
  status: {
    type: String,
    enum: ['open', 'claimed', 'completed', 'expired', 'cancelled'],
    default: 'open'
  },
  // Claimant
  claimerFingerprint: {
    type: String,
    default: null
  },
  claimedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  // Payment
  paymentTxHash: {
    type: String,
    default: null
  },
  // Expiry
  expiresAt: {
    type: Date,
    default: null
  },
  // Whether this bounty was posted by us or received from a peer
  isLocal: {
    type: Boolean,
    default: false
  },
  // New fields for difficulty levels and skill requirements
  difficulty: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced'],
    default: 'beginner'
  },
  requiredSkills: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

skynetBountySchema.index({ status: 1 });
skynetBountySchema.index({ posterFingerprint: 1 });
skynetBountySchema.index({ category: 1 });
skynetBountySchema.index({ difficulty: 1 });
skynetBountySchema.index({ requiredSkills: 1 });

/**
 * Get open bounties with optional filtering by difficulty level
 * @param {string} difficulty - Difficulty level to filter by (beginner, intermediate, advanced)
 * @returns {Promise<Array>} Array of open bounties
 */
skynetBountySchema.statics.getOpenBounties = function(difficulty = null) {
  const query = { status: 'open', expiresAt: { $gt: new Date() } };
  if (difficulty) {
    query.difficulty = difficulty;
  }
  return this.find(query).sort({ reward: -1 });
};

/**
 * Get bounties posted by a specific agent
 * @param {string} fingerprint - Agent fingerprint
 * @returns {Promise<Array>} Array of bounties
 */
skynetBountySchema.statics.getMyBounties = function(fingerprint) {
  return this.find({ posterFingerprint: fingerprint }).sort({ createdAt: -1 });
};

/**
 * Get bounties that match an agent's skills
 * @param {Array<string>} agentSkills - Skills of the agent
 * @returns {Promise<Array>} Array of matching bounties
 */
skynetBountySchema.statics.getBountiesBySkills = function(agentSkills) {
  if (!agentSkills || !Array.isArray(agentSkills) || agentSkills.length === 0) {
    return this.find({ status: 'open', expiresAt: { $gt: new Date() } }).sort({ reward: -1 });
  }

  return this.find({
    status: 'open',
    expiresAt: { $gt: new Date() },
    requiredSkills: { $in: agentSkills }
  }).sort({ reward: -1 });
};

/**
 * Get bounties filtered by difficulty preference
 * @param {Array<string>} preferredDifficulties - Preferred difficulty levels
 * @returns {Promise<Array>} Array of matching bounties
 */
skynetBountySchema.statics.getBountiesByDifficulty = function(preferredDifficulties) {
  if (!preferredDifficulties || !Array.isArray(preferredDifficulties) || preferredDifficulties.length === 0) {
    return this.find({ status: 'open', expiresAt: { $gt: new Date() } }).sort({ reward: -1 });
  }

  return this.find({
    status: 'open',
    expiresAt: { $gt: new Date() },
    difficulty: { $in: preferredDifficulties }
  }).sort({ reward: -1 });
};

/**
 * Get recommended bounties for an agent based on skills and difficulty preferences
 * @param {Array<string>} agentSkills - Skills of the agent
 * @param {Array<string>} preferredDifficulties - Preferred difficulty levels
 * @returns {Promise<Array>} Array of recommended bounties
 */
skynetBountySchema.statics.getRecommendedBounties = function(agentSkills, preferredDifficulties) {
  const query = {
    status: 'open',
    expiresAt: { $gt: new Date() }
  };

  // Add skills filter if provided
  if (agentSkills && Array.isArray(agentSkills) && agentSkills.length > 0) {
    query.requiredSkills = { $in: agentSkills };
  }

  // Add difficulty filter if provided
  if (preferredDifficulties && Array.isArray(preferredDifficulties) && preferredDifficulties.length > 0) {
    query.difficulty = { $in: preferredDifficulties };
  }

  return this.find(query).sort({ reward: -1 });
};

const SkynetBounty = mongoose.model('SkynetBounty', skynetBountySchema);
export default SkynetBounty;
