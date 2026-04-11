import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

/**
 * SkynetGovernance - Proposals and votes for Skynet network governance.
 * Token-weighted voting: 1 SKYNET = 1 vote (standard) or sqrt(tokens) (quadratic).
 */
const skynetVoteSchema = new mongoose.Schema({
  voterFingerprint: { type: String, required: true },
  vote: { type: String, enum: ['for', 'against', 'abstain'], required: true },
  weight: { type: Number, default: 0 }, // SKYNET balance at time of vote
  votedAt: { type: Date, default: Date.now },
  voteType: { type: String, enum: ['standard', 'quadratic'], default: 'standard' }
}, { _id: false });

const skynetGovernanceSchema = new mongoose.Schema({
  proposalId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Who proposed it
  proposerFingerprint: {
    type: String,
    required: true
  },
  // Proposal content
  title: {
    type: String,
    required: true,
    maxlength: 200
  },
  description: {
    type: String,
    default: '',
    maxlength: 5000
  },
  category: {
    type: String,
    enum: ['protocol', 'economy', 'feature', 'governance', 'other'],
    default: 'other'
  },
  // Status
  status: {
    type: String,
    enum: ['active', 'passed', 'rejected', 'expired'],
    default: 'active'
  },
  // Voting
  votes: [skynetVoteSchema],
  votesFor: { type: Number, default: 0 },
  votesAgainst: { type: Number, default: 0 },
  votesAbstain: { type: Number, default: 0 },
  // Timing
  votingEndsAt: {
    type: Date,
    required: true
  },
  // Whether this was created locally
  isLocal: {
    type: Boolean,
    default: false
  },
  // Quadratic voting configuration
  isQuadratic: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Cache for proposal results (10 min TTL)
const proposalCache = new NodeCache({ stdTTL: 600 });

skynetGovernanceSchema.index({ status: 1 });

skynetGovernanceSchema.statics.getActiveProposals = function() {
  return this.find({ status: 'active', votingEndsAt: { $gt: new Date() } }).sort({ createdAt: -1 });
};

/**
 * Cast a vote on a proposal. Supports standard and quadratic voting.
 * Stays synchronous — caller is responsible for saving.
 */
skynetGovernanceSchema.methods.castVote = function(fingerprint, vote, weight, voteType = 'standard') {
  // Check for duplicate vote
  const existing = this.votes.find(v => v.voterFingerprint === fingerprint);
  if (existing) {
    logger.warn(`Duplicate vote attempt by ${fingerprint} on proposal ${this.proposalId}`);
    return false;
  }

  // Quadratic: weight = floor(sqrt(tokens))
  let effectiveWeight = weight;
  if (voteType === 'quadratic' && this.isQuadratic) {
    effectiveWeight = Math.floor(Math.sqrt(weight));
  }

  this.votes.push({ voterFingerprint: fingerprint, vote, weight: effectiveWeight, voteType });
  if (vote === 'for') this.votesFor += effectiveWeight;
  else if (vote === 'against') this.votesAgainst += effectiveWeight;
  else this.votesAbstain += effectiveWeight;

  // Clear cached results
  proposalCache.del(this.proposalId);

  return true;
};

/**
 * Get vote results with caching.
 */
skynetGovernanceSchema.methods.getResults = function() {
  const cached = proposalCache.get(this.proposalId);
  if (cached) return cached;

  const results = {
    proposalId: this.proposalId,
    votesFor: this.votesFor,
    votesAgainst: this.votesAgainst,
    votesAbstain: this.votesAbstain,
    totalVotes: this.votes.length,
    isQuadratic: this.isQuadratic,
    status: this.status
  };

  proposalCache.set(this.proposalId, results);
  return results;
};

/**
 * Finalize a proposal with retry logic.
 */
skynetGovernanceSchema.methods.finalize = async function() {
  try {
    if (this.votesFor > this.votesAgainst) {
      this.status = 'passed';
    } else {
      this.status = 'rejected';
    }

    const result = await retryOperation(() => this.save(), { retries: 3 });
    proposalCache.del(this.proposalId);
    logger.info(`Proposal ${this.proposalId} finalized: ${this.status}`);
    return result;
  } catch (error) {
    logger.error(`Error finalizing proposal ${this.proposalId}: ${error.message}`);
    throw error;
  }
};

/**
 * Health check for governance model.
 */
skynetGovernanceSchema.statics.healthCheck = async function() {
  try {
    const count = await retryOperation(() => this.countDocuments(), { retries: 3 });
    return {
      status: 'healthy',
      model: 'SkynetGovernance',
      documentCount: count,
      cacheSize: proposalCache.getStats().keys
    };
  } catch (error) {
    logger.error(`Health check failed for SkynetGovernance: ${error.message}`);
    return {
      status: 'unhealthy',
      model: 'SkynetGovernance',
      error: error.message
    };
  }
};

const SkynetGovernance = mongoose.model('SkynetGovernance', skynetGovernanceSchema);
export default SkynetGovernance;
