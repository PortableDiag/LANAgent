import { logger } from '../../utils/logger.js';
import lpManager from './lpManager.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import LPPosition from '../../models/LPPosition.js';

const SKYNET_ADDRESS = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const V2_PAIR_ADDRESS = '0xF3dEF3534EEC3195e0C217938F710E6F2838694A';
const V3_POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';
const V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';

// Token0 is SKYNET (0x8E < 0xbb), token1 is WBNB
const TOKEN0 = SKYNET_ADDRESS;
const TOKEN1 = WBNB_ADDRESS;

const DEFAULT_CONFIG = {
  enabled: false,
  network: 'bsc',
  feeTier: 2500,
  rangePercent: 20,
  allocationBNB: 0.01,
  allocationSKYNET: 500000,
  minRebalanceCooldownMs: 30 * 60 * 1000,
  maxRebalancesPerDay: 5,
  collectFeesIntervalMs: 60 * 60 * 1000,
};

const DEFAULT_STATE = {
  tokenId: null,
  poolAddress: null,
  active: false,
  tickLower: null,
  tickUpper: null,
  rebalanceCount: 0,
  rebalancesLast24h: [],
  totalFeesCollectedSKYNET: '0',
  totalFeesCollectedWBNB: '0',
  lastRebalanceAt: null,
  lastFeeCollectAt: null,
  openedAt: null,
  lastOpenAttemptAt: null,
};

const V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
];

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const V2_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

const WBNB_ABI = [
  'function deposit() external payable',
  'function balanceOf(address) external view returns (uint256)',
];

const POSITION_MANAGER_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

/**
 * BigInt integer square root via Newton's method
 */
function sqrtBigInt(n) {
  if (n < 0n) throw new Error('Square root of negative number');
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

class LPMarketMaker {
  constructor() {
    this._config = null;
    this._state = null;
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) return;
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      this.SystemSettings = SystemSettings;

      const savedConfig = await SystemSettings.getSetting('lp_market_maker_config', null);
      this._config = savedConfig ? { ...DEFAULT_CONFIG, ...savedConfig } : { ...DEFAULT_CONFIG };

      const savedState = await SystemSettings.getSetting('lp_market_maker_state', null);
      this._state = savedState ? { ...DEFAULT_STATE, ...savedState } : { ...DEFAULT_STATE };

      this._initialized = true;
      logger.debug('LP Market Maker initialized');
    } catch (err) {
      logger.error(`LP Market Maker init failed: ${err.message}`);
      this._config = { ...DEFAULT_CONFIG };
      this._state = { ...DEFAULT_STATE };
      this._initialized = true;
    }
  }

  async getConfig() {
    if (!this._initialized) await this.initialize();
    return { ...this._config };
  }

  async getState() {
    if (!this._initialized) await this.initialize();
    return { ...this._state };
  }

  async saveState(partial) {
    Object.assign(this._state, partial);
    await this.SystemSettings.setSetting('lp_market_maker_state', this._state, 'LP Market Maker state', 'crypto');
  }

  async saveConfig(config) {
    this._config = { ...this._config, ...config };
    await this.SystemSettings.setSetting('lp_market_maker_config', this._config, 'LP Market Maker config', 'crypto');
  }

  /**
   * Ensure the V3 pool exists, creating it if necessary
   */
  async ensurePoolExists() {
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider('bsc');
    const factory = new ethers.Contract(V3_FACTORY, V3_FACTORY_ABI, provider);

    const poolAddr = await factory.getPool(TOKEN0, TOKEN1, this._config.feeTier);
    if (poolAddr && poolAddr !== ethers.ZeroAddress) {
      logger.info(`V3 pool exists: ${poolAddr}`);
      return poolAddr;
    }

    // Pool doesn't exist — create and initialize
    logger.info('V3 pool not found, creating...');
    const sqrtPriceX96 = await this.computeInitialSqrtPrice();
    const signer = await contractServiceWrapper.getSigner('bsc');
    const posManager = new ethers.Contract(V3_POSITION_MANAGER, POSITION_MANAGER_ABI, signer);

    const tx = await posManager.createAndInitializePoolIfNecessary(
      TOKEN0, TOKEN1, this._config.feeTier, sqrtPriceX96
    );
    const receipt = await tx.wait();
    logger.info(`V3 pool created: tx=${receipt.hash}`);

    // Read the pool address now
    const newPool = await factory.getPool(TOKEN0, TOKEN1, this._config.feeTier);
    logger.info(`V3 pool address: ${newPool}`);
    return newPool;
  }

  /**
   * Compute sqrtPriceX96 from V2 pair reserves using BigInt Newton's method
   * token0 = SKYNET, token1 = WBNB
   * price = reserve1/reserve0 (how much WBNB per SKYNET)
   * sqrtPriceX96 = sqrt(price) * 2^96 = sqrt(reserve1 * 2^192 / reserve0)
   */
  async computeInitialSqrtPrice() {
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider('bsc');
    const pair = new ethers.Contract(V2_PAIR_ADDRESS, V2_PAIR_ABI, provider);

    const pairToken0 = await pair.token0();
    const reserves = await pair.getReserves();

    let reserveSKYNET, reserveWBNB;
    if (pairToken0.toLowerCase() === SKYNET_ADDRESS.toLowerCase()) {
      reserveSKYNET = reserves.reserve0;
      reserveWBNB = reserves.reserve1;
    } else {
      reserveSKYNET = reserves.reserve1;
      reserveWBNB = reserves.reserve0;
    }

    // TOKEN0 = SKYNET, TOKEN1 = WBNB
    // sqrtPriceX96 = sqrt(reserveWBNB * 2^192 / reserveSKYNET)
    const r0 = BigInt(reserveSKYNET.toString());
    const r1 = BigInt(reserveWBNB.toString());
    if (r0 === 0n) throw new Error('SKYNET reserve is zero');

    const numerator = r1 * (2n ** 192n);
    const sqrtPrice = sqrtBigInt(numerator / r0);
    logger.info(`Computed sqrtPriceX96: ${sqrtPrice.toString()}`);
    return sqrtPrice;
  }

  /**
   * Wrap native BNB to WBNB
   */
  async wrapBNB(amount) {
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner('bsc');
    const wbnb = new ethers.Contract(WBNB_ADDRESS, WBNB_ABI, signer);
    const amountWei = ethers.parseEther(amount.toString());
    const tx = await wbnb.deposit({ value: amountWei });
    await tx.wait();
    logger.info(`Wrapped ${amount} BNB → WBNB`);
  }

  /**
   * Open a new V3 concentrated liquidity position
   */
  async openPosition() {
    if (!this._initialized) await this.initialize();
    if (!this._config.enabled) throw new Error('Market maker is not enabled');

    const network = this._config.network;
    if (network !== 'bsc') throw new Error('Market maker only runs on BSC mainnet');

    if (this._state.active) throw new Error('Position already active. Close it first.');

    // Ensure pool exists
    const poolAddress = await this.ensurePoolExists();

    // Wrap BNB → WBNB
    await this.wrapBNB(this._config.allocationBNB);

    // Add V3 liquidity via lpManager
    const result = await lpManager.addLiquidityV3(
      SKYNET_ADDRESS,
      WBNB_ADDRESS,
      this._config.allocationSKYNET,
      this._config.allocationBNB,
      this._config.feeTier,
      this._config.rangePercent,
      network
    );

    await this.saveState({
      tokenId: result.tokenId,
      poolAddress,
      active: true,
      tickLower: result.tickLower,
      tickUpper: result.tickUpper,
      openedAt: new Date().toISOString(),
      rebalanceCount: 0,
      rebalancesLast24h: [],
    });

    await this._notifyTelegram(`V3 MM: Opened position #${result.tokenId}\nRange: [${result.tickLower}, ${result.tickUpper}]\nBNB: ${this._config.allocationBNB} | SKYNET: ${this._config.allocationSKYNET}`);

    logger.info(`LP MM: Position opened, tokenId=${result.tokenId}`);
    return { success: true, tokenId: result.tokenId, poolAddress, tickLower: result.tickLower, tickUpper: result.tickUpper };
  }

  /**
   * Rebalance: remove all liquidity, re-add at new center tick
   */
  async rebalancePosition() {
    if (!this._initialized) await this.initialize();
    if (!this._state.active || !this._state.tokenId) {
      throw new Error('No active position to rebalance');
    }

    const network = this._config.network;
    const tokenId = this._state.tokenId;

    // Remove 100% liquidity (this also collects in removeLiquidityV3)
    try {
      await lpManager.removeLiquidityV3(tokenId, 100, network);
    } catch (err) {
      if (!err.message?.includes('no liquidity') && !err.message?.includes('Position has no liquidity')) {
        throw err;
      }
      logger.info(`LP MM: Position #${tokenId} already has zero liquidity, proceeding with rebalance`);
    }
    logger.info(`LP MM: Removed liquidity from position #${tokenId}`);

    // Read wallet balances and cap to allocation
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(network);
    const signerAddr = await (await contractServiceWrapper.getSigner(network)).getAddress();

    const skynetBalResult = await contractServiceWrapper.getTokenBalance(SKYNET_ADDRESS, signerAddr, network);
    const skynetBal = skynetBalResult.formatted;
    const wbnbContract = new ethers.Contract(WBNB_ADDRESS, WBNB_ABI, provider);
    const wbnbBal = ethers.formatEther(await wbnbContract.balanceOf(signerAddr));

    const skynetAmount = Math.min(parseFloat(skynetBal), this._config.allocationSKYNET);
    const wbnbAmount = Math.min(parseFloat(wbnbBal), this._config.allocationBNB);

    if (skynetAmount <= 0 || wbnbAmount <= 0) {
      await this.saveState({ active: false });
      const msg = `LP MM: Insufficient balance for rebalance (SKYNET: ${skynetBal}, WBNB: ${wbnbBal})`;
      logger.warn(msg);
      await this._notifyTelegram(msg);
      return { success: false, reason: 'insufficient_balance' };
    }

    // Add new position centered on current tick
    const result = await lpManager.addLiquidityV3(
      SKYNET_ADDRESS, WBNB_ADDRESS,
      skynetAmount, wbnbAmount,
      this._config.feeTier,
      this._config.rangePercent,
      network
    );

    // Update rebalance tracking
    const now = new Date().toISOString();
    const rebalancesLast24h = [...this._state.rebalancesLast24h, now].filter(
      ts => Date.now() - new Date(ts).getTime() < 24 * 60 * 60 * 1000
    );

    await this.saveState({
      tokenId: result.tokenId,
      tickLower: result.tickLower,
      tickUpper: result.tickUpper,
      active: true,
      // Per-position scope — `openedAt` describes the *current* tokenId's mint
      // time. Without this reset it stays at whichever position was first
      // opened, even after multiple rebalances replace the tokenId.
      openedAt: now,
      // Strategy-level scope — kept rolling/cumulative on purpose:
      //   `rebalanceCount` is the lifetime count of rebalances done by the
      //   strategy across all positions.
      //   `rebalancesLast24h` is the rolling window the circuit breaker uses
      //   (line 492 below); zeroing it would let the strategy spam-rebalance.
      rebalanceCount: (this._state.rebalanceCount || 0) + 1,
      rebalancesLast24h,
      lastRebalanceAt: now,
    });

    // Update DB position v3.lastRebalance
    try {
      const dbPos = await LPPosition.findOne({ 'v3.tokenId': result.tokenId, network });
      if (dbPos) {
        dbPos.v3.lastRebalance = new Date();
        await dbPos.save();
      }
    } catch (err) {
      logger.debug(`Failed to update DB position lastRebalance: ${err.message}`);
    }

    await this._notifyTelegram(`V3 MM: Rebalanced → position #${result.tokenId}\nNew range: [${result.tickLower}, ${result.tickUpper}]\nRebalance #${this._state.rebalanceCount}`);

    logger.info(`LP MM: Rebalanced to position #${result.tokenId}, range=[${result.tickLower},${result.tickUpper}]`);
    return { success: true, tokenId: result.tokenId, tickLower: result.tickLower, tickUpper: result.tickUpper };
  }

  /**
   * Collect accumulated fees from active position
   */
  async collectFees() {
    if (!this._initialized) await this.initialize();
    if (!this._state.active || !this._state.tokenId) {
      throw new Error('No active position to collect fees from');
    }

    const result = await lpManager.collectFeesV3(this._state.tokenId, this._config.network);

    if (result.skipped) {
      // Still update timestamp so we don't retry every heartbeat
      await this.saveState({ lastFeeCollectAt: new Date().toISOString() });
      return { success: true, skipped: true, reason: result.reason };
    }

    // Increment lifetime totals. Pool ordering is canonical (token0 < token1 by
    // address); for SKYNET/WBNB on BSC, SKYNET=token0, WBNB=token1 (see TOKEN0/TOKEN1).
    const addSKYNET = parseFloat(result.amount0 || '0');
    const addWBNB = parseFloat(result.amount1 || '0');
    const prevSKYNET = parseFloat(this._state.totalFeesCollectedSKYNET || '0');
    const prevWBNB = parseFloat(this._state.totalFeesCollectedWBNB || '0');
    const newSKYNET = (prevSKYNET + addSKYNET).toString();
    const newWBNB = (prevWBNB + addWBNB).toString();

    await this.saveState({
      lastFeeCollectAt: new Date().toISOString(),
      totalFeesCollectedSKYNET: newSKYNET,
      totalFeesCollectedWBNB: newWBNB,
    });

    logger.info(`LP MM: Fees collected for position #${this._state.tokenId} — +${addSKYNET.toFixed(4)} SKYNET, +${addWBNB.toFixed(6)} WBNB (lifetime: ${parseFloat(newSKYNET).toFixed(2)} SKYNET, ${parseFloat(newWBNB).toFixed(6)} WBNB)`);
    return { success: true, txHash: result.txHash, amount0: result.amount0, amount1: result.amount1 };
  }

  /**
   * Close (remove all liquidity) and deactivate position
   */
  async closePosition() {
    if (!this._initialized) await this.initialize();
    if (!this._state.active || !this._state.tokenId) {
      throw new Error('No active position to close');
    }

    try {
      await lpManager.removeLiquidityV3(this._state.tokenId, 100, this._config.network);
    } catch (err) {
      // Position may already have zero liquidity (e.g. partial rebalance failure)
      if (err.message?.includes('no liquidity') || err.message?.includes('Position has no liquidity')) {
        logger.info(`LP MM: Position #${this._state.tokenId} already has zero liquidity, marking closed`);
      } else {
        throw err;
      }
    }

    await this.saveState({
      active: false,
    });

    await this._notifyTelegram(`V3 MM: Position #${this._state.tokenId} closed`);
    logger.info(`LP MM: Position #${this._state.tokenId} closed`);
    return { success: true };
  }

  /**
   * Main heartbeat handler — called from CryptoStrategyAgent every ~10 min
   */
  async check() {
    if (!this._initialized) await this.initialize();

    if (!this._config.enabled) {
      return { action: 'idle', reason: 'disabled' };
    }

    if (!this._state.active || !this._state.tokenId) {
      // Auto-open: attempt to open a position if none exists
      const lastAttempt = this._state.lastOpenAttemptAt;
      const cooldown = 10 * 60 * 1000; // 10 min between attempts
      if (!lastAttempt || Date.now() - new Date(lastAttempt).getTime() > cooldown) {
        try {
          logger.info('LP MM: No active position — auto-opening...');
          await this.saveState({ lastOpenAttemptAt: new Date().toISOString() });
          const result = await this.openPosition();
          if (result.success) {
            await this._notifyTelegram(`LP MM auto-opened position (tokenId: ${result.tokenId})`);
            return { action: 'opened', reason: 'auto_opened_position', tokenId: result.tokenId };
          } else {
            logger.warn(`LP MM auto-open failed: ${result.error}`);
            return { action: 'idle', reason: `auto_open_failed: ${result.error}` };
          }
        } catch (err) {
          logger.warn(`LP MM auto-open error: ${err.message}`);
          return { action: 'idle', reason: `auto_open_error: ${err.message}` };
        }
      }
      return { action: 'idle', reason: 'no_active_position (cooldown)' };
    }

    try {
      const { ethers } = await import('ethers');
      const provider = await contractServiceWrapper.getProvider(this._config.network);

      // Read current pool tick
      const pool = new ethers.Contract(this._state.poolAddress, V3_POOL_ABI, provider);
      const slot0 = await pool.slot0();
      const currentTick = Number(slot0.tick);

      const inRange = currentTick >= this._state.tickLower && currentTick < this._state.tickUpper;

      // Update in-range status on DB
      try {
        const dbPos = await LPPosition.findOne({ 'v3.tokenId': this._state.tokenId, network: this._config.network });
        if (dbPos) {
          dbPos.v3.inRange = inRange;
          await dbPos.save();
        }
      } catch { /* non-critical */ }

      if (inRange) {
        // Collect fees if enough time has passed
        const lastCollect = this._state.lastFeeCollectAt ? new Date(this._state.lastFeeCollectAt).getTime() : 0;
        if (Date.now() - lastCollect > this._config.collectFeesIntervalMs) {
          try {
            const feeResult = await this.collectFees();
            if (feeResult.skipped) {
              return { action: 'in_range', reason: `tick=${currentTick} in [${this._state.tickLower},${this._state.tickUpper}] (no pending fees)` };
            }
            return { action: 'collected_fees', reason: 'periodic_collection' };
          } catch (err) {
            logger.debug(`LP MM fee collection failed: ${err.message}`);
          }
        }
        return { action: 'in_range', reason: `tick=${currentTick} in [${this._state.tickLower},${this._state.tickUpper}]` };
      }

      // Out of range — check safety gates
      const now = Date.now();

      // Cooldown check
      const lastRebalance = this._state.lastRebalanceAt ? new Date(this._state.lastRebalanceAt).getTime() : 0;
      if (now - lastRebalance < this._config.minRebalanceCooldownMs) {
        const waitMin = Math.ceil((this._config.minRebalanceCooldownMs - (now - lastRebalance)) / 60000);
        return { action: 'cooldown', reason: `Rebalance cooldown: ${waitMin}min remaining` };
      }

      // Circuit breaker: max rebalances per 24h
      const recentRebalances = (this._state.rebalancesLast24h || []).filter(
        ts => now - new Date(ts).getTime() < 24 * 60 * 60 * 1000
      );
      if (recentRebalances.length >= this._config.maxRebalancesPerDay) {
        const msg = `LP MM: Circuit breaker — ${recentRebalances.length} rebalances in 24h (max ${this._config.maxRebalancesPerDay})`;
        logger.warn(msg);
        await this._notifyTelegram(msg);
        return { action: 'circuit_breaker', reason: msg };
      }

      // All gates pass — rebalance
      logger.info(`LP MM: Position out of range (tick=${currentTick}, range=[${this._state.tickLower},${this._state.tickUpper}]). Rebalancing...`);
      const rebalResult = await this.rebalancePosition();
      return { action: 'rebalanced', reason: `tick=${currentTick} was out of range`, ...rebalResult };

    } catch (err) {
      logger.error(`LP MM check error: ${err.message}`);
      return { action: 'error', reason: err.message };
    }
  }

  /**
   * Get full status snapshot for API/UI
   */
  async getStatus() {
    if (!this._initialized) await this.initialize();
    const state = { ...this._state };

    // Enrich with live on-chain data if active
    if (state.active && state.poolAddress && state.tickLower !== null) {
      try {
        const { ethers } = await import('ethers');
        const provider = await contractServiceWrapper.getProvider(this._config.network);
        const pool = new ethers.Contract(state.poolAddress, V3_POOL_ABI, provider);
        const slot0 = await pool.slot0();
        state.currentTick = Number(slot0.tick);
        state.inRange = state.currentTick >= state.tickLower && state.currentTick < state.tickUpper;
      } catch (err) {
        logger.debug(`LP MM getStatus: could not fetch live tick: ${err.message}`);
        state.currentTick = null;
        state.inRange = null;
      }
    }

    return {
      config: { ...this._config },
      state,
    };
  }

  /**
   * Enable the market maker (optionally override config)
   */
  async enable(configOverrides = {}) {
    if (!this._initialized) await this.initialize();
    const allowedKeys = ['rangePercent', 'feeTier', 'allocationBNB', 'allocationSKYNET'];
    const overrides = {};
    for (const key of allowedKeys) {
      if (configOverrides[key] !== undefined) {
        overrides[key] = configOverrides[key];
      }
    }
    await this.saveConfig({ ...overrides, enabled: true });
    logger.info('LP Market Maker enabled');
    return { success: true, config: this._config };
  }

  /**
   * Disable and optionally close active position
   */
  async disable() {
    if (!this._initialized) await this.initialize();
    if (this._state.active && this._state.tokenId) {
      try {
        await this.closePosition();
      } catch (err) {
        logger.warn(`Failed to close position on disable: ${err.message}`);
      }
    }
    await this.saveConfig({ enabled: false });
    logger.info('LP Market Maker disabled');
    return { success: true };
  }

  /**
   * Send Telegram notification
   */
  async _notifyTelegram(message) {
    try {
      const { default: agentSingleton } = await import('../../core/agent.js');
      const telegram = agentSingleton?.interfaces?.get('telegram');
      if (telegram && telegram.sendNotification) {
        await telegram.sendNotification(message, { parse_mode: 'Markdown' });
      }
    } catch {
      // Telegram not available — non-critical
    }
  }
}

export default new LPMarketMaker();
