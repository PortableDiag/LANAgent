import { logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';

/**
 * SkynetStakingService — Manages on-chain SKYNET token staking.
 *
 * When a staking contract is deployed, this service interacts with it
 * to stake/unstake SKYNET tokens, query stake balances, and calculate
 * trust score boosts from on-chain stakes.
 *
 * Points to SkynetDiamond (ERC-2535) which implements StakingFacet + LPStakingFacet.
 * Contract address configured via SystemSettings 'skynet_staking_address'.
 */

// ABI for SkynetDiamond StakingFacet + RegistryFacet + AdminFacet + TreasuryFacet views
const STAKING_ABI = [
  // StakingFacet
  'function stake(uint256 amount, uint256 tierId) external',
  'function stakeNoLock(uint256 amount) external',
  'function unstake(uint256 amount) external',
  'function claimRewards() external',
  'function emergencyWithdraw() external',
  'function depositStakingRewards(uint256 amount) external',
  'function getStakeInfo(address staker) external view returns (uint256 amount, uint256 effectiveBalance, uint256 tierId, uint256 lockExpiry, bool locked, uint256 stakedAt)',
  'function totalStaked() external view returns (uint256)',
  'function totalEffectiveStaked() external view returns (uint256)',
  'function stakingRewardRate() external view returns (uint256)',
  'function stakingPeriodFinish() external view returns (uint256)',
  'function rewardPerToken() external view returns (uint256)',
  'function earned(address staker) external view returns (uint256)',
  'function rewardPoolBalance() external view returns (uint256)',
  'function stakingTierCount() external view returns (uint256)',
  'function getStakingTier(uint256 tierId) external view returns (uint256 lockDuration, uint256 multiplierBps, bool active)',
  'function stakingTimeUntilEnd() external view returns (uint256)',
  // LPStakingFacet
  'function stakeLP(uint256 amount, uint256 tierId) external',
  'function unstakeLP(uint256 amount) external',
  'function claimLPRewards() external',
  'function emergencyWithdrawLP() external',
  'function depositLPStakingRewards(uint256 amount) external',
  'function getLPStakeInfo(address staker) external view returns (uint256 amount, uint256 effectiveBalance, uint256 tierId, uint256 lockExpiry, bool locked, uint256 stakedAt)',
  'function lpTotalStaked() external view returns (uint256)',
  'function lpTotalEffectiveStaked() external view returns (uint256)',
  'function lpRewardRate() external view returns (uint256)',
  'function lpPeriodFinish() external view returns (uint256)',
  'function lpRewardPerToken() external view returns (uint256)',
  'function lpEarned(address staker) external view returns (uint256)',
  'function lpStakingTierCount() external view returns (uint256)',
  'function getLPStakingTier(uint256 tierId) external view returns (uint256 lockDuration, uint256 multiplierBps, bool active)',
  'function lpTimeUntilEnd() external view returns (uint256)',
  // RegistryFacet views
  'function getScammerCount() external view returns (uint256)',
  'function reportFee() external view returns (uint256)',
  // FeeRouterFacet
  'function getFeeConfig() external view returns (uint256 stakingShareBps, uint256 lpStakingShareBps, uint256 treasuryShareBps, address treasuryAddress, uint256 totalFeesRouted)',
  // TreasuryFacet
  'function getAllPoolBalances() external view returns (uint256 staking, uint256 bounty, uint256 treasury, uint256 reserve)',
  'function canAutoFund() external view returns (bool stakingReady, bool lpReady, uint256 availableAmount)',
  // AdminFacet
  'function getConfig() external view returns (address stakingToken, address lpToken, address pancakeRouter, address treasuryAddress, uint256 stakingShareBps, uint256 lpStakingShareBps, uint256 treasuryShareBps, uint256 bnbReserveMin, uint256 skynetReserveMin)',
  'function isPaused() external view returns (bool)'
];

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];

class SkynetStakingService {
  constructor() {
    this.stakingAddress = null;
    this.tokenAddress = null;
    this.network = 'bsc';
  }

  /**
   * Initialize with staking contract address from SystemSettings
   */
  async initialize() {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      this.stakingAddress = await SystemSettings.getSetting('skynet_staking_address', null);
      this.tokenAddress = await SystemSettings.getSetting(
        'skynet_token_address',
        process.env.SKYNET_TOKEN_ADDRESS || '0x8Ef0ecE5687417a8037F787b39417eB16972b04F'
      );
      if (this.stakingAddress) {
        logger.info(`Skynet staking service initialized: contract=${this.stakingAddress.slice(0, 10)}...`);
      }
    } catch (err) {
      logger.debug(`Staking service init: ${err.message}`);
    }
  }

  isAvailable() {
    return !!this.stakingAddress;
  }

  /**
   * Stake SKYNET tokens with optional lock tier
   * @param {number} amount - Amount to stake
   * @param {number} tierId - Lock tier (0=no lock, 1-3=locked with multiplier). Default 0.
   */
  async stake(amount, tierId = 0) {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');

    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const amountWei = ethers.parseUnits(amount.toString(), 18);

    // Approve staking contract to spend SKYNET
    const token = new ethers.Contract(this.tokenAddress, ERC20_APPROVE_ABI, signer);
    const allowance = await token.allowance(await signer.getAddress(), this.stakingAddress);
    if (allowance < amountWei) {
      const approveTx = await token.approve(this.stakingAddress, ethers.MaxUint256);
      await approveTx.wait();
    }

    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);
    const tx = await staking['stake(uint256,uint256)'](amountWei, tierId);
    const receipt = await tx.wait();

    logger.info(`Staked ${amount} SKYNET: tx=${receipt.hash}`);
    return { txHash: receipt.hash, amount, success: true };
  }

  /**
   * Unstake SKYNET tokens
   */
  async unstake(amount) {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');

    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const amountWei = ethers.parseUnits(amount.toString(), 18);

    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);
    const tx = await staking.unstake(amountWei);
    const receipt = await tx.wait();

    logger.info(`Unstaked ${amount} SKYNET: tx=${receipt.hash}`);
    return { txHash: receipt.hash, amount, success: true };
  }

  /**
   * Unstake a percentage of the total staked amount
   * @param {number} percentage - The percentage of the total stake to unstake
   */
  async unstakePercentage(percentage) {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');
    if (percentage <= 0 || percentage > 100) throw new Error('Percentage must be between 0 and 100');

    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const address = await signer.getAddress();

    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);
    const stakeData = await staking.getStakeInfo(address);
    const totalStakedAmount = stakeData.amount;

    const amountToUnstake = (totalStakedAmount * BigInt(percentage)) / BigInt(100);
    const tx = await staking.unstake(amountToUnstake);
    const receipt = await tx.wait();

    logger.info(`Unstaked ${percentage}% of total stake: tx=${receipt.hash}`);
    return { txHash: receipt.hash, percentage, success: true };
  }

  /**
   * Claim staking rewards
   */
  async claimRewards() {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');

    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);
    const tx = await staking.claimRewards();
    const receipt = await tx.wait();

    logger.info(`Claimed staking rewards: tx=${receipt.hash}`);
    return { txHash: receipt.hash, success: true };
  }

  /**
   * Get our staking position
   */
  async getStakeInfo() {
    if (!this.isAvailable()) return { available: false, stakingAddress: null };

    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(this.network);
    const signer = await contractServiceWrapper.getSigner(this.network);
    const address = await signer.getAddress();

    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);
    const token = new ethers.Contract(this.tokenAddress, ERC20_APPROVE_ABI, provider);

    const [stakeData, totalStaked, earned, balance] = await Promise.all([
      staking.getStakeInfo(address),
      staking.totalStaked(),
      staking.earned(address).catch(() => 0n),
      token.balanceOf(address)
    ]);

    return {
      available: true,
      stakingAddress: this.stakingAddress,
      stakedAmount: parseFloat(ethers.formatUnits(stakeData.amount, 18)),
      stakedAt: stakeData[5] > 0 ? new Date(Number(stakeData[5]) * 1000) : null,
      totalStaked: parseFloat(ethers.formatUnits(totalStaked, 18)),
      pendingRewards: parseFloat(ethers.formatUnits(earned, 18)),
      walletBalance: parseFloat(ethers.formatUnits(balance, 18))
    };
  }

  /**
   * Get full stake info including APY, reward rate, and time until epoch end
   */
  async getFullStakeInfo() {
    if (!this.isAvailable()) return { available: false, stakingAddress: null };

    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(this.network);
    const signer = await contractServiceWrapper.getSigner(this.network);
    const address = await signer.getAddress();

    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);
    const token = new ethers.Contract(this.tokenAddress, ERC20_APPROVE_ABI, provider);

    const [stakeData, stakeInfo, totalStaked, earned, balance, rewardRate, rewardsDuration, periodFinish, rewardPerToken, rewardPool, scammerCount, feesRouted] = await Promise.all([
      staking.getStakeInfo(address),
      staking.getStakeInfo(address).catch(() => null),
      staking.totalStaked(),
      staking.earned(address).catch(() => 0n),
      token.balanceOf(address),
      staking.stakingRewardRate().catch(() => 0n),
      Promise.resolve(604800n).catch(() => 604800n),
      staking.stakingPeriodFinish().catch(() => 0n),
      staking.rewardPerToken().catch(() => 0n),
      staking.rewardPoolBalance().catch(() => 0n),
      staking.getScammerCount().catch(() => 0n),
      staking.getFeeConfig().then(fc => fc[4]).catch(() => 0n)
    ]);

    const totalStakedFloat = parseFloat(ethers.formatUnits(totalStaked, 18));
    const rewardRateFloat = parseFloat(ethers.formatUnits(rewardRate, 18));
    const periodFinishTs = Number(periodFinish);
    const nowTs = Math.floor(Date.now() / 1000);
    const timeUntilEnd = Math.max(0, periodFinishTs - nowTs);

    // APY = (rewardRate * secondsInYear / totalStaked) * 100
    let apy = 0;
    if (totalStakedFloat > 0 && rewardRateFloat > 0) {
      const secondsInYear = 365.25 * 24 * 3600;
      apy = (rewardRateFloat * secondsInYear / totalStakedFloat) * 100;
    }

    // Lock tier info
    let lockTier = 0, lockExpiry = null, locked = false, effectiveBalance = 0, multiplier = 10000;
    if (stakeInfo) {
      effectiveBalance = parseFloat(ethers.formatUnits(stakeInfo[1], 18));
      lockTier = Number(stakeInfo[2]);
      const lockExpiryTs = Number(stakeInfo[3]);
      locked = stakeInfo[4];
      lockExpiry = lockExpiryTs > 0 ? new Date(lockExpiryTs * 1000) : null;
    }

    // Fetch tier multiplier
    try {
      const tierData = await staking.getStakingTier(lockTier);
      multiplier = Number(tierData[1]);
    } catch {}

    return {
      available: true,
      stakingAddress: this.stakingAddress,
      stakedAmount: parseFloat(ethers.formatUnits(stakeData.amount, 18)),
      stakedAt: stakeData[5] > 0 ? new Date(Number(stakeData[5]) * 1000) : null,
      totalStaked: totalStakedFloat,
      pendingRewards: parseFloat(ethers.formatUnits(earned, 18)),
      walletBalance: parseFloat(ethers.formatUnits(balance, 18)),
      rewardRate: rewardRateFloat,
      rewardsDuration: Number(rewardsDuration),
      periodFinish: periodFinishTs > 0 ? new Date(periodFinishTs * 1000) : null,
      timeUntilEnd,
      rewardPerToken: parseFloat(ethers.formatUnits(rewardPerToken, 18)),
      apy: parseFloat(apy.toFixed(2)),
      // Hub-specific
      lockTier,
      lockExpiry,
      locked,
      effectiveBalance,
      multiplier: multiplier / 100, // Convert bps to percentage (100 = 1x)
      rewardPool: parseFloat(ethers.formatUnits(rewardPool, 18)),
      scammerCount: Number(scammerCount),
      totalFeesRouted: parseFloat(ethers.formatUnits(feesRouted, 18))
    };
  }

  /**
   * Get available lock tiers
   */
  async getLockTiers() {
    if (!this.isAvailable()) return [];

    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);

    try {
      const count = Number(await staking.stakingTierCount());
      const tiers = [];
      for (let i = 0; i < count; i++) {
        const [duration, multiplier, active] = await staking.getStakingTier(i);
        tiers.push({
          id: i,
          duration: Number(duration),
          multiplier: Number(multiplier) / 100, // bps to percentage
          active
        });
      }
      return tiers;
    } catch {
      return [];
    }
  }

  /**
   * Fund a new reward epoch (owner only)
   */
  async fundRewards(amount, duration) {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');

    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const amountWei = ethers.parseUnits(amount.toString(), 18);

    // Approve staking contract to spend reward tokens
    const token = new ethers.Contract(this.tokenAddress, ERC20_APPROVE_ABI, signer);
    const allowance = await token.allowance(await signer.getAddress(), this.stakingAddress);
    if (allowance < amountWei) {
      const approveTx = await token.approve(this.stakingAddress, ethers.MaxUint256);
      await approveTx.wait();
    }

    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);

    // Optionally update duration before funding
    if (duration && duration > 0) {
      const currentPeriodFinish = await staking.stakingPeriodFinish();
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now > currentPeriodFinish) {
        const setDurTx = await staking.setRewardsDuration(duration);
        await setDurTx.wait();
        logger.info(`Set rewards duration to ${duration}s`);
      }
    }

    const tx = await staking.depositStakingRewards(amountWei);
    const receipt = await tx.wait();

    logger.info(`Funded ${amount} SKYNET rewards: tx=${receipt.hash}`);
    return { txHash: receipt.hash, amount, success: true };
  }

  /**
   * Get contract-wide stats for dashboard
   */
  async getContractStats() {
    if (!this.isAvailable()) return { available: false };

    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);

    const timeoutMs = 15000;
    const withTimeout = (promise, fallback) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), timeoutMs))
    ]).catch(() => fallback);

    const [totalStaked, rewardRate, rewardsDuration, periodFinish, rewardPerToken] = await Promise.all([
      withTimeout(staking.totalStaked(), 0n),
      withTimeout(staking.stakingRewardRate(), 0n),
      withTimeout(Promise.resolve(604800n), 604800n),
      withTimeout(staking.stakingPeriodFinish(), 0n),
      withTimeout(staking.rewardPerToken(), 0n)
    ]);

    const totalStakedFloat = parseFloat(ethers.formatUnits(totalStaked, 18));
    const rewardRateFloat = parseFloat(ethers.formatUnits(rewardRate, 18));
    const periodFinishTs = Number(periodFinish);
    const nowTs = Math.floor(Date.now() / 1000);
    const timeUntilEnd = Math.max(0, periodFinishTs - nowTs);

    let apy = 0;
    if (totalStakedFloat > 0 && rewardRateFloat > 0) {
      const secondsInYear = 365.25 * 24 * 3600;
      apy = (rewardRateFloat * secondsInYear / totalStakedFloat) * 100;
    }

    // Remaining rewards in current epoch
    const remainingRewards = rewardRateFloat * timeUntilEnd;

    return {
      available: true,
      stakingAddress: this.stakingAddress,
      totalStaked: totalStakedFloat,
      rewardRate: rewardRateFloat,
      rewardRatePerDay: rewardRateFloat * 86400,
      rewardsDuration: Number(rewardsDuration),
      periodFinish: periodFinishTs > 0 ? new Date(periodFinishTs * 1000) : null,
      timeUntilEnd,
      rewardPerToken: parseFloat(ethers.formatUnits(rewardPerToken, 18)),
      remainingRewards: parseFloat(remainingRewards.toFixed(2)),
      apy: parseFloat(apy.toFixed(2))
    };
  }

  /**
   * Verify a peer's on-chain stake for trust score calculation
   */
  async verifyPeerStake(peerWalletAddress) {
    if (!this.isAvailable() || !peerWalletAddress) return { verified: false, amount: 0 };

    try {
      const { ethers } = await import('ethers');
      const provider = await contractServiceWrapper.getProvider(this.network);
      const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);

      const stakeData = await staking.getStakeInfo(peerWalletAddress);
      const amount = parseFloat(ethers.formatUnits(stakeData[0], 18));

      return { verified: amount > 0, amount, stakedAt: Number(stakeData[5]) };
    } catch (err) {
      logger.debug(`Failed to verify peer stake for ${peerWalletAddress}: ${err.message}`);
      return { verified: false, amount: 0 };
    }
  }

  // ── LP Staking ─────────────────────────────────────────

  async stakeLP(amount, tierId = 0) {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);

    // Get LP token address from config
    const config = await staking.getConfig();
    const lpTokenAddress = config[1]; // lpToken
    if (!lpTokenAddress || lpTokenAddress === ethers.ZeroAddress) throw new Error('LP token not configured');

    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const lpToken = new ethers.Contract(lpTokenAddress, ERC20_APPROVE_ABI, signer);
    const allowance = await lpToken.allowance(await signer.getAddress(), this.stakingAddress);
    if (allowance < amountWei) {
      const approveTx = await lpToken.approve(this.stakingAddress, amountWei);
      await approveTx.wait();
    }
    const tx = await staking.stakeLP(amountWei, tierId);
    const receipt = await tx.wait();
    logger.info(`LP Staked ${amount} (tier ${tierId}): tx=${receipt.hash}`);
    return { txHash: receipt.hash, amount, tierId, success: true };
  }

  async unstakeLP(amount) {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const tx = await staking.unstakeLP(amountWei);
    const receipt = await tx.wait();
    logger.info(`LP Unstaked ${amount}: tx=${receipt.hash}`);
    return { txHash: receipt.hash, amount, success: true };
  }

  async claimLPRewards() {
    if (!this.isAvailable()) throw new Error('Staking contract not configured');
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, signer);
    const tx = await staking.claimLPRewards();
    const receipt = await tx.wait();
    logger.info(`LP rewards claimed: tx=${receipt.hash}`);
    return { txHash: receipt.hash, success: true };
  }

  async getLPStakeInfo() {
    if (!this.isAvailable()) return { available: false };
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(this.network);
    const signer = await contractServiceWrapper.getSigner(this.network);
    const address = await signer.getAddress();
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);

    const config = await staking.getConfig();
    const lpTokenAddress = config[1];
    if (!lpTokenAddress || lpTokenAddress === ethers.ZeroAddress) return { available: false };

    const lpToken = new ethers.Contract(lpTokenAddress, ERC20_APPROVE_ABI, provider);

    const [info, totalStaked, earned, balance, rewardRate, periodFinish] = await Promise.all([
      staking.getLPStakeInfo(address),
      staking.lpTotalStaked(),
      staking.lpEarned(address).catch(() => 0n),
      lpToken.balanceOf(address),
      staking.lpRewardRate().catch(() => 0n),
      staking.lpPeriodFinish().catch(() => 0n)
    ]);

    const totalStakedFloat = parseFloat(ethers.formatUnits(totalStaked, 18));
    const rewardRateFloat = parseFloat(ethers.formatUnits(rewardRate, 18));
    const periodFinishTs = Number(periodFinish);
    let apy = 0;
    if (totalStakedFloat > 0 && rewardRateFloat > 0) {
      apy = (rewardRateFloat * 365.25 * 86400 / totalStakedFloat) * 100;
    }

    return {
      available: true,
      lpTokenAddress,
      stakedAmount: parseFloat(ethers.formatUnits(info[0], 18)),
      effectiveBalance: parseFloat(ethers.formatUnits(info[1], 18)),
      tierId: Number(info[2]),
      lockExpiry: Number(info[3]) > 0 ? new Date(Number(info[3]) * 1000) : null,
      locked: info[4],
      stakedAt: Number(info[5]) > 0 ? new Date(Number(info[5]) * 1000) : null,
      totalStaked: totalStakedFloat,
      pendingRewards: parseFloat(ethers.formatUnits(earned, 18)),
      walletBalance: parseFloat(ethers.formatUnits(balance, 18)),
      rewardRate: rewardRateFloat,
      periodFinish: periodFinishTs > 0 ? new Date(periodFinishTs * 1000) : null,
      timeUntilEnd: Math.max(0, periodFinishTs - Math.floor(Date.now() / 1000)),
      apy: parseFloat(apy.toFixed(2))
    };
  }

  async getLPStakingTiers() {
    if (!this.isAvailable()) return [];
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);
    const tiers = [];
    try {
      const count = Number(await staking.lpStakingTierCount());
      for (let i = 0; i < count; i++) {
        const [duration, multiplier, active] = await staking.getLPStakingTier(i);
        tiers.push({ id: i, duration: Number(duration), multiplierBps: Number(multiplier), multiplier: Number(multiplier) / 10000, active });
      }
    } catch {}
    return tiers;
  }

  // ── Treasury Pool Views ────────────────────────────────

  async getTreasuryPools() {
    if (!this.isAvailable()) return null;
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(this.network);
    const staking = new ethers.Contract(this.stakingAddress, STAKING_ABI, provider);
    try {
      const [s, b, t, r] = await staking.getAllPoolBalances();
      const [autoReady, lpReady, available] = await staking.canAutoFund();
      return {
        staking: parseFloat(ethers.formatUnits(s, 18)),
        bounty: parseFloat(ethers.formatUnits(b, 18)),
        treasury: parseFloat(ethers.formatUnits(t, 18)),
        reserve: parseFloat(ethers.formatUnits(r, 18)),
        autoFundReady: autoReady,
        lpAutoFundReady: lpReady,
        autoFundAvailable: parseFloat(ethers.formatUnits(available, 18))
      };
    } catch { return null; }
  }
  // ── Vault Integration ─────────────────────────────────────

  async getVaultAddress() {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      return await SystemSettings.getSetting('skynet_vault_address', null);
    } catch { return null; }
  }

  async getVaultContract(signerOrProvider) {
    const address = await this.getVaultAddress();
    if (!address) return null;
    const { ethers } = await import('ethers');
    const VAULT_ABI = [
      'function deposit(uint256 amount, uint256 tierId, bool autoCompound) external',
      'function withdraw(uint256 amount) external',
      'function claimRewards() external',
      'function setAutoCompound(bool enabled) external',
      'function depositLP(uint256 amount, uint256 tierId, uint8 compoundMode) external',
      'function withdrawLP(uint256 amount) external',
      'function claimLPRewards() external',
      'function setLPCompoundMode(uint8 mode) external',
      'function compound() external',
      'function compoundLP() external',
      'function getUserInfo(address) view returns (uint256 amount, uint256 tierId, bool autoCompound, uint256 pendingRewards)',
      'function getLPUserInfo(address) view returns (uint256 amount, uint256 tierId, uint8 compoundMode, uint256 pendingRewards)',
      'function getVaultStats() view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)',
      'function getPendingRewards() view returns (uint256)',
      'function getPendingLPRewards() view returns (uint256)',
      'function totalDeposited() view returns (uint256)',
      'function totalLPDeposited() view returns (uint256)',
      'function emergencyWithdrawAll() external',
      'function pause() external',
      'function unpause() external'
    ];
    return new ethers.Contract(address, VAULT_ABI, signerOrProvider);
  }

  /**
   * Call compound() on the vault — claims and re-stakes for all auto-compound users.
   * Anyone can call this. Caller gets the compound bounty.
   */
  async vaultCompound() {
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const vault = await this.getVaultContract(signer);
    if (!vault) throw new Error('Vault not configured');
    const tx = await vault.compound();
    const receipt = await tx.wait();
    logger.info(`Vault compound: tx=${receipt.hash}`);
    return { txHash: receipt.hash, success: true };
  }

  /**
   * Call compoundLP() on the vault
   */
  async vaultCompoundLP() {
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const vault = await this.getVaultContract(signer);
    if (!vault) throw new Error('Vault not configured');
    const tx = await vault.compoundLP();
    const receipt = await tx.wait();
    logger.info(`Vault LP compound: tx=${receipt.hash}`);
    return { txHash: receipt.hash, success: true };
  }

  /**
   * Get vault stats
   */
  async getVaultStats() {
    try {
      const provider = await contractServiceWrapper.getProvider(this.network);
      const vault = await this.getVaultContract(provider);
      if (!vault) return null;
      const { ethers } = await import('ethers');
      const [totalDep, totalLPDep, stakerCount, lpStakerCount, bountyBps, slippageBps, paused] = await vault.getVaultStats();
      const [pendingRewards, pendingLPRewards] = await Promise.all([
        vault.getPendingRewards(),
        vault.getPendingLPRewards()
      ]);
      return {
        totalDeposited: parseFloat(ethers.formatEther(totalDep)),
        totalLPDeposited: parseFloat(ethers.formatEther(totalLPDep)),
        stakerCount: Number(stakerCount),
        lpStakerCount: Number(lpStakerCount),
        bountyBps: Number(bountyBps),
        slippageBps: Number(slippageBps),
        paused,
        pendingRewards: parseFloat(ethers.formatEther(pendingRewards)),
        pendingLPRewards: parseFloat(ethers.formatEther(pendingLPRewards))
      };
    } catch { return null; }
  }
}

export default new SkynetStakingService();
