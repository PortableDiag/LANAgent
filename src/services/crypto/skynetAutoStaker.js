import { logger } from '../../utils/logger.js';

/**
 * SkynetAutoStaker — roll wallet SKYNET surplus into the Diamond StakingFacet.
 *
 * Why this exists: the Diamond's FeeRouterFacet sends 40% of every scam-report
 * (and commerce / oracle / coordination) fee to the token-staking pool. Stakers
 * earn a share of that 40% proportional to their effective balance. SKYNET left
 * idle in an agent's wallet earns nothing; staked SKYNET earns continuously.
 *
 * For non-genesis agents this is the only way to recover anything from the
 * fees they pay when flagging scammers. For genesis, it compounds the existing
 * position automatically as rewards are auto-claimed and residual tokens get
 * swept into the wallet.
 *
 * Defaults are conservative: tier 0 (no lock), 2× current reportFee as wallet
 * reserve floor, 6-hour cooldown, 1000-SKYNET minimum increment.
 */

const DEFAULT_RESERVE_MULTIPLIER = 2;   // keep 2× reportFee in wallet
const DEFAULT_RESERVE_FALLBACK = 60000; // fallback floor if reportFee unreadable
const DEFAULT_MIN_INCREMENT = 1000;     // SKYNET — below this not worth gas
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIER = 0;                  // no lock by default

class SkynetAutoStaker {
  constructor() {
    this._lastRunAt = 0;
    this._inFlight = false;
  }

  /**
   * Run one pass. Safe to call repeatedly — bails on cooldown, disabled, no surplus, etc.
   * @returns {Promise<{staked: boolean, reason?: string, amount?: number, txHash?: string}>}
   */
  async runOnce() {
    if (this._inFlight) return { staked: false, reason: 'in_flight' };
    this._inFlight = true;
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const stakingService = (await import('./skynetStakingService.js')).default;
      const scammerRegistry = (await import('./scammerRegistryService.js')).default;

      const enabled = await SystemSettings.getSetting('skynet.autoStake.enabled', true);
      if (!enabled) return { staked: false, reason: 'disabled' };

      if (!stakingService.isAvailable()) {
        return { staked: false, reason: 'staking_unavailable' };
      }

      const cooldownMs = await SystemSettings.getSetting('skynet.autoStake.cooldownMs', DEFAULT_COOLDOWN_MS);
      const now = Date.now();
      if (now - this._lastRunAt < cooldownMs) {
        return { staked: false, reason: 'cooldown', cooldownRemaining: cooldownMs - (now - this._lastRunAt) };
      }

      const info = await stakingService.getFullStakeInfo();
      if (!info.available) return { staked: false, reason: 'not_available' };

      // Reserve floor: keep enough to flag at least N times (default 2)
      let reserveFloor = await SystemSettings.getSetting('skynet.autoStake.reserveFloor', null);
      if (reserveFloor === null) {
        try {
          const stats = await scammerRegistry.getStats();
          const fee = parseFloat(stats.reportFee);
          reserveFloor = Number.isFinite(fee) && fee > 0
            ? fee * DEFAULT_RESERVE_MULTIPLIER
            : DEFAULT_RESERVE_FALLBACK;
        } catch {
          reserveFloor = DEFAULT_RESERVE_FALLBACK;
        }
      }

      const minIncrement = await SystemSettings.getSetting('skynet.autoStake.minIncrement', DEFAULT_MIN_INCREMENT);
      const surplus = info.walletBalance - reserveFloor;
      if (surplus < minIncrement) {
        return {
          staked: false,
          reason: 'below_increment',
          walletBalance: info.walletBalance,
          reserveFloor,
          surplus,
          minIncrement
        };
      }

      // Tier selection: never downgrade (the contract reverts on tier < current).
      const requestedTier = await SystemSettings.getSetting('skynet.autoStake.tierId', DEFAULT_TIER);
      const currentTier = info.stakedAmount > 0 ? info.lockTier : 0;
      const tierId = Math.max(currentTier, requestedTier);

      const amountToStake = Math.floor(surplus);

      logger.info(`Auto-stake: walletBalance=${info.walletBalance.toFixed(2)} reserveFloor=${reserveFloor} → staking ${amountToStake} SKYNET at tier ${tierId}`);

      const result = await stakingService.stake(amountToStake, tierId);
      this._lastRunAt = now;

      // Record historical transaction
      try {
        const mongoose = (await import('mongoose')).default;
        const HistoricalTransaction = mongoose.model('HistoricalTransaction');
        await new HistoricalTransaction({
          transactionType: 'stakingFund',
          category: 'staking',
          amount: amountToStake,
          txHash: result.txHash,
          network: 'bsc',
          description: `Auto-staked ${amountToStake} SKYNET surplus (reserve floor ${reserveFloor}, tier ${tierId})`
        }).save();
      } catch (logErr) {
        logger.debug(`Auto-stake history log failed: ${logErr.message}`);
      }

      return { staked: true, amount: amountToStake, tierId, txHash: result.txHash };
    } catch (err) {
      logger.warn(`Auto-stake failed: ${err.message}`);
      return { staked: false, reason: 'error', error: err.message };
    } finally {
      this._inFlight = false;
    }
  }

  /**
   * Snapshot of current state (for /api/staking/auto-stake/status)
   */
  async getStatus() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const stakingService = (await import('./skynetStakingService.js')).default;
    const scammerRegistry = (await import('./scammerRegistryService.js')).default;

    const [enabled, cooldownMs, minIncrement, tierId, configuredFloor] = await Promise.all([
      SystemSettings.getSetting('skynet.autoStake.enabled', true),
      SystemSettings.getSetting('skynet.autoStake.cooldownMs', DEFAULT_COOLDOWN_MS),
      SystemSettings.getSetting('skynet.autoStake.minIncrement', DEFAULT_MIN_INCREMENT),
      SystemSettings.getSetting('skynet.autoStake.tierId', DEFAULT_TIER),
      SystemSettings.getSetting('skynet.autoStake.reserveFloor', null)
    ]);

    let effectiveFloor = configuredFloor;
    if (effectiveFloor === null) {
      try {
        const stats = await scammerRegistry.getStats();
        const fee = parseFloat(stats.reportFee);
        effectiveFloor = Number.isFinite(fee) && fee > 0
          ? fee * DEFAULT_RESERVE_MULTIPLIER
          : DEFAULT_RESERVE_FALLBACK;
      } catch {
        effectiveFloor = DEFAULT_RESERVE_FALLBACK;
      }
    }

    let walletBalance = null, stakedAmount = null, currentTier = null;
    if (stakingService.isAvailable()) {
      try {
        const info = await stakingService.getFullStakeInfo();
        if (info.available) {
          walletBalance = info.walletBalance;
          stakedAmount = info.stakedAmount;
          currentTier = info.lockTier;
        }
      } catch {}
    }

    const surplus = walletBalance !== null ? walletBalance - effectiveFloor : null;
    const cooldownRemaining = Math.max(0, cooldownMs - (Date.now() - this._lastRunAt));

    return {
      enabled,
      reserveFloor: effectiveFloor,
      reserveFloorAuto: configuredFloor === null,
      minIncrement,
      cooldownMs,
      cooldownRemaining,
      tierId,
      currentTier,
      walletBalance,
      stakedAmount,
      surplus,
      eligible: surplus !== null && surplus >= minIncrement && cooldownRemaining === 0 && enabled,
      lastRunAt: this._lastRunAt > 0 ? new Date(this._lastRunAt) : null
    };
  }
}

const skynetAutoStaker = new SkynetAutoStaker();
export default skynetAutoStaker;
