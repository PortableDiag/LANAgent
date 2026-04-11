import { cryptoLogger as logger } from '../../utils/logger.js';
import { strategyRegistry } from './strategies/StrategyRegistry.js';

/**
 * TokenTraderHeartbeatManager
 *
 * Manages independent heartbeat timers per token trader instance.
 * Each token gets its own execution cycle with regime-based intervals,
 * error isolation, and per-network swap mutex to prevent nonce conflicts.
 */

// Regime-based heartbeat intervals (ms)
const REGIME_INTERVALS = {
  DUMP:            60_000,   // 1 min — emergency sell needs speed
  MOON:           120_000,   // 2 min — trailing stop precision
  PUMP:           180_000,   // 3 min — trailing stop responsiveness
  ENTERING:       300_000,   // 5 min — timely initial buy
  DIP:            300_000,   // 5 min — watch for recovery
  SIDEWAYS:       600_000,   // 10 min — default, matches main heartbeat
  COOLDOWN:       900_000,   // 15 min — just monitoring
  CIRCUIT_BREAKER: 900_000,  // 15 min — just monitoring
};
const DEFAULT_INTERVAL = 600_000; // 10 min for unconfigured/unknown
const MAX_INTERVAL = 1_800_000;   // 30 min cap for error backoff
const MAX_CONCURRENT_TICKS = 3;   // semaphore limit
const TICK_TIMEOUT = 90_000;      // 90s max per token tick
const MARKET_DATA_CACHE_TTL = 60_000; // 60s shared market data cache
const MAX_CONSECUTIVE_ERRORS = 3; // errors before backoff
const RPC_RATE_LIMIT = 100;       // max RPC-heavy operations per minute (global)

class TokenTraderHeartbeatManager {
  constructor(cryptoAgent) {
    this.cryptoAgent = cryptoAgent;
    this.tokens = new Map(); // address -> { timer, running, lastRun, consecutiveErrors, currentInterval, regime }
    this.swapLocks = new Map(); // network -> Promise chain (nonce serialization)
    this.concurrentTicks = 0;
    this.started = false;
    this._ticksThisMinute = 0;
    this._tickMinuteReset = null;
  }

  /**
   * Start heartbeats for all registered token traders
   */
  startAll() {
    if (this.started) return;
    this.started = true;

    const allTraders = strategyRegistry.getAllTokenTraders();
    if (allTraders.size === 0) {
      logger.info('TokenHeartbeat: No token traders to start');
      return;
    }

    // Stagger starts so tokens don't all fire at once
    let staggerMs = 0;
    for (const [address] of allTraders) {
      setTimeout(() => this.startToken(address), staggerMs);
      staggerMs += 5_000; // 5s between each token's first tick
    }

    logger.info(`TokenHeartbeat: Starting ${allTraders.size} independent heartbeats (staggered over ${staggerMs / 1000}s)`);
  }

  /**
   * Stop all heartbeats and wait for in-flight ticks
   */
  async stopAll() {
    this.started = false;
    const runningPromises = [];

    for (const [address, state] of this.tokens) {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      if (state.runningPromise) {
        runningPromises.push(state.runningPromise);
      }
    }

    if (runningPromises.length > 0) {
      logger.info(`TokenHeartbeat: Waiting for ${runningPromises.length} in-flight tick(s) to complete...`);
      await Promise.allSettled(runningPromises);
    }

    this.tokens.clear();
    logger.info('TokenHeartbeat: All heartbeats stopped');
  }

  /**
   * Start heartbeat for a specific token
   */
  startToken(address) {
    const key = address.toLowerCase();
    if (this.tokens.has(key)) {
      // Update symbol in case token was reconfigured at this address
      const existing = this.tokens.get(key);
      const trader = strategyRegistry.getTokenTrader(key);
      const newSymbol = trader?.config?.tokenSymbol || key.slice(0, 10);
      if (existing.symbol !== newSymbol) {
        logger.info(`TokenHeartbeat: Updated ${existing.symbol} → ${newSymbol} at ${key.slice(0, 10)}...`);
        existing.symbol = newSymbol;
      }
      return;
    }

    const trader = strategyRegistry.getTokenTrader(key);
    const regime = trader?.state?.regime || null;
    const interval = this.getIntervalForRegime(regime);
    const symbol = trader?.config?.tokenSymbol || key.slice(0, 10);

    const state = {
      timer: null,
      running: false,
      runningPromise: null,
      lastRun: 0,
      consecutiveErrors: 0,
      currentInterval: interval,
      regime: regime,
      symbol: symbol
    };

    state.timer = setInterval(() => this._tick(key), interval);
    this.tokens.set(key, state);

    logger.info(`TokenHeartbeat: Started ${symbol} — interval ${interval / 1000}s (${regime || 'default'})`);
  }

  /**
   * Stop heartbeat for a specific token
   */
  async stopToken(address) {
    const key = address.toLowerCase();
    const state = this.tokens.get(key);
    if (!state) return;

    if (state.timer) clearInterval(state.timer);
    state.timer = null;

    if (state.runningPromise) {
      logger.info(`TokenHeartbeat: Waiting for ${state.symbol} tick to complete before stopping...`);
      await state.runningPromise;
    }

    this.tokens.delete(key);
    logger.info(`TokenHeartbeat: Stopped ${state.symbol}`);
  }

  /**
   * Get interval based on regime
   */
  getIntervalForRegime(regime) {
    return REGIME_INTERVALS[regime] || DEFAULT_INTERVAL;
  }

  /**
   * Internal tick handler — called by setInterval for each token
   */
  async _tick(address) {
    if (!this.started) return;

    const state = this.tokens.get(address);
    if (!state) return;

    // Overlap protection: skip if previous tick still running
    if (state.running) {
      logger.debug(`TokenHeartbeat: ${state.symbol} — skipping, previous tick still running`);
      return;
    }

    // Concurrency semaphore
    if (this.concurrentTicks >= MAX_CONCURRENT_TICKS) {
      logger.debug(`TokenHeartbeat: ${state.symbol} — skipping, ${MAX_CONCURRENT_TICKS} concurrent ticks already running`);
      return;
    }

    // Global rate limiter: reset counter every minute
    const now = Date.now();
    if (!this._tickMinuteReset || now - this._tickMinuteReset > 60_000) {
      this._ticksThisMinute = 0;
      this._tickMinuteReset = now;
    }
    if (this._ticksThisMinute >= RPC_RATE_LIMIT) {
      logger.debug(`TokenHeartbeat: Rate limit reached (${RPC_RATE_LIMIT} ticks/min), deferring ${state.symbol}`);
      return;
    }

    state.running = true;
    state.runningPromise = this._executeTick(address, state);

    try {
      await state.runningPromise;
    } finally {
      state.running = false;
      state.runningPromise = null;
    }
  }

  /**
   * Execute a single tick for a token
   */
  async _executeTick(address, state) {
    this.concurrentTicks++;
    this._ticksThisMinute++;
    const startTime = Date.now();

    try {
      // Build decision
      const config = this.cryptoAgent.getConfig();
      const decision = {
        strategy: 'token_trader',
        tokenAddress: address,
        confidence: 1.0,
        tradeParams: {
          direction: 'analyze',
          percentOfBalance: config.maxTradePercentage || 25
        }
      };

      // Get market data (cached or fresh)
      const marketData = await this.cryptoAgent.getOrFetchMarketData();

      // Get the token's network for swap lock
      const trader = strategyRegistry.getTokenTrader(address);
      const network = trader?.config?.tokenNetwork || 'bsc';

      // Execute with per-network swap lock (prevents nonce conflicts) and timeout
      const result = await Promise.race([
        this.withSwapLock(network, () => this.cryptoAgent.executeTokenTrader(decision, marketData)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Token trader tick timeout (${TICK_TIMEOUT / 1000}s)`)), TICK_TIMEOUT)
        )
      ]);

      // Record trade if action taken
      if (result?.action && result.action !== 'hold') {
        await this.cryptoAgent.recordTrade(decision, result);
      }

      // Persist registry state
      await this.cryptoAgent.persistRegistryState();

      // Update state on success
      state.lastRun = Date.now();
      state.consecutiveErrors = 0;

      // Check if regime changed and adjust interval
      const updatedTrader = strategyRegistry.getTokenTrader(address);
      const newRegime = updatedTrader?.state?.regime || null;
      if (newRegime !== state.regime) {
        const oldRegime = state.regime;
        state.regime = newRegime;
        const newInterval = this.getIntervalForRegime(newRegime);
        if (newInterval !== state.currentInterval) {
          this._reschedule(address, state, newInterval);
          logger.info(`TokenHeartbeat: ${state.symbol} regime ${oldRegime || 'null'} → ${newRegime} — interval ${state.currentInterval / 1000}s → ${newInterval / 1000}s`);
        }
      }

      const elapsed = Date.now() - startTime;
      const action = result?.action || 'hold';
      if (action !== 'hold') {
        logger.info(`TokenHeartbeat: ${state.symbol} tick complete — ${action} (${elapsed}ms)`);
      } else {
        logger.debug(`TokenHeartbeat: ${state.symbol} tick complete — hold (${elapsed}ms)`);
      }

    } catch (error) {
      state.consecutiveErrors++;
      const elapsed = Date.now() - startTime;
      logger.warn(`TokenHeartbeat: ${state.symbol} tick error (${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${error.message} (${elapsed}ms)`);

      // Backoff after repeated errors
      if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        const backoffInterval = Math.min(state.currentInterval * 2, MAX_INTERVAL);
        if (backoffInterval !== state.currentInterval) {
          this._reschedule(address, state, backoffInterval);
          logger.warn(`TokenHeartbeat: ${state.symbol} — backing off to ${backoffInterval / 1000}s after ${state.consecutiveErrors} consecutive errors`);
        }
      }
    } finally {
      this.concurrentTicks--;
    }
  }

  /**
   * Reschedule a token's interval
   */
  _reschedule(address, state, newInterval) {
    if (state.timer) clearInterval(state.timer);
    state.currentInterval = newInterval;
    state.timer = setInterval(() => this._tick(address), newInterval);
  }

  /**
   * Per-network swap mutex — prevents nonce conflicts when multiple tokens
   * on the same network try to execute swaps simultaneously.
   *
   * Usage: await manager.withSwapLock('bsc', async () => { ... swap ... });
   */
  async withSwapLock(network, fn) {
    const prev = this.swapLocks.get(network) || Promise.resolve();
    let resolve;
    const current = new Promise(r => { resolve = r; });
    this.swapLocks.set(network, current);

    try {
      await prev; // wait for previous swap on this network
      return await fn();
    } finally {
      resolve();
      // Clean up if this was the last in chain
      if (this.swapLocks.get(network) === current) {
        this.swapLocks.delete(network);
      }
    }
  }

  /**
   * Get status for API/UI
   */
  getStatus() {
    const status = {};
    for (const [address, state] of this.tokens) {
      status[address] = {
        symbol: state.symbol,
        regime: state.regime,
        interval: state.currentInterval / 1000,
        intervalLabel: this._intervalLabel(state.currentInterval),
        running: state.running,
        lastRun: state.lastRun ? new Date(state.lastRun).toISOString() : null,
        consecutiveErrors: state.consecutiveErrors,
        backedOff: state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
      };
    }
    return {
      started: this.started,
      tokenCount: this.tokens.size,
      concurrentTicks: this.concurrentTicks,
      ticksThisMinute: this._ticksThisMinute,
      tokens: status
    };
  }

  _intervalLabel(ms) {
    if (ms < 60_000) return `${ms / 1000}s`;
    return `${ms / 60_000}m`;
  }
}

export default TokenTraderHeartbeatManager;
