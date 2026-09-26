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

const governancePolicySchema = new mongoose.Schema({
  // Minimum participating voting weight required to satisfy quorum.
  quorumWeight: { type: Number, default: 0, min: 0 },
  // Minimum number of unique voters required to satisfy quorum.
  quorumVoterCount: { type: Number, default: 0, min: 0 },
  // Votes-for ratio among non-abstaining votes must EXCEED this. Strictly greater, so the
  // 0.5 default is the original rule (votesFor > votesAgainst): a tie is rejected.
  approvalThreshold: { type: Number, default: 0.5, min: 0, max: 1 },
  // Minimum number of milliseconds a proposal must remain open.
  minVotingDuration: { type: Number, default: 0, min: 0 }
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
  isQuadratic: { type: Boolean, default: false },
  // Optional governance rules. Defaults preserve the original majority-vote behavior.
  governancePolicy: {
    type: governancePolicySchema,
    default: () => ({})
  }
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
 * Validate and normalize governance policy values.
 */
skynetGovernanceSchema.statics.validateGovernancePolicy = function(policy = {}) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('Governance policy must be an object');
  }

  const normalized = {
    quorumWeight: policy.quorumWeight ?? 0,
    quorumVoterCount: policy.quorumVoterCount ?? 0,
    approvalThreshold: policy.approvalThreshold ?? 0.5,
    minVotingDuration: policy.minVotingDuration ?? 0
  };

  if (!Number.isFinite(normalized.quorumWeight) || normalized.quorumWeight < 0) {
    throw new RangeError('quorumWeight must be a non-negative finite number');
  }
  if (!Number.isInteger(normalized.quorumVoterCount) || normalized.quorumVoterCount < 0) {
    throw new RangeError('quorumVoterCount must be a non-negative integer');
  }
  if (!Number.isFinite(normalized.approvalThreshold)
    || normalized.approvalThreshold < 0
    || normalized.approvalThreshold > 1) {
    throw new RangeError('approvalThreshold must be between 0 and 1');
  }
  if (!Number.isFinite(normalized.minVotingDuration) || normalized.minVotingDuration < 0) {
    throw new RangeError('minVotingDuration must be a non-negative finite number');
  }

  return normalized;
};

/**
 * Evaluate quorum, turnout, approval, and the outcome currently supported by a proposal.
 */
skynetGovernanceSchema.statics.evaluateProposal = async function(proposalOrId) {
  let proposal = proposalOrId;
  if (typeof proposalOrId === 'string') {
    proposal = await this.findOne({ proposalId: proposalOrId }).lean();
  } else if (proposalOrId && typeof proposalOrId.toObject === 'function') {
    proposal = proposalOrId.toObject();
  }

  if (!proposal) {
    throw new Error('Proposal not found');
  }

  const policy = this.validateGovernancePolicy(proposal.governancePolicy || {});
  const votes = Array.isArray(proposal.votes) ? proposal.votes : [];
  const votesFor = Number(proposal.votesFor) || 0;
  const votesAgainst = Number(proposal.votesAgainst) || 0;
  const votesAbstain = Number(proposal.votesAbstain) || 0;
  const turnoutWeight = votesFor + votesAgainst + votesAbstain;
  const countedWeight = votesFor + votesAgainst;
  const voterCount = new Set(votes.map(vote => vote.voterFingerprint).filter(Boolean)).size;
  const approvalRatio = countedWeight > 0 ? votesFor / countedWeight : 0;
  const quorumByWeight = turnoutWeight >= policy.quorumWeight;
  const quorumByVoterCount = voterCount >= policy.quorumVoterCount;
  const quorumMet = quorumByWeight && quorumByVoterCount;
  const approvalMet = countedWeight > 0 && approvalRatio > policy.approvalThreshold;
  const proposedOutcome = quorumMet && approvalMet ? 'passed' : 'rejected';

  return {
    proposalId: proposal.proposalId,
    quorumMet,
    quorumByWeight,
    quorumByVoterCount,
    quorumWeight: policy.quorumWeight,
    quorumVoterCount: policy.quorumVoterCount,
    voterCount,
    turnoutWeight,
    turnout: {
      weight: turnoutWeight,
      voterCount,
      participationWeight: turnoutWeight
    },
    approvalRatio,
    approvalThreshold: policy.approvalThreshold,
    approvalMet,
    proposedOutcome,
    status: proposal.status
  };
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
    const now = new Date();
    const policy = this.constructor.validateGovernancePolicy(this.governancePolicy || {});
    const createdAt = this.createdAt ? new Date(this.createdAt) : now;
    const minimumEnd = new Date(createdAt.getTime() + policy.minVotingDuration);

    if (now < minimumEnd && now < new Date(this.votingEndsAt)) {
      throw new Error(`Proposal ${this.proposalId} has not reached its minimum voting duration`);
    }

    const evaluation = await this.constructor.evaluateProposal(this);
    const votingEnded = now >= new Date(this.votingEndsAt);

    if (!evaluation.quorumMet) {
      this.status = votingEnded ? 'expired' : 'rejected';
    } else if (evaluation.approvalMet) {
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
 * Get voting trends and analytics for governance proposals.
 */
skynetGovernanceSchema.statics.getVotingTrends = async function() {
  try {
    const proposals = await this.find({}, {
      proposalId: 1,
      category: 1,
      status: 1,
      votesFor: 1,
      votesAgainst: 1,
      votesAbstain: 1,
      isQuadratic: 1,
      createdAt: 1,
      votingEndsAt: 1
    }).lean();

    // Calculate participation metrics
    const totalProposals = proposals.length;
    const categoryDistribution = {};
    const statusDistribution = {};
    const participationRates = [];
    const votingPatterns = {
      standard: { for: 0, against: 0, abstain: 0 },
      quadratic: { for: 0, against: 0, abstain: 0 }
    };

    proposals.forEach(proposal => {
      // Category distribution
      categoryDistribution[proposal.category] = (categoryDistribution[proposal.category] || 0) + 1;
      
      // Status distribution
      statusDistribution[proposal.status] = (statusDistribution[proposal.status] || 0) + 1;
      
      // Participation rate (total votes / proposals)
      const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
      participationRates.push(totalVotes);
      
      // Voting patterns by type
      const voteType = proposal.isQuadratic ? 'quadratic' : 'standard';
      votingPatterns[voteType].for += proposal.votesFor;
      votingPatterns[voteType].against += proposal.votesAgainst;
      votingPatterns[voteType].abstain += proposal.votesAbstain;
    });

    const avgParticipationRate = participationRates.length > 0 
      ? participationRates.reduce((a, b) => a + b, 0) / participationRates.length 
      : 0;

    return {
      totalProposals,
      categoryDistribution,
      statusDistribution,
      averageParticipationRate: avgParticipationRate,
      votingPatterns
    };
  } catch (error) {
    logger.error(`Error getting voting trends: ${error.message}`);
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
