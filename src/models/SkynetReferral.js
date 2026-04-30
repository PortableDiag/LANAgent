import mongoose from 'mongoose';

const skynetReferralSchema = new mongoose.Schema({
  referrerFingerprint: { type: String, required: true },
  referredFingerprint: { type: String, required: true },
  serviceId: { type: String, required: true },
  originalAmount: { type: Number, default: 0 },
  rewardAmount: { type: Number, default: 0 },
  rewardPercent: { type: Number, default: 5 },
  txHash: { type: String, default: null },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  referralSource: {
    type: String,
    enum: ['p2p', 'web', 'email', 'social_media', 'cli', 'other'],
    default: 'other'
  }
}, { timestamps: true });

skynetReferralSchema.index({ referrerFingerprint: 1, createdAt: -1 });
skynetReferralSchema.index({ referredFingerprint: 1 });

const REFERRAL_TIERS = [
  { level: 1, minReferrals: 0, rewardMultiplier: 1.0, name: 'Bronze' },
  { level: 2, minReferrals: 10, rewardMultiplier: 1.5, name: 'Silver' },
  { level: 3, minReferrals: 25, rewardMultiplier: 2.0, name: 'Gold' },
  { level: 4, minReferrals: 50, rewardMultiplier: 2.5, name: 'Platinum' },
  { level: 5, minReferrals: 100, rewardMultiplier: 3.0, name: 'Diamond' }
];

/**
 * Get referral tiers configuration.
 */
skynetReferralSchema.statics.getReferralTiers = function () {
  return REFERRAL_TIERS;
};

/**
 * Calculate which tier a user belongs to based on referral count.
 */
skynetReferralSchema.statics.calculateUserTier = function (referralCount, tiers) {
  const sortedTiers = [...tiers].sort((a, b) => b.minReferrals - a.minReferrals);
  for (const tier of sortedTiers) {
    if (referralCount >= tier.minReferrals) {
      return tier;
    }
  }
  return null;
};

/**
 * Calculate reward amount with tier multiplier.
 */
skynetReferralSchema.statics.calculateTierBasedReward = function (originalAmount, baseRewardPercent, tier) {
  const baseReward = (originalAmount * baseRewardPercent) / 100;
  const multiplier = tier ? tier.rewardMultiplier : 1.0;
  return baseReward * multiplier;
};

/**
 * Get referral statistics for a user including tier information.
 */
skynetReferralSchema.statics.getReferralStats = async function (fingerprint) {
  const stats = await this.aggregate([
    { $match: { referrerFingerprint: fingerprint, status: 'paid' } },
    { $group: { _id: null, totalRewards: { $sum: '$rewardAmount' }, count: { $sum: 1 } } }
  ]);

  const referralCount = stats[0] ? stats[0].count : 0;
  const totalRewards = stats[0] ? stats[0].totalRewards : 0;
  const currentTier = this.calculateUserTier(referralCount, REFERRAL_TIERS);

  return { totalRewards, count: referralCount, currentTier };
};

/**
 * Get referrals with pagination.
 */
skynetReferralSchema.statics.getReferralsPaginated = async function (fingerprint, page = 1, limit = 10) {
  const skip = (page - 1) * limit;

  const [referrals, total] = await Promise.all([
    this.find({ referrerFingerprint: fingerprint })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments({ referrerFingerprint: fingerprint })
  ]);

  return {
    referrals,
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalRecords: total,
      hasNextPage: page < Math.ceil(total / limit),
      hasPrevPage: page > 1
    }
  };
};

/**
 * Get referral statistics for multiple users at once.
 */
skynetReferralSchema.statics.getMultipleReferralStats = async function (fingerprints) {
  const stats = await this.aggregate([
    { $match: { referrerFingerprint: { $in: fingerprints }, status: 'paid' } },
    { $group: { _id: '$referrerFingerprint', totalRewards: { $sum: '$rewardAmount' }, count: { $sum: 1 } } }
  ]);

  const statsMap = {};
  for (const stat of stats) {
    statsMap[stat._id] = { totalRewards: stat.totalRewards, count: stat.count };
  }
  for (const fp of fingerprints) {
    if (!statsMap[fp]) {
      statsMap[fp] = { totalRewards: 0, count: 0 };
    }
  }
  return statsMap;
};

/**
 * Get referral conversion rate (paid referrals / total referrals).
 */
skynetReferralSchema.statics.getReferralConversionRate = async function (fingerprint) {
  const stats = await this.aggregate([
    { $match: { referrerFingerprint: fingerprint } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  let totalReferrals = 0;
  let paidReferrals = 0;

  for (const stat of stats) {
    totalReferrals += stat.count;
    if (stat._id === 'paid') {
      paidReferrals = stat.count;
    }
  }

  const conversionRate = totalReferrals > 0 ? (paidReferrals / totalReferrals) * 100 : 0;
  return {
    totalReferrals,
    paidReferrals,
    conversionRate: parseFloat(conversionRate.toFixed(2))
  };
};

/**
 * Get reward distribution statistics.
 */
skynetReferralSchema.statics.getRewardDistributionStats = async function (fingerprint) {
  const stats = await this.aggregate([
    { $match: { referrerFingerprint: fingerprint, status: 'paid' } },
    {
      $group: {
        _id: null,
        totalRewards: { $sum: '$rewardAmount' },
        averageReward: { $avg: '$rewardAmount' },
        minReward: { $min: '$rewardAmount' },
        maxReward: { $max: '$rewardAmount' },
        rewardCount: { $sum: 1 }
      }
    }
  ]);

  if (stats.length === 0) {
    return {
      totalRewards: 0,
      averageReward: 0,
      minReward: 0,
      maxReward: 0,
      rewardCount: 0
    };
  }

  return {
    totalRewards: stats[0].totalRewards,
    averageReward: parseFloat(stats[0].averageReward.toFixed(2)),
    minReward: stats[0].minReward,
    maxReward: stats[0].maxReward,
    rewardCount: stats[0].rewardCount
  };
};

/**
 * Get tier progression report for a user.
 */
skynetReferralSchema.statics.getTierProgressionReport = async function (fingerprint) {
  const referralCount = await this.countDocuments({ referrerFingerprint: fingerprint, status: 'paid' });
  const currentTier = this.calculateUserTier(referralCount, REFERRAL_TIERS);
  
  const sortedTiers = [...REFERRAL_TIERS].sort((a, b) => a.minReferrals - b.minReferrals);
  let nextTier = null;
  for (const tier of sortedTiers) {
    if (referralCount < tier.minReferrals) {
      nextTier = tier;
      break;
    }
  }

  const progressToNextTier = nextTier 
    ? {
        referralsNeeded: Math.max(0, nextTier.minReferrals - referralCount),
        nextTier: nextTier
      }
    : null;

  return {
    currentReferralCount: referralCount,
    currentTier,
    progressToNextTier
  };
};

/**
 * Get referral source statistics.
 */
skynetReferralSchema.statics.getReferralSourceStats = async function (fingerprint) {
  const stats = await this.aggregate([
    { $match: { referrerFingerprint: fingerprint, status: 'paid' } },
    { $group: { _id: '$referralSource', count: { $sum: 1 } } }
  ]);

  const sourceStats = {};
  for (const stat of stats) {
    sourceStats[stat._id] = stat.count;
  }

  return sourceStats;
};

const SkynetReferral = mongoose.model('SkynetReferral', skynetReferralSchema);
export default SkynetReferral;
