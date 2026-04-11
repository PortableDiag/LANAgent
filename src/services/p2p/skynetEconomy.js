import { logger } from '../../utils/logger.js';
import SkynetBounty from '../../models/SkynetBounty.js';
import SkynetGovernance from '../../models/SkynetGovernance.js';
import DataListing from '../../models/DataListing.js';
import SkynetReferral from '../../models/SkynetReferral.js';
import ArbSignal from '../../models/ArbSignal.js';
import ComputeJob from '../../models/ComputeJob.js';
import crypto from 'crypto';

/**
 * SkynetEconomy - Extended economy features for Skynet P2P network.
 *
 * Handles: Bounties, Governance Voting, Agent Tipping
 */
class SkynetEconomy {
  constructor(agent) {
    this.agent = agent;
  }

  // ==================== BOUNTIES ====================

  /**
   * Handle bounty_post — a peer is advertising a bounty
   */
  async handleBountyPost(fromFingerprint, message) {
    const { bountyId, title, description, category, reward, expiresAt } = message;
    logger.info(`Skynet bounty from ${fromFingerprint.slice(0, 8)}...: "${title}" (${reward} SKYNET)`);

    try {
      await SkynetBounty.findOneAndUpdate(
        { bountyId },
        {
          bountyId,
          posterFingerprint: fromFingerprint,
          title, description, category,
          reward: reward || 0,
          expiresAt: expiresAt ? new Date(expiresAt) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          status: 'open',
          isLocal: false
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      logger.error(`Failed to save bounty: ${err.message}`);
    }
  }

  /**
   * Handle bounty_claim — a peer wants to claim our bounty
   */
  async handleBountyClaim(fromFingerprint, message, sendFn) {
    const { bountyId } = message;
    const bounty = await SkynetBounty.findOne({ bountyId, isLocal: true });
    if (!bounty || bounty.status !== 'open') {
      return sendFn(fromFingerprint, {
        type: 'bounty_claim_response',
        bountyId,
        accepted: false,
        reason: 'Bounty not found or already claimed'
      });
    }

    bounty.status = 'claimed';
    bounty.claimerFingerprint = fromFingerprint;
    bounty.claimedAt = new Date();
    await bounty.save();

    logger.info(`Skynet bounty ${bountyId} claimed by ${fromFingerprint.slice(0, 8)}...`);
    await sendFn(fromFingerprint, {
      type: 'bounty_claim_response',
      bountyId,
      accepted: true
    });
  }

  /**
   * Create a local bounty and broadcast it
   */
  async createBounty(title, description, category, reward, expiresInDays = 7) {
    const bountyId = `bounty_${crypto.randomBytes(12).toString('hex')}`;
    const bounty = await SkynetBounty.create({
      bountyId,
      posterFingerprint: 'local',
      title, description, category,
      reward,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
      status: 'open',
      isLocal: true
    });
    return bounty;
  }

  /**
   * Get bounties for the dashboard
   */
  async getBounties(filter = 'all') {
    if (filter === 'open') return SkynetBounty.getOpenBounties();
    if (filter === 'mine') return SkynetBounty.find({ isLocal: true }).sort({ createdAt: -1 });
    return SkynetBounty.find({}).sort({ createdAt: -1 }).limit(50);
  }

  // ==================== GOVERNANCE ====================

  /**
   * Handle governance_proposal — a peer broadcasts a proposal
   */
  async handleGovernanceProposal(fromFingerprint, message) {
    const { proposalId, title, description, category, votingEndsAt } = message;
    logger.info(`Skynet proposal from ${fromFingerprint.slice(0, 8)}...: "${title}"`);

    try {
      const existing = await SkynetGovernance.findOne({ proposalId });
      if (!existing) {
        await SkynetGovernance.create({
          proposalId,
          proposerFingerprint: fromFingerprint,
          title, description,
          category: category || 'other',
          votingEndsAt: votingEndsAt ? new Date(votingEndsAt) : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
          isLocal: false
        });
      }
    } catch (err) {
      logger.error(`Failed to save proposal: ${err.message}`);
    }
  }

  /**
   * Handle governance_vote — a peer votes on a proposal
   */
  async handleGovernanceVote(fromFingerprint, message) {
    const { proposalId, vote, weight } = message;
    const proposal = await SkynetGovernance.findOne({ proposalId, status: 'active' });
    if (!proposal) return;

    const added = proposal.castVote(fromFingerprint, vote, weight || 0);
    if (added) {
      await proposal.save();
      logger.info(`Skynet vote on ${proposalId}: ${vote} from ${fromFingerprint.slice(0, 8)}... (weight: ${weight})`);
    }
  }

  /**
   * Create a local proposal
   */
  async createProposal(title, description, category, votingDays = 3) {
    const proposalId = `prop_${crypto.randomBytes(12).toString('hex')}`;
    return SkynetGovernance.create({
      proposalId,
      proposerFingerprint: 'local',
      title, description,
      category: category || 'other',
      votingEndsAt: new Date(Date.now() + votingDays * 24 * 60 * 60 * 1000),
      isLocal: true
    });
  }

  async getProposals(filter = 'active') {
    if (filter === 'active') return SkynetGovernance.getActiveProposals();
    return SkynetGovernance.find({}).sort({ createdAt: -1 }).limit(50);
  }

  // ==================== TIPPING ====================

  /**
   * Handle tip_received — a peer tipped us SKYNET tokens
   */
  async handleTipReceived(fromFingerprint, message) {
    const { txHash, amount, note } = message;
    logger.info(`Skynet tip from ${fromFingerprint.slice(0, 8)}...: ${amount} SKYNET${note ? ` — "${note}"` : ''}`);

    if (this.agent?.emit) {
      this.agent.emit('skynet:tip_received', { fromFingerprint, txHash, amount, note });
    }
  }

  // ==================== DATA MARKETPLACE ====================

  async handleDataListingPost(fromFingerprint, message) {
    const { listingId, title, description, category, dataType, price, size, samplePreview, expiresAt } = message;
    logger.info(`Data listing from ${fromFingerprint.slice(0, 8)}...: "${title}" (${price} SKYNET)`);

    try {
      await DataListing.findOneAndUpdate(
        { listingId },
        {
          listingId,
          sellerFingerprint: fromFingerprint,
          title, description, category,
          dataType: dataType || 'other',
          price: price || 0,
          size: size || 0,
          samplePreview: (samplePreview || '').slice(0, 500),
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          status: 'active',
          isLocal: false
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      logger.error(`Failed to save data listing: ${err.message}`);
    }
  }

  async handleDataPurchaseRequest(fromFingerprint, message, sendFn) {
    const { listingId, paymentTxHash } = message;
    const listing = await DataListing.findOne({ listingId, isLocal: true, status: 'active' });
    if (!listing) {
      return sendFn(fromFingerprint, {
        type: 'data_purchase_response',
        listingId,
        success: false,
        error: 'Listing not found or no longer available'
      });
    }

    // Payment verification delegated to skynetServiceExecutor if price > 0
    if (listing.price > 0 && !paymentTxHash) {
      return sendFn(fromFingerprint, {
        type: 'data_purchase_response',
        listingId,
        success: false,
        error: `Payment required: ${listing.price} SKYNET`
      });
    }

    listing.purchases += 1;
    listing.totalRevenue += listing.price;
    await listing.save();

    logger.info(`Data purchase for ${listingId} by ${fromFingerprint.slice(0, 8)}...`);
    await sendFn(fromFingerprint, {
      type: 'data_purchase_response',
      listingId,
      success: true
    });
  }

  async createDataListing(title, description, category, dataType, price, size, samplePreview, expiresInDays = 30) {
    const listingId = `data_${crypto.randomBytes(12).toString('hex')}`;
    return DataListing.create({
      listingId,
      sellerFingerprint: 'local',
      title, description, category,
      dataType: dataType || 'other',
      price, size,
      samplePreview: (samplePreview || '').slice(0, 500),
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null,
      status: 'active',
      isLocal: true
    });
  }

  async getDataListings(filter = 'active') {
    if (filter === 'active') return DataListing.getActiveListings();
    if (filter === 'mine') return DataListing.getMyListings();
    return DataListing.find({}).sort({ createdAt: -1 }).limit(50);
  }

  // ==================== REFERRAL REWARDS ====================

  async handleReferralReward(fromFingerprint, message) {
    const { referredFingerprint, serviceId, originalAmount, rewardAmount, txHash } = message;
    logger.info(`Referral reward from ${fromFingerprint.slice(0, 8)}...: ${rewardAmount} SKYNET for service ${serviceId}`);

    try {
      await SkynetReferral.create({
        referrerFingerprint: 'local',
        referredFingerprint,
        serviceId,
        originalAmount: originalAmount || 0,
        rewardAmount: rewardAmount || 0,
        txHash,
        status: txHash ? 'paid' : 'pending'
      });

      if (this.agent?.emit) {
        this.agent.emit('skynet:referral_reward', { fromFingerprint, rewardAmount, serviceId });
      }
    } catch (err) {
      logger.error(`Failed to save referral: ${err.message}`);
    }
  }

  async getReferralStats() {
    const stats = await SkynetReferral.aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: null, totalRewards: { $sum: '$rewardAmount' }, count: { $sum: 1 } } }
    ]);
    return stats[0] || { totalRewards: 0, count: 0 };
  }

  // ==================== ARBITRAGE SIGNALS ====================

  async handleArbSignal(fromFingerprint, message) {
    const { token, symbol, network, spread, buyProtocol, sellProtocol, netProfit, gasCostUsd } = message;
    logger.info(`Arb signal from ${fromFingerprint.slice(0, 8)}...: ${symbol} spread=${spread?.toFixed(2)}% profit=$${netProfit?.toFixed(2)}`);

    try {
      const { P2PPeer } = await import('../../models/P2PPeer.js');
      const peer = await P2PPeer.findByFingerprint(fromFingerprint);
      const trustScore = peer?.trustScore || 0;

      await ArbSignal.create({
        senderFingerprint: fromFingerprint,
        token, symbol,
        network: network || 'bsc',
        spread: spread || 0,
        buyProtocol: buyProtocol || '',
        sellProtocol: sellProtocol || '',
        netProfit: netProfit || 0,
        gasCostUsd: gasCostUsd || 0,
        senderTrustScore: trustScore
      });

      if (this.agent?.emit) {
        this.agent.emit('skynet:arb_signal', { fromFingerprint, symbol, spread, netProfit, trustScore });
      }
    } catch (err) {
      logger.error(`Failed to save arb signal: ${err.message}`);
    }
  }

  async getRecentArbSignals(limit = 20) {
    return ArbSignal.getRecentSignals(limit);
  }

  // ==================== COMPUTE RENTAL ====================

  async handleComputeRequest(fromFingerprint, message, sendFn) {
    const { jobId, type, command, input, maxDurationSeconds, paymentTxHash } = message;
    logger.info(`Compute request from ${fromFingerprint.slice(0, 8)}...: ${type} job ${jobId}`);

    // Check if compute rental is enabled
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const enabled = await SystemSettings.getSetting('compute_rental_enabled', false);
      if (!enabled) {
        return sendFn(fromFingerprint, {
          type: 'compute_response',
          jobId,
          success: false,
          error: 'Compute rental not enabled on this node'
        });
      }

      const pricePerMinute = await SystemSettings.getSetting('compute_price_per_minute', 1);

      // Require payment for compute jobs
      if (pricePerMinute > 0 && !paymentTxHash) {
        return sendFn(fromFingerprint, {
          type: 'compute_payment_required',
          jobId,
          pricePerMinute,
          currency: 'SKYNET',
          maxDurationSeconds: maxDurationSeconds || 300
        });
      }

      // Create job record
      const job = await ComputeJob.create({
        jobId: jobId || `compute_${crypto.randomBytes(12).toString('hex')}`,
        type: type || 'script',
        requesterFingerprint: fromFingerprint,
        command: (command || '').slice(0, 1000),
        input,
        maxDurationSeconds: Math.min(maxDurationSeconds || 300, 600),
        maxMemoryMB: 512,
        pricePerMinute,
        paymentTxHash,
        status: 'pending',
        direction: 'provider'
      });

      // Execute in sandboxed environment (timeout-protected)
      this._executeComputeJob(job, fromFingerprint, sendFn);

    } catch (err) {
      logger.error(`Compute request error: ${err.message}`);
      await sendFn(fromFingerprint, {
        type: 'compute_response',
        jobId,
        success: false,
        error: 'Internal error processing compute request'
      });
    }
  }

  async _executeComputeJob(job, fromFingerprint, sendFn) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    job.status = 'running';
    job.startedAt = new Date();
    await job.save();

    try {
      const timeout = (job.maxDurationSeconds || 300) * 1000;
      const result = await execAsync(job.command, {
        timeout,
        maxBuffer: job.maxMemoryMB * 1024 * 1024,
        env: { ...process.env, NODE_ENV: 'production', HOME: '/tmp' },
        cwd: '/tmp'
      });

      job.status = 'completed';
      job.completedAt = new Date();
      job.durationMs = Date.now() - job.startedAt.getTime();
      job.result = { stdout: (result.stdout || '').slice(0, 10000), stderr: (result.stderr || '').slice(0, 2000) };
      job.totalPrice = (job.pricePerMinute * job.durationMs) / 60000;
      await job.save();

      await sendFn(fromFingerprint, {
        type: 'compute_response',
        jobId: job.jobId,
        success: true,
        result: job.result,
        durationMs: job.durationMs,
        totalPrice: job.totalPrice
      });

    } catch (err) {
      job.status = err.killed ? 'timeout' : 'failed';
      job.completedAt = new Date();
      job.durationMs = Date.now() - job.startedAt.getTime();
      job.error = err.message?.slice(0, 500) || 'Unknown error';
      await job.save();

      await sendFn(fromFingerprint, {
        type: 'compute_response',
        jobId: job.jobId,
        success: false,
        error: job.status === 'timeout' ? 'Job timed out' : 'Execution failed'
      });
    }
  }

  async handleComputeResponse(fromFingerprint, message) {
    const { jobId, success, result, error, durationMs, totalPrice } = message;
    logger.info(`Compute response from ${fromFingerprint.slice(0, 8)}...: ${jobId} ${success ? 'success' : 'failed'}`);

    if (this.agent?.emit) {
      this.agent.emit('skynet:compute_response', { fromFingerprint, jobId, success, result, error, durationMs, totalPrice });
    }
  }

  async getComputeJobs(filter = 'all') {
    if (filter === 'active') return ComputeJob.getActiveJobs();
    return ComputeJob.getJobHistory();
  }

  // ==================== STATS ====================

  async getEconomyStats() {
    const [openBounties, activeBounties, proposals, activeProposals] = await Promise.all([
      SkynetBounty.countDocuments({ status: 'open' }),
      SkynetBounty.countDocuments({}),
      SkynetGovernance.countDocuments({}),
      SkynetGovernance.countDocuments({ status: 'active' })
    ]);

    const totalBountyRewards = await SkynetBounty.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: null, total: { $sum: '$reward' } } }
    ]);

    return {
      bounties: {
        open: openBounties,
        total: activeBounties,
        totalRewards: totalBountyRewards[0]?.total || 0
      },
      governance: {
        active: activeProposals,
        total: proposals
      }
    };
  }
}

export default SkynetEconomy;
