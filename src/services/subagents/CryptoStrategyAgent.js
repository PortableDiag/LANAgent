import { cryptoLogger as logger } from '../../utils/logger.js';
import { BaseAgentHandler } from './BaseAgentHandler.js';
import walletService from '../crypto/walletService.js';
import swapService from '../crypto/swapService.js';
import contractServiceWrapper from '../crypto/contractServiceWrapper.js';
import { strategyRegistry } from '../crypto/strategies/StrategyRegistry.js';
import { tokenScanner } from '../crypto/tokenScanner.js';
import TokenTraderHeartbeatManager from '../crypto/TokenTraderHeartbeatManager.js';

/**
 * CryptoStrategyAgent
 *
 * Intelligent crypto trading agent that replaces the simple loop-based strategy.
 *
 * Key features:
 * - Local analysis first (free Chainlink reads) - only calls LLM when actionable
 * - Multiple strategy tools (DCA, MeanReversion, Momentum, Arbitrage)
 * - Cost-aware execution with budget tracking
 * - Learning from past trades
 * - Event-driven rather than blind loops
 */

// System tokens that must never be auto-sold, blacklisted, or reported as scams
// by the residual sweep / unknown-token processor — user-owned tokens with thin
// liquidity that would otherwise trip the "Output sanity check failed" / "no
// viable swap path" instant-blacklist branches.
// The list itself lives in ../crypto/systemTokens.js so strategies can consult
// it without importing this module back (that edge would be circular — this
// module already pulls the strategies in via StrategyRegistry). Re-exported
// here so every existing importer of isSystemToken keeps working unchanged.
import { SYSTEM_TOKEN_ALLOWLIST, isSystemToken } from '../crypto/systemTokens.js';
export { isSystemToken };

// CoinGecko ID mapping for tokens
const COINGECKO_IDS = {
  ETH: 'ethereum',
  tBNB: 'binancecoin',  // testnet BNB uses mainnet price
  BNB: 'binancecoin',
  MATIC: 'matic-network'
};

// CoinGecko platform IDs for contract-based price lookup
const COINGECKO_PLATFORMS = {
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  polygon: 'polygon-pos',
  base: 'base'
};

// Network and token configuration
const NETWORK_CONFIG = {
  testnet: {
    sepolia: {
      symbol: 'ETH',
      decimals: 18,
      stablecoin: 'USDC',
      stablecoinAddress: null,
      priceFeed: '0x694AA1769357215DE4FAC081bf1f309aDC325306'
    },
    'bsc-testnet': {
      symbol: 'tBNB',
      decimals: 18,
      stablecoin: 'BUSD',
      stablecoinAddress: '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee',
      priceFeed: '0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526'
    }
  },
  mainnet: {
    ethereum: {
      symbol: 'ETH',
      decimals: 18,
      stablecoin: 'USDC',
      stablecoinAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
    },
    bsc: {
      symbol: 'BNB',
      decimals: 18,
      stablecoin: 'USDT',
      stablecoinAddress: '0x55d398326f99059fF775485246999027B3197955',
      priceFeed: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE'
    }
  }
};

// Chainlink price feeds for ERC20 tokens (token address → price feed address)
// These give authoritative USD prices without relying on DEX liquidity
const TOKEN_CHAINLINK_FEEDS = {
  bsc: {
    '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD': '0xca236E327F629f9Fc2c30A4E95775EbF0B89fAC8', // LINK/USD
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8': '0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e', // ETH/USD
    '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c': '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf', // BTC/USD
  },
  ethereum: {
    '0x514910771AF9Ca656af840dff83E8264EcF986CA': '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c', // LINK/USD
  }
};

// Chainlink Price Feed ABI
const PRICE_FEED_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function'
  }
];

// Native symbol per network, for looking up the gas reserve the project already
// declares (dollar_maximizer's `gasReserves`: BNB 0.05, ETH 0.01, MATIC 1.0).
const NATIVE_SYMBOL = { ethereum: 'ETH', bsc: 'BNB', polygon: 'MATIC', base: 'ETH', arbitrum: 'ETH' };
// Last-resort floors, used ONLY when the strategy registry cannot be reached.
// Deliberately the same numbers the strategy declares, so the fallback can never
// silently disagree with the live configuration.
const FALLBACK_NATIVE_GAS_FLOOR = { ETH: 0.01, BNB: 0.05, MATIC: 1.0 };
const DEFAULT_NATIVE_GAS_FLOOR = 0.01;

export class CryptoStrategyAgent extends BaseAgentHandler {
  constructor(mainAgent, agentDoc) {
    super(mainAgent, agentDoc);

    // Strategy tools
    this.strategies = new Map();

    // Price cache (free local data)
    this.priceCache = new Map();
    this.priceCacheTTL = 60000; // 1 minute

    // Trade journal for learning
    this.tradeJournal = [];

    // Reference to scheduler for dynamic interval changes
    this.scheduler = null;

    // Deep-scan lifecycle: 'idle' | 'running' | 'done'. The scan runs detached from
    // the heartbeat so it can never hold up a trading decision; deposit DETECTION
    // waits on it instead. See scanForDeposits().
    this._deepScanState = 'idle';
  }

  async initialize() {
    await super.initialize();

    // Prime the displayed P&L before anything can query the status endpoint, so a
    // restart never serves a stale zero for the day's earnings.
    //
    // One attempt is not enough: on 2026-08-20 the first attempt came back empty even
    // though MongoDB had been connected for 19s, and the figures only appeared on the
    // first strategy execution ~2min later. Whatever the ordering (revenueService's own
    // cache still cold, traders not yet registered), a short bounded retry closes it,
    // and the log line says plainly which attempt won — or that none did, instead of
    // silently serving zeros again.
    this._primePnLCaches();

    // Register strategy tools
    this.registerStrategies();

    // Get scheduler reference
    this.scheduler = this.mainAgent?.scheduler;

    // Initialize strategy registry with saved state
    try {
      const state = this.getState();
      const savedRegistry = state.strategyRegistry;
      if (savedRegistry) {
        strategyRegistry.importState(savedRegistry);
      }
    } catch (error) {
      logger.warn('Failed to import strategy registry state:', error.message);
    }

    // Register token_trader tokens with price monitor for real-time DEX quotes
    // Must be AFTER importState so token_trader config is loaded
    const allTokenTraders = strategyRegistry.getAllTokenTraders();
    if (allTokenTraders.size > 0 && this.scheduler) {
      this.scheduler.cryptoWatchedTokens = [];
      for (const [address, instance] of allTokenTraders) {
        if (instance.config?.tokenAddress) {
          this.scheduler.cryptoWatchedTokens.push({
            address: instance.config.tokenAddress,
            network: instance.config.tokenNetwork,
            symbol: instance.config.tokenSymbol || 'TOKEN',
            decimals: instance.config.tokenDecimals || 18
          });
        }
      }
      if (this.scheduler.cryptoWatchedTokens.length > 0) {
        logger.info(`Price monitor: registered ${this.scheduler.cryptoWatchedTokens.map(t => t.symbol).join(', ')} for DEX price tracking`);
      }
    } else {
      // Backward compat: check base token_trader
      const tokenTrader = strategyRegistry.get('token_trader');
      if (tokenTrader?.config?.tokenAddress && this.scheduler) {
        this.scheduler.cryptoWatchedTokens = [{
          address: tokenTrader.config.tokenAddress,
          network: tokenTrader.config.tokenNetwork,
          symbol: tokenTrader.config.tokenSymbol || 'TOKEN',
          decimals: tokenTrader.config.tokenDecimals || 18
        }];
        logger.info(`Price monitor: registered ${tokenTrader.config.tokenSymbol || 'TOKEN'} for DEX price tracking`);
      }
    }

    // Initialize per-token heartbeat manager
    this.tokenHeartbeatManager = new TokenTraderHeartbeatManager(this);
    if (allTokenTraders.size > 0 && this.agentDoc.enabled) {
      this.tokenHeartbeatManager.startAll();
    }

    // Start background V4 CLAMM hook discovery for all token traders
    if (allTokenTraders.size > 0) {
      swapService.startV4DiscoveryLoop(() => {
        const pairs = [];
        const traders = strategyRegistry.getAllTokenTraders();
        const nets = NETWORK_CONFIG.mainnet || {};
        for (const [address, instance] of traders) {
          const cfg = instance.config;
          if (!cfg?.tokenAddress || !cfg?.tokenNetwork) continue;
          const netCfg = nets[cfg.tokenNetwork];
          if (!netCfg?.stablecoinAddress) continue;
          pairs.push({ tokenAddress: cfg.tokenAddress, stablecoin: netCfg.stablecoinAddress, network: cfg.tokenNetwork });
        }
        return pairs;
      });
    }

    // Schedule Agenda job if enabled
    if (this.agentDoc.enabled) {
      await this.scheduleAgendaJob();
    }

    logger.info(`CryptoStrategyAgent initialized for: ${this.agentDoc.name}`);
  }

  /**
   * Register available strategy tools
   */
  registerStrategies() {
    this.strategies.set('native_maximizer', {
      name: 'Native Token Maximizer',
      description: 'Swap to stablecoin on peaks, buy back on dips',
      execute: this.executeNativeMaximizer.bind(this)
    });

    this.strategies.set('dca', {
      name: 'Dollar Cost Averaging',
      description: 'Systematic accumulation at regular intervals',
      execute: this.executeDCA.bind(this)
    });

    this.strategies.set('mean_reversion', {
      name: 'Mean Reversion',
      description: 'Trade based on price deviation from moving average',
      execute: this.executeMeanReversion.bind(this)
    });

    this.strategies.set('momentum', {
      name: 'Momentum Following',
      description: 'Follow strong price trends',
      execute: this.executeMomentum.bind(this)
    });

    this.strategies.set('arbitrage_scan', {
      name: 'Arbitrage Scanner',
      description: 'Scan for cross-DEX price differences',
      execute: this.executeArbitrageScan.bind(this)
    });

    this.strategies.set('volatility_adjusted', {
      name: 'Volatility-Adjusted Trading',
      description: 'Dynamic thresholds based on market volatility',
      execute: this.executeVolatilityAdjusted.bind(this)
    });

    this.strategies.set('grid_trading', {
      name: 'Grid Trading',
      description: 'Place orders at regular intervals above and below a set price',
      execute: this.executeGridTrading.bind(this)
    });

    this.strategies.set('dollar_maximizer', {
      name: 'Dollar Maximizer',
      description: 'Maximize stablecoin holdings - profit measured in dollars with gas reserves',
      execute: this.executeDollarMaximizer.bind(this)
    });

    this.strategies.set('token_trader', {
      name: 'Token Trader',
      description: 'Trade any ERC20 token with regime-based strategy - auto-buys, grid trades, trailing stops',
      execute: this.executeTokenTrader.bind(this)
    });

    this.strategies.set('arbitrage', {
      name: 'Cross-DEX Arbitrage',
      description: 'Exploit price differences across V2/V3 protocols via round-trip trades',
      execute: this.executeArbitrage.bind(this)
    });

    logger.info(`Registered ${this.strategies.size} trading strategies`);
  }

  /**
   * Check and reset stale baselines that are preventing trades
   * Baselines become stale when they're old AND price has moved significantly below them
   */
  async checkAndResetStaleBaselines(marketData) {
    const config = this.getConfig();
    const state = this.getState();
    const baselines = state.priceBaselines || {};

    const staleDays = config.baselineStaleDays || 5;
    const staleThreshold = config.baselineStaleThreshold || -2; // Reset if X% below baseline
    const staleDaysMs = staleDays * 24 * 60 * 60 * 1000;
    const resets = [];

    for (const [network, baseline] of Object.entries(baselines)) {
      if (!baseline?.price || !baseline?.timestamp) continue;

      // Get current price for this network
      const currentPriceData = marketData.prices[network];
      if (!currentPriceData?.price) continue;

      const currentPrice = currentPriceData.price;
      const baselineAge = Date.now() - new Date(baseline.timestamp).getTime();

      // Check if baseline is stale enough
      if (baselineAge < staleDaysMs) continue;

      // Calculate price change from baseline
      const priceChange = ((currentPrice - baseline.price) / baseline.price) * 100;

      // Check if price is below threshold (negative value comparison)
      if (priceChange > staleThreshold) continue;

      // Check position - don't reset if we've traded recently
      const position = state.positions?.[network];
      if (position?.inStablecoin) continue; // Don't reset during active trade

      // All conditions met - reset baseline
      const daysStale = Math.floor(baselineAge / (24 * 60 * 60 * 1000));

      await this.updateState({
        priceBaselines: {
          ...(state.priceBaselines || {}),
          [network]: {
            price: currentPrice,
            timestamp: new Date(),
            previousBaseline: baseline.price,
            resetReason: 'stale_baseline',
            resetAt: new Date()
          }
        }
      });

      resets.push({
        network,
        oldBaseline: baseline.price,
        newBaseline: currentPrice,
        priceChange: priceChange.toFixed(2) + '%',
        daysStale
      });

      logger.info(`📊 BASELINE RESET [${network}]: Stale baseline (${daysStale} days old) reset from $${baseline.price.toFixed(2)} to $${currentPrice.toFixed(2)} (was ${priceChange.toFixed(2)}% below)`);
    }

    if (resets.length > 0) {
      await this.log('baselines_reset', { resets });
    }

    return resets;
  }

  /**
   * Main execution - event-driven, cost-aware
   */
  async execute(options = {}) {
    this.running = true;
    this.shouldStop = false;
    // Read by SubAgentOrchestrator when logging a session-timeout / failure
    // so the error line surfaces which step was running, instead of just
    // "Crypto Strategy Agent execution failed" with no clue what hung.
    this._currentStage = 'starting';
    // Session start time for time-budget checks in long-running stages
    // (residual-sweep, deposit-scan). Orchestrator hard-cap is 20min;
    // stages bail at ~90s remaining via _remainingSessionMs().
    this._sessionStartedAt = Date.now();

    const config = this.getConfig();
    const state = this.getState();

    try {
      const triggerSource = options.triggeredBy || 'manual';
      const eventName = options.eventName || null;
      await this.log('session_started', { config, trigger: triggerSource, eventName });
      if (triggerSource === 'event') {
        logger.info(`Strategy execution triggered by event: ${eventName}`);
      }

      // Step 1: Gather market data (use pre-fetched Chainlink prices from event if available)
      this._currentStage = 'market-data';
      const prefetchedPrices = options.eventData?.prices || null;
      const marketData = await this.gatherMarketData(prefetchedPrices);

      // Refresh the displayed P&L cache on EVERY execution, not only on heartbeats.
      // Heartbeat-only left the figures unset between a restart and the first heartbeat,
      // which is exactly when the status endpoint was serving stale values.
      await this.refreshPnLCaches();

      // Step 1.5a: Scan for new deposits on heartbeat (agent-owned, no Agenda job)
      if (eventName === 'crypto:heartbeat' || triggerSource === 'manual') {
        // Sync scammer registry cache (only fetches if >4h stale)
        try {
          const scammerRegistry = (await import('../crypto/scammerRegistryService.js')).default;
          if (!scammerRegistry.isAvailable()) await scammerRegistry.initialize();
          await scammerRegistry.syncScammerCache();
        } catch (scammerErr) {
          logger.debug('Scammer registry sync (non-fatal):', scammerErr.message);
        }

        try {
          this._currentStage = 'deposit-scan';
          await this.scanForDeposits();
        } catch (depositErr) {
          logger.warn('Deposit scan error (non-fatal):', depositErr.message);
        }
        // Sweep residual tokens (BUSD, reflection tokens, etc.) that aren't caught by delta-based deposit scan
        try {
          // Known overrun candidate — when a batch of unsellable airdrops
          // queues sequential RPC scans this can blow the 20-min budget.
          this._currentStage = 'residual-sweep';
          await this.sweepResidualTokens();
        } catch (sweepErr) {
          logger.warn('Residual sweep error (non-fatal):', sweepErr.message);
        }

        // Flush any queued scam token reports to on-chain registry (batched after scan+sweep)
        try {
          const scammerRegistry = (await import('../crypto/scammerRegistryService.js')).default;
          if (scammerRegistry._reportQueue?.size > 0) {
            const reportResult = await scammerRegistry.flushReportQueue();
            if (reportResult.reported > 0) {
              logger.info(`Scam registry: reported ${reportResult.reported} token(s) on-chain — ${reportResult.tokens?.join(', ')}`);
            }
          }
        } catch (reportErr) {
          logger.debug('Scam report flush (non-fatal):', reportErr.message);
        }

        // Auto-claim staking rewards when above threshold (saves gas by not claiming dust)
        try {
          const skynetStakingService = (await import('../crypto/skynetStakingService.js')).default;
          if (skynetStakingService.isAvailable()) {
            if (!this._lastStakingClaim) this._lastStakingClaim = 0;
            const claimCooldownMs = 6 * 60 * 60 * 1000; // Claim at most every 6 hours
            const minClaimThreshold = 1000; // Minimum 1000 SKYNET to justify gas
            const now = Date.now();
            if (now - this._lastStakingClaim > claimCooldownMs) {
              const info = await skynetStakingService.getStakeInfo();
              if (info.pendingRewards >= minClaimThreshold) {
                const claimResult = await skynetStakingService.claimRewards();
                this._lastStakingClaim = now;
                logger.info(`Staking auto-claim: ${info.pendingRewards.toFixed(2)} SKYNET — tx=${claimResult.txHash}`);
                // Log to historical transactions for staking history
                try {
                  const mongoose = (await import('mongoose')).default;
                  const HistoricalTransaction = mongoose.model('HistoricalTransaction');
                  await new HistoricalTransaction({
                    transactionType: 'stakingClaim',
                    category: 'staking',
                    amount: info.pendingRewards,
                    txHash: claimResult.txHash,
                    network: 'bsc',
                    description: `Auto-claimed ${info.pendingRewards.toFixed(2)} SKYNET staking rewards`
                  }).save();
                } catch { /* non-critical */ }
              } else {
                logger.debug(`Staking rewards below threshold: ${info.pendingRewards.toFixed(2)} SKYNET (min: ${minClaimThreshold})`);
              }
              this._lastStakingClaim = now; // Update even if below threshold to avoid re-checking every heartbeat
            }
          }
        } catch (stakingErr) {
          logger.debug('Staking auto-claim (non-fatal):', stakingErr.message);
        }

        // Auto-claim LP staking rewards when above threshold
        try {
          const skynetStakingService = (await import('../crypto/skynetStakingService.js')).default;
          if (skynetStakingService.isAvailable()) {
            if (!this._lastLPStakingClaim) this._lastLPStakingClaim = 0;
            const claimCooldownMs = 6 * 60 * 60 * 1000;
            const minClaimThreshold = 1000;
            const now = Date.now();
            if (now - this._lastLPStakingClaim > claimCooldownMs) {
              const lpInfo = await skynetStakingService.getLPStakeInfo();
              if (lpInfo && lpInfo.stakedAmount > 0 && lpInfo.pendingRewards >= minClaimThreshold) {
                const claimResult = await skynetStakingService.claimLPRewards();
                this._lastLPStakingClaim = now;
                logger.info(`LP staking auto-claim: ${lpInfo.pendingRewards.toFixed(2)} SKYNET — tx=${claimResult.txHash}`);
                try {
                  const mongoose = (await import('mongoose')).default;
                  const HistoricalTransaction = mongoose.model('HistoricalTransaction');
                  await new HistoricalTransaction({
                    transactionType: 'lpStakingClaim',
                    category: 'staking',
                    amount: lpInfo.pendingRewards,
                    txHash: claimResult.txHash,
                    network: 'bsc',
                    description: `Auto-claimed ${lpInfo.pendingRewards.toFixed(2)} SKYNET LP staking rewards`
                  }).save();
                } catch { /* non-critical */ }
              }
              this._lastLPStakingClaim = now;
            }
          }
        } catch (lpStakingErr) {
          logger.debug('LP staking auto-claim (non-fatal):', lpStakingErr.message);
        }

        // Auto-stake wallet SKYNET surplus into the Diamond StakingFacet.
        // Captures a share of the on-chain 40% fee-routing pool instead of
        // letting claimed rewards / residual sweeps sit idle in the wallet.
        try {
          const autoStaker = (await import('../crypto/skynetAutoStaker.js')).default;
          const result = await autoStaker.runOnce();
          if (result.staked) {
            logger.info(`Auto-stake: rolled ${result.amount.toLocaleString()} SKYNET surplus into stake (tier ${result.tierId}) — tx=${result.txHash}`);
          }
        } catch (autoStakeErr) {
          logger.debug('Auto-stake (non-fatal):', autoStakeErr.message);
        }
      }

      // Step 1.5: Check for stale baselines and reset if needed
      this._currentStage = 'baseline-check';
      const baselineResets = await this.checkAndResetStaleBaselines(marketData);
      if (baselineResets.length > 0) {
        logger.info(`Reset ${baselineResets.length} stale baseline(s)`);
      }
      await this.log('market_data_gathered', {
        prices: Object.fromEntries(
          Object.entries(marketData.prices).map(([k, v]) => [k, v.price])
        )
      });

      // Step 2: Calculate technical indicators (FREE - local computation)
      this._currentStage = 'indicators';
      const indicators = await this.calculateIndicators(marketData);
      await this.log('indicators_calculated', indicators);

      // Step 3: Check if the active strategy has a dedicated executor (bypasses signal gate + LLM)
      // Strategies with their own analyze/decide logic don't need generic signal pre-screening
      const activeStrategy = config.activeStrategy || config.strategy || config.domainConfig?.strategy || state.activeStrategy;
      const dedicatedExecutor = activeStrategy && activeStrategy !== 'native_maximizer'
        ? this.strategies.get(activeStrategy)
        : null;

      if (dedicatedExecutor) {
        // Dedicated strategies handle their own analysis - bypass signal gate and LLM
        logger.info(`Executing dedicated strategy: ${activeStrategy} (bypassing signal gate)`);
        await this.log('dedicated_strategy_execute', { strategy: activeStrategy });

        const decision = {
          strategy: activeStrategy,
          confidence: 1.0,
          tradeParams: {
            direction: 'analyze', // Strategy will determine direction
            percentOfBalance: config.maxTradePercentage || 25
          }
        };

        let primaryResult;
        try {
          this._currentStage = `strategy:${activeStrategy}`;
          const result = await dedicatedExecutor.execute(decision, marketData, indicators);
          primaryResult = result;
          const action = result?.action === 'hold' ? 'hold' : 'trade';
          logger.info(`Strategy ${activeStrategy} result: action=${action}, reason=${result?.reason || 'none'}`);
          if (result?.networkAnalysis) {
            for (const [net, analysis] of Object.entries(result.networkAnalysis)) {
              logger.info(`  ${net}: price=$${analysis.currentPrice}, baseline=$${analysis.baselinePrice}, change=${analysis.priceChange?.toFixed(2)}%, opportunity=${analysis.opportunity ? analysis.opportunity.action : 'none'}, reason=${analysis.reason || analysis.opportunity?.reason || 'n/a'}`);
            }
          }
          await this.recordTrade(decision, result);
          await this.log('strategy_executed', { strategy: activeStrategy, result });
        } catch (execError) {
          logger.error(`Dedicated strategy ${activeStrategy} execution error:`, execError);
          primaryResult = { success: false, action: 'hold', reason: execError.message };
        }

        // Run secondary strategy (e.g., token_trader) alongside primary
        let secondaryResult = null;
        const secondaryStrategy = strategyRegistry.getSecondary();
        if (secondaryStrategy && secondaryStrategy.name !== activeStrategy) {
          if (secondaryStrategy.name === 'token_trader') {
            // Token traders run on independent heartbeats via TokenTraderHeartbeatManager
            const tokenTraders = strategyRegistry.getAllTokenTraders();
            if (this.tokenHeartbeatManager?.started && tokenTraders.size > 0) {
              const hbStatus = this.tokenHeartbeatManager.getStatus();
              logger.info(`Token traders running on independent heartbeats (${hbStatus.tokenCount} tokens, ${hbStatus.concurrentTicks} active ticks)`);
              secondaryResult = { action: 'independent_heartbeats', tokenCount: tokenTraders.size };
            } else if (tokenTraders.size > 0) {
              // Fallback: heartbeat manager not started, run sequentially (backward compat)
              const tokenTraderExecutor = this.strategies.get('token_trader');
              if (tokenTraderExecutor) {
                for (const [address, tokenStrat] of tokenTraders) {
                  try {
                    logger.info(`Running token trader (fallback): ${tokenStrat.config.tokenSymbol || address}`);
                    const secDecision = {
                      strategy: 'token_trader',
                      tokenAddress: address,
                      confidence: 1.0,
                      tradeParams: { direction: 'analyze', percentOfBalance: config.maxTradePercentage || 25 }
                    };
                    secondaryResult = await tokenTraderExecutor.execute(secDecision, marketData);
                    if (secondaryResult && secondaryResult.action && secondaryResult.action !== 'hold') {
                      await this.recordTrade(secDecision, secondaryResult);
                    }
                  } catch (secErr) {
                    logger.warn(`Token trader ${tokenStrat.config.tokenSymbol || address} error: ${secErr.message}`);
                  }
                }
              }
            }
          } else {
            // Non-token-trader secondary strategy (original single-execution path)
            const secondaryExecutor = this.strategies.get(secondaryStrategy.name);
            if (secondaryExecutor) {
              try {
                logger.info(`Running secondary strategy: ${secondaryStrategy.name}`);
                const secDecision = {
                  strategy: secondaryStrategy.name,
                  confidence: 1.0,
                  tradeParams: { direction: 'analyze', percentOfBalance: config.maxTradePercentage || 25 }
                };
                secondaryResult = await secondaryExecutor.execute(secDecision, marketData);
                logger.info(`Secondary strategy ${secondaryStrategy.name} result: action=${secondaryResult?.action || 'hold'}`);
                if (secondaryResult && secondaryResult.action && secondaryResult.action !== 'hold') {
                  await this.recordTrade(secDecision, secondaryResult);
                }
              } catch (secErr) {
                logger.warn(`Secondary strategy ${secondaryStrategy.name} error: ${secErr.message}`);
              }
            }
          }
        }

        // Run arbitrage scanner (always, independent of primary/secondary)
        // Use fast mode during high volatility events for quicker scanning
        const isHighVolatility = eventName === 'crypto:high_volatility' || eventName === 'crypto:significant_move';
        let arbResult = null;
        try {
          const arbStrategy = strategyRegistry.get('arbitrage');
          if (arbStrategy?.enabled) {
            const arbExecutor = this.strategies.get('arbitrage');
            if (arbExecutor) {
              arbResult = this._runArbScanDetached(arbExecutor, { strategy: 'arbitrage', fastMode: isHighVolatility }, marketData);
            }
          }
        } catch (arbErr) {
          logger.warn(`Arbitrage scan error: ${arbErr.message}`);
        }

        // Run LP market maker check (independent of primary/secondary/arb)
        let mmResult = null;
        try {
          const { default: lpMarketMaker } = await import('../crypto/lpMarketMaker.js');
          const mmConfig = await lpMarketMaker.getConfig();
          if (mmConfig?.enabled) {
            mmResult = await Promise.race([
              lpMarketMaker.check(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('LP MM timed out')), 30000))
            ]);
            if (mmResult?.action && mmResult.action !== 'in_range' && mmResult.action !== 'idle') {
              logger.info(`LP MM: ${mmResult.action} — ${mmResult.reason || ''}`);
            }
          }
        } catch (mmErr) {
          logger.warn(`LP market maker error: ${mmErr.message}`);
        }

        const primaryAction = primaryResult?.action === 'hold' ? 'hold' : 'trade';
        return {
          success: primaryResult?.success ?? false,
          action: primaryAction,
          strategy: activeStrategy,
          result: primaryResult,
          secondaryResult,
          arbResult,
          mmResult,
          llmCalled: false,
          trigger: triggerSource,
          eventName
        };
      }

      // Step 3b: Generic signal analysis (for native_maximizer / LLM path)
      this._currentStage = 'signal-analysis';
      const signals = this.analyzeSignals(marketData, indicators, state);
      await this.log('signals_analyzed', { signalCount: signals.length });

      // If no actionable signals, skip LLM call entirely
      if (signals.length === 0) {
        await this.log('no_actionable_signals', { message: 'Skipping LLM call - no signals detected' });
        return {
          success: true,
          action: 'hold',
          reason: 'No actionable signals detected',
          llmCalled: false
        };
      }

      // Step 4: Only NOW call LLM to decide strategy (COSTS MONEY)
      this._currentStage = 'llm-decide';
      const decision = await this.decideStrategy(marketData, indicators, signals, state);
      await this.log('strategy_decided', { decision: decision.strategy, confidence: decision.confidence });

      // Step 5: Execute if confidence is high enough
      if (decision.confidence >= (config.minConfidence || 0.7)) {
        let strategy = this.strategies.get(decision.strategy);

        // Fallback: check strategy registry if not found in built-in map
        if (!strategy) {
          const registryStrategy = strategyRegistry.get(decision.strategy);
          if (registryStrategy) {
            logger.info(`Strategy '${decision.strategy}' found in registry, delegating to native_maximizer for execution`);
            strategy = this.strategies.get('native_maximizer');
          }
        }

        if (strategy) {
          this._currentStage = `strategy:${decision.strategy}`;
          const result = await strategy.execute(decision, marketData);

          // Record for learning
          await this.recordTrade(decision, result);

          await this.log('strategy_executed', { strategy: decision.strategy, result });
          return {
            success: true,
            action: 'trade',
            strategy: decision.strategy,
            result,
            llmCalled: true
          };
        }

        logger.warn(`Strategy '${decision.strategy}' not found in execution handlers or registry`);
        return {
          success: true,
          action: 'hold',
          reason: `Strategy '${decision.strategy}' not found in execution handlers`,
          llmCalled: true
        };
      }

      return {
        success: true,
        action: 'hold',
        reason: `Confidence ${decision.confidence} below threshold ${config.minConfidence || 0.7}`,
        llmCalled: true
      };

    } catch (error) {
      logger.error(`CryptoStrategyAgent execution error (stage=${this._currentStage}):`, error);
      await this.log('execution_error', { error: error.message, stage: this._currentStage });
      throw error;
    } finally {
      this.running = false;
      this.lastSuccessfulExecution = Date.now();
      this._currentStage = 'idle';

      // Persist strategy registry state after each run
      await this.persistRegistryState();
    }
  }

  /**
   * Get cached or fresh market data (shared across independent token heartbeats)
   * TTL: 60 seconds — avoids redundant Chainlink/CoinGecko calls when multiple tokens tick close together
   */
  async getOrFetchMarketData() {
    const now = Date.now();
    if (this._marketDataCache && (now - this._marketDataCacheTime) < 60_000) {
      return this._marketDataCache;
    }
    const marketData = await this.gatherMarketData();
    this._marketDataCache = marketData;
    this._marketDataCacheTime = now;
    return marketData;
  }

  /**
   * Persist strategy registry state to MongoDB (reusable by main heartbeat and token heartbeats)
   */
  async persistRegistryState() {
    try {
      const registryState = strategyRegistry.exportState();
      if (registryState && Object.keys(registryState).length > 0) {
        await this.updateState({ strategyRegistry: registryState });
        logger.debug('Strategy registry state persisted');
      }
    } catch (err) {
      logger.warn('Failed to persist strategy registry state:', err.message);
    }
  }

  /**
   * Fetch prices from CoinGecko (free API, rate limited)
   */
  async fetchCoinGeckoPrices(symbols) {
    try {
      const ids = symbols.map(s => COINGECKO_IDS[s]).filter(Boolean).join(',');
      if (!ids) return {};

      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
      );

      if (!response.ok) {
        logger.warn(`CoinGecko API error: ${response.status}`);
        return {};
      }

      const data = await response.json();
      const prices = {};

      for (const symbol of symbols) {
        const geckoId = COINGECKO_IDS[symbol];
        if (geckoId && data[geckoId]) {
          prices[symbol] = {
            price: data[geckoId].usd,
            change24h: data[geckoId].usd_24h_change || 0,
            source: 'coingecko'
          };
        }
      }

      return prices;
    } catch (error) {
      logger.warn('CoinGecko fetch failed:', error.message);
      return {};
    }
  }

  /**
   * Gather market data - Chainlink primary, CoinGecko fallback
   * Accepts optional pre-fetched prices from event data to avoid redundant reads
   */
  async gatherMarketData(prefetchedPrices = null) {
    const data = {
      prices: {},
      balances: {},
      timestamp: new Date()
    };

    const config = this.getConfig();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    // Map mainnet event keys to agent's active network mode
    const mainnetToNetwork = {
      'ethereum': networkMode === 'testnet' ? 'sepolia' : 'ethereum',
      'bsc': networkMode === 'testnet' ? 'bsc-testnet' : 'bsc'
    };

    // Pre-populate from event data if available (avoids redundant Chainlink reads)
    if (prefetchedPrices) {
      for (const [key, priceData] of Object.entries(prefetchedPrices)) {
        const mappedNetwork = mainnetToNetwork[key] || key;
        if (networks[mappedNetwork]) {
          data.prices[mappedNetwork] = {
            price: priceData.price,
            symbol: priceData.symbol || networks[mappedNetwork].symbol,
            source: priceData.source || 'chainlink',
            updatedAt: priceData.updatedAt || new Date(),
            network: mappedNetwork
          };
          this.priceCache.set(`${mappedNetwork}_price`, {
            timestamp: Date.now(),
            data: data.prices[mappedNetwork]
          });
        }
      }
      if (Object.keys(data.prices).length > 0) {
        logger.info(`Using ${Object.keys(data.prices).length} pre-fetched Chainlink price(s) from event`);
      }
    }

    // Fetch any networks NOT covered by pre-fetched data
    const missingNetworks = Object.entries(networks).filter(([n]) => !data.prices[n]);

    if (missingNetworks.length > 0) {
      const symbols = missingNetworks.map(([, cfg]) => cfg.symbol);
      const coinGeckoPrices = await this.fetchCoinGeckoPrices(symbols);
      const ethers = await import('ethers');

      for (const [network, networkConfig] of missingNetworks) {
        try {
          const cacheKey = `${network}_price`;
          const cached = this.priceCache.get(cacheKey);
          if (cached && Date.now() - cached.timestamp < this.priceCacheTTL) {
            data.prices[network] = cached.data;
            continue;
          }

          // Try Chainlink first (primary source)
          let priceSet = false;
          if (networkConfig.priceFeed) {
            try {
              const provider = await contractServiceWrapper.getProvider(network);
              const contract = new ethers.Contract(networkConfig.priceFeed, PRICE_FEED_ABI, provider);
              const [, answer, , updatedAt] = await contract.latestRoundData();
              const decimals = await contract.decimals();
              const price = Number(answer) / Math.pow(10, Number(decimals));

              data.prices[network] = {
                price,
                symbol: networkConfig.symbol,
                source: 'chainlink',
                updatedAt: new Date(Number(updatedAt) * 1000)
              };
              priceSet = true;
            } catch (chainlinkErr) {
              logger.warn(`Chainlink read failed for ${network}: ${chainlinkErr.message}`);
            }
          }

          // Fallback to CoinGecko
          if (!priceSet && coinGeckoPrices[networkConfig.symbol]) {
            const geckoData = coinGeckoPrices[networkConfig.symbol];
            data.prices[network] = {
              price: geckoData.price,
              symbol: networkConfig.symbol,
              change24h: geckoData.change24h,
              source: 'coingecko',
              updatedAt: new Date()
            };
          }

          if (data.prices[network]) {
            this.priceCache.set(cacheKey, {
              timestamp: Date.now(),
              data: data.prices[network]
            });
          }
        } catch (error) {
          logger.warn(`Failed to get price for ${network}:`, error.message);
        }
      }
    }

    // Get wallet balances using walletService (handles chain-to-network mapping)
    try {
      const wallet = await walletService.getWallet();
      if (wallet) {
        const balances = await walletService.getBalances();
        logger.info(`Wallet balances fetched: chains=${JSON.stringify(Object.keys(balances))}`);

        // Map chain balances to network names
        const chainToNetwork = {
          'eth': networkMode === 'testnet' ? 'sepolia' : 'ethereum',
          'bsc': networkMode === 'testnet' ? 'bsc-testnet' : 'bsc'
        };

        for (const [chain, balance] of Object.entries(balances)) {
          const network = chainToNetwork[chain];
          if (network && networks[network]) {
            // null = the read failed (unknown), not zero. Carry NO balance entry for
            // the network this tick — every consumer treats a missing entry as
            // "no data" and holds, whereas a fake 0 triggers real trades (gas
            // top-ups, position flips) against a wallet that isn't actually empty.
            if (balance === null || balance === undefined) {
              logger.warn(`Balance [${network}]: read failed — skipping balance data this tick`);
              continue;
            }
            const address = wallet.addresses.find(a => a.chain === chain)?.address;
            data.balances[network] = {
              native: balance,
              symbol: networks[network].symbol,
              address
            };
            logger.info(`Balance [${network}]: ${balance} ${networks[network].symbol}`);
          }
        }
      } else {
        logger.warn('No wallet found - walletService.getWallet() returned null');
      }

      // Also fetch stablecoin balances for each network
      const stableNetworks = Object.entries(networks).filter(([n, c]) => c.stablecoinAddress && data.balances[n]?.address);
      logger.info(`Fetching stablecoin balances for ${stableNetworks.length} network(s): ${stableNetworks.map(([n]) => n).join(', ')}`);
      for (const [network, netConfig] of stableNetworks) {
        try {
          const stableResult = await contractServiceWrapper.getTokenBalance(
            netConfig.stablecoinAddress,
            data.balances[network].address,
            network
          );
          data.balances[network].stablecoin = parseFloat(stableResult.formatted) || 0;
          data.balances[network].stablecoinSymbol = netConfig.stablecoin;
          logger.info(`Stablecoin [${network}]: ${stableResult.formatted} ${netConfig.stablecoin}`);
        } catch (err) {
          // A failed stablecoin read must not look like an empty wallet: position
          // reconciliation resets "in stablecoin" positions to native when it sees
          // stablecoin < 0.01. Drop the network's balance data for this tick instead.
          delete data.balances[network];
          logger.warn(`Could not fetch ${netConfig.stablecoin} balance on ${network} — skipping balance data this tick: ${err.message}`);
        }
      }
    } catch (error) {
      logger.warn('Failed to get wallet balances:', error.message);
    }

    return data;
  }

  /**
   * Calculate technical indicators (FREE - local computation)
   */
  async calculateIndicators(marketData) {
    const indicators = {};
    const state = this.getState();

    for (const [network, priceData] of Object.entries(marketData.prices)) {
      const priceHistory = state.priceHistory?.[network] || [];
      const currentPrice = priceData.price;

      // Add current price to history
      priceHistory.push({ price: currentPrice, timestamp: Date.now() });

      // Keep last 100 data points
      if (priceHistory.length > 100) {
        priceHistory.shift();
      }

      // Calculate indicators
      const prices = priceHistory.map(p => p.price);

      indicators[network] = {
        currentPrice,
        // Simple Moving Averages
        sma5: this.calculateSMA(prices, 5),
        sma20: this.calculateSMA(prices, 20),
        // Exponential Moving Average
        ema12: this.calculateEMA(prices, 12),
        // RSI (Relative Strength Index)
        rsi: this.calculateRSI(prices, 14),
        // Price change percentages
        change1h: this.calculateChange(prices, 6), // ~6 data points per hour
        change24h: this.calculateChange(prices, 24),
        // Volatility (standard deviation)
        volatility: this.calculateVolatility(prices, 20),
        // Trend strength
        trendStrength: this.calculateTrendStrength(prices)
      };

      // Save updated history
      await this.updateState({
        priceHistory: {
          ...(state.priceHistory || {}),
          [network]: priceHistory
        }
      });
    }

    return indicators;
  }

  // Helper: Simple Moving Average
  calculateSMA(prices, period) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // Helper: Exponential Moving Average
  calculateEMA(prices, period) {
    if (prices.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  // Helper: RSI
  calculateRSI(prices, period) {
    if (prices.length < period + 1) return 50; // Neutral default

    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) gains += change;
      else losses -= change;
    }

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  // Helper: Price change percentage
  calculateChange(prices, periods) {
    if (prices.length < periods + 1) return 0;
    const current = prices[prices.length - 1];
    const past = prices[prices.length - 1 - periods];
    return ((current - past) / past) * 100;
  }

  // Helper: Volatility (standard deviation)
  calculateVolatility(prices, period) {
    if (prices.length < period) return 0;
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const squaredDiffs = slice.map(p => Math.pow(p - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / period);
  }

  // Helper: Trend strength
  calculateTrendStrength(prices) {
    if (prices.length < 10) return 0;
    const recent = prices.slice(-10);
    let ups = 0, downs = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) ups++;
      else if (recent[i] < recent[i - 1]) downs++;
    }
    // -1 = strong downtrend, +1 = strong uptrend
    return (ups - downs) / (recent.length - 1);
  }

  /**
   * Analyze signals locally (NO LLM CALL)
   * Returns array of actionable signals
   */
  analyzeSignals(marketData, indicators, state) {
    const signals = [];
    const config = this.getConfig();

    for (const [network, ind] of Object.entries(indicators)) {
      if (!ind.currentPrice) continue;

      // Signal: RSI Oversold (potential buy)
      if (ind.rsi && ind.rsi < 30) {
        signals.push({
          network,
          type: 'rsi_oversold',
          strength: (30 - ind.rsi) / 30,
          description: `RSI at ${ind.rsi.toFixed(1)} - oversold condition`
        });
      }

      // Signal: RSI Overbought (potential sell)
      if (ind.rsi && ind.rsi > 70) {
        signals.push({
          network,
          type: 'rsi_overbought',
          strength: (ind.rsi - 70) / 30,
          description: `RSI at ${ind.rsi.toFixed(1)} - overbought condition`
        });
      }

      // Signal: Price above SMA (bullish)
      if (ind.sma20 && ind.currentPrice > ind.sma20 * 1.05) {
        signals.push({
          network,
          type: 'above_sma',
          strength: (ind.currentPrice - ind.sma20) / ind.sma20,
          description: `Price ${((ind.currentPrice / ind.sma20 - 1) * 100).toFixed(1)}% above 20-period SMA`
        });
      }

      // Signal: Price below SMA (bearish)
      if (ind.sma20 && ind.currentPrice < ind.sma20 * 0.95) {
        signals.push({
          network,
          type: 'below_sma',
          strength: (ind.sma20 - ind.currentPrice) / ind.sma20,
          description: `Price ${((1 - ind.currentPrice / ind.sma20) * 100).toFixed(1)}% below 20-period SMA`
        });
      }

      // Signal: Strong momentum
      if (ind.trendStrength > 0.6) {
        signals.push({
          network,
          type: 'strong_uptrend',
          strength: ind.trendStrength,
          description: `Strong upward momentum (${(ind.trendStrength * 100).toFixed(0)}%)`
        });
      } else if (ind.trendStrength < -0.6) {
        signals.push({
          network,
          type: 'strong_downtrend',
          strength: Math.abs(ind.trendStrength),
          description: `Strong downward momentum (${(Math.abs(ind.trendStrength) * 100).toFixed(0)}%)`
        });
      }

      // Signal: High volatility (opportunity or risk)
      const avgPrice = ind.sma20 || ind.currentPrice;
      const volPercent = (ind.volatility / avgPrice) * 100;
      if (volPercent > 5) {
        signals.push({
          network,
          type: 'high_volatility',
          strength: Math.min(volPercent / 10, 1),
          description: `High volatility: ${volPercent.toFixed(1)}%`
        });
      }

      // Signal: Price threshold from baseline
      // Use volatility-adjusted thresholds when that strategy is active
      const baseline = state.priceBaselines?.[network];
      if (baseline) {
        const changeFromBaseline = ((ind.currentPrice - baseline.price) / baseline.price) * 100;
        let sellThreshold = config.priceThresholds?.sellThreshold || 5;
        let buyThreshold = config.priceThresholds?.buyThreshold || -3;

        // If volatility_adjusted is active, use its tighter thresholds
        const activeStrategy = config.activeStrategy || config.strategy || config.domainConfig?.strategy;
        if (activeStrategy === 'volatility_adjusted') {
          const volStrategy = strategyRegistry.get('volatility_adjusted');
          if (volStrategy) {
            const priceData = marketData.prices[network];
            const symbol = priceData?.symbol || 'ETH';
            const baseThresholds = volStrategy.getBaseThresholds(symbol);
            // Calculate regime-aware thresholds using available volatility data
            const volPercent = (ind.volatility / (ind.sma20 || ind.currentPrice)) * 100;
            const annualizedVol = volPercent * Math.sqrt(365);
            let multiplier = 1;
            if (annualizedVol < (volStrategy.config?.lowVolThreshold || 30)) {
              multiplier = volStrategy.config?.lowVolMultiplier || 0.6;
            } else if (annualizedVol > (volStrategy.config?.highVolThreshold || 80)) {
              multiplier = volStrategy.config?.highVolMultiplier || 1.8;
            }
            sellThreshold = baseThresholds.sell * multiplier;
            buyThreshold = baseThresholds.buy * multiplier;
          }
        }

        if (changeFromBaseline >= sellThreshold) {
          signals.push({
            network,
            type: 'sell_threshold',
            strength: Math.min(changeFromBaseline / 10, 1),
            description: `Price up ${changeFromBaseline.toFixed(1)}% from baseline (threshold: ${sellThreshold.toFixed(1)}%) - sell opportunity`
          });
        } else if (changeFromBaseline <= buyThreshold) {
          signals.push({
            network,
            type: 'buy_threshold',
            strength: Math.min(Math.abs(changeFromBaseline) / 10, 1),
            description: `Price down ${Math.abs(changeFromBaseline).toFixed(1)}% from baseline (threshold: ${Math.abs(buyThreshold).toFixed(1)}%) - buy opportunity`
          });
        }
      }
    }

    return signals;
  }

  /**
   * Decide which strategy to use (LLM CALL - costs money)
   * Only called when there are actionable signals
   */
  async decideStrategy(marketData, indicators, signals, state) {
    const config = this.getConfig();
    const enabledStrategies = config.enabledStrategies || ['native_maximizer'];

    const prompt = `You are a crypto trading AI agent. Analyze the market data and signals to decide on a trading strategy.

AVAILABLE STRATEGIES:
${enabledStrategies.map(s => {
  const strategy = this.strategies.get(s);
  return `- ${s}: ${strategy?.description || 'Unknown'}`;
}).join('\n')}

CURRENT SIGNALS:
${signals.map(s => `- [${s.network}] ${s.type}: ${s.description} (strength: ${(s.strength * 100).toFixed(0)}%)`).join('\n')}

MARKET DATA:
${Object.entries(indicators).map(([network, ind]) => `
${network}:
  Price: $${ind.currentPrice?.toFixed(2)}
  RSI: ${ind.rsi?.toFixed(1)}
  SMA20: $${ind.sma20?.toFixed(2)}
  Trend: ${ind.trendStrength > 0 ? 'Up' : 'Down'} (${(Math.abs(ind.trendStrength) * 100).toFixed(0)}%)
  Volatility: ${((ind.volatility / ind.currentPrice) * 100).toFixed(1)}%
`).join('')}

PORTFOLIO:
${Object.entries(marketData.balances).map(([network, b]) => `${network}: ${b.native} ${b.symbol}`).join('\n')}

PAST LEARNINGS:
${(this.agentDoc.state.learnings || []).slice(-5).map(l => `- ${l.insight}`).join('\n') || 'None yet'}

Based on the signals and data, which strategy should be executed?

Respond in JSON format:
{
  "strategy": "strategy_name",
  "network": "primary_network_to_trade",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation",
  "tradeParams": {
    "direction": "buy" | "sell",
    "percentOfBalance": 10-50
  }
}`;

    const response = await this.generateResponse(prompt, {
      maxTokens: 500,
      temperature: 0.3
    });

    const content = response.content || response;

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      logger.warn('Failed to parse strategy decision:', error.message);
    }

    return {
      strategy: 'native_maximizer',
      confidence: 0.5,
      reasoning: 'Fallback to default strategy'
    };
  }

  /**
   * Execute Native Maximizer strategy
   */
  async executeNativeMaximizer(decision, marketData) {
    const network = decision.network;
    const config = this.getConfig();
    const state = this.getState();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networkConfig = NETWORK_CONFIG[networkMode]?.[network];

    if (!networkConfig) {
      return { success: false, error: `Unknown network: ${network}` };
    }

    const balance = marketData.balances[network];
    if (!balance) {
      return { success: false, error: `No balance data for ${network}` };
    }

    const position = state.positions?.[network] || { inStablecoin: false };
    const direction = decision.tradeParams?.direction;
    const percentOfBalance = decision.tradeParams?.percentOfBalance || 20;

    // Check if we should actually trade
    if (direction === 'sell' && !position.inStablecoin && networkConfig.stablecoinAddress) {
      // Sell native to stablecoin
      const nativeBalance = parseFloat(balance.native) || 0;
      const tradeAmount = (nativeBalance * percentOfBalance / 100).toFixed(6);

      if (parseFloat(tradeAmount) < 0.001) {
        return { success: false, error: 'Trade amount too small' };
      }

      // Minimum $1 USD trade value.
      //
      // `usdValue > 0 && usdValue < 1` was meant as "skip if we can value this and it is
      // tiny". But a missing price read makes usdValue exactly 0, so the first clause is
      // false and the guard is SKIPPED — a feed miss silently disabled the very check
      // meant to catch a worthless trade, and the swap then went out with
      // expectedOutputUsd: 0. "Unknown" was being treated as "fine".
      //
      // Unknown now blocks the trade, with one exception kept deliberately: an urgent
      // sell (stop-loss) still goes through. Refusing to cut a loss because the price
      // feed blinked is strictly worse than selling late — the same reasoning the
      // strategy's own stale-oracle guard already uses.
      const currentPrice = marketData.prices?.[network]?.price || 0;
      const priceKnown = Number.isFinite(currentPrice) && currentPrice > 0;
      const usdValue = parseFloat(tradeAmount) * currentPrice;
      if (!priceKnown) {
        if (decision.urgent === true) {
          logger.warn(`NativeMaximizer: no usable ${network} price, but proceeding — urgent sell must not be blocked by a feed miss`);
        } else {
          logger.info(`NativeMaximizer: Sell skipped - no usable ${network} price, cannot confirm the trade clears the $1 minimum`);
          return { success: false, error: `No usable ${network} price to value the trade` };
        }
      } else if (usdValue < 1) {
        logger.info(`NativeMaximizer: Sell skipped - trade value $${usdValue.toFixed(2)} below $1 minimum`);
        return { success: false, error: `Trade value $${usdValue.toFixed(2)} below $1 minimum` };
      }

      // Check if requires approval
      if (config.requiresApproval?.forTrades) {
        await this.requestApproval(
          'execute_trade',
          `Sell ${tradeAmount} ${networkConfig.symbol} for ${networkConfig.stablecoin}`,
          { network, direction: 'sell', amount: tradeAmount }
        );
        return { success: true, waitingApproval: true };
      }

      // Execute swap: swap(tokenIn, tokenOut, amountIn, slippageTolerance, network, options)
      const expectedOutputUsd = usdValue || (parseFloat(tradeAmount) * currentPrice);
      const swapResult = await swapService.swap(
        'native',
        networkConfig.stablecoinAddress,
        tradeAmount,
        config.slippageTolerance || 2,
        network,
        { preferV3: true, gasCheck: true, expectedOutputUsd, urgent: decision.urgent || false }
      );

      if (swapResult.success) {
        // Use expectedOut from swap service (now correctly formatted with output token decimals)
        let stablecoinReceived = parseFloat(swapResult.expectedOut) || 0;
        // The swap's own yield — stablecoinReceived below may be bumped to the
        // full on-chain balance (position/buy-back budget), which is NOT what
        // this sell produced. Journal and profit stats use the yield.
        const swapYield = stablecoinReceived;
        logger.info(`Swap expectedOut: ${swapResult.expectedOut} (parsed: ${stablecoinReceived})`);

        // Try to verify with on-chain balance, but only use it if > expectedOut
        // (TX may not be confirmed yet, so balanceOf could return stale/zero value)
        try {
          const { ethers } = await import('ethers');
          const provider = await contractServiceWrapper.getProvider(network);
          const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
          const stableContract = new ethers.Contract(networkConfig.stablecoinAddress, erc20Abi, provider);
          const wallet = await walletService.getWallet();
          const walletAddress = wallet.addresses.find(a => a.chain === (network === 'ethereum' ? 'eth' : network))?.address;
          if (walletAddress) {
            const decimals = await stableContract.decimals();
            const actualBalance = await stableContract.balanceOf(walletAddress);
            const actualFormatted = parseFloat(ethers.formatUnits(actualBalance, decimals));
            logger.info(`On-chain stablecoin balance: ${actualFormatted} ${networkConfig.stablecoin}`);
            // Only use on-chain balance if it's higher (confirms TX went through)
            if (actualFormatted > stablecoinReceived) {
              stablecoinReceived = actualFormatted;
            }
          }
        } catch (balErr) {
          logger.warn(`Could not read actual stablecoin balance, using expectedOut: ${balErr.message}`);
        }

        // Update position (atomic per-network)
        await this._persistPosition(network, {
          inStablecoin: true,
          entryPrice: marketData.prices[network].price,
          stablecoinAmount: stablecoinReceived,
          timestamp: new Date()
        });

        // Set new baseline
        await this.updateState({
          priceBaselines: {
            ...(state.priceBaselines || {}),
            [network]: {
              price: marketData.prices[network].price,
              timestamp: new Date()
            }
          }
        });

        const sellResult = {
          success: true,
          action: 'sold_to_stablecoin',
          amount: tradeAmount,
          received: swapYield || stablecoinReceived,
          txHash: swapResult.hash
        };

        await this.notifySwap({
          action: 'sold_to_stablecoin',
          network,
          amountIn: tradeAmount,
          amountOut: swapYield || stablecoinReceived,
          symbolIn: networkConfig.symbol,
          symbolOut: networkConfig.stablecoin || 'USDC',
          txHash: swapResult.hash,
          strategy: decision.strategy || 'native_maximizer'
        });

        return sellResult;
      }

      return { success: false, error: swapResult.error || 'Swap failed' };

    } else if (direction === 'buy' && position.inStablecoin && position.stablecoinAmount > 0) {
      // Buy back native with stablecoin.
      //
      // Honour the amount the STRATEGY asked for. This used to read
      // `position.stablecoinAmount` unconditionally, ignoring decision.amount entirely —
      // harmless while every buy-back was all-in by design, and wrong the moment one was
      // not. The stranded-capital re-entry deploys a fraction on purpose, so that a single
      // entry price cannot commit the whole leg; on 2026-08-21 20:44 the strategy correctly
      // asked for $341.68 and this line spent $1,004.93 anyway.
      //
      // Bounded by the position either way: a decision can ask for LESS than the leg holds,
      // never more. Absent or unusable, the old behaviour stands.
      const requested = parseFloat(decision?.amount);
      let stableAmount = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, position.stablecoinAmount)
        : position.stablecoinAmount;
      if (stableAmount < position.stablecoinAmount) {
        logger.info(`DollarMaximizer [${network}]: partial buy — deploying $${stableAmount.toFixed(2)} of the leg's $${position.stablecoinAmount.toFixed(2)} as the strategy requested`);
      }
      // Verify actual wallet balance before using the amount above
      try {
        const { ethers } = await import('ethers');
        const provider = await contractServiceWrapper.getProvider(network);
        const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
        const stableContract = new ethers.Contract(networkConfig.stablecoinAddress, erc20Abi, provider);
        const wallet = await walletService.getWallet();
        const walletAddress = wallet.addresses.find(a => a.chain === (network === 'ethereum' ? 'eth' : network))?.address;
        if (walletAddress) {
          const decimals = await stableContract.decimals();
          const actualBalance = await stableContract.balanceOf(walletAddress);
          const actualAmount = parseFloat(ethers.formatUnits(actualBalance, decimals));
          // Judged against the POSITION, not the (possibly partial) trade size: a small
          // tranche must not make a genuinely drained wallet look adequately funded.
          if (actualAmount < position.stablecoinAmount * 0.01) {
            // Actual balance is less than 1% of expected - position state is stale
            logger.warn(`Buy aborted: recorded ${stableAmount} ${networkConfig.stablecoin} but wallet only has ${actualAmount}. Resetting position.`);
            await this._persistPosition(network, { inStablecoin: false, entryPrice: null, stablecoinAmount: 0 });
            return { success: false, error: `Stablecoin balance mismatch: expected ${stableAmount}, actual ${actualAmount}` };
          }
          if (actualAmount < stableAmount) {
            logger.warn(`Adjusting buy amount from ${stableAmount} to actual balance ${actualAmount}`);
            stableAmount = actualAmount;
          }
          // Second line of defence on the shared pot. The position should already carry
          // DM's own share, but this path reads a LIVE on-chain balance that includes the
          // token trader's reserve, so re-apply the split here rather than trusting that
          // reconciliation ran this tick. A buy-back spends the whole figure.
          const dmCeiling = this.getDmAvailableStable(network, actualAmount);
          if (dmCeiling < stableAmount) {
            logger.info(`DollarMaximizer [${network}]: capping buy at $${dmCeiling.toFixed(2)} of $${actualAmount.toFixed(2)} on-chain — the remainder is the token trader's allotment`);
            stableAmount = dmCeiling;
          }
          if (!(stableAmount > 0)) {
            return { success: false, error: 'No stablecoin available to DollarMaximizer after the token-trader allotment' };
          }
        }
      } catch (balErr) {
        logger.warn(`Could not verify stablecoin balance, using recorded amount: ${balErr.message}`);
      }
      // Minimum $1 USD trade value (stableAmount is already in USD)
      if (stableAmount > 0 && stableAmount < 1) {
        logger.info(`NativeMaximizer: Buy skipped - trade value $${stableAmount.toFixed(2)} below $1 minimum`);
        return { success: false, error: `Trade value $${stableAmount.toFixed(2)} below $1 minimum` };
      }

      // INVARIANT — never spend more than the strategy decided.
      //
      // On 2026-08-21 a decision asking for $341.68 executed as $1,004.93 (the whole leg),
      // and NOTHING anywhere compared the two: no log line, no alert, no notification. The
      // swap confirmed on-chain and the first anyone knew was a -$290.61 line on the next
      // day's ledger. The specific sizing bug is fixed, but the failure CLASS is "executed
      // size silently diverged from decided size", and that had no detection at all.
      //
      // Checked here because this is the last point before money moves. Capping rather than
      // only warning: the strategy's own decision is the authority, so clamping to it can
      // never suppress intended activity — it can only stop an overspend the strategy did
      // not ask for. Tolerance is 1% or $1, whichever is larger, so ordinary float and
      // balance-adjustment noise does not cry wolf.
      if (Number.isFinite(requested) && requested > 0) {
        const aboutToSpend = parseFloat(stableAmount) || 0;
        const overBy = aboutToSpend - requested;
        if (overBy > Math.max(requested * 0.01, 1)) {
          logger.error(
            `TRADE SIZE DIVERGENCE [${network}]: strategy decided $${requested.toFixed(2)} but execution was about to spend ` +
            `$${aboutToSpend.toFixed(2)} (+$${overBy.toFixed(2)}, ${((aboutToSpend / requested - 1) * 100).toFixed(1)}%). ` +
            `Capping to the decided size. This is the 2026-08-21 full-leg failure class.`
          );
          try {
            await this.notifySwap({
              action: 'trade_size_divergence_blocked',
              network,
              amountIn: aboutToSpend,
              amountOut: requested,
              symbolIn: networkConfig.stablecoin,
              symbolOut: networkConfig.symbol,
              strategy: 'dollar_maximizer'
            });
          } catch (notifyErr) {
            logger.warn(`Size-divergence alert could not be sent: ${notifyErr.message}`);
          }
          stableAmount = requested;
        }
      }

      stableAmount = stableAmount.toString();

      if (config.requiresApproval?.forTrades) {
        await this.requestApproval(
          'execute_trade',
          `Buy ${networkConfig.symbol} with ${stableAmount} ${networkConfig.stablecoin}`,
          { network, direction: 'buy', amount: stableAmount }
        );
        return { success: true, waitingApproval: true };
      }

      // Execute swap: swap(tokenIn, tokenOut, amountIn, slippageTolerance, network, options)
      const buyExpectedUsd = parseFloat(stableAmount) || 0;
      const nativePrice = marketData.prices?.[network]?.price || 0;
      const swapResult = await swapService.swap(
        networkConfig.stablecoinAddress,
        'native',
        stableAmount,
        config.slippageTolerance || 2,
        network,
        { preferV3: true, gasCheck: true, expectedOutputUsd: buyExpectedUsd, outputTokenPriceUsd: nativePrice }
      );

      if (swapResult.success) {
        // Calculate gain (handle null entryPrice from initial/reset positions).
        // gainNative = extra native acquired vs. what the dollars would have bought at the sell
        // price (the buy-low edge). Value it in USD: dmPnL/totalPnL is a DOLLAR figure (this is
        // dollar_maximizer), so it must NOT carry native token units — that was mixing BNB into
        // a USD total. `lastGain` stays native for display; `gain` (→ dmPnL via recordTrade) is USD.
        const originalNative = position.entryPrice ? (position.stablecoinAmount / position.entryPrice) : 0;
        const newNative = parseFloat(swapResult.expectedOut) || 0;
        const gainNative = originalNative > 0 ? (newNative - originalNative) : 0;
        const gain = nativePrice > 0 ? gainNative * nativePrice : 0;

        // Update position (atomic per-network)
        await this._persistPosition(network, {
          inStablecoin: false,
          lastGain: gainNative,
          timestamp: new Date()
        });

        // Learn from this trade (native-unit edge for the message; symbol-labelled)
        if (gainNative > 0) {
          await this.addLearning('trade_success',
            `Profitable trade: gained ${gainNative.toFixed(6)} ${networkConfig.symbol} (~$${gain.toFixed(2)})`,
            0.8
          );
        } else {
          await this.addLearning('trade_loss',
            `Unprofitable trade: lost ${Math.abs(gainNative).toFixed(6)} ${networkConfig.symbol} (~$${Math.abs(gain).toFixed(2)})`,
            0.6
          );
        }

        const buyResult = {
          success: true,
          action: 'bought_native',
          spent: stableAmount,
          received: swapResult.expectedOut,
          gain,            // USD — flows to dmPnL via recordTrade
          gainNative,      // native units — for display
          txHash: swapResult.hash
        };

        await this.notifySwap({
          action: 'bought_native',
          network,
          amountIn: stableAmount,
          amountOut: swapResult.expectedOut,
          symbolIn: networkConfig.stablecoin || 'USDC',
          symbolOut: networkConfig.symbol,
          txHash: swapResult.hash,
          gain: gainNative,
          strategy: decision.strategy || 'native_maximizer'
        });

        return buyResult;
      }

      return { success: false, error: swapResult.error || 'Swap failed' };
    }

    return { success: true, action: 'hold', reason: 'No action needed for current position' };
  }

  /**
   * Execute Volatility-Adjusted strategy using the registry strategy's own analysis
   * instead of relying solely on the LLM's tradeParams.direction
   */
  async executeVolatilityAdjusted(decision, marketData) {
    const config = this.getConfig();
    const state = this.getState();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    const volStrategy = strategyRegistry.get('volatility_adjusted');
    if (!volStrategy) {
      logger.warn('VolatilityAdjusted strategy not found in registry, falling back to native_maximizer');
      return this.executeNativeMaximizer(decision, marketData);
    }

    // Transform market data to the format the registry strategy expects (prices keyed by pair like 'ETH/USD')
    const transformedMarketData = { prices: {}, balances: marketData.balances };
    for (const [network, priceData] of Object.entries(marketData.prices)) {
      if (priceData.symbol) {
        const pair = `${priceData.symbol}/USD`;
        transformedMarketData.prices[pair] = priceData;
      }
    }

    const stratConfig = {
      minTradeValueNative: config.minTradeValueNative || 0.001,
      maxTradePercentage: config.maxTradePercentage || 20,
      slippageTolerance: config.slippageTolerance || 2
    };

    // Seed the registry strategy's price history and baselines from the agent's existing data
    // This prevents a cold-start gap where the strategy needs 12+ data points
    for (const [network, netConfig] of Object.entries(networks)) {
      const pair = `${netConfig.symbol}/USD`;
      const key = volStrategy.getBaselineKey(network, pair, networkMode);

      // Seed price history if needed
      const existingHistory = volStrategy.state?.priceHistory?.[key];
      const agentHistory = state.priceHistory?.[network];
      if ((!existingHistory || existingHistory.length < volStrategy.config.minDataPoints) && agentHistory?.length > 0) {
        if (!volStrategy.state.priceHistory) volStrategy.state.priceHistory = {};
        const seeded = agentHistory.map(p => ({ price: p.price, timestamp: p.timestamp }));
        volStrategy.state.priceHistory[key] = seeded;
        logger.info(`Seeded vol-adjusted price history for ${network}: ${seeded.length} points`);
      }

      // Sync baselines from agent state if the strategy's baseline is missing or freshly initialized
      // A freshly initialized baseline has highWatermark == price (no real history)
      const agentBaseline = state.priceBaselines?.[network];
      const stratBaseline = volStrategy.state?.priceBaselines?.[key];
      const isFreshBaseline = stratBaseline && Math.abs((stratBaseline.highWatermark || stratBaseline.price) - stratBaseline.price) < 1;
      if (agentBaseline && (!stratBaseline || isFreshBaseline)) {
        // Also check pair-based baselines for high watermark data (e.g., ETH/USD has the real HWM)
        const pairBaseline = state.priceBaselines?.[pair] || state.priceBaselines?.[`${netConfig.symbol}/USD`];
        const highWatermark = pairBaseline?.highWatermark || agentBaseline.highWatermark || agentBaseline.price;
        const highWatermarkTime = pairBaseline?.highWatermarkTime || agentBaseline.highWatermarkTime || agentBaseline.timestamp;

        if (!volStrategy.state.priceBaselines) volStrategy.state.priceBaselines = {};
        volStrategy.state.priceBaselines[key] = {
          price: agentBaseline.price,
          timestamp: agentBaseline.timestamp,
          highWatermark,
          highWatermarkTime,
          previousBaseline: agentBaseline.previousBaseline,
          resetReason: agentBaseline.resetReason,
          resetAt: agentBaseline.resetAt
        };
        logger.info(`Synced baseline for ${network}: $${agentBaseline.price.toFixed(2)} (HWM: $${highWatermark.toFixed(2)})`);
      }

      // Also sync positions from agent state
      const agentPosition = state.positions?.[network];
      if (agentPosition) {
        volStrategy.setPosition(network, agentPosition);
      }
    }

    // Run vol-adjusted analysis on all networks, not just the LLM's target
    const analyses = [];
    const networkOrder = decision.network
      ? [decision.network, ...Object.keys(networks).filter(n => n !== decision.network)]
      : Object.keys(networks);

    for (const network of networkOrder) {
      const netConfig = networks[network];
      if (!netConfig) continue;

      try {
        const tokenConfig = { symbol: netConfig.symbol };
        const analysis = await volStrategy.analyze(
          transformedMarketData, { balances: marketData.balances }, network, networkMode, tokenConfig
        );
        analyses.push(analysis);

        if (analysis.opportunity) {
          logger.info(`Vol-adjusted found opportunity on ${network}: ${analysis.opportunity.action} - ${analysis.opportunity.reason}`);
        } else {
          logger.info(`Vol-adjusted ${network}: ${analysis.reason || 'no opportunity'}`);
        }
      } catch (err) {
        logger.warn(`Vol-adjusted analysis failed for ${network}: ${err.message}`);
      }
    }

    // Store the analysis for status display
    const networkAnalysis = {};
    for (const a of analyses) {
      networkAnalysis[a.network] = a;
    }

    await this.updateState({
      lastDecision: {
        action: 'hold',
        reason: 'volatility_adjusted: analyzing',
        decisions: [],
        networkAnalysis,
        strategy: 'volatility_adjusted',
        timestamp: new Date()
      }
    });

    // Run the strategy's decide() to get concrete trade decisions
    const decisions = await volStrategy.decide(analyses, { balances: marketData.balances }, stratConfig);

    if (decisions.length > 0) {
      const tradeDecision = decisions[0];
      const direction = tradeDecision.action === 'buy_native' ? 'buy' : 'sell';

      logger.info(`Vol-adjusted executing: ${direction} on ${tradeDecision.network} - ${tradeDecision.reason}`);

      // Update lastDecision with actual trade info
      await this.updateState({
        lastDecision: {
          action: direction,
          reason: tradeDecision.reason,
          decisions,
          networkAnalysis,
          strategy: 'volatility_adjusted',
          timestamp: new Date()
        }
      });

      // Map to executeNativeMaximizer format with the proper direction
      // Use 50% for stop-loss sells (more aggressive) vs normal config percentage
      const mappedDecision = {
        ...decision,
        network: tradeDecision.network,
        tradeParams: {
          direction,
          percentOfBalance: tradeDecision.isStopLoss ? 50 : stratConfig.maxTradePercentage
        }
      };

      return this.executeNativeMaximizer(mappedDecision, marketData);
    }

    // No opportunities - update state with hold reasoning
    const holdReasons = analyses
      .filter(a => a.reason)
      .map(a => `${a.network}: ${a.reason}`)
      .join('; ');

    await this.updateState({
      lastDecision: {
        action: 'hold',
        reason: `volatility_adjusted: No trading opportunities`,
        decisions: [],
        networkAnalysis,
        strategy: 'volatility_adjusted',
        timestamp: new Date()
      }
    });

    return {
      success: true,
      action: 'hold',
      reason: holdReasons || 'No vol-adjusted opportunities found',
      networkAnalysis
    };
  }

  /**
   * Execute DCA strategy - real swap execution
   * Buys a fixed USD amount of native tokens at regular intervals
   */
  async executeDCA(decision, marketData) {
    const config = this.getConfig();
    const state = this.getState();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    const dcaStrategy = strategyRegistry.get('dca');
    if (!dcaStrategy) {
      logger.warn('DCA strategy not found in registry, falling back to native_maximizer');
      return this.executeNativeMaximizer(decision, marketData);
    }

    // Transform market data to pair-keyed format
    const transformedMarketData = { prices: {}, balances: marketData.balances };
    for (const [network, priceData] of Object.entries(marketData.prices)) {
      // Use actual token symbol (ETH, BNB) not network name (ethereum, bsc)
      const sym = priceData.symbol && priceData.symbol !== network
        ? priceData.symbol
        : networks[network]?.symbol;
      if (sym) {
        transformedMarketData.prices[`${sym}/USD`] = priceData;
      }
    }

    const stratConfig = {
      minTradeValueNative: config.minTradeValueNative || 0.001,
      maxTradePercentage: config.maxTradePercentage || 20,
      slippageTolerance: config.slippageTolerance || 2
    };

    // Seed price history from agent state
    for (const [network, netConfig] of Object.entries(networks)) {
      const pair = `${netConfig.symbol}/USD`;
      const key = dcaStrategy.getBaselineKey(network, pair, networkMode);
      const agentHistory = state.priceHistory?.[network];
      const existingHistory = dcaStrategy.state?.priceHistory?.[key];
      if ((!existingHistory || existingHistory.length < 3) && agentHistory?.length > 0) {
        if (!dcaStrategy.state.priceHistory) dcaStrategy.state.priceHistory = {};
        dcaStrategy.state.priceHistory[key] = agentHistory.map(p => ({ price: p.price, timestamp: p.timestamp }));
        logger.info(`Seeded DCA price history for ${network}: ${agentHistory.length} points`);
      }

      // Sync DCA buy timing from agent state
      if (state.lastDcaPurchase?.[network] && !dcaStrategy.state.lastBuyTime?.[network]) {
        if (!dcaStrategy.state.lastBuyTime) dcaStrategy.state.lastBuyTime = {};
        dcaStrategy.state.lastBuyTime[network] = state.lastDcaPurchase[network];
      }
    }

    // Run analysis on all networks
    const analyses = [];
    const networkOrder = decision.network
      ? [decision.network, ...Object.keys(networks).filter(n => n !== decision.network)]
      : Object.keys(networks);

    for (const network of networkOrder) {
      const netConfig = networks[network];
      if (!netConfig) continue;
      try {
        const tokenConfig = { symbol: netConfig.symbol };
        const analysis = await dcaStrategy.analyze(
          transformedMarketData, { balances: marketData.balances }, network, networkMode, tokenConfig
        );
        analyses.push(analysis);
        if (analysis.opportunity) {
          logger.info(`DCA opportunity on ${network}: ${analysis.opportunity.action} - ${analysis.opportunity.reason}`);
        } else {
          logger.info(`DCA ${network}: ${analysis.reason || 'no opportunity'}`);
        }
      } catch (err) {
        logger.warn(`DCA analysis failed for ${network}: ${err.message}`);
      }
    }

    const decisions = await dcaStrategy.decide(analyses, { balances: marketData.balances }, stratConfig);

    if (decisions.length > 0) {
      const tradeDecision = decisions[0];
      const network = tradeDecision.network;
      const networkConfig = NETWORK_CONFIG[networkMode]?.[network];

      if (!networkConfig || !networkConfig.stablecoinAddress) {
        return { success: false, error: `No stablecoin configured for ${network}` };
      }

      logger.info(`DCA executing buy on ${network}: ${tradeDecision.reason}`);

      // DCA buys a fixed USD amount - use amountToken from strategy or config dcaAmount
      const amountUSD = tradeDecision.amountUSD || config.dcaAmount || 10;
      const amountStr = amountUSD.toString();

      // Execute swap: stablecoin -> native
      const swapResult = await swapService.swap(
        networkConfig.stablecoinAddress,
        'native',
        amountStr,
        config.slippageTolerance || 2,
        network
      );

      if (swapResult.success) {
        const nativeReceived = parseFloat(swapResult.expectedOut) || 0;
        const currentPrice = tradeDecision.priceAtDecision || marketData.prices[network]?.price;

        // Record in registry strategy
        if (dcaStrategy.recordDCABuy) {
          dcaStrategy.recordDCABuy(network, amountUSD, nativeReceived, currentPrice);
        }

        // Update agent state
        await this.updateState({
          lastDcaPurchase: { ...(state.lastDcaPurchase || {}), [network]: new Date() },
          dcaHistory: [
            ...(state.dcaHistory || []),
            { network, amountUSD, amountNative: nativeReceived, price: currentPrice, isDip: tradeDecision.isDip || false, txHash: swapResult.hash, timestamp: new Date() }
          ],
          lastDecision: { action: 'dca_buy', reason: tradeDecision.reason, decisions, strategy: 'dca', timestamp: new Date() }
        });

        await this.notifySwap({
          action: 'dca_buy',
          network,
          amountIn: amountUSD,
          amountOut: nativeReceived,
          symbolIn: networkConfig.stablecoin || 'USDC',
          symbolOut: networkConfig.symbol,
          txHash: swapResult.hash,
          strategy: 'dca'
        });

        return { success: true, action: 'dca_buy', amountUSD, received: nativeReceived, isDip: tradeDecision.isDip || false, txHash: swapResult.hash };
      }

      return { success: false, error: swapResult.error || 'DCA swap failed' };
    }

    await this.updateState({
      lastDecision: { action: 'hold', reason: 'DCA: No buy opportunity', decisions: [], strategy: 'dca', timestamp: new Date() }
    });

    return {
      success: true,
      action: 'hold',
      reason: analyses.map(a => a.reason).filter(Boolean).join('; ') || 'DCA interval not reached'
    };
  }

  /**
   * Execute Mean Reversion strategy - uses registry strategy analyze/decide
   * Buys below moving average, sells above moving average
   */
  async executeMeanReversion(decision, marketData) {
    const config = this.getConfig();
    const state = this.getState();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    const mrStrategy = strategyRegistry.get('mean_reversion');
    if (!mrStrategy) {
      logger.warn('MeanReversion strategy not found in registry, falling back to native_maximizer');
      return this.executeNativeMaximizer(decision, marketData);
    }

    // Transform market data to pair-keyed format
    const transformedMarketData = { prices: {}, balances: marketData.balances };
    for (const [network, priceData] of Object.entries(marketData.prices)) {
      // Use actual token symbol (ETH, BNB) not network name (ethereum, bsc)
      const sym = priceData.symbol && priceData.symbol !== network
        ? priceData.symbol
        : networks[network]?.symbol;
      if (sym) {
        transformedMarketData.prices[`${sym}/USD`] = priceData;
      }
    }

    const stratConfig = {
      minTradeValueNative: config.minTradeValueNative || 0.001,
      maxTradePercentage: config.maxTradePercentage || 20,
      slippageTolerance: config.slippageTolerance || 2
    };

    // Seed price history and sync state from agent
    for (const [network, netConfig] of Object.entries(networks)) {
      const pair = `${netConfig.symbol}/USD`;
      const key = mrStrategy.getBaselineKey(network, pair, networkMode);
      const agentHistory = state.priceHistory?.[network];
      const existingHistory = mrStrategy.state?.priceHistory?.[key];
      if ((!existingHistory || existingHistory.length < (mrStrategy.config?.minDataPoints || 12)) && agentHistory?.length > 0) {
        if (!mrStrategy.state.priceHistory) mrStrategy.state.priceHistory = {};
        mrStrategy.state.priceHistory[key] = agentHistory.map(p => ({ price: p.price, timestamp: p.timestamp }));
        logger.info(`Seeded mean-reversion price history for ${network}: ${agentHistory.length} points`);
      }
      const agentBaseline = state.priceBaselines?.[network];
      if (agentBaseline && !mrStrategy.getBaseline(network, pair, networkMode)) {
        mrStrategy.setBaseline(network, pair, networkMode, agentBaseline.price);
      }
      const agentPosition = state.positions?.[network];
      if (agentPosition) {
        mrStrategy.setPosition(network, agentPosition);
      }
    }

    // Run analysis
    const analyses = [];
    const networkOrder = decision.network
      ? [decision.network, ...Object.keys(networks).filter(n => n !== decision.network)]
      : Object.keys(networks);

    for (const network of networkOrder) {
      const netConfig = networks[network];
      if (!netConfig) continue;
      try {
        const tokenConfig = { symbol: netConfig.symbol };
        const analysis = await mrStrategy.analyze(
          transformedMarketData, { balances: marketData.balances }, network, networkMode, tokenConfig
        );
        analyses.push(analysis);
        if (analysis.opportunity) {
          logger.info(`MeanReversion opportunity on ${network}: ${analysis.opportunity.action} - ${analysis.opportunity.reason}`);
        }
      } catch (err) {
        logger.warn(`MeanReversion analysis failed for ${network}: ${err.message}`);
      }
    }

    const networkAnalysis = {};
    for (const a of analyses) { networkAnalysis[a.network] = a; }

    const decisions = await mrStrategy.decide(analyses, { balances: marketData.balances }, stratConfig);

    if (decisions.length > 0) {
      const tradeDecision = decisions[0];
      let direction, percentOfBalance = stratConfig.maxTradePercentage;

      if (tradeDecision.action === 'sell_to_stablecoin') {
        direction = 'sell';
      } else if (tradeDecision.action === 'buy_native') {
        direction = 'buy';
      } else if (tradeDecision.action === 'accumulate') {
        // Small additional buy when below MA but already holding native
        direction = 'buy';
        percentOfBalance = 5;
      } else {
        logger.warn(`MeanReversion: Unknown action ${tradeDecision.action}`);
        return { success: true, action: 'hold', reason: `Unknown MR action: ${tradeDecision.action}` };
      }

      logger.info(`MeanReversion executing: ${direction} on ${tradeDecision.network} - ${tradeDecision.reason}`);

      await this.updateState({
        lastDecision: { action: direction, reason: tradeDecision.reason, decisions, networkAnalysis, strategy: 'mean_reversion', timestamp: new Date() }
      });

      return this.executeNativeMaximizer({
        ...decision,
        network: tradeDecision.network,
        tradeParams: { direction, percentOfBalance }
      }, marketData);
    }

    await this.updateState({
      lastDecision: { action: 'hold', reason: 'mean_reversion: No opportunities', decisions: [], networkAnalysis, strategy: 'mean_reversion', timestamp: new Date() }
    });

    return {
      success: true, action: 'hold',
      reason: analyses.map(a => a.reason).filter(Boolean).join('; ') || 'No mean reversion opportunities',
      networkAnalysis
    };
  }

  /**
   * Execute Momentum strategy - uses registry strategy analyze/decide
   * Follows trends using fast/slow MA crossover with trailing stops
   */
  async executeMomentum(decision, marketData) {
    const config = this.getConfig();
    const state = this.getState();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    const momStrategy = strategyRegistry.get('momentum');
    if (!momStrategy) {
      logger.warn('Momentum strategy not found in registry, falling back to native_maximizer');
      return this.executeNativeMaximizer(decision, marketData);
    }

    const transformedMarketData = { prices: {}, balances: marketData.balances };
    for (const [network, priceData] of Object.entries(marketData.prices)) {
      // Use actual token symbol (ETH, BNB) not network name (ethereum, bsc)
      const sym = priceData.symbol && priceData.symbol !== network
        ? priceData.symbol
        : networks[network]?.symbol;
      if (sym) {
        transformedMarketData.prices[`${sym}/USD`] = priceData;
      }
    }

    const stratConfig = {
      minTradeValueNative: config.minTradeValueNative || 0.001,
      maxTradePercentage: config.maxTradePercentage || 20,
      slippageTolerance: config.slippageTolerance || 2
    };

    // Seed price history and sync positions
    for (const [network, netConfig] of Object.entries(networks)) {
      const pair = `${netConfig.symbol}/USD`;
      const key = momStrategy.getBaselineKey(network, pair, networkMode);
      const agentHistory = state.priceHistory?.[network];
      const existingHistory = momStrategy.state?.priceHistory?.[key];
      if ((!existingHistory || existingHistory.length < (momStrategy.config?.minDataPoints || 12)) && agentHistory?.length > 0) {
        if (!momStrategy.state.priceHistory) momStrategy.state.priceHistory = {};
        momStrategy.state.priceHistory[key] = agentHistory.map(p => ({ price: p.price, timestamp: p.timestamp }));
        logger.info(`Seeded momentum price history for ${network}: ${agentHistory.length} points`);
      }
      const agentPosition = state.positions?.[network];
      if (agentPosition) {
        momStrategy.setPosition(network, agentPosition);
      }
    }

    const analyses = [];
    const networkOrder = decision.network
      ? [decision.network, ...Object.keys(networks).filter(n => n !== decision.network)]
      : Object.keys(networks);

    for (const network of networkOrder) {
      const netConfig = networks[network];
      if (!netConfig) continue;
      try {
        const tokenConfig = { symbol: netConfig.symbol };
        const analysis = await momStrategy.analyze(
          transformedMarketData, { balances: marketData.balances }, network, networkMode, tokenConfig
        );
        analyses.push(analysis);
        if (analysis.opportunity) {
          logger.info(`Momentum opportunity on ${network}: ${analysis.opportunity.action} - ${analysis.opportunity.reason}`);
        }
      } catch (err) {
        logger.warn(`Momentum analysis failed for ${network}: ${err.message}`);
      }
    }

    const networkAnalysis = {};
    for (const a of analyses) { networkAnalysis[a.network] = a; }

    const decisions = await momStrategy.decide(analyses, { balances: marketData.balances }, stratConfig);

    if (decisions.length > 0) {
      const tradeDecision = decisions[0];
      let direction, percentOfBalance = stratConfig.maxTradePercentage;

      if (tradeDecision.action === 'buy_native') {
        direction = 'buy';
      } else if (tradeDecision.action === 'trailing_stop_sell') {
        direction = 'sell';
        percentOfBalance = 40; // Larger exit on trailing stop
      } else if (tradeDecision.action === 'trend_exit_sell') {
        direction = 'sell';
        percentOfBalance = 30; // Trend reversal exit
      } else {
        logger.warn(`Momentum: Unknown action ${tradeDecision.action}`);
        return { success: true, action: 'hold', reason: `Unknown momentum action: ${tradeDecision.action}` };
      }

      logger.info(`Momentum executing: ${direction} on ${tradeDecision.network} - ${tradeDecision.reason}`);

      await this.updateState({
        lastDecision: { action: direction, reason: tradeDecision.reason, decisions, networkAnalysis, strategy: 'momentum', timestamp: new Date() }
      });

      return this.executeNativeMaximizer({
        ...decision,
        network: tradeDecision.network,
        tradeParams: { direction, percentOfBalance }
      }, marketData);
    }

    await this.updateState({
      lastDecision: { action: 'hold', reason: 'momentum: No opportunities', decisions: [], networkAnalysis, strategy: 'momentum', timestamp: new Date() }
    });

    return {
      success: true, action: 'hold',
      reason: analyses.map(a => a.reason).filter(Boolean).join('; ') || 'No momentum opportunities',
      networkAnalysis
    };
  }

  /**
   * Execute Arbitrage Scan - experimental, informational only
   * Real multi-DEX price comparison not yet implemented
   */
  async executeArbitrageScan(decision, marketData) {
    logger.info('ArbitrageScan: Strategy is experimental - real DEX price comparison not yet implemented');

    const observations = [];
    for (const [network, priceData] of Object.entries(marketData.prices)) {
      if (!priceData.price) continue;
      observations.push({
        network,
        symbol: priceData.symbol,
        price: priceData.price,
        source: priceData.source || 'unknown',
        note: 'Single-source price. Multi-DEX comparison requires router getAmountsOut queries.'
      });
    }

    await this.updateState({
      lastArbitrageScan: new Date(),
      arbitrageObservations: observations,
      lastDecision: { action: 'hold', reason: 'arbitrage_scan: Experimental - no real DEX price comparison yet', strategy: 'arbitrage_scan', timestamp: new Date() }
    });

    return {
      success: true,
      action: 'arbitrage_scan_info',
      experimental: true,
      message: 'Arbitrage scanning is experimental. Real multi-DEX price comparison not yet implemented.',
      observations
    };
  }

  /**
   * Execute Grid Trading strategy - uses registry strategy analyze/decide
   * Places virtual buy/sell levels at price intervals
   */
  async executeGridTrading(decision, marketData) {
    const config = this.getConfig();
    const state = this.getState();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    const gridStrategy = strategyRegistry.get('grid_trading');
    if (!gridStrategy) {
      logger.warn('GridTrading strategy not found in registry, falling back to native_maximizer');
      return this.executeNativeMaximizer(decision, marketData);
    }

    const transformedMarketData = { prices: {}, balances: marketData.balances };
    for (const [network, priceData] of Object.entries(marketData.prices)) {
      // Use actual token symbol (ETH, BNB) not network name (ethereum, bsc)
      const sym = priceData.symbol && priceData.symbol !== network
        ? priceData.symbol
        : networks[network]?.symbol;
      if (sym) {
        transformedMarketData.prices[`${sym}/USD`] = priceData;
      }
    }

    const stratConfig = {
      minTradeValueNative: config.minTradeValueNative || 0.001,
      maxTradePercentage: config.maxTradePercentage || 20,
      slippageTolerance: config.slippageTolerance || 2
    };

    // Sync positions
    for (const [network, netConfig] of Object.entries(networks)) {
      const agentPosition = state.positions?.[network];
      if (agentPosition) {
        gridStrategy.setPosition(network, agentPosition);
      }
    }

    const analyses = [];
    const networkOrder = decision.network
      ? [decision.network, ...Object.keys(networks).filter(n => n !== decision.network)]
      : Object.keys(networks);

    for (const network of networkOrder) {
      const netConfig = networks[network];
      if (!netConfig) continue;
      try {
        const tokenConfig = { symbol: netConfig.symbol };
        const analysis = await gridStrategy.analyze(
          transformedMarketData, { balances: marketData.balances }, network, networkMode, tokenConfig
        );
        analyses.push(analysis);
        if (analysis.opportunity) {
          logger.info(`GridTrading opportunity on ${network}: ${analysis.opportunity.action} (level ${analysis.opportunity.gridLevel})`);
        }
      } catch (err) {
        logger.warn(`GridTrading analysis failed for ${network}: ${err.message}`);
      }
    }

    const networkAnalysis = {};
    for (const a of analyses) { networkAnalysis[a.network] = a; }

    const decisions = await gridStrategy.decide(analyses, { balances: marketData.balances }, stratConfig);

    if (decisions.length > 0) {
      const tradeDecision = decisions[0];
      const tradePerLevel = gridStrategy.config?.tradePerLevel || 10;
      let direction;

      if (tradeDecision.action === 'grid_buy') {
        direction = 'buy';
      } else if (tradeDecision.action === 'grid_sell') {
        direction = 'sell';
      } else {
        logger.warn(`GridTrading: Unknown action ${tradeDecision.action}`);
        return { success: true, action: 'hold', reason: `Unknown grid action: ${tradeDecision.action}` };
      }

      logger.info(`GridTrading executing: ${direction} on ${tradeDecision.network} (level ${tradeDecision.gridLevel}) - ${tradeDecision.reason}`);

      await this.updateState({
        lastDecision: { action: direction, reason: tradeDecision.reason, decisions, networkAnalysis, strategy: 'grid_trading', gridLevel: tradeDecision.gridLevel, timestamp: new Date() }
      });

      const result = await this.executeNativeMaximizer({
        ...decision,
        network: tradeDecision.network,
        tradeParams: { direction, percentOfBalance: tradePerLevel }
      }, marketData);

      // Mark grid level as filled on successful trade
      if (result.success && result.action !== 'hold') {
        try {
          const netConfig = networks[tradeDecision.network];
          const pair = `${netConfig.symbol}/USD`;
          const levelType = tradeDecision.action === 'grid_buy' ? 'buy' : 'sell';
          if (gridStrategy.markLevelFilled) {
            gridStrategy.markLevelFilled(tradeDecision.network, pair, networkMode, levelType, tradeDecision.gridLevel, tradeDecision.priceAtDecision);
          }
        } catch (markErr) {
          logger.warn(`Failed to mark grid level as filled: ${markErr.message}`);
        }
      }

      return result;
    }

    await this.updateState({
      lastDecision: { action: 'hold', reason: 'grid_trading: No grid levels triggered', decisions: [], networkAnalysis, strategy: 'grid_trading', timestamp: new Date() }
    });

    return {
      success: true, action: 'hold',
      reason: analyses.map(a => a.reason).filter(Boolean).join('; ') || 'No grid levels triggered',
      networkAnalysis
    };
  }

  /**
   * Execute Dollar Maximizer strategy - uses registry strategy analyze/decide
   * Maximizes stablecoin holdings with gas reserve protection
   */

  /**
   * Native held back for gas on this network. Per-network because the same number
   * cannot be right for both BSC and Ethereum mainnet.
   */
  _getNativeGasFloor(network) {
    const override = this.getConfig().nativeGasFloor?.[network];
    if (Number.isFinite(override) && override >= 0) return override;

    const symbol = NATIVE_SYMBOL[network] || 'BNB';

    // The project already has ONE declared gas reserve per asset, which
    // dollar_maximizer honours on its own sells. The token trader's buy gates were
    // hardcoding 0.005 instead — 10x BELOW the declared 0.05 BNB — which is how the
    // native balance came to sit under the floor the config claims to keep.
    // Read the declared value rather than inventing a second standard.
    try {
      const dm = strategyRegistry.get('dollar_maximizer');
      if (typeof dm?.getGasReserve === 'function') {
        const declared = parseFloat(dm.getGasReserve(symbol));
        if (Number.isFinite(declared) && declared >= 0) return declared;
      }
    } catch {
      // fall through to the mirror below
    }

    const fallback = FALLBACK_NATIVE_GAS_FLOOR[symbol];
    return Number.isFinite(fallback) ? fallback : DEFAULT_NATIVE_GAS_FLOOR;
  }

  /**
   * How much native TokenTrader may actually spend on this network.
   *
   * TokenTrader and DollarMaximizer share one wallet. The native-funding gate used
   * to read the WHOLE wallet balance, so whenever the native pool quoted lower price
   * impact TokenTrader spent DollarMaximizer's position out from under it: 0.661574
   * BNB (~$465) became LINK over 2026-08-22/23 with no sell, no PnL and no log line
   * on DollarMaximizer's side, because its position is reconciled FROM the wallet and
   * silently wrote itself down to match.
   *
   * Attribution is by TRACKED BALANCE, deliberately NOT by the `inStablecoin` flag.
   * An earlier version of this fix keyed on "DollarMaximizer's leg IS native", which
   * reads sensibly and would NOT have prevented the incident: through the whole
   * afternoon that its BNB was being consumed, its own logs said "Holding stablecoin"
   * while ~0.7 BNB sat in the wallet. A flag that can be wrong is exactly what this
   * class of bug corrupts, so it must not be the thing standing between one strategy
   * and another's assets. `nativeAmount` is reconciled from the wallet and is the
   * durable record of what is attributed elsewhere.
   *
   * The practical consequence is that the token trader funds buys from its stablecoin
   * reserve rather than native, and that is correct: its accounting has no native line
   * item at all — position is tokens plus stablecoin reserve — and a native-funded buy
   * was still debited from that stablecoin reserve, so it was spending one asset while
   * charging itself for another. Only genuine surplus above both the gas floor and the
   * attributed position is spendable. If the token trader ever tracks native of its
   * own, subtract it here.
   *
   * Pausing a strategy does not transfer ownership: a paused position is still a
   * position, so this deliberately ignores pausedStrategies.
   */
  _getAvailableNativeForTokenTrader(network, walletNative) {
    const gasFloor = this._getNativeGasFloor(network);
    const wallet = Number.isFinite(walletNative) ? walletNative : 0;

    const position = this.getState().positions?.[network];
    const rawDmNative = parseFloat(position?.nativeAmount);
    const dmOwned = Number.isFinite(rawDmNative) && rawDmNative > 0
      ? Math.min(rawDmNative, wallet)
      : 0;

    const available = Math.max(0, wallet - dmOwned - gasFloor);
    return { available, dmOwned, gasFloor, wallet };
  }


  /**
   * Swap a little stablecoin into native when gas runs critically low.
   *
   * This lived inline in executeDollarMaximizer, AFTER the operator-pause gate — so
   * pausing that one strategy silently switched off gas maintenance for the whole
   * agent, including the token trader that was still trading. Nothing said so, and
   * the coupling is invisible from the pause itself.
   *
   * Topping up gas is infrastructure, not a trading decision: it takes no view on
   * price and opens no position. It therefore runs whether or not any strategy is
   * paused, and is called on both paths.
   *
   * Fires only below 50% of the declared reserve, so it is a floor-restorer, not a
   * balance-maintainer — a balance between the trigger and the reserve is left alone
   * by design.
   */
  async _autoGasTopUp(networks, marketData, dollarStrategy) {
    if (!networks || !marketData?.balances || !dollarStrategy) return;
    try {
  // === Auto gas top-up: swap small stablecoin amount to native if gas is critically low ===
  for (const [network, netConfig] of Object.entries(networks)) {
    const balance = marketData.balances[network];
    if (!balance) continue;

    const symbol = netConfig.symbol;
    const gasReserve = dollarStrategy.getGasReserve(symbol);
    const nativeBalance = parseFloat(balance.native) || 0;
    const stableBalance = parseFloat(balance.stablecoin) || 0;

    // Trigger when native is below 50% of gas reserve AND we have stablecoins to swap
    if (nativeBalance < gasReserve * 0.5 && stableBalance > 5) {
      // This swap spends strategy capital, so never act on the snapshot alone: a
      // transient RPC failure can make the snapshot read 0 for a funded wallet,
      // and repeated top-ups against that phantom zero drain the stablecoin
      // position into native. Confirm with a fresh on-chain read; if the balance
      // can't be verified, skip — running low on gas for one tick is recoverable,
      // spent capital is not.
      let confirmedNative = null;
      try {
        const gasWallet = await walletService.getWallet();
        const gasChainMap = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', base: 'base' };
        const gasAddr = gasWallet?.addresses?.find(a => a.chain === gasChainMap[network])?.address;
        if (gasAddr) {
          const fresh = await contractServiceWrapper.getNativeBalance(gasAddr, network);
          const parsed = parseFloat(fresh.formatted);
          if (Number.isFinite(parsed)) confirmedNative = parsed;
        }
      } catch (verifyErr) {
        logger.warn(`Auto gas top-up [${network}]: balance verification failed (${verifyErr.message})`);
      }
      if (confirmedNative === null) {
        logger.warn(`Auto gas top-up [${network}]: skipped — native balance could not be verified`);
        continue;
      }
      if (confirmedNative >= gasReserve * 0.5) {
        logger.warn(`Auto gas top-up [${network}]: skipped — snapshot read ${nativeBalance.toFixed(6)} but wallet actually holds ${confirmedNative.toFixed(6)} ${symbol}`);
        continue;
      }

      // Swap enough stablecoins to cover 2x gas reserve (small swap to minimize market impact)
      const nativePrice = transformedMarketData.prices[`${symbol}/USD`]?.price || 0;
      if (nativePrice <= 0) continue;

      const targetNative = gasReserve * 2;
      const deficit = targetNative - confirmedNative;
      const swapAmountUsd = Math.min(deficit * nativePrice, stableBalance * 0.5, 50); // Cap at $50 or 50% of stablecoins

      if (swapAmountUsd < 2) continue; // Not worth the gas

      logger.info(`Auto gas top-up [${network}]: native ${confirmedNative.toFixed(6)} ${symbol} below 50% of ${gasReserve} reserve. Swapping ~$${swapAmountUsd.toFixed(2)} stablecoin → ${symbol}`);

      try {
        const swapResult = await swapService.swap(
          netConfig.stablecoinAddress,
          'native',
          swapAmountUsd.toFixed(2),
          2, // slippage
          network,
          { preferV3: true, gasCheck: true, expectedOutputUsd: swapAmountUsd, outputTokenPriceUsd: nativePrice }
        );

        if (swapResult.success) {
          const nativeReceived = parseFloat(swapResult.expectedOut) || 0;
          logger.info(`Auto gas top-up [${network}]: SUCCESS — received ${nativeReceived.toFixed(6)} ${symbol} (tx: ${swapResult.hash})`);

          // Update the balance data so the rest of the cycle sees the new amounts
          balance.native = (confirmedNative + nativeReceived).toString();
          balance.stablecoin = Math.max(0, stableBalance - swapAmountUsd);

          // Update position to reflect reduced stablecoins
          const pos = dollarStrategy.getPosition(network);
          if (pos.inStablecoin && pos.stablecoinAmount) {
            pos.stablecoinAmount = Math.max(0, pos.stablecoinAmount - swapAmountUsd);
            pos.nativeAmount = confirmedNative + nativeReceived;
            pos.updatedAt = new Date().toISOString();
            dollarStrategy.setPosition(network, pos);
            await this._persistPosition(network, pos);
          }
        } else {
          logger.warn(`Auto gas top-up [${network}]: swap failed — ${swapResult.error || 'unknown error'}`);
        }
      } catch (err) {
        logger.warn(`Auto gas top-up [${network}]: error — ${err.message}`);
      }
    }
  }
    } catch (err) {
      // Gas maintenance must never take down the caller.
      logger.warn(`Auto gas top-up: aborted — ${err.message}`);
    }
  }

  async executeDollarMaximizer(decision, marketData, indicators) {
    const config = this.getConfig();
    const state = this.getState();

    // OPERATOR PAUSE — per-strategy, checked before any analysis or balance read.
    //
    // There was no way to stop ONE strategy. Clearing the registry's activeStrategy looks
    // like it should work and does not: this function is dispatched dynamically, so it kept
    // running, kept analysing, and would have kept producing trade decisions — it simply
    // happened to find no opportunity that tick. "It didn't trade" is not "it is stopped".
    //
    // The gate lives at the top of the executor, not at a call site, so it cannot be
    // bypassed by whatever route reaches here. Emergency-stop halts everything including
    // the token trader's protective exits; this pauses one strategy and leaves the other
    // guarding its open position.
    const paused = config.domainConfig?.pausedStrategies || config.pausedStrategies || [];
    if (Array.isArray(paused) && paused.includes('dollar_maximizer')) {
      logger.warn('DollarMaximizer: PAUSED by operator — skipping analysis and trading entirely');
      // Gas maintenance is NOT trading, and the token trader may still be running on
      // this wallet. Pausing a strategy must not quietly disable the agent's ability
      // to buy the gas its other strategy needs to execute — or to exit.
      try {
        const pausedNetworkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
        await this._autoGasTopUp(
          NETWORK_CONFIG[pausedNetworkMode],
          marketData,
          strategyRegistry.get('dollar_maximizer')
        );
      } catch (err) {
        logger.warn(`Auto gas top-up while paused: ${err.message}`);
      }
      return {
        success: true,
        action: 'paused',
        strategy: 'dollar_maximizer',
        reason: 'Paused by operator (domainConfig.pausedStrategies)'
      };
    }

    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    const dollarStrategy = strategyRegistry.get('dollar_maximizer');
    if (!dollarStrategy) {
      logger.warn('DollarMaximizer strategy not found in registry, falling back to native_maximizer');
      return this.executeNativeMaximizer(decision, marketData);
    }

    const transformedMarketData = { prices: {}, balances: marketData.balances };
    for (const [network, priceData] of Object.entries(marketData.prices)) {
      // Use actual token symbol (ETH, BNB) not network name (ethereum, bsc)
      const sym = priceData.symbol && priceData.symbol !== network
        ? priceData.symbol
        : networks[network]?.symbol;
      if (sym) {
        transformedMarketData.prices[`${sym}/USD`] = priceData;
        // Attach agent indicators for trend awareness
        if (indicators?.[network]) {
          transformedMarketData.prices[`${sym}/USD`].indicators = indicators[network];
        }
      }
    }

    const stratConfig = {
      minTradeValueNative: config.minTradeValueNative || 0.001,
      maxTradePercentage: config.maxTradePercentage || 20,
      slippageTolerance: config.slippageTolerance || 2
    };

    // Seed history and sync state
    for (const [network, netConfig] of Object.entries(networks)) {
      const pair = `${netConfig.symbol}/USD`;
      const key = dollarStrategy.getBaselineKey(network, pair, networkMode);
      const agentHistory = state.priceHistory?.[network];
      const existingHistory = dollarStrategy.state?.priceHistory?.[key];
      if ((!existingHistory || existingHistory.length < (dollarStrategy.config?.minDataPoints || 6)) && agentHistory?.length > 0) {
        if (!dollarStrategy.state.priceHistory) dollarStrategy.state.priceHistory = {};
        dollarStrategy.state.priceHistory[key] = agentHistory.map(p => ({ price: p.price, timestamp: p.timestamp }));
      }
      // Seed trend history for regime detection if strategy has insufficient data
      const existingTrendHistory = dollarStrategy.state?.trendHistory?.[key];
      if ((!existingTrendHistory || existingTrendHistory.length < 24) && agentHistory?.length > 0) {
        if (!dollarStrategy.state.trendHistory) dollarStrategy.state.trendHistory = {};
        dollarStrategy.state.trendHistory[key] = agentHistory.map(p => ({ price: p.price, timestamp: p.timestamp }));
      }
      const agentBaseline = state.priceBaselines?.[network];
      if (agentBaseline && !dollarStrategy.getBaseline(network, pair, networkMode)) {
        dollarStrategy.setBaseline(network, pair, networkMode, agentBaseline.price);
      }
      const agentPosition = state.positions?.[network];
      if (agentPosition) {
        // Fix null entryPrice: use baseline price if available
        if (!agentPosition.entryPrice && agentBaseline?.price) {
          agentPosition.entryPrice = agentBaseline.price;
          // Persist the fix (atomic per-network)
          await this._persistPosition(network, { ...agentPosition });
          logger.info(`Fixed null entryPrice for ${network}: set to baseline $${agentBaseline.price}`);
        }
        dollarStrategy.setPosition(network, agentPosition);
      }
    }

    // Reconcile position state with actual wallet balances
    for (const [network, netConfig] of Object.entries(networks)) {
      const balance = marketData.balances[network];
      if (!balance) continue;

      const position = dollarStrategy.getPosition(network);
      const actualStable = balance.stablecoin || 0;
      // What the WALLET holds vs what DM may SPEND are different numbers whenever a
      // token trader is running on this network. Branch conditions below stay on the
      // wallet figure — "is there stablecoin here at all" is an observation about the
      // chain. The amount STORED on the position is DM's own share, because that field
      // is what a buy-back spends.
      const dmStable = this.getDmAvailableStable(network, actualStable);
      const pricePair = `${netConfig.symbol}/USD`;
      const currentPrice = transformedMarketData.prices[pricePair]?.price;

      // Pre-calculate native excess value for all checks
      const actualNativeBalance = parseFloat(balance.native) || 0;
      const gasReserve = dollarStrategy.getGasReserve(netConfig.symbol);
      const excessNative = Math.max(0, actualNativeBalance - gasReserve);
      const excessNativeValueUSD = excessNative * (currentPrice || 0);

      // Determine which asset is dominant by USD value.
      //
      // With no usable price, excessNativeValueUSD collapses to 0 and `stableDominant`
      // becomes trivially true for any dust above $1 — enough to flip a position that
      // genuinely holds native into "in stablecoin" and PERSIST that. A feed miss must
      // not rewrite what we hold. nativeDominant needs no such guard: its branch also
      // requires excessNativeValueUSD > 5, which a zero can never satisfy.
      //
      // Dominance must compare LIKE WITH LIKE. actualStable is the WHOLE wallet, which on
      // a network where a token trader runs is mostly the trader's reserve — so comparing
      // it against DM's own native let the trader's USDT outvote DM's BNB. Live on
      // 2026-08-21: DM spent its $1,004.93 leg on BNB at 20:54, and reconciliation at
      // 21:04 saw "1304.62 USDT (dominant over ~$1000.07 native)" — that USDT was the LINK
      // reserve, not DM's — flipped the position back to stablecoin, and so never cleared
      // stablecoinHoldingSince. The idle clock kept running (31.5d → 32.8d) while the leg
      // actually held native, leaving the stranded-capital re-entry permanently armed
      // against a clock that could never reset. Compare DM's own share on both sides.
      const reconcilePriceKnown = Number.isFinite(currentPrice) && currentPrice > 0;
      const stableDominant = reconcilePriceKnown && dmStable > excessNativeValueUSD;
      const nativeDominant = excessNativeValueUSD > dmStable;
      if (!reconcilePriceKnown && actualStable > 1) {
        logger.warn(`Position reconciliation [${network}]: no usable price — holding position state as-is rather than valuing native at $0`);
      }

      // Wallet has stablecoins but position says NOT in stablecoin
      // Only flip if stablecoin is the dominant value (prevents flip-flop when both have value)
      if (!position.inStablecoin && dmStable > 1 && stableDominant) {
        logger.info(`Position reconciliation [${network}]: $${dmStable.toFixed(2)} of this leg's ${netConfig.stablecoin} (dominant over ~$${excessNativeValueUSD.toFixed(2)} native) but position says native. Updating to stablecoin position. Wallet holds ${actualStable} ${netConfig.stablecoin} in total; the remainder is the token trader's allotment.`);
        const reconciled = {
          inStablecoin: true,
          stablecoinAmount: dmStable,
          entryPrice: position.entryPrice || currentPrice || 0,
          nativeAmount: actualNativeBalance,
          timestamp: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reconciledFromWallet: true
        };
        dollarStrategy.setPosition(network, reconciled);
        await this._persistPosition(network, reconciled);
      }
      // Position says IN stablecoin but wallet has none
      else if (position.inStablecoin && actualStable < 0.01) {
        logger.info(`Position reconciliation [${network}]: position says stablecoin but wallet has ${actualStable}. Resetting to native.`);
        const reconciled = {
          inStablecoin: false,
          stablecoinAmount: 0,
          entryPrice: currentPrice || null,
          nativeAmount: actualNativeBalance,
          timestamp: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reconciledFromWallet: true
        };
        dollarStrategy.setPosition(network, reconciled);
        await this._persistPosition(network, reconciled);
      }
      // Position says IN stablecoin but wallet has significant native above gas reserve
      // Only flip if native is the dominant value (prevents flip-flop when both have value).
      // This check MUST come before the stablecoin drift-sync below: that branch matches
      // any position with ≥ $0.01 of stablecoin, so putting it first made this flip
      // unreachable — a position whose capital had leaked to native (e.g. runaway gas
      // top-ups) stayed "in stablecoin" with dust forever instead of resuming native trading.
      else if (position.inStablecoin && nativeDominant && excessNative > gasReserve && excessNativeValueUSD > 5) {
        logger.info(`Position reconciliation [${network}]: native ~$${excessNativeValueUSD.toFixed(2)} dominant over this leg's $${dmStable.toFixed(2)} stablecoin. Switching to native position. Wallet holds $${actualStable.toFixed(2)} in total; the remainder is the token trader's allotment.`);
        const reconciled = {
          inStablecoin: false,
          stablecoinAmount: dmStable,
          entryPrice: currentPrice || position.entryPrice || null,
          nativeAmount: actualNativeBalance,
          timestamp: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reconciledFromWallet: true
        };
        dollarStrategy.setPosition(network, reconciled);
        await this._persistPosition(network, reconciled);
      }
      // Wallet is the source of truth for stablecoinAmount: always sync to live
      // balance. State stores intent (direction, entry price, history); the
      // wallet stores capital. This eliminates inter-strategy drift entirely —
      // any other strategy that spends from the shared stablecoin pool is
      // automatically reflected here on the next tick.
      else if (position.inStablecoin && actualStable > 0.01) {
        const drift = Math.abs(dmStable - (position.stablecoinAmount || 0));
        if (drift > 0.01) {
          const reconciled = { ...position, stablecoinAmount: dmStable, nativeAmount: actualNativeBalance, updatedAt: new Date().toISOString() };
          dollarStrategy.setPosition(network, reconciled);
          // Persist only on meaningful drift to avoid hammering the DB every tick.
          if (drift > 0.5) {
            logger.debug(`Position sync [${network}]: stablecoin ${position.stablecoinAmount} → ${dmStable} (wallet $${actualStable.toFixed(2)} less token-trader allotment)`);
            await this._persistPosition(network, reconciled);
          }
        }
      }

      // Always sync nativeAmount to actual wallet balance.
      // Read FRESH on-chain, not the heartbeat-start marketData snapshot (`balance.native`):
      // the token trader runs on its own heartbeat and can spend native (native-funded buys)
      // between the snapshot and here, so trusting the snapshot would re-clobber DM's native
      // back to a stale pre-trade value — re-introducing the v2.25.109 double-count. Fall back
      // to the snapshot only if the fresh read fails.
      const currentPos = dollarStrategy.getPosition(network);
      let actualNative = parseFloat(balance.native) || 0;
      try {
        const reconcileWallet = await walletService.getWallet();
        const chainMap = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', base: 'base' };
        const evmAddr = reconcileWallet?.addresses?.find(a => a.chain === chainMap[network])?.address;
        if (evmAddr) {
          const freshNative = await contractServiceWrapper.getNativeBalance(evmAddr, network);
          const parsed = parseFloat(freshNative.formatted);
          if (Number.isFinite(parsed)) actualNative = parsed;
        }
      } catch (freshErr) {
        logger.debug(`DM native sync: fresh read failed for ${network}, using snapshot: ${freshErr.message}`);
      }
      if (Math.abs(actualNative - (currentPos.nativeAmount || 0)) > 0.0001) {
        currentPos.nativeAmount = actualNative;
        currentPos.updatedAt = new Date().toISOString();
        dollarStrategy.setPosition(network, currentPos);
        await this._persistPosition(network, currentPos);
      }
    }

    // Keep gas topped up. This is infrastructure, not trading — see _autoGasTopUp.
    await this._autoGasTopUp(networks, marketData, dollarStrategy);

    const analyses = [];
    let networkOrder = decision.network
      ? [decision.network, ...Object.keys(networks).filter(n => n !== decision.network)]
      : Object.keys(networks);

    // Filter out disabled networks (user toggle from Web UI)
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const disabledNetworks = await SystemSettings.getSetting('crypto.disabledNetworks', []);
      if (disabledNetworks.length > 0) {
        const before = networkOrder.length;
        networkOrder = networkOrder.filter(n => !disabledNetworks.includes(n));
        if (networkOrder.length < before) {
          logger.info(`DollarMaximizer: Disabled networks filtered out: ${disabledNetworks.join(', ')} (${before} → ${networkOrder.length})`);
        }
      }
    } catch (err) {
      logger.debug(`Could not load disabled networks setting: ${err.message}`);
    }

    // Filter out networks with total wallet value below minimum threshold
    const minNetworkValueUsd = dollarStrategy.config.minNetworkValueUsd || {};
    const filteredNetworkOrder = [];
    for (const network of networkOrder) {
      const netConfig = networks[network];
      if (!netConfig) continue;
      const symbol = netConfig.symbol;
      const minValue = minNetworkValueUsd[symbol] || minNetworkValueUsd[`${symbol}_${network.toUpperCase()}`] || 0;
      if (minValue > 0) {
        const nativeBalance = parseFloat(marketData.balances[network]?.native) || 0;
        const stableBalance = parseFloat(marketData.balances[network]?.stablecoin) || 0;
        const nativePrice = transformedMarketData.prices[`${symbol}/USD`]?.price || 0;
        const totalValueUsd = (nativeBalance * nativePrice) + stableBalance;
        if (totalValueUsd < minValue) {
          logger.info(`DollarMaximizer: Skipping ${network} — total value $${totalValueUsd.toFixed(2)} below $${minValue} minimum for ${symbol}`);
          continue;
        }
      }
      filteredNetworkOrder.push(network);
    }
    networkOrder = filteredNetworkOrder;

    logger.info(`DollarMaximizer: analyzing ${networkOrder.length} network(s) in ${networkMode} mode`);
    logger.info(`DollarMaximizer: balances available: ${JSON.stringify(Object.keys(marketData.balances))}`);
    logger.info(`DollarMaximizer: prices available: ${JSON.stringify(Object.keys(transformedMarketData.prices))}`);

    for (const network of networkOrder) {
      const netConfig = networks[network];
      if (!netConfig) continue;
      try {
        const tokenConfig = { symbol: netConfig.symbol };
        const analysis = await dollarStrategy.analyze(
          transformedMarketData, { balances: marketData.balances }, network, networkMode, tokenConfig
        );
        analyses.push(analysis);
        logger.info(`DollarMaximizer [${network}]: price=$${analysis.currentPrice}, baseline=$${analysis.baselinePrice}, change=${analysis.priceChange?.toFixed(2)}%, opportunity=${analysis.opportunity ? analysis.opportunity.action : 'none'}, reason=${analysis.reason || analysis.opportunity?.reason || 'n/a'}`);
      } catch (err) {
        logger.warn(`DollarMaximizer analysis failed for ${network}: ${err.message}`);
      }
    }

    const networkAnalysis = {};
    for (const a of analyses) { networkAnalysis[a.network] = a; }

    const decisions = await dollarStrategy.decide(analyses, { balances: marketData.balances }, stratConfig);
    logger.info(`DollarMaximizer: ${decisions.length} trade decision(s) from ${analyses.length} analysis(es)`);

    if (decisions.length > 0) {
      // Execute ALL trade decisions across networks (not just the first)
      const results = [];
      for (const tradeDecision of decisions) {
        let direction;

        if (tradeDecision.action === 'sell_native_profit' || tradeDecision.action === 'sell_stop_loss') {
          direction = 'sell';
          const isStopLoss = tradeDecision.action === 'sell_stop_loss';

          // Gas reserve check: limit sell to (balance - gasReserve)
          const network = tradeDecision.network;
          const netConfig = networks[network];
          const symbol = netConfig.symbol;
          const gasReserve = dollarStrategy.getGasReserve(symbol);
          const nativeBalance = parseFloat(marketData.balances[network]?.native) || 0;

          if (nativeBalance <= gasReserve) {
            logger.warn(`DollarMaximizer: Cannot sell on ${network} - balance ${nativeBalance} <= gas reserve ${gasReserve} ${symbol}`);
            results.push({ success: true, action: 'hold', network, reason: `Gas reserve protection: ${nativeBalance} ${symbol} <= ${gasReserve} ${symbol} reserve` });
            continue;
          }

          const maxSellable = nativeBalance - gasReserve;
          // Stop-loss sells more aggressively to protect capital
          const sellPct = isStopLoss ? Math.min(50, stratConfig.maxTradePercentage * 1.5) : stratConfig.maxTradePercentage;
          const requestedSell = nativeBalance * (sellPct / 100);
          const actualPercent = Math.min(requestedSell, maxSellable) / nativeBalance * 100;

          logger.info(`DollarMaximizer: ${isStopLoss ? 'STOP-LOSS' : 'Profit'} selling ${actualPercent.toFixed(1)}% of ${symbol} on ${network} (keeping ${gasReserve} ${symbol} for gas)`);

          // Gas profitability check: skip if expected profit doesn't justify gas cost
          // Stop-loss sells BYPASS this check (capital preservation > gas cost)
          if (!isStopLoss) {
            try {
              const nativePrice = transformedMarketData.prices[`${symbol}/USD`]?.price || 0;
              const sellAmountNative = Math.min(requestedSell, maxSellable);
              const tradeValueUsd = sellAmountNative * nativePrice;
              // Fall back to the analysis — a decision without priceChange would
              // otherwise compute $0 profit and veto every take-profit sell.
              const priceChange = Math.abs(tradeDecision.priceChange ?? networkAnalysis[network]?.priceChange ?? 0) / 100;
              const expectedProfitUsd = tradeValueUsd * priceChange;

              // Estimate gas cost
              const { ethers } = await import('ethers');
              const provider = await contractServiceWrapper.getProvider(network);
              const feeData = await provider.getFeeData();
              const gasPrice = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
              const gasCostWei = gasPrice * BigInt(250000);
              const gasCostNative = parseFloat(ethers.formatEther(gasCostWei));
              const gasCostUsd = gasCostNative * nativePrice;

              const multiplier = dollarStrategy.config.minProfitGasMultiplier || 2;
              if (expectedProfitUsd < gasCostUsd * multiplier) {
                logger.info(`DollarMaximizer: Skipping ${network} sell — expected profit $${expectedProfitUsd.toFixed(4)} < ${multiplier}x gas cost $${gasCostUsd.toFixed(4)} ($${(gasCostUsd * multiplier).toFixed(4)} minimum)`);
                results.push({ success: true, action: 'hold', network, reason: `Gas unprofitable: profit $${expectedProfitUsd.toFixed(2)} < ${multiplier}x gas $${gasCostUsd.toFixed(2)}` });
                continue;
              }
              logger.info(`DollarMaximizer: Gas check OK — expected profit $${expectedProfitUsd.toFixed(4)} >= ${multiplier}x gas $${gasCostUsd.toFixed(4)}`);
            } catch (gasErr) {
              logger.warn(`DollarMaximizer: Gas profitability check failed (proceeding anyway): ${gasErr.message}`);
            }
          }

          // Persist baselines and positions along with decision
          const sellBaselines = {};
          const sellPositions = {};
          for (const [n, nc] of Object.entries(networks)) {
            const p = `${nc.symbol}/USD`;
            const bl = dollarStrategy.getBaseline(n, p, networkMode);
            if (bl) sellBaselines[n] = bl;
            const pos = dollarStrategy.getPosition(n);
            if (pos) sellPositions[n] = pos;
          }
          await this.updateState({
            lastDecision: { action: 'sell', reason: tradeDecision.reason, decisions, networkAnalysis, strategy: 'dollar_maximizer', gasReserveKept: gasReserve, timestamp: new Date() },
            priceBaselines: sellBaselines,
            positions: sellPositions
          });

          const result = await this.executeNativeMaximizer({
            ...decision,
            network: tradeDecision.network,
            urgent: isStopLoss,
            tradeParams: { direction: 'sell', percentOfBalance: Math.max(1, Math.floor(actualPercent)) }
          }, marketData);

          // Track stablecoin P&L
          if (result.success && result.received) {
            dollarStrategy.recordDollarProfit(network, parseFloat(result.received) || 0);
          }

          results.push({ ...result, network, reason: result.reason || tradeDecision.reason });
        } else if (tradeDecision.action === 'buy_native_cheap') {
          direction = 'buy';

          logger.info(`DollarMaximizer: Buying cheap ${tradeDecision.symbol} on ${tradeDecision.network} - ${tradeDecision.reason}`);

          // Persist baselines and positions along with decision
          const buyBaselines = {};
          const buyPositions = {};
          for (const [n, nc] of Object.entries(networks)) {
            const p = `${nc.symbol}/USD`;
            const bl = dollarStrategy.getBaseline(n, p, networkMode);
            if (bl) buyBaselines[n] = bl;
            const pos = dollarStrategy.getPosition(n);
            if (pos) buyPositions[n] = pos;
          }
          await this.updateState({
            lastDecision: { action: 'buy', reason: tradeDecision.reason, decisions, networkAnalysis, strategy: 'dollar_maximizer', timestamp: new Date() },
            priceBaselines: buyBaselines,
            positions: buyPositions
          });

          const result = await this.executeNativeMaximizer({
            ...decision,
            network: tradeDecision.network,
            // The per-network decision carries the size the strategy asked for; the outer
            // `decision` is the generic strategy-execution envelope and has no amount. This
            // spread dropped it, so a buy that deliberately requested a fraction was
            // executed at full size — observed 2026-08-21 20:54, where the strategy asked
            // for $341.68 and $1,004.94 was swapped. Harmless while every buy-back was
            // all-in; wrong the moment one was not.
            amount: tradeDecision.amount,
            tradeParams: { direction: 'buy', percentOfBalance: stratConfig.maxTradePercentage }
          }, marketData);

          results.push({ ...result, network: tradeDecision.network, reason: result.reason || tradeDecision.reason });
        } else {
          results.push({ success: true, action: 'hold', network: tradeDecision.network, reason: `Unknown dollar_maximizer action: ${tradeDecision.action}` });
        }
      }

      // Return combined result
      if (results.length === 1) return results[0];
      const successful = results.filter(r => r.success && r.action !== 'hold');
      return {
        success: results.some(r => r.success),
        action: 'trade',
        trades: results,
        reason: results.map(r => r.reason).filter(Boolean).join('; ') || undefined,
        summary: `Executed ${successful.length}/${results.length} trades across networks`
      };
    }

    // Persist strategy baselines and positions back to agent state so they survive restarts
    const persistedBaselines = {};
    const persistedPositions = {};
    for (const [network, netConfig] of Object.entries(networks)) {
      const pair = `${netConfig.symbol}/USD`;
      const baseline = dollarStrategy.getBaseline(network, pair, networkMode);
      if (baseline) {
        persistedBaselines[network] = baseline;
      }
      const position = dollarStrategy.getPosition(network);
      if (position) {
        persistedPositions[network] = position;
      }
    }

    await this.updateState({
      lastDecision: { action: 'hold', reason: 'dollar_maximizer: No opportunities', decisions: [], networkAnalysis, strategy: 'dollar_maximizer', timestamp: new Date() },
      priceBaselines: persistedBaselines,
      positions: persistedPositions
    });

    return {
      success: true, action: 'hold',
      reason: analyses.map(a => a.reason).filter(Boolean).join('; ') || 'No dollar maximizer opportunities',
      networkAnalysis
    };
  }

  /**
   * Execute Token Trader strategy
   * Trades a user-specified ERC20 token using regime-based logic
   */
  /**
   * v2.25.249: the majors' market regime for a network, from DollarMaximizer's
   * composite assessment (72h slope + trend strength + RSI, see assessMarketRegime).
   * Keys are `${networkMode}:${network}:${pair}`; a network has one major pair in
   * practice (BNB/USD on bsc, ETH/USD on ethereum) but the freshest entry wins if
   * several match. Returns { regime, score, confidence, updatedAt } or null — never
   * throws, because TokenTrader must keep trading when DM is absent or unconfigured.
   */
  _getMajorRegimeForNetwork(network, networkMode) {
    try {
      const dm = strategyRegistry.get('dollar_maximizer');
      const regimes = dm?.state?.marketRegime;
      if (!regimes || !network || !networkMode) return null;
      const prefix = `${networkMode}:${network}:`;
      let best = null;
      for (const [key, value] of Object.entries(regimes)) {
        if (!key.startsWith(prefix) || !value?.regime || !value?.updatedAt) continue;
        if (!best || new Date(value.updatedAt) > new Date(best.updatedAt)) best = value;
      }
      if (!best) return null;
      return { regime: best.regime, score: best.score, confidence: best.confidence, updatedAt: best.updatedAt };
    } catch (e) {
      logger.debug(`TokenTrader majors-regime lookup failed: ${e.message}`);
      return null;
    }
  }

  async executeTokenTrader(decision, marketData) {
    const config = this.getConfig();
    const state = this.getState();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';

    // Resolve token trader instance: from multi-instance map (by address) or fallback to base
    let tokenStrategy;
    if (decision.tokenAddress) {
      tokenStrategy = strategyRegistry.getTokenTrader(decision.tokenAddress);
      if (!tokenStrategy) {
        logger.warn(`TokenTrader instance not found for address: ${decision.tokenAddress}`);
        return { success: false, error: `TokenTrader instance not found for ${decision.tokenAddress}` };
      }
    } else {
      // Fallback: first instance from map, or base token_trader
      const allTraders = strategyRegistry.getAllTokenTraders();
      tokenStrategy = allTraders.size > 0
        ? allTraders.values().next().value
        : strategyRegistry.get('token_trader');
    }
    if (!tokenStrategy) {
      logger.warn('TokenTrader strategy not found in registry');
      return { success: false, error: 'TokenTrader strategy not found' };
    }

    if (!tokenStrategy.isConfigured()) {
      // Not configured — attempt auto-rotation to best watchlist candidate
      if (tokenStrategy.config.tokenWatchlist?.length > 0) {
        try {
          const watchlistPriceFetcher = async (addr, net) => {
            const pd = await this.fetchTokenPrice(addr, net, 18);
            if (!pd || pd.price <= 0) return { price: 0, change24h: 0, priceHistory: [], hasLiquidity: false, liquidityDepth: 0 };
            const hist = await this.fetchTokenPriceHistory(addr, net, 24);
            // Check actual liquidity across any available protocol (V2, V3, V4).
            // V2-only tokens (e.g. small-cap or early system tokens) are still
            // tradable — gate on "any pool has a quote", not "V3/V4 beats V2".
            let hasLiquidity = false, liquidityDepth = 0;
            const accumulate = (quotes) => {
              if (!quotes) return;
              for (const q of [quotes.v2, quotes.v3, quotes.v4]) {
                const out = parseFloat(q?.amountOut) || 0;
                if (out > 0) {
                  hasLiquidity = true;
                  liquidityDepth = Math.max(liquidityDepth, out * pd.price);
                }
              }
            };
            try {
              const stablecoins = swapService.getStablecoins(net);
              const stablecoinAddr = stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
              if (stablecoinAddr) {
                accumulate(await swapService.getQuotesByProtocol(stablecoinAddr, addr, '10', net));
              }
              if (!hasLiquidity) {
                accumulate(await swapService.getQuotesByProtocol('native', addr, '0.01', net));
              }
            } catch (e) { /* transient — leave hasLiquidity false */ }
            return { price: pd.price, change24h: pd?.change24h || 0, priceHistory: hist || [], hasLiquidity, liquidityDepth };
          };
          // evaluateWatchlist skips the active token (null here), so all watchlist tokens are candidates
          const candidate = await tokenStrategy.evaluateWatchlist(watchlistPriceFetcher);
          if (candidate) {
            logger.info(`TokenTrader: Not configured — auto-configuring ${candidate.symbol} from watchlist (score: ${candidate.score})`);
            tokenStrategy.configure({
              tokenAddress: candidate.address, tokenNetwork: candidate.network,
              tokenSymbol: candidate.symbol, tokenDecimals: candidate.decimals || 18
            });
          } else {
            // No candidates scored high enough — wait for better conditions
            return { success: true, action: 'hold', reason: 'Token trader not configured and no watchlist candidates scored above threshold' };
          }
        } catch (err) {
          logger.warn(`TokenTrader: Auto-configure from watchlist failed: ${err.message}`);
          return { success: true, action: 'hold', reason: 'Token trader not configured - use /strategy/token-trader/configure' };
        }
      } else {
        return { success: true, action: 'hold', reason: 'Token trader not configured - use /strategy/token-trader/configure' };
      }
    }

    const tokenAddress = tokenStrategy.config.tokenAddress;
    const tokenNetwork = tokenStrategy.config.tokenNetwork;
    const tokenSymbol = tokenStrategy.config.tokenSymbol;
    const tokenDecimals = tokenStrategy.config.tokenDecimals;

    // Fetch current token price
    const priceData = await this.fetchTokenPrice(tokenAddress, tokenNetwork, tokenDecimals);
    if (!priceData || priceData.price === 0) {
      return { success: false, error: `Could not fetch price for ${tokenSymbol} on ${tokenNetwork}` };
    }

    // Fetch price history for regime detection
    const priceHistory = await this.fetchTokenPriceHistory(tokenAddress, tokenNetwork, 24);
    if (priceHistory.length > 0) {
      // Merge new history into strategy state
      const existingTimestamps = new Set(tokenStrategy.state.tokenPriceHistory.map(p => p.timestamp));
      for (const point of priceHistory) {
        if (!existingTimestamps.has(point.timestamp)) {
          tokenStrategy.state.tokenPriceHistory.push(point);
        }
      }
      // Trim to last 288 points
      if (tokenStrategy.state.tokenPriceHistory.length > 288) {
        tokenStrategy.state.tokenPriceHistory = tokenStrategy.state.tokenPriceHistory.slice(-288);
      }
    }

    // Update stablecoin reserve from total portfolio value (native + stablecoins)
    // Use the network's configured stablecoin first (e.g., BUSD for BSC, USDC for ETH)
    const networkConfig = NETWORK_CONFIG[networkMode]?.[tokenNetwork];
    const stablecoins = swapService.getStablecoins(tokenNetwork);
    const stablecoinAddr = (networkConfig?.stablecoinAddress) || stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
    if (stablecoinAddr) {
      try {
        const wallet = await walletService.getWallet();
        const chainMap = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', base: 'base' };
        const chain = chainMap[tokenNetwork];
        const addrEntry = wallet?.addresses?.find(a => a.chain === chain);
        if (addrEntry) {
          const stableBalance = await contractServiceWrapper.getTokenBalance(stablecoinAddr, addrEntry.address, tokenNetwork);
          const totalStable = parseFloat(stableBalance.formatted) || 0;

          // Total capital on this network = liquid (native + stablecoins) + capital ALREADY
          // deployed into the token position. The position term is essential: buys (especially
          // native-funded ones) move value out of native/stable and INTO the token. Omitting it
          // made measured capital shrink as we deployed, so the % budget drifted down and the
          // deployed capital became invisible to the cap (the old per-cycle reset hack papered
          // over this). Including it keeps the budget stable regardless of funding source.
          const nativeBalance = parseFloat(marketData.balances?.[tokenNetwork]?.native) || 0;
          const nativePrice = marketData.prices?.[tokenNetwork]?.price || 0;
          // Exclude a gas reserve from deployable native: buys can be native-funded, so counting
          // the gas-reserve BNB/ETH as budget would let the trader spend the native it needs to
          // pay for its own swaps/sells. Mirrors the gas reserve dollar_maximizer keeps.
          // Deployable native excludes BOTH the gas reserve and any native that is
          // dollar_maximizer's open position. Counting a co-tenant's holding as this
          // trader's budget inflates every position size it derives from it, and is
          // the upstream half of the same shared-wallet confusion that let the buy
          // gates spend that position outright.
          const { available: deployableNative, dmOwned: dmOwnedNative, gasFloor: gasReserveNative } =
            this._getAvailableNativeForTokenTrader(tokenNetwork, nativeBalance);
          const nativeValue = deployableNative * nativePrice;
          const tokenPositionValue = (tokenStrategy.state.tokenBalance || 0) * (priceData?.price || 0);

          // Shared-pool accounting across ALL token-trader instances on this network. The liquid
          // (native+stable) pool is shared by every instance, so total capital must include EVERY
          // instance's deployed position — not just this one — and each instance gets its share of
          // the SAME base. Without this, each instance budgets against (liquid + only its own
          // position): N instances each see ~the full liquid pool and can collectively target
          // >100% of the wallet, racing to over-deploy.
          let allPositionsValue = 0;
          let sumAllocOnNet = 0;
          for (const [, inst] of strategyRegistry.getAllTokenTraders()) {
            if (inst?.config?.tokenNetwork !== tokenNetwork) continue;
            const instPrice = (inst === tokenStrategy) ? (priceData?.price || 0) : (parseFloat(inst.state?.lastPrice) || 0);
            allPositionsValue += (inst.state?.tokenBalance || 0) * instPrice;
            sumAllocOnNet += (inst.config?.capitalAllocationPercent || 20);
          }
          const totalCapital = nativeValue + totalStable + allPositionsValue;

          // budget = this instance's share of total capital; availableToDeploy = budget minus
          // what THIS instance already deployed. When instances oversubscribe the pool
          // (sum of allocations > 100%), normalize proportionally so the combined target never
          // exceeds the wallet (the configure endpoint also rejects sums >100 up front).
          const capitalAlloc = tokenStrategy.config.capitalAllocationPercent || 20;
          const allocFraction = sumAllocOnNet > 100 ? (capitalAlloc / sumAllocOnNet) : (capitalAlloc / 100);
          const budget = totalCapital * allocFraction;
          const deployed = tokenPositionValue;
          const availableToDeploy = Math.max(0, budget - deployed);
          // Update reserve if entering, empty, or available-to-deploy changed by >10% (picks up new deposits sooner)
          const currentReserve = tokenStrategy.state.stablecoinReserve || 0;
          const reserveDiff = Math.abs(availableToDeploy - currentReserve);
          const shouldUpdate = tokenStrategy.state.regime === 'ENTERING' || currentReserve <= 0 || reserveDiff > Math.max(1, currentReserve * 0.1);
          if (shouldUpdate) {
            tokenStrategy.setStablecoinReserve(availableToDeploy);
            const allocStr = sumAllocOnNet > 100 ? `${capitalAlloc}/${sumAllocOnNet}% (normalized)` : `${capitalAlloc}%`;
            logger.info(`TokenTrader: Set available-to-deploy to $${availableToDeploy.toFixed(2)} (budget $${budget.toFixed(2)} = ${allocStr} of $${totalCapital.toFixed(2)} total [${deployableNative.toFixed(4)} native (of ${nativeBalance.toFixed(4)}, ${gasReserveNative} gas-reserved, ${dmOwnedNative.toFixed(4)} dollar_maximizer) @ $${nativePrice.toFixed(2)} + $${totalStable.toFixed(2)} stable + $${allPositionsValue.toFixed(2)} all-positions] − $${deployed.toFixed(2)} this-deployed)`);
          }
        }
      } catch (err) {
        logger.warn(`TokenTrader: Could not fetch stablecoin balance: ${err.message}`);
      }
    }

    // Also update token balance from on-chain
    try {
      const wallet = await walletService.getWallet();
      const chainMap = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', base: 'base' };
      const chain = chainMap[tokenNetwork];
      const addrEntry = wallet?.addresses?.find(a => a.chain === chain);
      if (addrEntry) {
        const tokenBalance = await contractServiceWrapper.getTokenBalance(tokenAddress, addrEntry.address, tokenNetwork);
        const actualBalance = parseFloat(tokenBalance.formatted) || 0;
        if (Math.abs(actualBalance - tokenStrategy.state.tokenBalance) > 0.001) {
          const oldBalance = tokenStrategy.state.tokenBalance;
          const diff = actualBalance - oldBalance;
          logger.info(`TokenTrader: Syncing token balance from ${oldBalance} to ${actualBalance}`);

          // If wallet has MORE tokens than tracked, estimate cost basis at current market price
          // to prevent inflated PnL from "free" tokens.
          // Guard: only reconcile if the diff is ≤ 2x current balance (catches swap rounding/slippage).
          // Larger discrepancies (airdrops, manual transfers) are logged but not added to cost basis.
          if (diff > 0 && priceData?.price > 0) {
            const estimatedCost = diff * priceData.price;
            const isReasonableDiff = oldBalance <= 0 || diff <= oldBalance * 2;
            if (isReasonableDiff) {
              tokenStrategy.state.totalInvested = (tokenStrategy.state.totalInvested || 0) + estimatedCost;
              // Use weighted average (existing position value + new cost) / total balance
              // NOT totalInvested/balance — totalInvested is cumulative and includes sold tokens
              if (actualBalance > 0) {
                const existingValue = oldBalance * (tokenStrategy.state.averageEntryPrice || 0);
                tokenStrategy.state.averageEntryPrice = (existingValue + estimatedCost) / actualBalance;
              }
              logger.info(`TokenTrader: Reconciled +${diff.toFixed(4)} tokens at $${priceData.price.toFixed(6)} — added $${estimatedCost.toFixed(2)} to cost basis (avg entry: $${tokenStrategy.state.averageEntryPrice.toFixed(6)})`);
            } else {
              logger.warn(`TokenTrader: Large unexpected token increase +${diff.toFixed(4)} (was ${oldBalance.toFixed(4)}) — likely airdrop/transfer, NOT adding to cost basis`);
            }
          } else if (diff < 0 && oldBalance > 0) {
            // Wallet has FEWER tokens than tracked with no recorded sell (transfer tax skim,
            // honeypot, external move). Previously this silently set tokenBalance lower, leaving
            // the vanished tokens' cost basis embedded in averageEntryPrice over a smaller
            // position — so the loss was never realized and PnL stayed optimistic. Book the lost
            // tokens as a realized loss at cost (avg entry). averageEntryPrice (per-token) is
            // unchanged; only the count and realized PnL move.
            const lostTokens = -diff;
            const avgEntry = tokenStrategy.state.averageEntryPrice || 0;
            const realizedLoss = lostTokens * avgEntry;
            tokenStrategy.state.realizedPnL = (tokenStrategy.state.realizedPnL || 0) - realizedLoss;
            logger.warn(`TokenTrader: Token balance DECREASED ${oldBalance.toFixed(4)} → ${actualBalance.toFixed(4)} with no recorded sell (tax/skim/transfer) — booking realized loss $${realizedLoss.toFixed(2)} (${lostTokens.toFixed(4)} @ $${avgEntry.toFixed(6)})`);
          }

          tokenStrategy.state.tokenBalance = actualBalance;
        }
      }
    } catch (err) {
      logger.debug(`TokenTrader: Could not fetch token balance: ${err.message}`);
    }

    // Price fetcher for watchlist evaluation (combines price + 24h change + liquidity + history)
    const watchlistPriceFetcher = async (address, network) => {
      const pd = await this.fetchTokenPrice(address, network);
      if (!pd || pd.price <= 0) return null;
      let change24h = 0;
      let priceHistory = [];
      try {
        const history = await this.fetchTokenPriceHistory(address, network, 24);
        priceHistory = history || [];
        if (history.length >= 2) {
          const oldest = history[0].price;
          if (oldest > 0) change24h = ((pd.price - oldest) / oldest) * 100;
        }
      } catch (e) { /* ignore */ }
      // Check liquidity across any available protocol (V2, V3, V4). V2-only
      // tokens (e.g. small-cap or early system tokens like SKYNET) are still
      // tradable — gate on "any pool has a quote", not "V3/V4 beats V2".
      // Return hasLiquidity flag instead of null so the caller can apply
      // fail-count policy instead of instant removal.
      let hasLiquidity = false;
      let liquidityDepth = 0;
      let liquidityPaths = 0;
      const accumulate = (quotes) => {
        if (!quotes) return;
        for (const q of [quotes.v2, quotes.v3, quotes.v4]) {
          const out = parseFloat(q?.amountOut) || 0;
          if (out > 0) {
            hasLiquidity = true;
            liquidityPaths++;
            liquidityDepth = Math.max(liquidityDepth, out * pd.price);
          }
        }
      };
      try {
        const stablecoins = swapService.getStablecoins(network);
        const stablecoinAddr = stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
        if (stablecoinAddr) {
          accumulate(await swapService.getQuotesByProtocol(stablecoinAddr, address, '10', network));
        }
        if (!hasLiquidity) {
          // Try native→token path (e.g., WBNB→SKYNET)
          accumulate(await swapService.getQuotesByProtocol('native', address, '0.01', network));
        }
        if (!hasLiquidity) {
          logger.debug(`Watchlist: ${address} on ${network} has no liquidity in any V2/V3/V4 pool`);
        }
      } catch (e) {
        logger.debug(`Watchlist: ${address} liquidity check failed: ${e.message}`);
        // Transient error — return data without liquidity info so caller doesn't penalize
        return { price: pd.price, change24h, priceHistory, hasLiquidity: false, liquidityDepth: 0, liquidityPaths: 0, fetchError: true };
      }
      return { price: pd.price, change24h, priceHistory, hasLiquidity, liquidityDepth, liquidityPaths };
    };

    // Run analysis
    const tokenMarketData = {
      tokenPrice: priceData.price,
      prices: marketData.prices,
      // v2.25.249: majors' composite regime for this token's network (BNB for bsc,
      // ETH for ethereum), read from DollarMaximizer's assessment. TokenTrader only
      // sees its own token, so without this it grid-bought through a week the whole
      // market spent in a downtrend. Null when DM has no fresh reading — the
      // strategy's freshness check disables the widening in that case.
      majorRegime: this._getMajorRegimeForNetwork(tokenNetwork, networkMode)
    };

    const analysis = await tokenStrategy.analyze(
      tokenMarketData, { balances: marketData.balances }, tokenNetwork, networkMode,
      { symbol: tokenSymbol, address: tokenAddress, decimals: tokenDecimals }
    );

    // Update state for display (keyed by token address for multi-token support)
    // Only keep keys that are still active in the registry
    const existingTTStatus = state.tokenTraderStatus || {};
    const activeAddrs = strategyRegistry.getAllTokenTraders();
    const updatedTTStatus = {};
    for (const [k, v] of Object.entries(existingTTStatus)) {
      if (k.startsWith('0x') && activeAddrs.has(k)) updatedTTStatus[k] = v;
    }
    updatedTTStatus[tokenAddress.toLowerCase()] = {
      ...tokenStrategy.getTokenTraderStatus(),
      lastPrice: priceData.price,
      lastPriceSource: priceData.source,
      lastAnalysis: new Date().toISOString()
    };
    await this.updateState({ tokenTraderStatus: updatedTTStatus });

    // Check for pending manual exit — bypass analysis pipeline and sell immediately
    let tradeDecision;
    if (tokenStrategy.state.pendingManualExit) {
      logger.info(`TokenTrader [${tokenSymbol}]: Manual exit requested — bypassing analysis, selling all ${tokenStrategy.state.tokenBalance} tokens`);
      tokenStrategy.state.pendingManualExit = false;

      // If token balance is dust (< $1), skip the sell and configure rotation target directly
      const exitHoldingValue = tokenStrategy.state.tokenBalance * priceData.price;
      if (exitHoldingValue < 1 && tokenStrategy.state._pendingRotation) {
        const rot = tokenStrategy.state._pendingRotation;
        logger.info(`TokenTrader: Holdings worth $${exitHoldingValue.toFixed(4)} (dust) — skipping sell, configuring ${rot.symbol} directly`);
        tokenStrategy.configure({
          tokenAddress: rot.address, tokenNetwork: rot.network,
          tokenSymbol: rot.symbol, tokenDecimals: rot.decimals || 18,
          _preserveBreaker: true
        });
        tokenStrategy.state._watchlistRotation = true;
        delete tokenStrategy.state._pendingRotation;
        return {
          success: true, action: 'watchlist_rotate',
          reason: `Dust position ($${exitHoldingValue.toFixed(4)}) — rotated to ${rot.symbol}`,
          regime: 'ENTERING', newToken: rot.symbol
        };
      }

      tradeDecision = {
        strategy: 'token_trader',
        network: tokenNetwork,
        action: 'sell_token',
        amountToken: tokenStrategy.state.tokenBalance,
        reason: 'Manual exit requested',
        confidence: 1.0,
        sellAll: true,
        isManualExit: true
      };
    } else if (!analysis.opportunity) {
      // During circuit breaker or cooldown, evaluate watchlist for token rotation
      // Skip rotation for user-configured tokens — they stay on their assigned token
      if ((analysis.regime === 'CIRCUIT_BREAKER' || analysis.regime === 'COOLDOWN')
          && tokenStrategy.config.tokenWatchlist?.length > 0
          && !tokenStrategy.config.userConfigured) {
        try {
          const candidate = await tokenStrategy.evaluateWatchlist(watchlistPriceFetcher);
          if (candidate) {
            logger.info(`TokenTrader: Watchlist rotation — switching from ${tokenSymbol} to ${candidate.symbol} (score: ${candidate.score}, momentum: ${candidate.momentum >= 0 ? '+' : ''}${candidate.momentum.toFixed(1)}%)`);

            // Sell remaining tokens first if value is worth the gas fees (>$1 dust threshold)
            const holdingValue = tokenStrategy.state.tokenBalance * priceData.price;
            if (holdingValue > 1) {
              tokenStrategy.state.pendingManualExit = true;
              // Store rotation candidate in state so it persists across cycles
              tokenStrategy.state._pendingRotation = {
                address: candidate.address, network: candidate.network,
                symbol: candidate.symbol, decimals: candidate.decimals
              };
              return {
                success: true, action: 'watchlist_exit',
                reason: `Rotating to ${candidate.symbol} — selling ${tokenSymbol} first ($${holdingValue.toFixed(2)} held)`,
                regime: analysis.regime, price: priceData.price,
                pendingRotation: tokenStrategy.state._pendingRotation
              };
            }

            // No tokens held (or dust not worth selling) — configure new token immediately
            // Preserve breaker state so consecutive stop-losses carry forward
            tokenStrategy.configure({
              tokenAddress: candidate.address, tokenNetwork: candidate.network,
              tokenSymbol: candidate.symbol, tokenDecimals: candidate.decimals || 18,
              _preserveBreaker: true
            });
            // Flag watchlist rotation so initial buy uses smaller position (25% of reserve)
            tokenStrategy.state._watchlistRotation = true;
            return {
              success: true, action: 'watchlist_rotate',
              reason: `Rotated from ${tokenSymbol} to ${candidate.symbol} (score: ${candidate.score}, ${candidate.momentum >= 0 ? '+' : ''}${candidate.momentum.toFixed(1)}%)`,
              regime: 'ENTERING', price: candidate.price, newToken: candidate.symbol
            };
          }
        } catch (wlErr) {
          logger.warn(`TokenTrader watchlist evaluation error: ${wlErr.message}`);
        }
      }

      logger.info(`TokenTrader [${tokenSymbol}]: ${analysis.regime} - ${analysis.reason || 'no opportunity'}`);
      return {
        success: true, action: 'hold',
        reason: analysis.reason || `${analysis.regime}: No action needed`,
        regime: analysis.regime, price: priceData.price
      };
    } else {
      // Get trade decisions from analysis
      const decisions = await tokenStrategy.decide([analysis], { balances: marketData.balances });
      if (decisions.length === 0) {
        return { success: true, action: 'hold', reason: 'No actionable decisions', regime: analysis.regime };
      }
      tradeDecision = decisions[0];
    }
    logger.info(`TokenTrader executing: ${tradeDecision.action} on ${tokenNetwork} - ${tradeDecision.reason}`);

    // Execute the trade — force V3 for token_trader (V2 has catastrophic liquidity for small-cap tokens)
    // Manual exits allow V2 fallback since user explicitly requested the sell
    const isUrgentSell = tradeDecision.isEmergency || tradeDecision.isStopLoss || tradeDecision.isTrailingStop || tradeDecision.sellAll;
    const swapOptions = {
      tokenTaxPercent: tokenStrategy.config.tokenTaxPercent || 0,
      maxSlippage: Math.max(tokenStrategy.config.maxSlippage || 5, 10),
      enableRetry: tokenStrategy.config.enableRetry,
      maxRetries: tokenStrategy.config.maxRetries,
      gasCheck: true,
      forceV3: !tradeDecision.isManualExit,
      urgent: isUrgentSell  // Skip CoW Protocol for stop-loss/trailing-stop/emergency (needs instant execution)
    };

    // Maximum acceptable price impact (%) - protects against thin liquidity pools
    const MAX_PRICE_IMPACT_PCT = 10;

    try {
      if (tradeDecision.action === 'buy_token') {
        // Buy token with stablecoins
        const buyAmount = tradeDecision.amountStablecoin;
        if (buyAmount <= 0) {
          return { success: false, error: 'No stablecoins available for buy' };
        }

        // Estimate gas cost in USD for profitability check
        let estimatedGasCostUsd = 0;
        try {
          const { ethers } = await import('ethers');
          const provider = await contractServiceWrapper.getProvider(tokenNetwork);
          const feeData = await provider.getFeeData();
          const gasPrice = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
          const gasCostWei = gasPrice * BigInt(250000);
          const gasCostNativeEst = parseFloat(ethers.formatEther(gasCostWei));
          const nativePriceUsd = marketData.prices?.[tokenNetwork]?.price || 0;
          estimatedGasCostUsd = gasCostNativeEst * nativePriceUsd;
        } catch (gasErr) {
          logger.warn(`TokenTrader: Gas estimate failed (proceeding): ${gasErr.message}`);
        }

        // Minimum $1 USD net trade value after gas
        const netBuyValue = buyAmount - estimatedGasCostUsd;
        if (netBuyValue < 1) {
          logger.info(`TokenTrader: Buy skipped - net value $${netBuyValue.toFixed(2)} after gas ($${estimatedGasCostUsd.toFixed(4)}) below $1 minimum`);
          return { success: false, error: `Net trade value $${netBuyValue.toFixed(2)} after gas below $1 minimum` };
        }

        // Determine best buy path: try both stablecoin and native routes, pick lowest impact
        // Many BSC tokens are paired with WBNB, so native→token (1 hop) is often better than
        // stablecoin→WBNB→token (2 hops with more slippage)
        let swapFromToken = stablecoinAddr;
        let swapAmount = buyAmount.toString();
        let usedNative = false;

        // Check stablecoin balance first — if insufficient, we must use native anyway
        try {
          const { ethers } = await import('ethers');
          const provider = await contractServiceWrapper.getProvider(tokenNetwork);
          const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
          const stableContract = new ethers.Contract(stablecoinAddr, erc20Abi, provider);
          const wallet = await walletService.getWallet();
          const chainMap = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', base: 'base' };
          const walletAddress = wallet?.addresses?.find(a => a.chain === chainMap[tokenNetwork])?.address;
          if (walletAddress) {
            const stableDecimals = await stableContract.decimals();
            const actualStableBal = parseFloat(ethers.formatUnits(await stableContract.balanceOf(walletAddress), stableDecimals));
            if (actualStableBal < buyAmount) {
              const nativePrice = marketData.prices?.[tokenNetwork]?.price || 0;
              if (nativePrice > 0) {
                // Native balance lives at marketData.balances[network].native, not on prices.
                // Reading from .prices was always 0, so this branch never approved a switch
                // — the price-impact branch below would override regardless without checking.
                const nativeBalance = parseFloat(marketData.balances?.[tokenNetwork]?.native || 0);
                const nativeEquivalent = parseFloat((buyAmount / nativePrice).toFixed(6));
                // Only what TokenTrader actually owns — never DollarMaximizer's leg.
                const { available: maxNativeAvailable, dmOwned, gasFloor } =
                  this._getAvailableNativeForTokenTrader(tokenNetwork, nativeBalance);

                if (nativeEquivalent <= maxNativeAvailable) {
                  logger.info(`TokenTrader: Insufficient stablecoins ($${actualStableBal.toFixed(2)} < $${buyAmount.toFixed(2)}), using ${nativeEquivalent} native ($${buyAmount.toFixed(2)} worth, ${maxNativeAvailable.toFixed(6)} available after ${gasFloor} gas floor and ${dmOwned.toFixed(6)} owned by dollar_maximizer)`);
                  swapFromToken = 'native';
                  swapAmount = nativeEquivalent.toFixed(6);
                  usedNative = true;
                } else {
                  logger.warn(`TokenTrader: Insufficient own native for buy (need ${nativeEquivalent}, available ${maxNativeAvailable.toFixed(6)} of ${nativeBalance.toFixed(6)} wallet — ${gasFloor} gas floor, ${dmOwned.toFixed(6)} owned by dollar_maximizer)`);
                }
              }
            }
          }
        } catch (err) {
          logger.warn(`TokenTrader: Could not check stablecoin balance for buy, using stablecoin path: ${err.message}`);
        }

        // Pre-swap price impact check — try both stablecoin and native paths, use whichever is better
        if (priceData.price > 0) {
          try {
            const nativePrice = marketData.prices?.[tokenNetwork]?.price || 0;

            // Quote via stablecoin path
            let stableImpactPct = Infinity;
            let stableQuotedTokens = 0;
            try {
              const stableQuote = await swapService.getQuote(stablecoinAddr, tokenAddress, buyAmount.toString(), tokenNetwork);
              stableQuotedTokens = parseFloat(stableQuote.amountOut) || 0;
              if (stableQuotedTokens > 0) {
                const effectivePrice = buyAmount / stableQuotedTokens;
                stableImpactPct = ((effectivePrice - priceData.price) / priceData.price) * 100;
              }
            } catch { /* no stablecoin path */ }

            // Quote via native path (WBNB/WETH → token, often 1-hop with better liquidity)
            let nativeImpactPct = Infinity;
            let nativeQuotedTokens = 0;
            let nativeEquivalent = '0';
            if (nativePrice > 0) {
              try {
                nativeEquivalent = (buyAmount / nativePrice).toFixed(6);
                const nativeQuote = await swapService.getQuote('native', tokenAddress, nativeEquivalent, tokenNetwork);
                nativeQuotedTokens = parseFloat(nativeQuote.amountOut) || 0;
                if (nativeQuotedTokens > 0) {
                  const effectivePrice = buyAmount / nativeQuotedTokens;
                  nativeImpactPct = ((effectivePrice - priceData.price) / priceData.price) * 100;
                }
              } catch { /* no native path */ }
            }

            // Pick the path with lower price impact
            const bestImpact = Math.min(stableImpactPct, nativeImpactPct);
            const bestPath = nativeImpactPct < stableImpactPct ? 'native' : 'stablecoin';

            if (bestImpact !== Infinity) {
              if (bestPath === 'native' && !usedNative) {
                // Native path has better liquidity — but only switch if the wallet
                // actually holds enough native for swap + gas. Without this gate,
                // we'd dispatch a swap for amount X when the wallet has << X
                // (the chain rejects with INSUFFICIENT_FUNDS — the original bug).
                const actualNative = parseFloat(marketData.balances?.[tokenNetwork]?.native || 0);
                const requiredNative = parseFloat(nativeEquivalent) || 0;
                // Spend only TokenTrader's own native. This gate reading the whole
                // wallet is what let it consume DollarMaximizer's BNB position.
                const { available: availableNative, dmOwned, gasFloor } =
                  this._getAvailableNativeForTokenTrader(tokenNetwork, actualNative);
                if (requiredNative > 0 && requiredNative <= availableNative) {
                  logger.info(`TokenTrader: Native path has lower impact (${nativeImpactPct.toFixed(1)}%) vs stablecoin (${stableImpactPct === Infinity ? 'no path' : stableImpactPct.toFixed(1) + '%'}) — using native (${availableNative.toFixed(6)} available)`);
                  swapFromToken = 'native';
                  swapAmount = nativeEquivalent;
                  usedNative = true;
                } else if (stableImpactPct !== Infinity) {
                  logger.info(`TokenTrader: Native path lower impact (${nativeImpactPct.toFixed(1)}%) but only ${availableNative.toFixed(6)} native available for it (need ${requiredNative.toFixed(6)}; wallet ${actualNative.toFixed(6)}, ${gasFloor} gas floor, ${dmOwned.toFixed(6)} owned by dollar_maximizer) — falling back to stablecoin path`);
                } else {
                  logger.warn(`TokenTrader: Native path lower impact but insufficient own native AND no stablecoin path — buy will likely fail`);
                }
              }

              if (bestImpact > MAX_PRICE_IMPACT_PCT) {
                const bestTokens = bestPath === 'native' ? nativeQuotedTokens : stableQuotedTokens;
                const effectiveBuyPrice = bestTokens > 0 ? buyAmount / bestTokens : 0;
                logger.warn(`TokenTrader: Buy aborted - ${bestImpact.toFixed(1)}% price impact exceeds ${MAX_PRICE_IMPACT_PCT}% limit (best path: ${bestPath}). Effective: $${effectiveBuyPrice.toFixed(6)}/token, spot: $${priceData.price.toFixed(6)}/token`);
                return { success: false, error: `Price impact too high: ${bestImpact.toFixed(1)}% via ${bestPath} (limit: ${MAX_PRICE_IMPACT_PCT}%)` };
              }

              const bestTokens = bestPath === 'native' ? nativeQuotedTokens : stableQuotedTokens;
              const effectiveBuyPrice = bestTokens > 0 ? buyAmount / bestTokens : 0;
              logger.info(`TokenTrader: Buy price impact: ${bestImpact.toFixed(1)}% via ${bestPath} (effective: $${effectiveBuyPrice.toFixed(6)}, spot: $${priceData.price.toFixed(6)})`);
            }
          } catch (quoteErr) {
            logger.warn(`TokenTrader: Could not check buy price impact: ${quoteErr.message}`);
          }
        }

        // Size invariant. buyAmount comes straight off the decision, but swapAmount is
        // re-derived when the native route wins — so the USD actually leaving the wallet can
        // drift from what was decided. Check the USD equivalent, not the raw units.
        {
          const nativePx = marketData.prices?.[tokenNetwork]?.price || 0;
          const spendUsd = usedNative && nativePx > 0 ? parseFloat(swapAmount) * nativePx : buyAmount;
          const allowedUsd = await this.enforceTradeSize({
            label: 'buy', network: tokenNetwork, decided: tradeDecision.amountStablecoin,
            actual: spendUsd, unit: 'USD'
          });
          if (allowedUsd < spendUsd && usedNative && nativePx > 0) {
            swapAmount = (allowedUsd / nativePx).toFixed(6);
          } else if (allowedUsd < spendUsd) {
            swapAmount = allowedUsd.toString();
          }
        }

        logger.info(`TokenTrader: Buying ${tokenSymbol} with ${usedNative ? swapAmount + ' native' : '$' + buyAmount.toFixed(2) + ' stablecoin'} (~$${buyAmount.toFixed(2)})`);

        // expectedOutputUsd is compared against raw swap output (in token units for buys)
        // Convert from USD to expected token count so the sanity check compares like-for-like
        swapOptions.expectedOutputUsd = priceData.price > 0 ? buyAmount / priceData.price : 0;
        const swapResult = await swapService.swap(
          swapFromToken,
          tokenAddress,
          swapAmount,
          swapOptions.maxSlippage,
          tokenNetwork,
          swapOptions
        );

        if (swapResult.success) {
          const tokenReceived = parseFloat(swapResult.expectedOut) || 0;
          if (tokenReceived <= 0) {
            logger.error(`TokenTrader: BUY swap reported success but tokenReceived=${tokenReceived} — skipping recordBuy to prevent state corruption`);
            return { success: false, error: 'Swap returned 0 tokens despite success flag' };
          }
          // Convert actual gas cost from native to USD
          const nativePriceForGas = marketData.prices?.[tokenNetwork]?.price || 0;
          const actualGasCostUsd = (swapResult.gasCostNative || 0) * nativePriceForGas;
          // Use actual execution price (amount spent / tokens received), not theoretical quote
          const effectivePrice = tokenReceived > 0 ? buyAmount / tokenReceived : priceData.price;
          // Record funding source so the ledger tracks native- vs stablecoin-funded buys.
          // swapAmount is the native (BNB/ETH) amount when usedNative, else the stablecoin path was used.
          tokenStrategy.recordBuy(buyAmount, tokenReceived, effectivePrice, actualGasCostUsd, tradeDecision, {
            usedNative,
            nativeSpent: usedNative ? swapAmount : 0
          });

          // Update grid trade timestamp if applicable
          if (tradeDecision.isGrid) {
            tokenStrategy.state.lastGridTrade = new Date().toISOString();
          }
          if (tradeDecision.isDip) {
            tokenStrategy.state.lastDipBuy = new Date().toISOString();
          }

          await this.notifySwap({
            action: tradeDecision.isInitialBuy ? 'token_trader_initial_buy' : 'token_trader_buy',
            network: tokenNetwork,
            amountIn: buyAmount,
            amountOut: tokenReceived,
            symbolIn: 'USDT',
            symbolOut: tokenSymbol,
            txHash: swapResult.hash,
            strategy: 'token_trader'
          });

          // Refresh DM position after TT buy changed wallet balance
          await this._refreshDMPositionAfterTrade(tokenNetwork);

          return {
            success: true,
            action: 'buy_token',
            network: tokenNetwork,
            amountUSD: buyAmount,
            amount: buyAmount,
            received: tokenReceived,
            regime: tokenStrategy.state.regime,
            txHash: swapResult.hash,
            reason: `Bought ${tokenReceived.toFixed(2)} ${tokenSymbol} for $${buyAmount.toFixed(2)}`
          };
        }

        return { success: false, error: swapResult.error || 'Buy swap failed' };

      } else if (tradeDecision.action === 'sell_token') {
        // Sell token for stablecoins
        // `let`, not `const`: the size invariant below clamps this before the swap.
        let sellAmount = tradeDecision.amountToken;
        if (sellAmount <= 0) {
          return { success: false, error: 'No tokens to sell' };
        }

        // Pre-swap price impact check + minimum $1 USD trade value
        if (priceData.price > 0) {
          // Quick USD estimate before quote
          const estimatedUsdValue = sellAmount * priceData.price;
          if (estimatedUsdValue < 1) {
            logger.info(`TokenTrader: Sell skipped - estimated value $${estimatedUsdValue.toFixed(2)} below $1 minimum`);
            return { success: false, error: `Trade value $${estimatedUsdValue.toFixed(2)} below $1 minimum` };
          }

          try {
            const quote = await swapService.getQuote(tokenAddress, stablecoinAddr, sellAmount.toString(), tokenNetwork);
            const quotedStable = parseFloat(quote.amountOut);
            if (quotedStable > 0) {
              // Minimum $1 USD from quote
              if (quotedStable < 1) {
                logger.info(`TokenTrader: Sell skipped - quoted value $${quotedStable.toFixed(2)} below $1 minimum`);
                return { success: false, error: `Trade value $${quotedStable.toFixed(2)} below $1 minimum` };
              }
              const effectiveSellPrice = quotedStable / sellAmount;
              const priceImpactPct = ((priceData.price - effectiveSellPrice) / priceData.price) * 100;
              if (priceImpactPct > MAX_PRICE_IMPACT_PCT) {
                logger.warn(`TokenTrader: Sell aborted - ${priceImpactPct.toFixed(1)}% price impact exceeds ${MAX_PRICE_IMPACT_PCT}% limit. Effective: $${effectiveSellPrice.toFixed(6)}/token, spot: $${priceData.price.toFixed(6)}/token`);
                // If this is a manual exit for watchlist rotation, the token is unsellable due to liquidity.
                // Abandon the position and rotate to the pending target instead of getting stuck.
                if (tradeDecision.isManualExit && tokenStrategy.state._pendingRotation) {
                  const rot = tokenStrategy.state._pendingRotation;
                  logger.info(`TokenTrader: ${tokenSymbol} unsellable (${priceImpactPct.toFixed(1)}% impact) — abandoning position, rotating to ${rot.symbol}`);
                  tokenStrategy.configure({
                    tokenAddress: rot.address, tokenNetwork: rot.network,
                    tokenSymbol: rot.symbol, tokenDecimals: rot.decimals || 18,
                    _preserveBreaker: true
                  });
                  tokenStrategy.state._watchlistRotation = true;
                  delete tokenStrategy.state._pendingRotation;
                  return {
                    success: true, action: 'watchlist_rotate',
                    reason: `Abandoned unsellable ${tokenSymbol} (${priceImpactPct.toFixed(0)}% price impact), rotated to ${rot.symbol}`,
                    regime: 'ENTERING', newToken: rot.symbol
                  };
                }
                return { success: false, error: `Price impact too high: ${priceImpactPct.toFixed(1)}% (limit: ${MAX_PRICE_IMPACT_PCT}%)` };
              }
              logger.info(`TokenTrader: Sell price impact: ${priceImpactPct.toFixed(1)}% (effective: $${effectiveSellPrice.toFixed(6)}, spot: $${priceData.price.toFixed(6)})`);
              // Pass expected output for swap sanity check
              swapOptions.expectedOutputUsd = quotedStable;
            }
          } catch (quoteErr) {
            logger.warn(`TokenTrader: Could not check sell price impact: ${quoteErr.message}`);
            // Fallback: use spot price estimate so sanity check still has a baseline
            swapOptions.expectedOutputUsd = sellAmount * priceData.price;
            logger.info(`TokenTrader: Using spot-price estimate for sanity check: $${swapOptions.expectedOutputUsd.toFixed(2)}`);
          }
        }

        // Final safety net: ensure expectedOutputUsd is ALWAYS set before any sell
        if (!swapOptions.expectedOutputUsd && priceData.price > 0) {
          swapOptions.expectedOutputUsd = sellAmount * priceData.price;
          logger.info(`TokenTrader: Setting fallback expectedOutputUsd from spot: $${swapOptions.expectedOutputUsd.toFixed(2)}`);
        }

        // Last resort: use averageEntryPrice if spot price is unavailable
        if (!swapOptions.expectedOutputUsd && tokenStrategy.state.averageEntryPrice > 0) {
          swapOptions.expectedOutputUsd = sellAmount * tokenStrategy.state.averageEntryPrice;
          logger.warn(`TokenTrader: Spot price unavailable — using entry price $${tokenStrategy.state.averageEntryPrice.toFixed(6)} for sanity check (expectedOutputUsd=$${swapOptions.expectedOutputUsd.toFixed(2)})`);
        }

        // Absolute last resort: refuse to sell without ANY price reference
        if (!swapOptions.expectedOutputUsd) {
          logger.error(`TokenTrader: SELL ABORTED — no price data available (spot=0, entryPrice=0). Cannot safely execute without sanity check.`);
          return { success: false, error: 'Sell aborted: no price reference for sanity check' };
        }

        // Gas profitability check for non-emergency sells
        // Emergency/stop-loss sells bypass — capital preservation > gas cost
        // Belt-and-braces: any loss-cutting exit bypasses the profit floor, whatever
        // flag the caller happened to set. A stop-loss is unprofitable BY DEFINITION —
        // gating one on expected profit makes it unfireable exactly when it is needed,
        // which is how a trailing stop came to veto itself three times in a row on
        // 2026-08-05. isTrailingStop/isStopLossTranche are listed explicitly so a future
        // exit path that forgets isEmergency still cannot be talked out of cutting a loss.
        const isEmergencySell = tradeDecision.isEmergency || tradeDecision.sellAll
          || tradeDecision.isStopLoss || tradeDecision.isTrailingStop
          || tradeDecision.isTrailingStopTranche || tradeDecision.isStopLossTranche;
        if (!isEmergencySell) {
          try {
            const { ethers } = await import('ethers');
            const provider = await contractServiceWrapper.getProvider(tokenNetwork);
            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
            const gasCostWei = gasPrice * BigInt(250000);
            const gasCostNativeEst = parseFloat(ethers.formatEther(gasCostWei));
            const nativePriceUsd = marketData.prices?.[tokenNetwork]?.price || 0;
            const sellGasCostUsd = gasCostNativeEst * nativePriceUsd;

            // Tranche scalps sell a specific lot — profit must be judged against that
            // lot's own basis, not the blended average. In a basis-above-range bag the
            // average sits above every scalpable lot by construction, so using it here
            // vetoed 100% of tranche sells (the exact trades the feature exists for).
            const basisPrice = (tradeDecision.isTrancheSell && tradeDecision.lotPrice > 0)
              ? tradeDecision.lotPrice
              : tokenStrategy.state.averageEntryPrice;
            const costBasis = sellAmount * basisPrice;
            const expectedOutput = swapOptions.expectedOutputUsd || (sellAmount * priceData.price);
            const expectedNetProfit = expectedOutput - costBasis - sellGasCostUsd;

            // Grid sells must clear their own COSTS, not an arbitrary share of notional.
            //
            // The previous max($0.10, 1% of output) refused profitable trades at both
            // ends, because neither term tracked a real cost. Measured on BSC 2026-08:
            // gas is $0.0076 a sell, so a $3.22 slice returning $0.061 net — eight times
            // gas — was refused by the flat $0.10 floor, while a $1474 position holding
            // $7.69 of profit (a thousand times gas) was refused by the 1% rule needing
            // $14.74. Four days passed with grid buys firing and no grid sell clearing,
            // which is what drained the reserve into a bag that could only grow.
            //
            // The two costs that are actually incurred:
            //   - gas, which is fixed per transaction and already deducted from
            //     expectedNetProfit; require a multiple of it so a trade is worth doing.
            //   - the DEX fee and price impact, which are NOT in expectedOutput: that is
            //     `usdValue || amount × spot`, a spot estimate rather than a routed quote.
            //     Observed fee tiers on these pools top out at 0.30%, so 0.4% covers the
            //     worst tier plus slippage.
            // Both scale correctly: a tiny slice is refused because gas dominates it, a
            // large one clears because its costs are genuinely a small share of proceeds.
            const minProfit = tradeDecision.isGrid
              ? Math.max(3 * sellGasCostUsd, expectedOutput * 0.004)
              : 1.0;
            if (expectedNetProfit < minProfit) {
              logger.info(`TokenTrader: Sell skipped — net profit $${expectedNetProfit.toFixed(4)} after gas ($${sellGasCostUsd.toFixed(4)}) below $${minProfit.toFixed(2)} minimum (output: $${expectedOutput.toFixed(2)}, cost: $${costBasis.toFixed(2)})`);
              return { success: false, error: `Net profit $${expectedNetProfit.toFixed(2)} after gas below $${minProfit.toFixed(2)} minimum` };
            }
            logger.info(`TokenTrader: Gas check OK — expected net profit $${expectedNetProfit.toFixed(4)} after gas $${sellGasCostUsd.toFixed(4)}`);
          } catch (gasErr) {
            logger.warn(`TokenTrader: Sell gas profitability check failed (proceeding): ${gasErr.message}`);
          }
        }

        // Size invariant on the sell side. Over-selling is the mirror of the 2026-08-21
        // overspend and just as unrecoverable: tokens sold cannot be un-sold, and a sell
        // larger than intended liquidates inventory the strategy meant to keep. Floor is a
        // token count, not dollars, so it scales with the token's own precision.
        sellAmount = await this.enforceTradeSize({
          label: 'sell', network: tokenNetwork, decided: tradeDecision.amountToken,
          actual: sellAmount, unit: tokenSymbol, floor: 1e-6
        });
        // Independently bounded by what we actually hold — a decision can never sell
        // inventory that is not there, whatever the strategy asked for.
        const heldNow = tokenStrategy?.state?.tokenBalance;
        if (Number.isFinite(heldNow) && sellAmount > heldNow) {
          logger.warn(`TokenTrader: sell of ${sellAmount.toFixed(6)} ${tokenSymbol} exceeds the ${heldNow.toFixed(6)} held — capping to balance`);
          sellAmount = heldNow;
        }

        logger.info(`TokenTrader: Selling ${sellAmount.toFixed(4)} ${tokenSymbol} (${tradeDecision.reason})`);

        // Emergency-sell fast-retry: on RPC timeout during a stop-loss / dump,
        // the default heartbeat cadence (~60s) before the next attempt costs
        // 1+pp of execution price as the dump continues. Rotate to the next
        // RPC and retry once within the same tick.
        // Non-emergency sells keep the original behavior — small grid sells
        // can safely wait for the next heartbeat.
        const _isTimeoutErr = (e) => {
          if (!e) return false;
          const code = String(e.code || '').toUpperCase();
          const msg = String(e.message || e.error || e || '').toLowerCase();
          if (code === 'TIMEOUT' || code === 'ETIMEDOUT') return true;
          if (msg.includes('etimedout')) return true;
          if (msg.includes('timed out')) return true;
          // 'timeout' substring is broad — explicitly exclude swap's own
          // tx-confirmation timeout (different problem, retrying the RPC
          // won't help an already-broadcast tx that just hasn't mined yet)
          if (msg.includes('confirmation_timeout')) return false;
          if (msg.includes('timeout')) return true;
          return false;
        };

        let swapResult;
        let _swapThrown = null;
        try {
          swapResult = await swapService.swap(
            tokenAddress,
            stablecoinAddr,
            sellAmount.toString(),
            swapOptions.maxSlippage,
            tokenNetwork,
            swapOptions
          );
        } catch (swapErr) {
          _swapThrown = swapErr;
          swapResult = { success: false, error: swapErr.message };
        }

        if (!swapResult.success && isEmergencySell && _isTimeoutErr(_swapThrown || swapResult)) {
          const rotated = await contractServiceWrapper.switchToNextRpc(tokenNetwork);
          if (rotated) {
            logger.warn(`TokenTrader: Emergency sell timed out on ${tokenNetwork} — rotated RPC, retrying immediately`);
            _swapThrown = null;
            try {
              swapResult = await swapService.swap(
                tokenAddress,
                stablecoinAddr,
                sellAmount.toString(),
                swapOptions.maxSlippage,
                tokenNetwork,
                swapOptions
              );
              if (swapResult.success) {
                logger.info(`TokenTrader: Emergency sell fast-retry succeeded on next RPC`);
              }
            } catch (retryErr) {
              _swapThrown = retryErr;
              swapResult = { success: false, error: retryErr.message };
            }
          } else {
            logger.warn(`TokenTrader: Emergency sell timed out on ${tokenNetwork} but no fallback RPC available`);
          }
        }

        // Preserve original throw semantics so downstream catch (no-swap-path
        // detection, system-token retry-later, etc.) keeps working.
        if (!swapResult.success && _swapThrown) {
          throw _swapThrown;
        }

        if (swapResult.success) {
          const stableReceived = parseFloat(swapResult.expectedOut) || 0;

          if (stableReceived <= 0) {
            logger.error(`TokenTrader: SELL swap reported success but stableReceived=${stableReceived} — skipping recordSell to prevent state corruption`);
            return { success: false, error: 'Swap returned 0 stablecoins despite success flag' };
          }

          // Post-swap sanity check: verify received amount is reasonable vs quote
          if (swapOptions.expectedOutputUsd > 0 && stableReceived < swapOptions.expectedOutputUsd * 0.5) {
            logger.error(`TokenTrader: CATASTROPHIC SWAP DETECTED — received $${stableReceived.toFixed(4)} vs expected $${swapOptions.expectedOutputUsd.toFixed(2)} (${((stableReceived / swapOptions.expectedOutputUsd) * 100).toFixed(1)}% of expected). Protocol: ${swapResult.protocolVersion || 'unknown'}`);
          }

          // Convert actual gas cost from native to USD
          const nativePriceForGas = marketData.prices?.[tokenNetwork]?.price || 0;
          const actualGasCostUsd = (swapResult.gasCostNative || 0) * nativePriceForGas;

          // Use actual execution price (stablecoins received / tokens sold), not theoretical quote
          const effectiveSellPrice = sellAmount > 0 ? stableReceived / sellAmount : priceData.price;

          // Capture position context BEFORE recordSell mutates it — avg entry, peak and the
          // trailing stop are all rewritten by the sell, and they are exactly the fields
          // needed to judge the exit after the fact.
          const exitCtx = {
            avgEntry: tokenStrategy.state.averageEntryPrice,
            peak: tokenStrategy.state.peakPrice,
            trailStop: tokenStrategy.state.trailingStopPrice,
            regime: tokenStrategy.state.regime
          };
          const sellOutcome = tokenStrategy.recordSell(sellAmount, stableReceived, effectiveSellPrice, tradeDecision, actualGasCostUsd);

          // Exit forensics. Never allowed to affect the trade path: fully awaited-free and
          // swallowed, because a logging failure must not corrupt a settled position.
          this._recordExitForensics({
            tokenStrategy, tradeDecision, exitCtx,
            tokensSold: sellAmount,
            proceeds: stableReceived,
            exitPrice: effectiveSellPrice,
            pnl: sellOutcome?.pnl,
            gasCostUsd: actualGasCostUsd,
            network: tokenNetwork,
            tokenSymbol
          }).catch(err => logger.debug(`Exit forensics write skipped: ${err.message}`));

          const actionLabel = tradeDecision.isEmergency ? 'token_trader_emergency_sell'
            : tradeDecision.isTrailingStop ? 'token_trader_trailing_stop'
            : tradeDecision.isGrid ? 'token_trader_grid_sell'
            : 'token_trader_sell';

          await this.notifySwap({
            action: actionLabel,
            network: tokenNetwork,
            amountIn: sellAmount,
            amountOut: stableReceived,
            symbolIn: tokenSymbol,
            symbolOut: 'USDT',
            txHash: swapResult.hash,
            gain: stableReceived - (sellAmount * tokenStrategy.state.averageEntryPrice),
            strategy: 'token_trader'
          });

          // Refresh DM position after TT sell changed wallet balance
          await this._refreshDMPositionAfterTrade(tokenNetwork);

          // Complete pending watchlist rotation after manual exit sell
          if (tradeDecision.isManualExit && tokenStrategy.state._pendingRotation) {
            const rot = tokenStrategy.state._pendingRotation;
            logger.info(`TokenTrader: Manual exit sell complete — now configuring ${rot.symbol} (pending rotation)`);
            tokenStrategy.configure({
              tokenAddress: rot.address, tokenNetwork: rot.network,
              tokenSymbol: rot.symbol, tokenDecimals: rot.decimals || 18,
              _preserveBreaker: true
            });
            tokenStrategy.state._watchlistRotation = true;
            delete tokenStrategy.state._pendingRotation;
            return {
              success: true,
              action: 'watchlist_rotate',
              network: tokenNetwork,
              amountUSD: stableReceived,
              amount: sellAmount,
              received: stableReceived,
              gain: stableReceived - (sellAmount * tokenStrategy.state.averageEntryPrice) - actualGasCostUsd,
              txHash: swapResult.hash,
              regime: 'ENTERING',
              newToken: rot.symbol,
              reason: `Sold ${sellAmount.toFixed(2)} ${tokenSymbol} for $${stableReceived.toFixed(2)}, rotated to ${rot.symbol}`
            };
          }

          return {
            success: true,
            action: 'sell_token',
            network: tokenNetwork,
            amountUSD: stableReceived,
            amount: sellAmount,
            received: stableReceived,
            gain: stableReceived - (sellAmount * tokenStrategy.state.averageEntryPrice) - actualGasCostUsd,
            regime: tokenStrategy.state.regime,
            txHash: swapResult.hash,
            sellAll: tradeDecision.sellAll,
            reason: `Sold ${sellAmount.toFixed(2)} ${tokenSymbol} for $${stableReceived.toFixed(2)}`
          };
        }

        // Sell swap failed — if this was a manual exit with pending rotation,
        // the token is unsellable. Abandon it and rotate to the next token anyway.
        if (tradeDecision.isManualExit && tokenStrategy.state._pendingRotation) {
          const rot = tokenStrategy.state._pendingRotation;
          logger.warn(`TokenTrader: Sell failed (${swapResult.error || 'swap failed'}) but rotation pending — abandoning unsellable ${tokenSymbol}, configuring ${rot.symbol}`);
          tokenStrategy.configure({
            tokenAddress: rot.address, tokenNetwork: rot.network,
            tokenSymbol: rot.symbol, tokenDecimals: rot.decimals || 18,
            _preserveBreaker: true
          });
          tokenStrategy.state._watchlistRotation = true;
          delete tokenStrategy.state._pendingRotation;
          return {
            success: true, action: 'watchlist_rotate',
            reason: `Abandoned unsellable ${tokenSymbol}, rotated to ${rot.symbol}`,
            regime: 'ENTERING', newToken: rot.symbol
          };
        }
        return { success: false, error: swapResult.error || 'Sell swap failed' };
      }
    } catch (execError) {
      logger.error(`TokenTrader execution error: ${execError.message}`);
      // If buy failed due to no swap path and we never held this token, it may be untradeable
      const isSwapPathError = execError.message?.includes('forceV3') || execError.message?.includes('No viable swap path');
      if (isSwapPathError && tokenStrategy.state.tokenBalance <= 0) {
        // Check if this is a system token — never remove system tokens
        const currentAddr = tokenAddress?.toLowerCase();
        const watchlistEntry = tokenStrategy.config.tokenWatchlist?.find(
          t => t.address?.toLowerCase() === currentAddr
        );
        const isSystemToken = watchlistEntry?.system === true;

        if (isSystemToken) {
          // System token — don't remove, just apply temporary skip and retry later
          logger.warn(`TokenTrader: ${tokenSymbol} (system token) swap path failed — will retry later (NOT removing)`);
          return { success: true, action: 'hold', reason: `${tokenSymbol} V3 path temporarily unavailable — will retry` };
        }

        // Non-system token with no swap path: apply 24h skip cooldown instead of permanent removal
        logger.warn(`TokenTrader: ${tokenSymbol} has no swap path — applying 24h cooldown and rotating`);
        if (watchlistEntry) {
          watchlistEntry._skipUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        } else if (!isSystemToken && tokenStrategy.config.tokenWatchlist?.length > 0) {
          // Only remove truly untradeable non-system tokens that aren't even in watchlist
          tokenStrategy.config.tokenWatchlist = tokenStrategy.config.tokenWatchlist.filter(
            t => t.address.toLowerCase() !== currentAddr
          );
        }

        // Trigger watchlist rotation to next candidate instead of going to null state
        tokenStrategy.state.regime = null;
        tokenStrategy.state.initialBuyAttempts = 0;
        return { success: true, action: 'hold', reason: `${tokenSymbol} untradeable (no V3 path) — rotating to next watchlist token` };
      }
      return { success: false, error: execError.message };
    }

    return { success: true, action: 'hold', reason: `Unknown trade action: ${tradeDecision.action}` };
  }

  /**
   * Per-network async mutex. Position writes happen from independent flows (the main
   * heartbeat reconcile and per-token TokenTrader ticks share this one agent instance),
   * so read-modify-write of position state must be serialized per network or one flow's
   * update silently overwrites another's.
   */
  async _withPositionLock(network, fn) {
    if (!this._positionLocks) this._positionLocks = {};
    const key = network || '_global';
    const prev = this._positionLocks[key] || Promise.resolve();
    let release;
    const gate = new Promise((res) => { release = res; });
    // Chain this op after any in-flight op for the same network (one resolved
    // promise per network is retained — bounded by the small network count).
    const chained = prev.then(() => gate);
    this._positionLocks[key] = chained;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Persist a single network's position ATOMICALLY.
   *
   * The previous pattern — read the whole `positions` map, mutate one network, then
   * `$set` the entire map back — meant two concurrent writers (main heartbeat + a token
   * trader tick) each based on the same snapshot would clobber each other's network
   * (last-writer-wins drops one update). This writes only `positions.<network>` via a
   * dotted `$set`, so sibling networks are never touched, under a per-network lock so
   * same-network writes apply in order. Replace semantics (not merge) — matches the
   * prior call sites, which passed complete position objects.
   */
  async _persistPosition(network, positionObj, { syncStrategy = false, strategyName = 'dollar_maximizer' } = {}) {
    return this._withPositionLock(network, async () => {
      if (syncStrategy) {
        const strat = strategyRegistry.get(strategyName);
        if (strat?.setPosition) strat.setPosition(network, positionObj);
      }
      await this.updateState({ [`positions.${network}`]: positionObj });
    });
  }

  /**
   * Refresh Dollar Maximizer position after Token Trader trade changed wallet balance.
   * Prevents DM stablecoin amount from going stale between its own analysis cycles.
   */
  async _refreshDMPositionAfterTrade(tokenNetwork) {
    try {
      const dollarStrategy = strategyRegistry.get('dollar_maximizer');
      if (!dollarStrategy) return;

      const position = dollarStrategy.getPosition(tokenNetwork);
      if (!position) return;

      const config = this.getConfig();
      const networks = config.domainConfig?.networks || config.networks || {};
      const netConfig = networks[tokenNetwork];
      if (!netConfig?.stablecoinAddress) return;

      const wallet = await walletService.getWallet();
      const chainMap = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', base: 'base' };
      const chain = chainMap[tokenNetwork];
      const addr = wallet?.addresses?.find(a => a.chain === chain)?.address;
      if (!addr) return;

      const stableResult = await contractServiceWrapper.getTokenBalance(netConfig.stablecoinAddress, addr, tokenNetwork);
      const actualStable = parseFloat(stableResult.formatted) || 0;

      // Also reconcile the native (BNB/ETH) balance: native-funded token buys draw down the
      // SAME wallet native that dollar_maximizer tracks as its position. Without this, DM keeps
      // a stale nativeAmount and the two strategies double-count the same BNB (the "tally is off"
      // symptom). Read it on-chain and sync.
      let actualNative = null;
      try {
        const nativeResult = await contractServiceWrapper.getNativeBalance(addr, tokenNetwork);
        actualNative = parseFloat(nativeResult.formatted);
        if (!Number.isFinite(actualNative)) actualNative = null;
      } catch (nativeErr) {
        logger.debug(`DM native reconcile: could not read native balance: ${nativeErr.message}`);
      }

      const stableDrift = Math.abs(actualStable - (position.stablecoinAmount || 0)) > 0.5;
      const nativeDrift = actualNative !== null && Math.abs(actualNative - (position.nativeAmount || 0)) > 0.0005;

      if (stableDrift || nativeDrift) {
        if (stableDrift) position.stablecoinAmount = actualStable;
        if (nativeDrift) position.nativeAmount = actualNative;
        position.updatedAt = new Date().toISOString();
        dollarStrategy.setPosition(tokenNetwork, position);
        await this._persistPosition(tokenNetwork, position);
        logger.info(`DM position refreshed after TT trade: ${tokenNetwork} stablecoin=$${actualStable.toFixed(2)}${actualNative !== null ? ` native=${actualNative.toFixed(4)}` : ''}`);
      }
    } catch (refreshErr) {
      logger.warn(`DM position refresh after TT trade failed: ${refreshErr.message}`);
    }
  }

  /**
   * Scan for new deposits — agent-owned, runs on heartbeat cycle
   * Replaces the old Agenda job approach: the sub-agent owns its own scan lifecycle.
   */
  async scanForDeposits() {
    // Get wallet address
    let walletAddress;
    try {
      const wallet = await walletService.getWallet();
      if (!wallet?.addresses?.length) {
        logger.info('Deposit scan: no wallet addresses, skipping');
        return;
      }
      // Use BSC or ETH address (they're the same for EVM)
      const addrEntry = wallet.addresses.find(a => a.chain === 'bsc' || a.chain === 'eth');
      walletAddress = addrEntry?.address;
      if (!walletAddress) {
        logger.info('Deposit scan: no EVM address found, skipping');
        return;
      }
    } catch (err) {
      logger.info('Deposit scan: wallet not available yet:', err.message);
      return;
    }

    logger.info(`Deposit scan: starting (wallet=${walletAddress?.slice(0,10)}..., scanner=${!!tokenScanner.walletAddress})`);

    // Ensure token scanner is initialized and auto-started
    if (!tokenScanner.walletAddress) {
      await tokenScanner.initialize(walletAddress, { autoStart: true });

      // Feed token addresses from trade history into scanner for balance probing
      try {
        const state = this.getState();
        const journal = state.decisionJournal || [];
        const extraAddrs = new Set();
        for (const entry of journal) {
          if (entry.tokenAddress) extraAddrs.add(entry.tokenAddress);
          if (entry.trade?.tokenAddress) extraAddrs.add(entry.trade.tokenAddress);
        }
        if (extraAddrs.size > 0) {
          tokenScanner.addExtraTokenAddresses(extraAddrs);
          logger.info(`Fed ${extraAddrs.size} token address(es) from trade history to scanner`);
        }
      } catch (err) {
        logger.debug('Could not extract trade history addresses:', err.message);
      }
    }

    // The deep scan must finish before deposits can be DETECTED — running
    // detectNewDeposits against an empty knownTokens map finds 0 deposits every
    // time, which is the fire-and-forget bug this used to have. That requirement
    // is real and is kept below. What was wrong was *where* the waiting happened.
    //
    // The wait sat on the heartbeat's critical path, ahead of the strategy
    // execution in the same cycle, so a cold start bought a full deep scan of
    // silence: on 2026-08-21 the 07:43:34 heartbeat produced no trading decision
    // until 07:54:07, ten and a half minutes later, and on 2026-08-17 the same
    // stage blew the orchestrator's 20-minute session cap outright. Deep-scan
    // walks ~5M blocks in 501 chunks on BSC and can legitimately take 60-80min on
    // a slow RPC, so no deadline short enough to protect the trade path is long
    // enough to be worth waiting for.
    //
    // So the scan runs detached and DETECTION waits for it instead of the agent
    // waiting for either. Nothing about its lifetime changes — tokenScanner is a
    // singleton and the old code already let the scan outlive its deadline and
    // keep running in the background; that is now the ordinary path rather than
    // the timeout path. Deposit detection is delayed by exactly as long as the
    // scan takes, which is the cost that belongs to deposits, not to trading.
    //
    // A failure resets to 'idle' rather than latching, because the old block sat
    // inside the `!tokenScanner.walletAddress` gate and could therefore never
    // honour its own "will retry next heartbeat" promise.
    if (this._deepScanState !== 'done') {
      if (this._deepScanState !== 'running') {
        this._deepScanState = 'running';
        logger.info('Deposit scan: populating the token map in the background — the trade path is not held behind it');
        tokenScanner.runDeepScanAll(['bsc', 'ethereum'])
          .then(() => {
            this._deepScanState = 'done';
            logger.info(`Deposit scan: deep scan complete, knownTokens=${tokenScanner.knownTokens.size} — detection enabled`);
          })
          .catch(err => {
            this._deepScanState = 'idle';
            logger.warn(`Deposit scan: deep scan failed (${err.message}) — retrying on a later heartbeat`);
          });
      }
      logger.info(`Deposit scan: token map still populating (knownTokens=${tokenScanner.knownTokens.size}) — deferring detection to a later heartbeat`);
      return;
    }

    // Collect managed token addresses from all token trader instances
    const managedAddresses = new Set();
    for (const [, ttInstance] of strategyRegistry.getAllTokenTraders()) {
      if (ttInstance?.getManagedTokenAddresses) {
        for (const addr of ttInstance.getManagedTokenAddresses()) {
          managedAddresses.add(addr);
        }
      }
    }

    // Get last known balances from persisted state
    const state = this.getState();
    const depositTracking = state.depositTracking || {};
    const lastKnownBalances = depositTracking.lastKnownBalances || {};

    // Scan active networks
    const allDeposits = [];
    for (const network of ['bsc', 'ethereum']) {
      try {
        const networkBalances = lastKnownBalances[network] || {};
        logger.info(`Deposit scan [${network}]: lastKnown=${Object.keys(networkBalances).length} entries, managed=${managedAddresses.size} addrs`);
        const deposits = await tokenScanner.detectNewDeposits(network, networkBalances, managedAddresses);
        logger.info(`Deposit scan [${network}]: ${deposits.length} deposit(s) found`);
        allDeposits.push(...deposits);
      } catch (err) {
        logger.warn(`Deposit scan failed for ${network}: ${err.message}`);
      }
    }

    if (allDeposits.length > 0) {
      const summary = allDeposits.map(d => `${d.symbol}: +${d.amountFormatted} (${d.classification})`).join(', ');
      logger.info(`Deposit scan: ${allDeposits.length} deposit(s) detected — ${summary}`);
      await this.handleDeposits(allDeposits);
    } else {
      logger.info('Deposit scan: no new deposits detected');
    }
  }

  /**
   * Sweep residual token balances that the delta-based deposit scanner misses.
   * Catches: non-primary stablecoins (BUSD), reflection tokens that dripped back,
   * and any other ERC20 sitting in the wallet that isn't actively managed.
   */
  async sweepResidualTokens() {
    const config = this.getConfig();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const state = this.getState();
    const tracking = state.depositTracking || {};
    const lastKnownBalances = tracking.lastKnownBalances || {};
    const processedDeposits = tracking.processedDeposits || {};

    // Determine what to skip: primary stablecoin, native, managed token
    const skipAddresses = new Set();
    for (const network of ['bsc', 'ethereum']) {
      const netCfg = NETWORK_CONFIG[networkMode]?.[network];
      if (netCfg?.stablecoinAddress) skipAddresses.add(netCfg.stablecoinAddress.toLowerCase());
    }
    // Skip all active token trader instance addresses
    for (const [addr] of strategyRegistry.getAllTokenTraders()) {
      skipAddresses.add(addr.toLowerCase());
    }
    // Backward compat: also check base token_trader
    const tokenTrader = strategyRegistry.get('token_trader');
    if (tokenTrader?.config?.tokenAddress) {
      skipAddresses.add(tokenTrader.config.tokenAddress.toLowerCase());
    }
    // Also check persisted strategy registry state (survives restarts)
    const persistedRegistry = state.strategyRegistry || {};
    const persistedTokenTrader = persistedRegistry.token_trader || {};
    if (persistedTokenTrader.config?.tokenAddress) {
      skipAddresses.add(persistedTokenTrader.config.tokenAddress.toLowerCase());
    }
    // Also check the tokenTraderStatus saved by the executor (multi-token: keyed by address)
    if (state.tokenTraderStatus) {
      for (const [key, val] of Object.entries(state.tokenTraderStatus)) {
        if (val?.token?.address) {
          skipAddresses.add(val.token.address.toLowerCase());
        }
      }
    }
    // Skip system-allowlist tokens (user-owned, low-liq) so the sweep never
    // tries to sell them and the instant-blacklist branches can't fire on them
    for (const key of SYSTEM_TOKEN_ALLOWLIST) {
      const addr = key.split(':')[1];
      if (addr) skipAddresses.add(addr);
    }

    // Skip WBNB when LP market maker is enabled (it manages WBNB for V3 liquidity)
    try {
      const { default: lpMarketMaker } = await import('../crypto/lpMarketMaker.js');
      const mmConfig = await lpMarketMaker.getConfig();
      if (mmConfig?.enabled) {
        skipAddresses.add('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'); // WBNB
      }
    } catch { /* LP MM not available */ }
    // Skip owned tokens that should never be auto-sold (dead projects, LP tokens, minted tokens, ecosystem tokens)
    const OWNED_TOKEN_WHITELIST = [
      '0x9a0ee07f1412e46ff12d22f4380ff2f823d5eb23', // MANTIS (BSC)
      '0x97439478b92f6d8d59c2081dec9e6eac587dabc0', // NAUT (BSC)
      '0x894d305d1a010c88ed4c3f885969d192d81816b0', // STINGRAY (BSC)
      '0x2ac21524188988025e54429a40b83460098eb601', // Cake-LP SKYNET/WBNB (BSC)
      '0x3f8d1a1c568ba520e05a35ac31040976828aa5a1', // LOTTO (BSC)
      // Skynet ecosystem — never auto-sell
      '0x8b77cc5c6cb3d846608d9d5dd03fa406ba03b8f1', // SKYNET token (BSC)
      '0xffa95ec77d7ed205d48fea72a888ae1c93e30ff7', // SkynetDiamond contract (BSC)
      '0x72f2e5b2ffa9a391e0c4befd9c61a909f6ae099c', // SkynetHub (decommissioned)
      '0x7d5a345b25163edcfdce16b08d0fddd19263dd72', // SCAMMER badge (BSC)
      '0xb752e44e1e67e657cf0553993b4552644ce2c352', // SCAMTOKEN badge (BSC)
      '0xae1908c7d64562732a25e7b55980556514d46c35', // SENTINEL badge (BSC)
      // Decommissioned contracts (may still hold tokens)
      '0xdb700a7df83bf4db6e82f91f86b0c38e01645eea', // SENTINEL V1 (old registry)
      '0x9205b5e16e3ef7e6dd51ee6334ea7f8d7fec31d6', // SkynetStaking V1 (decommissioned)
      '0x8a3c987203a1d3711e2287728fa8bfda2411bd8b', // SkynetStaking V2 (decommissioned)
      '0xea68dad9d44a51428206b4ecfe38147c7783b9e9', // ScammerRegistry V1 (decommissioned)
      '0x0b9271fba756d3754b9bcb467881f21c7c169884', // SkynetHub V1 (decommissioned)
    ];
    for (const addr of OWNED_TOKEN_WHITELIST) skipAddresses.add(addr);
    // Skip known scam/honeypot airdrop tokens (no liquidity, transfer-blocked, or fake value)
    const SCAM_TOKEN_BLACKLIST = [
      '0x221771df08a59d6cb4cf0bd21ccaad6e429f5699', // ChinaHorse (BSC) — no liquidity
      '0xd8f1200650fb2e28b8a068d4bc4d53c4d8984990', // SN3 (ETH) — honeypot, TRANSFER_FROM_FAILED
      '0x3b10d974439b7124c1bf124e1764bb3cc59cf04f', // WAR (ETH) — no liquidity
      '0x7f9acaddfe815921b1228ea3e6eee098ab8e2cb7', // Unknown (ETH) — honeypot, TRANSFER_FROM_FAILED
      '0xbcc34a88c584e30d1be7c782c6391c439111cdae', // APEXX (BSC) — no liquidity, no swap path (dust airdrop)
      '0xfec3cf1a1c9288813585984cd6a457f22fcd2cee', // SECA "SecantX AI" (BSC) — honeypot, unsellable (TRANSFER_FROM_FAILED despite real 5.0 balance + max router allowance)
    ];
    for (const addr of SCAM_TOKEN_BLACKLIST) skipAddresses.add(addr);
    // Also skip tokens flagged in the on-chain scammer registry cache
    try {
      const scammerRegistry = (await import('../crypto/scammerRegistryService.js')).default;
      if (scammerRegistry._scammerCache?.size > 0) {
        for (const addr of scammerRegistry._scammerCache) {
          skipAddresses.add(addr);
        }
      }
    } catch { /* scammer registry not available */ }
    // Skip system watchlist tokens (e.g., SKYNET reserved for staking — must never be auto-sold)
    if (tokenTrader?.config?.tokenWatchlist) {
      for (const entry of tokenTrader.config.tokenWatchlist) {
        if (entry.system && entry.address) {
          skipAddresses.add(entry.address.toLowerCase());
        }
      }
    }
    // Also check persisted watchlist in case in-memory registry isn't loaded yet
    if (persistedTokenTrader.config?.tokenWatchlist) {
      for (const entry of persistedTokenTrader.config.tokenWatchlist) {
        if (entry.system && entry.address) {
          skipAddresses.add(entry.address.toLowerCase());
        }
      }
    }
    if (skipAddresses.size > 0) {
      logger.debug(`Residual sweep: skipping managed addresses: ${Array.from(skipAddresses).map(a => a.slice(0,10)).join(', ')}`);
    }

    let swept = 0;
    let deferredForTime = 0;
    const MAX_SWEEPS_PER_CYCLE = 5; // Limit sells per heartbeat to conserve gas
    // Bail before the orchestrator's 20-min hard cap fires. 90s gives
    // enough headroom for the in-flight sweep to finish + scammer-registry
    // flush + state persist before the cap.
    const TIME_BUDGET_BAIL_MS = 90 * 1000;

    // Build a unified list of token addresses to check from ALL sources:
    // 1. lastKnownBalances (tokens previously detected by deposit scanner)
    // 2. tokenScanner.knownTokens (tokens found by explorer API / deep scan / balance probe)
    // This ensures pre-existing tokens that were never flagged as "deposits" still get swept.
    for (const network of ['bsc', 'ethereum']) {
      if (swept >= MAX_SWEEPS_PER_CYCLE) break;
      if (this._remainingSessionMs() < TIME_BUDGET_BAIL_MS) {
        deferredForTime++;
        break;
      }

      const tokensToCheck = new Set();

      // Source 1: lastKnownBalances (existing behavior)
      const balances = lastKnownBalances[network] || {};
      for (const addrOrNative of Object.keys(balances)) {
        if (addrOrNative !== 'native') tokensToCheck.add(addrOrNative.toLowerCase());
      }

      // Source 2: tokenScanner knownTokens — catches ALL tokens the scanner has ever seen,
      // including those found by explorer API that never made it into lastKnownBalances
      if (tokenScanner.knownTokens) {
        for (const [key, info] of tokenScanner.knownTokens) {
          if (key.startsWith(`${network}:`) && info.address) {
            const addr = info.address.toLowerCase();
            // Only add if it has a known non-zero balance (avoid probing dead tokens)
            if (parseFloat(info.balance || '0') > 0) {
              tokensToCheck.add(addr);
            }
          }
        }
      }

      for (const tokenAddr of tokensToCheck) {
        if (swept >= MAX_SWEEPS_PER_CYCLE) break;
        if (this._remainingSessionMs() < TIME_BUDGET_BAIL_MS) {
          deferredForTime++;
          break;
        }
        if (skipAddresses.has(tokenAddr)) continue;

        // Skip if recently failed or permanently gave up
        const dedupKey = `${network}:${tokenAddr}`;
        const existing = processedDeposits[dedupKey];
        if (existing?.action === 'auto_sell_failed') {
          // After 3 full failed cycles (all slippage levels exhausted), stop retrying
          // Token will be eligible again after 7-day auto-cleanup
          if ((existing.failCount || 1) >= 3) {
            logger.debug(`Residual sweep: skipping ${existing.symbol || tokenAddr} — failed ${existing.failCount} full cycles, no liquidity`);
            continue;
          }
          const hoursSince = (Date.now() - new Date(existing.timestamp).getTime()) / (1000 * 60 * 60);
          if (hoursSince < 24) continue;
        }
        // Skip if swept less than 1h ago (avoid re-sweeping every heartbeat)
        if (existing?.action === 'stablecoin_swept' || existing?.action === 'auto_sell_attempted') {
          const hoursSince = (Date.now() - new Date(existing.timestamp).getTime()) / (1000 * 60 * 60);
          if (hoursSince < 1) continue;
        }
        // Skip if gas exceeds value — suppress for 7 days. These are worthless dust
        // tokens whose value almost never recovers; re-checking them every 24h is
        // what makes the sweep exhaust its session budget daily without finishing.
        if (existing?.action === 'skipped_gas_exceeds_value') {
          const hoursSince = (Date.now() - new Date(existing.timestamp).getTime()) / (1000 * 60 * 60);
          if (hoursSince < 24 * 7) continue;
        }
        // Skip scam/dust tokens — but allow re-check after 24h (classification may have improved)
        if (existing?.action === 'ignored_scam' || existing?.action === 'ignored_dust') {
          const hoursSince = (Date.now() - new Date(existing.timestamp).getTime()) / (1000 * 60 * 60);
          if (hoursSince < 24) continue;
        }

        // Get fresh on-chain balance
        try {
          const wallet = await walletService.getWallet();
          const chainMap = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', base: 'base' };
          const addrEntry = wallet?.addresses?.find(a => a.chain === chainMap[network]);
          if (!addrEntry) continue;

          const tokenBal = await contractServiceWrapper.getTokenBalance(tokenAddr, addrEntry.address, network);
          const actualBalance = parseFloat(tokenBal.formatted) || 0;
          if (actualBalance <= 0) continue;

          // Get token info from scanner or basic ERC20 read
          const tokenKey = `${network}:${tokenAddr}`;
          const tokenInfo = tokenScanner.knownTokens?.get(tokenKey);
          const symbol = tokenInfo?.symbol || existing?.symbol || 'UNKNOWN';
          const decimals = tokenInfo?.decimals || 18;

          // Skip scam/honeypot tokens detected by the scanner
          if (tokenInfo?.isScam || tokenInfo?.checks?.isHoneypot) {
            logger.debug(`Residual sweep: skipping ${symbol} — classified as scam/honeypot by scanner`);
            await this.recordProcessedDeposit(dedupKey, { action: 'ignored_scam', deposit: { symbol, tokenAddress: tokenAddr, network } });
            this._reportHoneypotToRegistry(tokenAddr, symbol, network, 0, tokenInfo?.scamCategory || 'scam_token');
            continue;
          }

          // Skip redeployments of already-confirmed honeypots (same symbol,
          // new contract address) — don't burn sell attempts re-proving them
          const priorHoneypot = this._findConfirmedHoneypotBySymbol(symbol);
          if (priorHoneypot) {
            logger.info(`Residual sweep: skipping ${symbol} (${tokenAddr.slice(0, 10)}...) — same symbol confirmed honeypot at ${priorHoneypot.key}`);
            await this.recordProcessedDeposit(dedupKey, { action: 'ignored_scam', deposit: { symbol, tokenAddress: tokenAddr, network } });
            this._reportHoneypotToRegistry(tokenAddr, symbol, network, 0, 'honeypot');
            continue;
          }

          // NOTE: We don't heuristically flag tokens as scam based on name/balance alone.
          // Scam classification requires evidence: on-chain revert (honeypot), scanner classification,
          // or failed sell attempts. Unsolicited airdrops are common but not proof of scam — some are
          // legitimate marketing. The auto-sell path handles this: if the token reverts, the honeypot
          // revert detector (revertCount >= 2) will catch it and report to the registry.

          logger.info(`Residual sweep: found ${actualBalance.toFixed(4)} ${symbol} on ${network} (addr=${tokenAddr.slice(0,10)}...)`);

          // Build synthetic deposit for autoSellUnknownToken
          const deposit = {
            type: 'erc20', network, tokenAddress: tokenAddr, symbol, decimals,
            amount: actualBalance.toString(), amountFormatted: actualBalance.toFixed(6),
            classification: 'safe_unknown', currentBalance: actualBalance.toString()
          };

          try {
            const result = await this._autoSellWithTimeout(deposit);
            result.action = result.action === 'auto_sell_attempted' ? 'stablecoin_swept' : result.action;
            // If autoSellUnknownToken returned auto_sell_failed with an unsellable-token error,
            // immediately mark failCount=3 so we never retry this dead token
            if (result.action === 'auto_sell_failed' && result.error &&
                (result.error.includes('No viable swap path') || result.error.includes('no real liquidity') ||
                 result.error.includes('TRANSFER_FROM_FAILED') || result.error.includes('Output sanity check failed') ||
                 result.error.includes('Honeypot'))) {
              result.failCount = 3;
              logger.warn(`Residual sweep: ${symbol} is unsellable — permanently blacklisted`);
              // Report to scammer registry — we have hard evidence: unsolicited token that can't be sold
              const category = result.error.includes('Honeypot') || result.error.includes('TRANSFER_FROM_FAILED') ? 'honeypot' : 'airdrop_scam';
              this._reportHoneypotToRegistry(tokenAddr, symbol, network, 0, category);
            }
            // NOTE: skipped_gas_exceeds_value tokens are NOT reported — being cheap/worthless is
            // not proof of being a scam. Legitimate low-liquidity tokens (e.g., SKYNET early stage)
            // would be false-positived. Only tokens with hard sell-failure evidence get reported.
            await this.recordProcessedDeposit(dedupKey, result);
            if (result.action !== 'auto_sell_failed' && result.action !== 'skipped_gas_exceeds_value') swept++;
            logger.info(`Residual sweep: ${symbol} sell ${result.action}`);
          } catch (sellErr) {
            const isUnsellable = sellErr.message?.includes('No viable swap path') || sellErr.message?.includes('no real liquidity') ||
              sellErr.message?.includes('TRANSFER_FROM_FAILED') || sellErr.message?.includes('Output sanity check failed') ||
              sellErr.message?.includes('Honeypot');
            const failCount = isUnsellable ? 3 : undefined; // Permanently skip dead tokens
            logger.warn(`Residual sweep: ${symbol} sell failed: ${sellErr.message}${isUnsellable ? ' — permanently blacklisted' : ''}`);
            if (isUnsellable) {
              const category = sellErr.message?.includes('Honeypot') || sellErr.message?.includes('TRANSFER_FROM_FAILED') ? 'honeypot' : 'airdrop_scam';
              this._reportHoneypotToRegistry(tokenAddr, symbol, network, 0, category);
            }
            await this.recordProcessedDeposit(dedupKey, { action: 'auto_sell_failed', deposit, error: sellErr.message, failCount });
          }
          // RPC-politeness spacing between processed tokens. 1.5s is enough — the
          // old 5s pause was a major contributor to the sweep blowing its session
          // budget and bailing before finishing the token list.
          await new Promise(r => setTimeout(r, 1500));
        } catch (err) {
          logger.debug(`Residual sweep: could not check ${tokenAddr} on ${network}: ${err.message}`);
        }
      }
    }

    if (swept > 0) {
      logger.info(`Residual sweep: sold ${swept} token(s)`);
    }
    if (deferredForTime > 0) {
      logger.warn(`Residual sweep: bailed early — session budget low (${Math.round(this._remainingSessionMs() / 1000)}s remaining). Tokens will be reprocessed next heartbeat.`);
    }
  }

  /**
   * Handle detected deposits — classify and auto-sell unknown safe tokens
   */
  async handleDeposits(deposits) {
    if (!deposits || deposits.length === 0) return;

    const state = this.getState();
    const processedDeposits = state.depositTracking?.processedDeposits || {};
    const results = [];
    // Same bail threshold as residual sweep — keep the two stages in sync.
    const TIME_BUDGET_BAIL_MS = 90 * 1000;
    let deferredForTime = 0;

    for (const deposit of deposits) {
      if (this._remainingSessionMs() < TIME_BUDGET_BAIL_MS) {
        deferredForTime++;
        break;
      }
      // System-allowlisted tokens (user-owned, low-liq): never auto-sell or record
      if (isSystemToken(deposit.network, deposit.tokenAddress)) {
        logger.debug(`Deposit handler: ${deposit.symbol} is system-allowlisted — leaving in wallet`);
        continue;
      }
      // Dedup by network:tokenAddress (not amount, which changes between scans)
      const dedupKey = `${deposit.network}:${deposit.tokenAddress || 'native'}`;
      const existing = processedDeposits[dedupKey];
      if (existing) {
        const hoursSince = (Date.now() - new Date(existing.timestamp).getTime()) / (1000 * 60 * 60);
        // Failed sells: permanently skip dead tokens after 3 failures, 24h cooldown otherwise
        if (existing.action === 'auto_sell_failed') {
          const failCount = existing.failCount || 1;
          if (failCount >= 3) {
            logger.info(`Permanently skipping dead token ${deposit.symbol}: ${failCount} consecutive sell failures (no liquidity)`);
            continue;
          }
          if (hoursSince < 24) {
            logger.debug(`Skipping ${deposit.symbol}: sell failed ${hoursSince.toFixed(1)}h ago (attempt ${failCount}/3), cooldown until 24h`);
            continue;
          }
          logger.info(`Retrying ${deposit.symbol} auto-sell: 24h cooldown expired (failed ${hoursSince.toFixed(0)}h ago, attempt ${failCount}/3)`);
        // Successful sells: allow re-processing (reflection tokens drip back)
        } else if (existing.action === 'auto_sell_attempted' || existing.action === 'stablecoin_swept') {
          logger.info(`Re-processing ${deposit.symbol}: new balance detected after previous sell (reflections?)`);
        // Scam/dust: re-classify after 24h (false positives are common for legit tokens without V2 pairs)
        } else if (existing.action.startsWith('ignored_')) {
          if (hoursSince < 24) {
            logger.debug(`Deposit ignored: ${dedupKey} (${existing.action}), re-classify in ${(24 - hoursSince).toFixed(1)}h`);
            continue;
          }
          logger.info(`Re-classifying ${deposit.symbol}: ${existing.action} expired after ${hoursSince.toFixed(0)}h — will re-analyze`);
        // Everything else (stablecoin_received, native_received, strategy_managed): allow re-processing
        } else {
          logger.debug(`Re-processing deposit: ${dedupKey} (prev: ${existing.action})`);
        }
      }

      logger.info(`Processing deposit: ${deposit.amountFormatted} ${deposit.symbol} on ${deposit.network} (${deposit.classification})`);

      let result = { action: 'logged', deposit };

      switch (deposit.classification) {
        case 'stablecoin': {
          // Check if this is the primary trading stablecoin — if not, sweep it to native
          const agentConfig = this.getConfig();
          const netMode = agentConfig.domainConfig?.networkMode || agentConfig.networkMode || 'testnet';
          const netCfg = NETWORK_CONFIG[netMode]?.[deposit.network];
          const primaryStable = netCfg?.stablecoinAddress?.toLowerCase();
          const depositAddr = deposit.tokenAddress?.toLowerCase();

          if (primaryStable && depositAddr && depositAddr !== primaryStable) {
            // Non-primary stablecoin (e.g., BUSD when primary is USDT) — auto-sell to native
            const estValue = parseFloat(deposit.amountFormatted) || 0;
            if (estValue >= 1) {
              logger.info(`Non-primary stablecoin ${deposit.symbol}: $${estValue.toFixed(2)} — sweeping to native`);
              try {
                result = await this._autoSellWithTimeout(deposit);
                result.action = result.action === 'auto_sell_attempted' ? 'stablecoin_swept' : result.action;
              } catch (sellErr) {
                logger.error(`Stablecoin sweep failed for ${deposit.symbol}: ${sellErr.message}`);
                result.action = 'auto_sell_failed';
                result.error = sellErr.message;
              }
              await new Promise(r => setTimeout(r, 5000));
            } else {
              logger.info(`Non-primary stablecoin ${deposit.symbol}: $${estValue.toFixed(2)} below $1 sweep minimum`);
              result.action = 'stablecoin_received';
            }
          } else {
            logger.info(`Stablecoin deposit: +${deposit.amountFormatted} ${deposit.symbol} — available for strategies`);
            result.action = 'stablecoin_received';
          }
          break;
        }

        case 'strategy_managed':
          logger.info(`Strategy-managed token deposit: +${deposit.amountFormatted} ${deposit.symbol} — strategy will handle`);
          result.action = 'strategy_managed';
          break;

        case 'native':
          logger.info(`Native deposit: +${deposit.amountFormatted} ${deposit.symbol} — strategies will pick up updated balance`);
          result.action = 'native_received';
          break;

        case 'safe_unknown': {
          // Redeployment of an already-confirmed honeypot (same symbol, new
          // contract address) — skip without burning sell attempts on it
          const priorHoneypot = this._findConfirmedHoneypotBySymbol(deposit.symbol);
          if (priorHoneypot) {
            logger.info(`Deposit handler: skipping ${deposit.symbol} (${deposit.tokenAddress?.slice(0, 10)}...) — same symbol confirmed honeypot at ${priorHoneypot.key}`);
            result.action = 'ignored_scam';
            if (deposit.tokenAddress) {
              this._reportHoneypotToRegistry(deposit.tokenAddress, deposit.symbol, deposit.network, 0, 'honeypot');
            }
            break;
          }
          logger.info(`Unknown safe token: ${deposit.symbol} — attempting auto-sell to stablecoin`);
          try {
            result = await this._autoSellWithTimeout(deposit);
            // If unsellable token, immediately mark as permanently failed
            if (result.action === 'auto_sell_failed' && result.error &&
                (result.error.includes('No viable swap path') || result.error.includes('no real liquidity') ||
                 result.error.includes('TRANSFER_FROM_FAILED') || result.error.includes('Output sanity check failed'))) {
              result.failCount = 3;
              logger.warn(`${deposit.symbol} is unsellable — permanently blacklisted`);
            }
          } catch (sellErr) {
            logger.error(`Auto-sell failed for ${deposit.symbol}: ${sellErr.message}`);
            result.action = 'auto_sell_failed';
            result.error = sellErr.message;
            if (sellErr.message?.includes('No viable swap path') || sellErr.message?.includes('no real liquidity') ||
                sellErr.message?.includes('TRANSFER_FROM_FAILED') || sellErr.message?.includes('Output sanity check failed')) {
              result.failCount = 3;
            }
          }
          // Brief cooldown between token sells to avoid RPC rate limiting
          await new Promise(r => setTimeout(r, 5000));
          break;
        }

        case 'scam':
        case 'dust':
          logger.warn(`${deposit.classification} token detected: ${deposit.symbol} (${deposit.tokenAddress}) — ignoring`);
          result.action = `ignored_${deposit.classification}`;
          // Queue confirmed scam tokens for on-chain registry reporting (dust alone is not enough)
          if (deposit.classification === 'scam' && deposit.tokenAddress) {
            try {
              const tokenKey = `${deposit.network}:${deposit.tokenAddress.toLowerCase()}`;
              const tokenInfo = tokenScanner.knownTokens?.get(tokenKey);
              const confidence = tokenInfo?.scamConfidence || 0;
              const category = tokenInfo?.scamCategory || 7;
              if (confidence >= 50) {
                const scammerRegistry = (await import('../crypto/scammerRegistryService.js')).default;
                scammerRegistry.queueScamReport(deposit.tokenAddress, category, {
                  symbol: deposit.symbol, network: deposit.network, confidence,
                  reason: deposit.symbol
                });
              }
            } catch (queueErr) {
              logger.debug(`Scam report queue failed for ${deposit.symbol}: ${queueErr.message}`);
            }
          }
          break;

        default:
          logger.warn(`Unknown classification '${deposit.classification}' for ${deposit.symbol}`);
          result.action = 'ignored_unknown';
      }

      await this.recordProcessedDeposit(dedupKey, result);
      results.push(result);
    }

    if (deferredForTime > 0) {
      const skipped = deposits.length - results.length;
      logger.warn(`Deposit handler: bailed early — session budget low (${Math.round(this._remainingSessionMs() / 1000)}s remaining). ${skipped} deposit(s) deferred to next heartbeat.`);
    }

    // Update last known balances after processing
    await this.updateLastKnownBalances(deposits);

    await this.log('deposits_processed', {
      count: results.length,
      actions: results.map(r => `${r.deposit?.symbol || '?'}: ${r.action}`),
      deferredForTime
    });

    return results;
  }

  /**
   * Remaining wall-clock budget in the current session, vs the
   * SubAgentOrchestrator's 20-min hard cap. Used by long-running stages
   * (residual-sweep, deposit-scan) to bail gracefully before the cap
   * fires and the orchestrator logs a [TIMEOUT].
   *
   * Returns Infinity if the session start time hasn't been recorded —
   * never let an unset field cause us to skip work.
   */
  _remainingSessionMs() {
    if (!this._sessionStartedAt) return Infinity;
    const SESSION_CAP_MS = 20 * 60 * 1000; // mirror SubAgentOrchestrator.SESSION_TIMEOUT_MS
    return SESSION_CAP_MS - (Date.now() - this._sessionStartedAt);
  }

  /**
   * autoSellUnknownToken with a per-token deadline. Hung token sells
   * (RPC stuck, quoter never returns) used to consume the full 20-min
   * session and trigger the orchestrator [TIMEOUT]; now they cap at
   * `ms` (default 60s) and throw a typed AUTOSELL_TIMEOUT that callers'
   * existing catch blocks record as `auto_sell_failed`. The token
   * remains eligible for retry after the standard 24h cooldown — a
   * timeout is treated as transient, not as proof of unsellability.
   */
  async _autoSellWithTimeout(deposit, ms = 60000) {
    const symbol = deposit?.symbol || deposit?.tokenAddress || 'unknown';
    let timeoutHandle;
    try {
      return await Promise.race([
        this.autoSellUnknownToken(deposit),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const err = new Error(`auto-sell timeout (>${ms / 1000}s) for ${symbol}`);
            err.code = 'AUTOSELL_TIMEOUT';
            reject(err);
          }, ms);
        })
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Auto-sell an unknown safe token to stablecoin via V3/V2 routing
   */
  async autoSellUnknownToken(deposit) {
    const { network, tokenAddress, symbol, amount, decimals } = deposit;
    const result = { action: 'auto_sell_attempted', deposit };

    if (isSystemToken(network, tokenAddress)) {
      logger.info(`[AutoSell] ${symbol} (${tokenAddress}) is system-allowlisted — skipping auto-sell`);
      result.action = 'system_token_skipped';
      return result;
    }

    // Find stablecoin for this network
    const config = this.getConfig();
    const networkMode = config.networkMode || 'mainnet';
    const networkConfig = NETWORK_CONFIG[networkMode]?.[network];
    if (!networkConfig?.stablecoinAddress) {
      logger.warn(`No stablecoin configured for ${network} — skipping auto-sell`);
      result.action = 'no_stablecoin_configured';
      return result;
    }

    // Detect token tax to calibrate slippage and swap path
    let taxPercent = 0;
    let taxDetectionFailed = false;
    try {
      taxPercent = await swapService.detectTokenTax(tokenAddress, network);
      logger.info(`Token tax for ${symbol}: ${taxPercent}%`);
    } catch (err) {
      taxDetectionFailed = true;
      logger.debug(`Tax detection failed for ${symbol}: ${err.message}`);
    }

    // Quote-based slippage: start tight, let swap service retry-ladder handle reverts.
    // Base slippage = just enough for normal AMM variance + tax.
    // The swap service will retry with incremental +0.5% bumps up to maxSlippage on revert.
    let slippage, maxSlippage;
    if (taxDetectionFailed) {
      slippage = 3;       // Start cautious — retry ladder will find the right level
      maxSlippage = 20;   // Cap at 20% even for unknown tokens
    } else if (taxPercent === 0) {
      slippage = 1;       // Clean token — tight slippage, MEV-resistant
      maxSlippage = 5;    // Never exceed 5% for verified 0-tax tokens
    } else {
      slippage = taxPercent + 1;  // Just above tax
      maxSlippage = Math.min(taxPercent + 8, 30); // Reasonable ceiling
    }
    logger.info(`Auto-sell ${symbol}: slippage=${slippage}%, max=${maxSlippage}% (tax=${taxPercent}%, detection=${taxDetectionFailed ? 'failed' : 'ok'})`);
    const fullAmount = parseFloat(amount);

    // Use SupportingFeeOnTransfer variant for tokens with detected tax or unknown tax.
    // Clean tokens (0% verified tax) use standard swap path for better execution.
    const effectiveTax = taxDetectionFailed ? 50 : taxPercent;

    // Try progressively smaller sell amounts for low-liquidity pools
    // "Pancake: K" error means we're exceeding pool capacity
    // Goes down to 0.01% for micro-cap airdrop tokens with minimal liquidity
    const sellPercentages = [1.0, 0.5, 0.25, 0.10, 0.05, 0.01, 0.005, 0.001, 0.0001];

    const wrappedNative = {
      ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
    }[network];

    const isRateLimit = (msg) => msg?.includes('rate limit') || msg?.includes('429') || msg?.includes('Too Many');
    const isPoolError = (msg) => msg?.includes('Pancake: K') || msg?.includes('INSUFFICIENT_OUTPUT') || msg?.includes('ds-math-sub-underflow');
    const isNumericError = (msg) => msg?.includes('NUMERIC_FAULT') || msg?.includes('too many decimals') || msg?.includes('invalid FixedNumber') || msg?.includes('INVALID_ARGUMENT');
    const isNoPathError = (msg) => msg?.includes('No viable swap path') || msg?.includes('No route found');
    const isRevertError = (msg) => msg?.includes('reverted on-chain') || msg?.includes('execution reverted') || msg?.includes('CALL_EXCEPTION');
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    let revertCount = 0; // Track on-chain reverts — 2 reverts = honeypot, stop immediately

    // Helper: convert small float to fixed-point string (no scientific notation)
    const tokenDecimals = decimals || 18;
    const toFixedSafe = (num) => {
      if (num === 0) return '0';
      const s = num.toFixed(tokenDecimals);
      // Trim trailing zeros but keep at least one decimal
      return s.replace(/\.?0+$/, '') || '0';
    };

    // Pre-check: estimate output value and skip if not worth the gas.
    // Also capture expectedOutputUsd for the swap sanity check (prevents MEV/sandwich attacks).
    const MIN_SELL_VALUE_USD = network === 'bsc' ? 1 : network === 'polygon' ? 0.5 : 5;

    // Stablecoin decimals vary by network (USDC=6 on ETH/Polygon, USDT=18 on BSC)
    const stablecoinDecimals = { ethereum: 6, polygon: 6, bsc: 18 }[network] || 18;
    const quoteOpts = { decimalsIn: tokenDecimals, decimalsOut: stablecoinDecimals };
    const nativeQuoteOpts = { decimalsIn: tokenDecimals, decimalsOut: 18 }; // WETH/WBNB/WMATIC = 18 decimals

    let preQuoteUsd = 0; // Estimated USD value from quote — used as sanity floor in swap
    try {
      const quote = await swapService.getQuote(tokenAddress, networkConfig.stablecoinAddress, toFixedSafe(fullAmount), network, 'uniswapV2', quoteOpts);
      const quotedOut = parseFloat(quote?.amountOut || '0');
      preQuoteUsd = quotedOut; // Stablecoin output ≈ USD value
      if (quotedOut < MIN_SELL_VALUE_USD) {
        // Also try native path for tokens without stablecoin liquidity
        let nativeValueUsd = 0;
        if (wrappedNative) {
          try {
            const nativeQuote = await swapService.getQuote(tokenAddress, wrappedNative, toFixedSafe(fullAmount), network, 'uniswapV2', nativeQuoteOpts);
            const nativeOut = parseFloat(nativeQuote?.amountOut || '0');
            const nativePrice = this.scheduler?.cryptoPriceState?.get(network)?.price || 0;
            nativeValueUsd = nativeOut * nativePrice;
            if (nativeValueUsd > preQuoteUsd) preQuoteUsd = nativeValueUsd;
          } catch (_) { /* ignore */ }
        }
        if (nativeValueUsd < MIN_SELL_VALUE_USD) {
          logger.info(`[AutoSell] ${symbol}: value too low (stable=$${quotedOut.toFixed(2)}, native=$${nativeValueUsd.toFixed(2)}) — gas would exceed output, skipping`);
          result.action = 'skipped_gas_exceeds_value';
          return result;
        }
      }
      logger.info(`[AutoSell] ${symbol}: pre-quote=$${preQuoteUsd.toFixed(2)} — will enforce 70% sanity floor ($${(preQuoteUsd * 0.7).toFixed(2)})`);
    } catch (quoteErr) {
      // Quote failed — might still work with SupportingFeeOnTransfer, continue cautiously
      logger.debug(`[AutoSell] ${symbol} pre-quote failed: ${quoteErr.message} — proceeding with swap attempt`);
    }

    for (let i = 0; i < sellPercentages.length; i++) {
      const pct = sellPercentages[i];
      const rawAmount = fullAmount * pct;
      const sellAmount = toFixedSafe(rawAmount);

      // Skip if amount rounds to zero at this token's precision
      if (sellAmount === '0' || parseFloat(sellAmount) === 0) {
        logger.info(`[AutoSell] ${symbol} sell at ${(pct * 100).toFixed(2)}% rounds to 0 — amount too small, stopping`);
        break;
      }
      const pctLabel = pct >= 0.01 ? `${(pct * 100).toFixed(0)}%` : `${(pct * 100).toFixed(2)}%`;
      const hasMoreSteps = i < sellPercentages.length - 1;

      // Rate-limit backoff: wait between sell attempts to avoid RPC throttling
      if (i > 0) await delay(3000);

      // Try selling to stablecoin — use tight slippage with retry ladder
      // expectedOutputUsd scales proportionally to the sell percentage
      const expectedUsdForPct = preQuoteUsd > 0 ? preQuoteUsd * pct : 0;
      try {
        const swapResult = await swapService.swap(
          tokenAddress,
          networkConfig.stablecoinAddress,
          sellAmount,
          slippage,
          network,
          { gasCheck: true, tokenTaxPercent: effectiveTax, enableRetry: true, maxSlippage, expectedOutputUsd: expectedUsdForPct }
        );

        if (swapResult?.hash && swapResult.success !== false) {
          const received = parseFloat(swapResult.expectedOut || swapResult.amountOut || '0');
          logger.info(`Auto-sold ${pctLabel} of ${symbol} (${sellAmount}) → ${received.toFixed(4)} ${networkConfig.stablecoin} (tx: ${swapResult.hash})`);

          result.action = 'auto_sold_to_stablecoin';
          result.txHash = swapResult.hash;
          result.received = received;
          result.stablecoin = networkConfig.stablecoin;
          result.soldPercentage = pct;
          result.protocolVersion = swapResult.protocolVersion || 'unknown';

          await this.notifySwap({
            action: 'deposit_auto_sell',
            network,
            amountIn: parseFloat(sellAmount),
            amountOut: received,
            symbolIn: symbol,
            symbolOut: networkConfig.stablecoin,
            txHash: swapResult.hash,
            strategy: 'deposit_handler'
          });

          return result;
        } else if (swapResult?.hash && swapResult.success === false) {
          logger.warn(`[AutoSell] ${symbol} swap tx reverted on-chain (tx: ${swapResult.hash}) — treating as honeypot`);
          throw new Error(`Transaction reverted on-chain: ${swapResult.error || 'unknown'}`);
        }
      } catch (stableErr) {
        if (isNumericError(stableErr.message)) {
          logger.warn(`[AutoSell] ${symbol} amount too small for ethers.js at ${pctLabel} (${sellAmount}) — stopping`);
          break;
        }
        if (isRevertError(stableErr.message)) {
          revertCount++;
          if (revertCount >= 2) {
            logger.error(`[AutoSell] ${symbol} reverted ${revertCount} times — confirmed honeypot, stopping all attempts`);
            this._reportHoneypotToRegistry(tokenAddress, symbol, network, revertCount);
            result.action = 'auto_sell_failed';
            result.error = `Honeypot: ${revertCount} on-chain reverts`;
            result.failCount = 3; // Permanently blacklist
            return result;
          }
          logger.warn(`[AutoSell] ${symbol} stablecoin tx reverted (${revertCount}/2) — trying native fallback`);
        }
        if (isRateLimit(stableErr.message)) {
          logger.warn(`[AutoSell] ${symbol} RPC rate limited at ${pctLabel}, waiting 15s before retry...`);
          await delay(15000);
          i--; // retry same percentage
          continue;
        }
        if (isPoolError(stableErr.message) && hasMoreSteps) {
          logger.info(`[AutoSell] ${symbol} sell at ${pctLabel} too large for pool, trying smaller amount...`);
          continue;
        }

        // No swap path at all — bail after trying native fallback once
        if (isNoPathError(stableErr.message)) {
          logger.warn(`[sell-safe] ${symbol} has no stablecoin swap path — trying native fallback at 100% only`);
          // Skip directly to native fallback below, and if that also fails with no-path, bail completely
        }

        // Not a pool capacity error, or at smallest amount — try native fallback
        if (!isPoolError(stableErr.message) && !isNoPathError(stableErr.message) && !isRevertError(stableErr.message)) {
          logger.warn(`[sell-safe] ${symbol} stablecoin sell failed: ${stableErr.message?.slice(0, 120)}`);
        } else if (!hasMoreSteps) {
          logger.warn(`[sell-safe] ${symbol} stablecoin sell failed at minimum ${pctLabel} — pool too small`);
        }
      }

      await delay(2000); // Brief pause before native fallback

      // Fallback: sell to native token — same slippage ladder + sanity check
      if (wrappedNative) {
        try {
          const nativeSymbol = networkConfig.symbol;
          const swapResult = await swapService.swap(
            tokenAddress,
            wrappedNative,
            sellAmount,
            slippage,
            network,
            { gasCheck: true, tokenTaxPercent: effectiveTax, enableRetry: true, maxSlippage }
          );

          if (swapResult?.hash && swapResult.success !== false) {
            const received = parseFloat(swapResult.expectedOut || swapResult.amountOut || '0');
            logger.info(`Auto-sold ${pctLabel} of ${symbol} (${sellAmount}) → ${received.toFixed(6)} ${nativeSymbol} (fallback, tx: ${swapResult.hash})`);

            result.action = 'auto_sold_to_native';
            result.txHash = swapResult.hash;
            result.received = received;
            result.soldPercentage = pct;
            result.nativeSymbol = nativeSymbol;

            await this.notifySwap({
              action: 'deposit_auto_sell',
              network,
              amountIn: parseFloat(sellAmount),
              amountOut: received,
              symbolIn: symbol,
              symbolOut: nativeSymbol,
              txHash: swapResult.hash,
              strategy: 'deposit_handler'
            });

            return result;
          } else if (swapResult?.hash && swapResult.success === false) {
            logger.warn(`[AutoSell] ${symbol} native fallback tx reverted on-chain (tx: ${swapResult.hash}) — treating as honeypot`);
            throw new Error(`Transaction reverted on-chain: ${swapResult.error || 'unknown'}`);
          }
        } catch (nativeErr) {
          if (isNumericError(nativeErr.message)) {
            logger.warn(`[AutoSell] ${symbol} amount too small for ethers.js at ${pctLabel} (${sellAmount}) — stopping`);
            break;
          }
          if (isRevertError(nativeErr.message)) {
            revertCount++;
            if (revertCount >= 2) {
              logger.error(`[AutoSell] ${symbol} reverted ${revertCount} times (stablecoin+native) — confirmed honeypot, stopping`);
              this._reportHoneypotToRegistry(tokenAddress, symbol, network, revertCount);
              result.action = 'auto_sell_failed';
              result.error = `Honeypot: ${revertCount} on-chain reverts`;
              result.failCount = 3;
              return result;
            }
            logger.warn(`[AutoSell] ${symbol} native tx also reverted (${revertCount}/2) — will try smaller amount`);
          }
          if (isRateLimit(nativeErr.message)) {
            logger.warn(`[AutoSell] ${symbol} RPC rate limited on native fallback, waiting 15s...`);
            await delay(15000);
            i--; // retry same percentage
            continue;
          }
          // No swap path at all on native route too — token is dead, bail with blacklist signal
          if (isNoPathError(nativeErr.message)) {
            logger.error(`No viable swap path for ${symbol} on any route — token has no DEX liquidity, stopping`);
            result.action = 'auto_sell_failed';
            result.error = 'No viable swap path on any route — token has no DEX liquidity';
            result.failCount = 3;
            return result;
          }
          if (isPoolError(nativeErr.message) && hasMoreSteps) {
            logger.info(`[AutoSell] ${symbol} native sell at ${pctLabel} too large for pool, reducing...`);
            continue;
          }
          if (!isPoolError(nativeErr.message) && !isRevertError(nativeErr.message)) {
            logger.error(`Native fallback sell failed for ${symbol} at ${pctLabel}: ${nativeErr.message?.slice(0, 120)}`);
          }
        }
      }
    }

    // If we exhausted all percentages without the revert-count trigger, but had reverts, report anyway
    if (revertCount > 0) {
      this._reportHoneypotToRegistry(tokenAddress, symbol, network, revertCount);
    }

    logger.error(`All sell attempts failed for ${symbol} — pool may have no real liquidity`);
    result.action = 'auto_sell_failed';
    result.error = 'All sell percentages failed (100% → 0.01%)';
    return result;
  }

  /**
   * Report a confirmed honeypot/scam token to the on-chain scammer registry.
   */
  _reportHoneypotToRegistry(tokenAddress, symbol, network, revertCount = 0, category = 'honeypot') {
    try {
      import('../crypto/scammerRegistryService.js').then(mod => {
        const scammerRegistry = mod.default;
        const reason = revertCount > 0
          ? `Auto-sell reverted ${revertCount} times on-chain — transfer blocked (honeypot)`
          : `Detected as ${category} during residual sweep`;
        scammerRegistry.queueScamReport(tokenAddress, category, {
          symbol, network, confidence: revertCount >= 2 ? 90 : 70,
          reason
        });
        logger.info(`[ScamReport] Reported ${symbol} (${tokenAddress}) as ${category} to scammer registry`);
      }).catch(() => {});
    } catch { /* non-fatal */ }
  }

  /**
   * Check whether a token symbol matches a previously CONFIRMED honeypot
   * (an entry with permanent failCount and on-chain revert evidence).
   * Scam deployers redeploy the same token under new contract addresses
   * (same symbol/name) and re-airdrop it — each new address used to get a
   * fresh 2-revert sell attempt before being individually blacklisted.
   * Symbol match here is NOT a name heuristic: it propagates existing
   * hard evidence (reverted sells) across redeployments. Returns the
   * prior entry (with its address key) or null. Never matches the
   * 'UNKNOWN' placeholder; system-allowlisted tokens are excluded by
   * the isSystemToken check upstream of every caller.
   */
  _findConfirmedHoneypotBySymbol(symbol) {
    if (!symbol || symbol === 'UNKNOWN') return null;
    const processed = this.getState().depositTracking?.processedDeposits || {};
    for (const [key, entry] of Object.entries(processed)) {
      if (entry.symbol === symbol && (entry.failCount || 0) >= 3 &&
          /Honeypot|TRANSFER_FROM_FAILED/.test(entry.error || '')) {
        return { key, entry };
      }
    }
    return null;
  }

  /**
   * Record a processed deposit for dedup and tracking
   */
  async recordProcessedDeposit(key, result) {
    try {
      const state = this.getState();
      const tracking = state.depositTracking || { processedDeposits: {}, lastKnownBalances: {} };

      const prev = tracking.processedDeposits[key];
      const entry = {
        action: result.action,
        txHash: result.txHash || null,
        error: result.error || null,
        symbol: result.deposit?.symbol || prev?.symbol || null,
        timestamp: new Date().toISOString()
      };

      // Track consecutive full-failure count for residual sweep retry limiting
      // If caller explicitly set failCount (e.g., no-path = dead token), use that directly
      if (result.action === 'auto_sell_failed') {
        entry.failCount = result.failCount || ((prev?.action === 'auto_sell_failed' ? (prev.failCount || 1) : 0) + 1);
      }

      tracking.processedDeposits[key] = entry;

      // Auto-clean entries older than 7 days (but keep permanently-failed tokens forever)
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [k, v] of Object.entries(tracking.processedDeposits)) {
        if (new Date(v.timestamp).getTime() < sevenDaysAgo && !(v.failCount >= 3)) {
          delete tracking.processedDeposits[k];
        }
      }

      await this.updateState({ depositTracking: tracking });
    } catch (err) {
      logger.warn(`Failed to record processed deposit: ${err.message}`);
    }
  }

  /**
   * Update last known balances from processed deposits
   */
  async updateLastKnownBalances(deposits) {
    try {
      const state = this.getState();
      const tracking = state.depositTracking || { processedDeposits: {}, lastKnownBalances: {} };

      for (const deposit of deposits) {
        const network = deposit.network;
        if (!tracking.lastKnownBalances[network]) {
          tracking.lastKnownBalances[network] = {};
        }

        if (deposit.type === 'native') {
          tracking.lastKnownBalances[network].native = deposit.currentBalance;
        } else if (deposit.tokenAddress) {
          tracking.lastKnownBalances[network][deposit.tokenAddress.toLowerCase()] = deposit.currentBalance;
        }
      }

      await this.updateState({ depositTracking: tracking });
    } catch (err) {
      logger.warn(`Failed to update last known balances: ${err.message}`);
    }
  }

  async notifySwap({ action, network, amountIn, amountOut, symbolIn, symbolOut, txHash, gain, strategy }) {
    // Always journal the swap — the daily report tallies from this log, so it
    // must capture every event the per-trade notification used to announce.
    // Convention: `gain` is denominated in symbolOut units (USD-stable for
    // token_trader sells, native units for DM buy-backs).
    try {
      await this._appendSwapLog({
        ts: new Date(),
        action,
        network,
        strategy: strategy || 'unknown',
        amountIn: parseFloat(amountIn) || 0,
        amountOut: parseFloat(amountOut) || 0,
        symbolIn,
        symbolOut,
        gain: gain !== undefined && gain !== null ? parseFloat(gain) : null,
        txHash
      });
    } catch (err) {
      logger.warn(`Failed to journal swap event: ${err.message}`);
    }

    // Per-trade Telegram pings are opt-in (swapNotifications) — the daily
    // report carries the tally instead.
    if (this.getConfig().swapNotifications !== true) return;

    try {
      const telegram = this.mainAgent?.interfaces?.get('telegram');
      if (!telegram || !telegram.sendNotification) return;

      const explorers = {
        'ethereum': 'https://etherscan.io',
        'sepolia': 'https://sepolia.etherscan.io',
        'bsc': 'https://bscscan.com',
        'bsc-testnet': 'https://testnet.bscscan.com',
        'polygon': 'https://polygonscan.com',
        'amoy': 'https://amoy.polygonscan.com'
      };
      const explorer = explorers[network] || explorers['ethereum'];
      const txUrl = `${explorer}/tx/${txHash}`;

      let emoji = action === 'sold_to_stablecoin' ? '📉' : '📈';
      let actionLabel;
      if (action === 'sold_to_stablecoin') actionLabel = 'Sold to stablecoin';
      else if (action === 'bought_native') actionLabel = 'Bought native';
      else if (action === 'dca_buy') { actionLabel = 'DCA Buy'; emoji = '🔄'; }
      else actionLabel = action.replace(/_/g, ' ');

      // Escape underscores for Telegram Markdown parsing
      const safeStrategy = (strategy || 'unknown').replace(/_/g, ' ');
      let msg = `${emoji} *Crypto Swap Executed*\n`;
      msg += `*Strategy:* ${safeStrategy}\n`;
      msg += `*Action:* ${actionLabel}\n`;
      // Format amounts: show full precision for small values, round for larger
      const fmtAmount = (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n === 0) return '0';
        if (n >= 1) return n.toFixed(2);
        if (n >= 0.01) return n.toFixed(4);
        return n.toFixed(6);
      };

      msg += `*Network:* ${network}\n`;
      msg += `*Sent:* ${fmtAmount(amountIn)} ${symbolIn}\n`;
      msg += `*Received:* ${fmtAmount(amountOut)} ${symbolOut}\n`;
      if (gain !== undefined && gain !== null) {
        const gainEmoji = gain > 0 ? '✅' : '⚠️';
        msg += `*P&L:* ${gainEmoji} ${gain > 0 ? '+' : ''}${fmtAmount(gain)} ${symbolOut}\n`;
      }
      msg += `\n[View Transaction](${txUrl})`;

      await telegram.sendNotification(msg, { parse_mode: 'Markdown' });
      logger.info(`Telegram swap notification sent for ${action} on ${network}`);
    } catch (err) {
      logger.warn(`Failed to send Telegram swap notification: ${err.message}`);
    }
  }

  /**
   * Atomically append a swap event to the persisted state.swapLog (capped).
   * $push+$slice avoids the read-modify-write race that updateState() would
   * have if two swaps landed in the same heartbeat.
   */
  async _appendSwapLog(event) {
    const SubAgent = this.agentDoc.constructor;
    const updated = await SubAgent.findByIdAndUpdate(
      this.agentDoc._id,
      { $push: { 'state.domainState.swapLog': { $each: [event], $slice: -300 } } },
      { new: true }
    );
    if (updated) {
      this.agentDoc.state.domainState = updated.state.domainState;
      this.agentDoc.__v = updated.__v;
    }
  }

  /**
   * Record trade for learning
   */
  async recordTrade(decision, result) {
    // A "trade" is a trade. The primary-strategy call site used to invoke this on every
    // heartbeat, including the ticks that decided to do nothing, and the counter below
    // incremented on `result.success` — which a hold also reports. That is how
    // domainState reached 24,748 "executed" against 25,451 "proposed": both were tick
    // counts wearing trade labels, and the ratio they implied (a 97% fill rate) was
    // meaningless. TokenTraderHeartbeatManager already gates its own call this way; the
    // gate lives here now so no future call site can forget it.
    const isRealTrade = Boolean(result?.action) && result.action !== 'hold';
    if (!isRealTrade) return;

    this.tradeJournal.push({
      timestamp: new Date(),
      strategy: decision.strategy,
      network: decision.network,
      confidence: decision.confidence,
      result,
      success: result.success
    });

    // Keep last 100 trades
    if (this.tradeJournal.length > 100) {
      this.tradeJournal.shift();
    }

    // Determine if this is a token trader trade or primary strategy trade
    const isTokenTrader = decision.strategy === 'token_trader';

    // Persist trade counters to state — separate primary vs token trader
    const state = this.getState();
    const updates = {
      lastExecution: {
        timestamp: new Date().toISOString(),
        results: [{
          network: decision.network,
          direction: decision.direction || result.action,
          success: result.success,
          strategy: decision.strategy,
          ...(result.txHash && { txHash: result.txHash }),
          ...(result.error && { error: result.error })
        }]
      }
    };

    if (isTokenTrader) {
      // Token trader counters (separate namespace)
      updates.tokenTraderTradesExecuted = (state.tokenTraderTradesExecuted || 0) + (result.success ? 1 : 0);
      updates.tokenTraderTradesProposed = (state.tokenTraderTradesProposed || 0) + 1;
      // NOTE: this branch used to maintain `updates.tokenTraderPnL`, a running total
      // added up trade by trade. It drifted — by 2026-08-20 it read -$100.76 against a
      // true +$150.80 — and every consumer has since moved to an authoritative source:
      // getStatus() sums each trader's own pnl.lifetimeRealized, and the daily report
      // computes from live instance data. Maintaining a second, independently-drifting
      // copy of a number we can read exactly is how the $251 discrepancy happened, so
      // it is no longer written. The stale field is removed from persisted state.
      // (no write — the stale persisted field is cleared out-of-band, once.)
    } else {
      // Primary strategy counters
      updates.tradesExecuted = (state.tradesExecuted || 0) + (result.success ? 1 : 0);
      updates.tradesProposed = (state.tradesProposed || 0) + 1;
      if (result.success && result.gain) {
        updates.totalPnL = (state.totalPnL || 0) + result.gain;
      }
    }

    try {
      await this.updateState(updates);
    } catch (err) {
      logger.warn('Failed to persist trade counters:', err.message);
    }

    // Mirror onto the strategy instance's own state. Only DCAStrategy ever called
    // BaseStrategy.recordTrade(), so every other strategy — dollar_maximizer included —
    // reported `tradesExecuted: 0` forever while its `tradesProposed` climbed, and
    // StrategyRegistry published the resulting 0/702 as a "0.0%" success rate. The
    // execution figure at /api/crypto/strategy/status is the one an audit reads first;
    // it has to come from the same event that moves the money.
    try {
      const strategyInstance = this.strategies?.get(decision.strategy)
        || strategyRegistry.get(decision.strategy);
      if (typeof strategyInstance?.recordTrade === 'function') {
        strategyInstance.recordTrade({
          strategy: decision.strategy,
          network: decision.network,
          action: decision.action || result.action,
          success: result.success !== false,
          pnl: Number.isFinite(result.gain) ? result.gain : undefined,
          ...(result.txHash && { txHash: result.txHash })
        });
      }
    } catch (err) {
      // Bookkeeping must never be able to break the trade path it is recording.
      logger.warn('Failed to mirror trade onto strategy state:', err.message);
    }
  }

  // ==================== API METHODS (for WebUI control) ====================

  /**
   * Enable the agent
   */
  async enable() {
    this.agentDoc.enabled = true;
    await this.agentDoc.save();

    // Schedule with Agenda if scheduler is available
    await this.scheduleAgendaJob();

    // Start per-token heartbeats
    if (this.tokenHeartbeatManager) {
      this.tokenHeartbeatManager.startAll();
    }

    logger.info(`Crypto Strategy Agent enabled`);
    return { success: true, message: 'Crypto strategy agent enabled' };
  }

  /**
   * Disable the agent
   */
  async disable() {
    this.agentDoc.enabled = false;
    await this.agentDoc.save();

    // Stop per-token heartbeats
    if (this.tokenHeartbeatManager) {
      await this.tokenHeartbeatManager.stopAll();
    }

    // Cancel Agenda job if scheduler is available
    await this.cancelAgendaJob();

    logger.info(`Crypto Strategy Agent disabled`);
    return { success: true, message: 'Crypto strategy agent disabled' };
  }

  /**
   * Emergency stop - halt all trading
   */
  async emergencyStop() {
    const config = this.getConfig();
    config.emergencyStop = true;
    await this.updateConfig({ emergencyStop: true });

    logger.warn('Crypto Strategy Agent: EMERGENCY STOP activated');
    return { success: true, message: 'Emergency stop activated' };
  }

  /**
   * Clear emergency stop
   */
  async clearEmergencyStop() {
    await this.updateConfig({ emergencyStop: false });

    logger.info('Crypto Strategy Agent: Emergency stop cleared');
    return { success: true, message: 'Emergency stop cleared' };
  }

  /**
   * Update agent configuration
   */
  async updateConfig(updates) {
    const currentConfig = this.agentDoc.config.domainConfig || {};
    const prevReportTime = currentConfig.dailyReportTime;
    this.agentDoc.config.domainConfig = {
      ...currentConfig,
      ...updates
    };
    await this.agentDoc.save();

    logger.info('Crypto Strategy Agent config updated:', Object.keys(updates));

    // Re-pin the daily-report agenda job when its time changes
    if (updates.dailyReportTime !== undefined && updates.dailyReportTime !== prevReportTime) {
      try {
        await this.scheduler?.scheduleCryptoDailyReport?.();
      } catch (err) {
        logger.warn(`Failed to reschedule crypto daily report: ${err.message}`);
      }
    }

    return { success: true, config: this.agentDoc.config.domainConfig };
  }

  /**
   * Set network mode (testnet/mainnet)
   */
  async setNetworkMode(mode) {
    if (!['testnet', 'mainnet'].includes(mode)) {
      throw new Error('Invalid network mode. Must be "testnet" or "mainnet"');
    }

    await this.updateConfig({ networkMode: mode });

    logger.info(`Crypto Strategy Agent network mode set to: ${mode}`);
    return { success: true, networkMode: mode };
  }

  /**
   * Update position state for a network
   */
  async updatePosition(network, positionData) {
    const { inStablecoin, entryPrice, stablecoinAmount } = positionData;

    const newPosition = {
      inStablecoin: !!inStablecoin,
      entryPrice: entryPrice || null,
      stablecoinAmount: stablecoinAmount || 0,
      timestamp: new Date()
    };

    await this._persistPosition(network, newPosition);

    logger.info(`Position updated for ${network}:`, newPosition);
    return { success: true, network, position: newPosition };
  }

  /**
   * Get positions for all networks
   */
  getPositions() {
    const state = this.getState();
    return state.positions || {};
  }

  /**
   * Get trade journal — returns recent executed trades from the in-memory tradeJournal
   * populated by recordTrade(). The legacy state.decisionJournal field is unused
   * (recordDecision is defined but not wired up anywhere).
   */
  getJournal(limit = 20) {
    return (this.tradeJournal || []).slice(-limit);
  }

  /**
   * Record a decision to the journal
   */
  async recordDecision(decision, marketData) {
    const state = this.getState();
    const journal = state.decisionJournal || [];

    journal.push({
      timestamp: new Date(),
      decision,
      marketSnapshot: {
        prices: Object.fromEntries(
          Object.entries(marketData.prices || {}).map(([k, v]) => [k, v.price])
        )
      }
    });

    // Keep last 100 entries
    if (journal.length > 100) {
      journal.shift();
    }

    await this.updateState({ decisionJournal: journal });
  }

  // ==================== STRATEGY MANAGEMENT ====================

  /**
   * List all available strategies
   */
  listStrategies() {
    // Return both built-in strategies and registry strategies
    const builtIn = Array.from(this.strategies.entries()).map(([name, strategy]) => ({
      name,
      description: strategy.description,
      source: 'built-in'
    }));

    const registry = strategyRegistry.list().map(s => ({
      ...s,
      source: 'registry'
    }));

    return [...builtIn, ...registry];
  }

  /**
   * Get active strategy
   */
  getActiveStrategy() {
    const config = this.getConfig();
    const activeStrategyName = config.activeStrategy || config.enabledStrategies?.[0] || 'native_maximizer';

    // Check registry first
    const registryStrategy = strategyRegistry.getActive();
    if (registryStrategy) {
      return registryStrategy.getInfo();
    }

    // Fall back to built-in
    const builtIn = this.strategies.get(activeStrategyName);
    if (builtIn) {
      return {
        name: activeStrategyName,
        description: builtIn.description,
        source: 'built-in'
      };
    }

    return null;
  }

  /**
   * Switch to a different strategy
   */
  async switchStrategy(strategyName) {
    // Update registry if strategy exists there
    try {
      strategyRegistry.setActive(strategyName);
    } catch (e) {
      // Strategy might not be in registry, check built-in
      if (!this.strategies.has(strategyName)) {
        throw new Error(`Strategy '${strategyName}' not found`);
      }
    }

    // Update agent config
    await this.updateConfig({
      activeStrategy: strategyName,
      enabledStrategies: [strategyName]
    });

    logger.info(`Switched to strategy: ${strategyName}`);
    return { success: true, strategy: strategyName };
  }

  /**
   * Get strategy info by name
   */
  getStrategyInfo(name) {
    // Check registry first
    const registryInfo = strategyRegistry.getInfo(name);
    if (registryInfo) {
      return registryInfo;
    }

    // Check built-in
    const builtIn = this.strategies.get(name);
    if (builtIn) {
      return {
        name,
        description: builtIn.description,
        source: 'built-in'
      };
    }

    return null;
  }

  /**
   * Update strategy config
   */
  async updateStrategyConfig(strategyName, config) {
    const result = strategyRegistry.updateConfig(strategyName, config);

    // Also save to our config
    const currentConfig = this.getConfig();
    const strategyConfigs = currentConfig.strategyConfigs || {};
    strategyConfigs[strategyName] = {
      ...(strategyConfigs[strategyName] || {}),
      ...config
    };
    await this.updateConfig({ strategyConfigs });

    return result;
  }

  /**
   * Get performance comparison across all strategies
   */
  getStrategyPerformance() {
    return strategyRegistry.getPerformanceComparison();
  }

  /**
   * Seed price history for volatility-based strategies using CoinGecko data
   */
  async seedPriceHistory(strategyName = 'volatility_adjusted') {
    const strategy = strategyRegistry.get(strategyName);
    if (!strategy) {
      throw new Error(`Strategy '${strategyName}' not found in registry`);
    }

    if (!strategy.state.priceHistory) {
      throw new Error(`Strategy '${strategyName}' does not use price history`);
    }

    const config = this.getConfig();
    const networkMode = config.networkMode || 'mainnet';
    if (networkMode !== 'mainnet') {
      throw new Error('Price history seeding only available for mainnet');
    }

    const coins = [
      { id: 'ethereum', network: 'ethereum', symbol: 'ETH', pair: 'ETH/USD' },
      { id: 'binancecoin', network: 'bsc', symbol: 'BNB', pair: 'BNB/USD' },
      { id: 'matic-network', network: 'polygon', symbol: 'MATIC', pair: 'MATIC/USD' }
    ];

    const results = {};

    for (const coin of coins) {
      try {
        const url = `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=usd&days=1`;
        const response = await fetch(url);

        if (!response.ok) {
          results[coin.network] = { success: false, error: `HTTP ${response.status}` };
          continue;
        }

        const data = await response.json();
        const prices = data.prices;

        if (!prices || prices.length === 0) {
          results[coin.network] = { success: false, error: 'No price data returned' };
          continue;
        }

        const key = `${networkMode}:${coin.network}:${coin.pair}`;

        if (!strategy.state.priceHistory[key]) {
          strategy.state.priceHistory[key] = [];
        }

        let addedCount = 0;
        for (const [timestamp, price] of prices) {
          strategy.state.priceHistory[key].push({ price, timestamp });
          addedCount++;
        }

        const maxPoints = (strategy.config?.minDataPoints || 12) * 2;
        if (strategy.state.priceHistory[key].length > maxPoints) {
          strategy.state.priceHistory[key] = strategy.state.priceHistory[key].slice(-maxPoints);
        }

        logger.info(`Seeded ${addedCount} price points for ${coin.symbol} on ${coin.network}`);
        results[coin.network] = {
          success: true,
          dataPoints: strategy.state.priceHistory[key].length,
          latestPrice: prices[prices.length - 1][1]
        };

        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        logger.error(`Error seeding ${coin.id}: ${error.message}`);
        results[coin.network] = { success: false, error: error.message };
      }
    }

    return { success: true, strategy: strategyName, networkMode, results };
  }

  /**
   * Adjust config for current volatility
   */
  async adjustConfigForVolatility() {
    const activeStrategy = strategyRegistry.getActive();
    if (!activeStrategy) {
      return { success: false, error: 'No active strategy' };
    }

    const volatilityData = activeStrategy.state?.volatility || {};
    if (Object.keys(volatilityData).length === 0) {
      return { success: false, error: 'No volatility data available' };
    }

    // Calculate average volatility across networks
    const volatilities = Object.values(volatilityData).map(v => v.value || 0).filter(v => v > 0);
    if (volatilities.length === 0) {
      return { success: false, error: 'No valid volatility values' };
    }
    const avgVolatility = volatilities.reduce((a, b) => a + b, 0) / volatilities.length;

    // Determine regime
    let regime = 'normal';
    if (avgVolatility < 30) regime = 'low';
    else if (avgVolatility > 70) regime = 'high';

    const config = this.getConfig();
    const oldConfig = {
      maxTradePercentage: config.maxTradePercentage || 10,
      slippageTolerance: config.slippageTolerance || 1
    };

    // Adjust based on volatility
    let newMaxTrade, newSlippage;
    if (regime === 'low') {
      newMaxTrade = Math.min(oldConfig.maxTradePercentage * 1.3, 30);
      newSlippage = Math.max(oldConfig.slippageTolerance * 0.7, 0.5);
    } else if (regime === 'high') {
      newMaxTrade = Math.max(oldConfig.maxTradePercentage * 0.5, 5);
      newSlippage = Math.min(oldConfig.slippageTolerance * 2, 5);
    } else {
      newMaxTrade = oldConfig.maxTradePercentage;
      newSlippage = oldConfig.slippageTolerance;
    }

    await this.updateConfig({
      maxTradePercentage: Math.round(newMaxTrade),
      slippageTolerance: Math.round(newSlippage * 10) / 10
    });

    logger.info(`Config adjusted for volatility: regime=${regime}, avgVol=${avgVolatility.toFixed(1)}%`);

    return {
      success: true,
      regime,
      avgVolatility,
      old: oldConfig,
      new: { maxTradePercentage: newMaxTrade, slippageTolerance: newSlippage }
    };
  }

  // ==================== SCHEDULING ====================

  /**
   * Set schedule interval (uses Agenda)
   */
  async setScheduleInterval(intervalMinutes) {
    if (intervalMinutes < 1) {
      throw new Error('Interval must be at least 1 minute');
    }

    await this.updateConfig({ intervalMinutes });

    // Update schedule pattern
    this.agentDoc.schedule = this.agentDoc.schedule || {};
    this.agentDoc.schedule.runPattern = `${intervalMinutes}m`;
    this.agentDoc.schedule.nextRunAt = new Date(Date.now() + intervalMinutes * 60 * 1000);
    await this.agentDoc.save();

    // Reschedule Agenda job
    await this.scheduleAgendaJob();

    logger.info(`Schedule interval set to ${intervalMinutes} minutes`);
    return { success: true, intervalMinutes };
  }

  /**
   * Get schedule info
   */
  getScheduleInfo() {
    const config = this.getConfig();
    return {
      intervalMinutes: config.intervalMinutes || 60,
      runPattern: this.agentDoc.schedule?.runPattern || 'event-driven',
      eventTriggers: this.agentDoc.schedule?.eventTriggers || [],
      nextRunAt: this.agentDoc.schedule?.nextRunAt,
      lastRunAt: this.agentDoc.schedule?.lastRunAt,
      enabled: this.agentDoc.enabled
    };
  }

  /**
   * Configure event-driven execution (replaces old blind timer)
   */
  async scheduleAgendaJob() {
    const scheduler = this.mainAgent?.scheduler;
    if (!scheduler?.agenda) {
      logger.warn('Scheduler not available for event-driven setup');
      return;
    }

    // Cancel old blind-timer job
    await scheduler.agenda.cancel({ name: 'crypto-strategy-agent' });

    // Set event triggers for event-driven execution
    const requiredTriggers = ['crypto:significant_move', 'crypto:high_volatility', 'crypto:heartbeat', 'manual'];
    const currentTriggers = this.agentDoc.schedule?.eventTriggers || [];
    const needsUpdate = !requiredTriggers.every(t => currentTriggers.includes(t));

    if (needsUpdate) {
      this.agentDoc.schedule.eventTriggers = requiredTriggers;
      this.agentDoc.schedule.runPattern = 'event-driven';
      // Lower cooldown for event-driven responsiveness
      if (this.agentDoc.config.cooldownMinutes > 10) {
        this.agentDoc.config.cooldownMinutes = 5;
      }
      await this.agentDoc.save();
    }

    logger.info('CryptoStrategyAgent configured for event-driven execution (price monitor + heartbeat)');
  }

  /**
   * Cancel Agenda job
   */
  async cancelAgendaJob() {
    const scheduler = this.mainAgent?.scheduler;
    if (!scheduler?.agenda) return;

    await scheduler.agenda.cancel({ name: 'crypto-strategy-agent' });
    logger.info('Cancelled crypto-strategy-agent Agenda job');
  }

  /**
   * Trigger a manual run
   */
  async triggerRun() {
    logger.info('Manual trigger requested for Crypto Strategy Agent');

    try {
      const result = await this.execute();
      return { success: true, result };
    } catch (error) {
      logger.error('Manual trigger failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get comprehensive agent status (matches legacy format)
   */

  /**
   * Sum lifetime realized P&L across every registered token trader.
   *
   * Authoritative counterpart to the drifted state.tokenTraderPnL accumulator; mirrors
   * how revenueService.updateTodayPnL() reads the same figure so the API and the ledger
   * cannot disagree.
   *
   * @returns {number|null} total lifetime realized, or null when no trader is registered
   *                        (null, not 0, so callers can tell "nothing registered" apart
   *                        from "registered and flat")
   */
  /**
   * Stablecoin on `network` that belongs to the token trader(s), not to DollarMaximizer.
   *
   * Both strategies spend from ONE wallet. The token trader is allotted
   * capitalAllocationPercent of that network's capital and parks the undeployed part of
   * its allotment in `stablecoinReserve`. DM, meanwhile, reconciles its position straight
   * from the wallet balance, so it counted the trader's reserve as its own dry powder:
   * on 2026-08-20 DM believed it held $1967 of deployable stablecoin when $1054 of that
   * was the grid's buy side. Nothing enforced the split — DM simply had silent first
   * claim, and since a DM buy-back spends its ENTIRE recorded stablecoin position, one
   * re-entry could have consumed the grid's working capital outright.
   *
   * Only the reserve is claimed here. The trader's deployed capital is already held as
   * tokens, so it is not part of the stablecoin pot being divided.
   *
   * @param {string} network
   * @returns {number} stablecoin claimed by token traders on this network (0 on any error)
   */
  getTokenTraderStableClaim(network) {
    try {
      let claimed = 0;
      for (const [, instance] of strategyRegistry.getAllTokenTraders()) {
        if (instance?.config?.tokenNetwork !== network) continue;
        const reserve = parseFloat(instance.state?.stablecoinReserve) || 0;
        if (reserve > 0) claimed += reserve;
      }
      return claimed;
    } catch {
      return 0;
    }
  }

  /**
   * Stablecoin on `network` that DollarMaximizer may actually deploy.
   * Never negative: if the traders' allotment covers the whole pot, DM's share is zero
   * and it must not trade, which is the correct outcome rather than an overdraft.
   */
  /**
   * Classify a sell decision into the bucket the exit-quality report aggregates on.
   * Order matters: the specific triggers all also carry isEmergency (it bypasses the
   * min-profit filter), so emergency must be tested LAST or it would swallow them.
   */
  _classifyExitTrigger(decision = {}) {
    if (decision.isTrailingStop || decision.isTrailingStopTranche) return 'trailing_stop';
    if (decision.isDowntrendExit || decision.isDowntrendExitTranche) return 'downtrend_exit';
    if (decision.isStopLossTranche) return 'stop_loss';
    if (decision.isTrancheSell) return 'tranche_scalp';
    if (decision.isScaleOut) return 'scale_out';
    const reason = String(decision.reason || '').toLowerCase();
    if (reason.includes('scale-out')) return 'scale_out';
    if (reason.includes('dump')) return 'dump';
    if (decision.isGrid) return 'grid_sell';
    if (decision.isEmergency) return 'emergency';
    return 'other';
  }

  /**
   * Persist one exit record. Best-effort by design — see the call site.
   */
  async _recordExitForensics(args) {
    const { tokenStrategy, tradeDecision, exitCtx, tokensSold, proceeds,
            exitPrice, pnl, gasCostUsd, network, tokenSymbol } = args;
    if (!(exitPrice > 0)) return;

    const { default: CryptoExitRecord } = await import('../../models/CryptoExitRecord.js');
    const remaining = tokenStrategy?.state?.tokenBalance ?? null;
    const now = new Date();

    await CryptoExitRecord.create({
      date: now.toISOString().slice(0, 10),
      exitedAt: now,
      tokenSymbol: tokenSymbol || tokenStrategy?.config?.tokenSymbol || 'UNKNOWN',
      tokenAddress: tokenStrategy?.config?.tokenAddress || null,
      network: network || tokenStrategy?.config?.tokenNetwork || null,
      trigger: this._classifyExitTrigger(tradeDecision),
      reason: tradeDecision?.reason || null,
      exitPrice,
      tokensSold: tokensSold ?? null,
      proceeds: proceeds ?? null,
      pnl: Number.isFinite(pnl) ? pnl : null,
      gasCostUsd: gasCostUsd || 0,
      avgEntryAtExit: exitCtx?.avgEntry ?? null,
      peakPriceAtExit: exitCtx?.peak ?? null,
      trailingStopAtExit: exitCtx?.trailStop ?? null,
      regimeAtExit: exitCtx?.regime ?? null,
      tokensRemainingAfter: remaining,
      fullExit: Number.isFinite(remaining) ? remaining * exitPrice < 3 : false
    });
  }

  /**
   * Stamp elapsed outcome horizons on past exits using a price we already have.
   *
   * Called from the crypto heartbeat, so it costs no extra RPC: the caller passes the
   * price it just fetched. An exit is only judged once every horizon it is due for has
   * been filled; horizonsComplete then takes it out of the query for good.
   */
  async backfillExitHorizons(tokenSymbol, currentPrice) {
    if (!(currentPrice > 0) || !tokenSymbol) return 0;
    try {
      const { default: CryptoExitRecord } = await import('../../models/CryptoExitRecord.js');
      const pending = await CryptoExitRecord.find({ tokenSymbol, horizonsComplete: false }).limit(200);
      if (!pending.length) return 0;

      const now = Date.now();
      const HORIZONS = [['priceAfter1h', 3600e3], ['priceAfter4h', 4 * 3600e3], ['priceAfter24h', 24 * 3600e3]];
      let stamped = 0;

      for (const rec of pending) {
        const age = now - new Date(rec.exitedAt).getTime();
        let dirty = false;
        for (const [field, ms] of HORIZONS) {
          if (rec[field] == null && age >= ms) {
            rec[field] = currentPrice;
            // Stamp WHEN, so the report can tell a prompt sample from one taken hours late.
            rec[`${field}At`] = new Date();
            dirty = true;
          }
        }
        // Only complete once the LAST horizon is actually filled, not merely elapsed —
        // a restart that skips a window must not permanently blind the 24h column.
        if (rec.priceAfter1h != null && rec.priceAfter4h != null && rec.priceAfter24h != null) {
          rec.horizonsComplete = true; dirty = true;
        }
        if (dirty) { await rec.save(); stamped++; }
      }
      if (stamped) logger.debug(`Exit forensics: stamped horizons on ${stamped} ${tokenSymbol} exit(s)`);
      return stamped;
    } catch (err) {
      logger.debug(`Exit horizon backfill skipped: ${err.message}`);
      return 0;
    }
  }

  /**
   * Refuse to execute a trade larger than the strategy decided.
   *
   * The 2026-08-21 loss (-$290.61) happened because a decision for $341.68 executed as
   * $1,004.93 and nothing compared the two numbers. DollarMaximizer's buy path carries its
   * own inline version of this check; this is the shared form used by the token trader's
   * buy and sell paths, which had no such check at all despite a -$461.79 worst day.
   *
   * Returns the size to actually use: `actual` when it is within tolerance, otherwise
   * `decided`. Clamping rather than only warning, because the strategy's own decision is the
   * authority — the cap can never suppress intended activity, only an overspend nobody asked
   * for. Tolerance is 1% or `floor` (whichever is larger) so ordinary rounding, balance
   * adjustment and native-conversion drift do not cry wolf.
   *
   * @returns {number} the size to execute with
   */
  async enforceTradeSize({ label, network, decided, actual, unit, floor = 1, strategy = 'token_trader' }) {
    const d = parseFloat(decided);
    const a = parseFloat(actual);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(a)) return a;

    const overBy = a - d;
    if (overBy <= Math.max(d * 0.01, floor)) return a;

    logger.error(
      `TRADE SIZE DIVERGENCE [${strategy}/${label}] on ${network}: decided ${d.toFixed(6)} ${unit} ` +
      `but execution was about to use ${a.toFixed(6)} ${unit} (+${overBy.toFixed(6)}, ` +
      `${((a / d - 1) * 100).toFixed(1)}%). Capping to the decided size.`
    );
    try {
      await this.notifySwap({
        action: 'trade_size_divergence_blocked',
        network,
        amountIn: a,
        amountOut: d,
        symbolIn: unit,
        symbolOut: unit,
        strategy
      });
    } catch (notifyErr) {
      logger.warn(`Size-divergence alert could not be sent: ${notifyErr.message}`);
    }
    return d;
  }

  getDmAvailableStable(network, walletStable) {
    const wallet = parseFloat(walletStable) || 0;
    const claimed = this.getTokenTraderStableClaim(network);
    if (claimed <= 0) return wallet;
    const available = Math.max(0, wallet - claimed);
    if (available <= 0 && wallet > 0) {
      logger.info(`DollarMaximizer [${network}]: no deployable stablecoin — the full $${wallet.toFixed(2)} is allotted to the token trader (reserve $${claimed.toFixed(2)})`);
    }
    return available;
  }

  /**
   * Populate the P&L figures the status endpoint displays.
   *
   * `dailyPnL` fell back to domainState.dailyPnL — a stale 0 — for the ~15 minutes
   * between a restart and revenueService's next cycle, so a day's earnings read as
   * nothing while the ledger held the real figure. Called at init and on every
   * execution, so the window closes instead of waiting for a heartbeat.
   *
   * READ ONLY, deliberately. It must never call revenueService.updateTodayPnL(): at
   * init the token traders may not be registered yet, so that would compute a lifetime
   * total of 0 and write a phantom daily loss equal to everything ever earned — the
   * precise failure the DM accounting was designed around.
   *
   * @returns {Promise<boolean>} whether anything was populated
   */
  /**
   * Retry refreshPnLCaches() until it populates, briefly and in the background.
   *
   * Deliberately NOT awaited by initialize(): warming a display cache must never hold
   * up the boot chain. Bounded so a permanently empty ledger cannot leave a timer
   * running for the life of the process.
   */
  _primePnLCaches(attempt = 1) {
    const MAX_ATTEMPTS = 12;
    const INTERVAL_MS = 5000;
    this.refreshPnLCaches()
      .then((ok) => {
        if (ok) {
          logger.info(`Crypto P&L display cache primed on attempt ${attempt} (daily $${Number(this._cachedDailyPnL ?? 0).toFixed(4)}, lifetime $${Number(this._cachedTTTotalPnL ?? 0).toFixed(4)})`);
          return;
        }
        if (attempt >= MAX_ATTEMPTS) {
          logger.warn(`Crypto P&L display cache still empty after ${MAX_ATTEMPTS} attempts — the status endpoint will show zeros until the first strategy execution`);
          return;
        }
        // An uncaught throw inside a setTimeout callback takes the whole process down,
        // and this runs on the boot chain. A display-cache warmer must never be able to
        // kill the agent, so the retry is wrapped rather than trusted.
        const timer = setTimeout(() => {
          try {
            this._primePnLCaches(attempt + 1);
          } catch (err) {
            logger.warn(`Crypto P&L display cache retry failed: ${err.message}`);
          }
        }, INTERVAL_MS);
        if (typeof timer.unref === 'function') timer.unref();
      })
      .catch(() => { /* non-critical */ });
  }

  async refreshPnLCaches() {
    try {
      const revService = (await import('../crypto/revenueService.js')).default;
      const todayPnL = revService.getTodayPnLSummary();
      // `updatedAt`, NOT `dailyNet !== undefined`: the getter hands back a fully-zeroed
      // object when its cache is cold, so the old check always passed and cached zeros
      // over a ledger that held the real figures.
      if (todayPnL && todayPnL.updatedAt) {
        this._cachedDailyPnL = todayPnL.dailyNet;
        if (typeof todayPnL.cumulativePnL === 'number') this._cachedTTTotalPnL = todayPnL.cumulativePnL;
        this._cachedTTUnrealizedPnL = todayPnL.unrealizedPnL || 0;
        return true;
      }

      // revenueService's own cache is not warm yet — its init races ours after a
      // restart. Read today's ledger row straight from the database instead.
      const { default: DailyPnL } = await import('../../models/DailyPnL.js');
      const today = new Date().toISOString().slice(0, 10);
      const row = await DailyPnL.findOne({ date: today }).lean();
      if (row) {
        if (typeof row.dailyNet === 'number') this._cachedDailyPnL = row.dailyNet;
        if (typeof row.cumulativePnL === 'number') this._cachedTTTotalPnL = row.cumulativePnL;
        return true;
      }
    } catch { /* non-critical: the status view falls back as before */ }
    return false;
  }

  getTokenTraderLifetimeRealized() {
    try {
      let total = 0;
      let found = false;
      for (const [, instance] of strategyRegistry.getAllTokenTraders()) {
        const pnl = (instance.getTokenTraderStatus?.() || {}).pnl || {};
        const lr = pnl.lifetimeRealized != null ? pnl.lifetimeRealized : pnl.realized;
        if (typeof lr === 'number' && Number.isFinite(lr)) {
          total += lr;
          found = true;
        }
      }
      return found ? total : null;
    } catch {
      return null;
    }
  }
  getStatus() {
    const baseStatus = super.getStatus();
    const config = this.getConfig();
    const state = this.getState();

    // Get active strategy info
    const activeStrategyName = config.activeStrategy || config.enabledStrategies?.[0] || 'native_maximizer';
    let activeStrategyInfo = null;
    try {
      const registryActive = strategyRegistry.getActive();
      activeStrategyInfo = registryActive?.getInfo() || null;
    } catch (e) {
      // Registry strategy not available
    }

    // Capital allocation: derive secondary share from configured token-traders'
    // capitalAllocationPercent. An explicit config.domainConfig.capitalAllocation override wins.
    let capitalAllocation = config.domainConfig?.capitalAllocation;
    if (!capitalAllocation) {
      const ttStatus = state.tokenTraderStatus || {};
      const secondary = Object.values(ttStatus).reduce(
        (sum, tt) => sum + (tt?.settings?.capitalAllocationPercent || 0),
        0
      );
      capitalAllocation = { primary: Math.max(0, 100 - secondary), secondary };
    }

    // Lifetime realized P&L for the token traders.
    //
    // _cachedTTTotalPnL is refreshed from the DailyPnL ledger on crypto:heartbeat, so
    // between a restart and the first heartbeat it is unset. The old fallback was
    // state.tokenTraderPnL — a per-trade accumulator (see the isTokenTrader branch in
    // recordTradeResult) that has drifted badly: on 2026-08-20 it read -$100.76 against
    // a true +$150.80, and that $251 error was what the API served for the whole
    // post-restart window. The ledger and the traders' own books were correct
    // throughout; only this display path was wrong.
    //
    // Sum the traders' own lifetime counters instead — the same source revenueService
    // reconciles the ledger against, and correct from the first tick after boot. The
    // drifted accumulator is no longer consulted at all (v2.25.219) — it is not
    // written any more either. `??` not `||`: a legitimate 0 (no trades yet) must
    // not fall through.
    const ttLifetimeRealized = this._cachedTTTotalPnL
      ?? this.getTokenTraderLifetimeRealized()
      ?? 0;

    return {
      ...baseStatus,
      // Agent state
      enabled: this.agentDoc.enabled,
      isRunning: this.running,
      // isActive: true if a successful execution happened within the last 20 minutes (2x heartbeat interval)
      isActive: this.lastSuccessfulExecution ? (Date.now() - this.lastSuccessfulExecution < 20 * 60 * 1000) : false,
      lastSuccessfulExecution: this.lastSuccessfulExecution ? new Date(this.lastSuccessfulExecution).toISOString() : null,
      networkMode: config.networkMode || 'testnet',

      // Strategy info
      strategy: activeStrategyName,
      strategyInfo: activeStrategyInfo,
      availableStrategies: this.listStrategies().map(s => s.name),
      strategies: Array.from(this.strategies.keys()),

      // Schedule info
      schedule: this.getScheduleInfo(),

      // Config
      config: {
        intervalMinutes: config.intervalMinutes || 60,
        maxTradePercentage: config.maxTradePercentage || 20,
        dailyLossLimit: config.dailyLossLimit || 10,
        slippageTolerance: config.slippageTolerance || 2,
        autoExecute: config.autoExecute !== false,
        emergencyStop: config.emergencyStop || false,
        dailyPnLReport: config.dailyPnLReport || false,
        dailyReportTime: config.dailyReportTime || '09:00',
        priceThresholds: config.priceThresholds || {
          sellThreshold: 5,
          buyThreshold: -3
        }
      },

      // State — combined P&L (DM + token traders).
      // totalPnL/tokenTraderPnL represent REALIZED lifetime P&L (locked-in trade profits).
      // unrealizedPnL is current mark-to-market on open positions, exposed separately so
      // the dashboard can show "Total snapshot = realized + unrealized" without double-counting.
      state: {
        dailyPnL: this._cachedDailyPnL ?? state.dailyPnL ?? 0,
        totalPnL: (state.totalPnL || 0) + ttLifetimeRealized,
        unrealizedPnL: this._cachedTTUnrealizedPnL || 0,
        dmPnL: state.totalPnL || 0,
        tokenTraderPnL: ttLifetimeRealized,
        tradesExecuted: (state.tradesExecuted || 0) + (state.tokenTraderTradesExecuted || 0),
        tradesProposed: (state.tradesProposed || 0) + (state.tokenTraderTradesProposed || 0),
        positions: state.positions || {},
        priceBaselines: state.priceBaselines || {},
        lastDecision: state.lastDecision,
        lastExecution: state.lastExecution,
        // Separate counters for drill-down
        dmTradesExecuted: state.tradesExecuted || 0,
        tokenTraderTradesExecuted: state.tokenTraderTradesExecuted || 0,
        tokenTraderTradesProposed: state.tokenTraderTradesProposed || 0
      },

      // Journal (in-memory; tradeJournal is what /api/crypto/strategy/journal returns)
      journalEntries: (this.tradeJournal || []).length,
      recentTrades: this.tradeJournal.slice(-5),

      // Secondary strategy
      secondaryStrategy: strategyRegistry.getSecondary()?.name || null,
      capitalAllocation,

      // Token trader status
      tokenTraderStatus: state.tokenTraderStatus || null,

      // Cache info
      priceCache: {
        size: this.priceCache.size,
        keys: Array.from(this.priceCache.keys())
      }
    };
  }

  /**
   * Generate and send daily P&L report via Telegram
   */
  async sendDailyPnLReport() {
    try {
      const config = this.getConfig();
      if (!config.dailyPnLReport) {
        logger.debug('Daily P&L report disabled, skipping');
        return;
      }

      const telegram = this.mainAgent?.interfaces?.get('telegram');
      if (!telegram || !telegram.sendNotification) {
        logger.warn('Telegram not available for daily P&L report');
        return;
      }

      const built = await this.buildDailyPnLReport();
      if (!built) return;

      const sent = await telegram.sendNotification(built.text, { parse_mode: 'Markdown' });
      if (sent !== true) {
        logger.warn('Crypto daily report: Telegram send failed — snapshot kept, next report covers this window');
        return;
      }
      logger.info('Daily P&L report sent via Telegram');

      // Snapshot AFTER a successful send — if Telegram fails, the next report
      // covers the missed window instead of dropping it.
      await built.commitSnapshot();
    } catch (err) {
      logger.error(`Failed to send daily P&L report: ${err.message}`);
    }
  }

  /**
   * Build the daily crypto P&L report text WITHOUT sending it, and return a
   * `commitSnapshot()` closure that persists the window baselines (lastDailyReport
   * + pnlHistory). Callers send `text` however they like (standalone Telegram
   * message, or embedded in the unified daily status report) and MUST call
   * `commitSnapshot()` only after a successful send — otherwise the next report's
   * 24h/7d/30d windows would drift. Returns null if unavailable.
   */
  async buildDailyPnLReport({ header = true } = {}) {
    try {
      const config = this.getConfig();
      const state = this.getState();
      const positions = state.positions || {};
      const baselines = state.priceBaselines || {};

      // ---- Token trader lifetime realized + gas ----
      // Live instances are ground truth, but right after a restart the
      // registry can still be empty — fall back to the latest DailyPnL row
      // (derived from the same instances) rather than reporting $0.
      let ttTotalPnL = 0;
      let ttGasLifetime = 0;
      let ttUnrealized = 0;
      let ttLive = false;
      try {
        const traders = strategyRegistry.getAllTokenTraders();
        if (traders.size > 0) {
          ttLive = true;
          for (const [, instance] of traders) {
            const pnl = instance.getTokenTraderStatus()?.pnl || {};
            ttTotalPnL += pnl.lifetimeRealized != null ? pnl.lifetimeRealized : (pnl.realized || 0);
            ttGasLifetime += pnl.lifetimeGasCost || pnl.totalGasCost || 0;
            ttUnrealized += pnl.unrealized || 0;
          }
        }
      } catch { /* fall back below */ }

      let DailyPnL = null;
      try {
        DailyPnL = (await import('../../models/DailyPnL.js')).default;
      } catch { /* windows degrade gracefully */ }
      if (!ttLive && DailyPnL) {
        try {
          const latest = await DailyPnL.findOne({}).sort({ date: -1 }).lean();
          if (latest) {
            ttTotalPnL = latest.cumulativePnL || 0;
            ttGasLifetime = latest.gasCost || 0;
          }
        } catch { /* leave zeros */ }
      }

      const dmTotalPnL = state.totalPnL || 0;
      const combinedTotal = ttTotalPnL + dmTotalPnL;

      // ---- 24h: exact snapshot delta since the last sent report ----
      const lastReport = state.lastDailyReport || {};
      const windowStart = lastReport.at ? new Date(lastReport.at) : new Date(Date.now() - 24 * 3600 * 1000);
      const windowHours = (Date.now() - windowStart.getTime()) / 3600e3;
      const ttWindowPnL = typeof lastReport.ttTotalPnL === 'number' ? ttTotalPnL - lastReport.ttTotalPnL : null;
      const dmWindowPnL = typeof lastReport.dmTotalPnL === 'number' ? dmTotalPnL - lastReport.dmTotalPnL : null;
      const dayTotal = ttWindowPnL !== null || dmWindowPnL !== null ? (ttWindowPnL || 0) + (dmWindowPnL || 0) : null;
      const gasWindow = typeof lastReport.ttGasLifetime === 'number' ? ttGasLifetime - lastReport.ttGasLifetime : null;

      // ---- 7d / 30d: cumulative diffs against history at the cutoff ----
      // TT from DailyPnL rows (full history exists); DM from the pnlHistory
      // series this report persists each day — until 7/30 days of points
      // accumulate, the DM part covers only the recorded span.
      const pnlHistory = Array.isArray(state.pnlHistory) ? state.pnlHistory : [];
      const windowPnL = async (days) => {
        const cutoff = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
        let tt = ttTotalPnL; // no row at/before cutoff → all TT history is inside the window
        if (DailyPnL) {
          try {
            const base = await DailyPnL.findOne({ date: { $lte: cutoff } }).sort({ date: -1 }).lean();
            if (base) tt = ttTotalPnL - (base.cumulativePnL || 0);
          } catch { /* keep full-history value */ }
        }
        let dm = 0;
        const dmBase = [...pnlHistory].reverse().find(p => p.date <= cutoff) || pnlHistory[0];
        if (dmBase && typeof dmBase.dm === 'number') dm = dmTotalPnL - dmBase.dm;
        return tt + dm;
      };
      const pnl7d = await windowPnL(7);
      const pnl30d = await windowPnL(30);

      const networkMode = config.networkMode || 'testnet';
      const networks = NETWORK_CONFIG[networkMode] || {};

      const fmtUsd = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
      // Telegram legacy-Markdown: an unpaired _ or * in dynamic text (token
      // symbols, strategy names) makes the whole sendMessage 400.
      const esc = (v) => String(v ?? '').replace(/([_*`[])/g, '\\$1');
      const dayLabel = windowHours > 27 ? `${windowHours.toFixed(0)}h` : '24h';

      // When embedded in the unified daily status report the caller supplies
      // its own section heading, so omit the standalone title line.
      let msg = header ? `*Daily Crypto Report* (${networkMode})\n\n` : '';

      // Profit block — the headline. Realized only; windows are deltas of
      // lifetime realized, so gas-in/gas-out conventions cancel.
      msg += `💰 *Profit (realized):*\n`;
      if (dayTotal !== null) msg += `  ${dayLabel}: ${fmtUsd(dayTotal)}\n`;
      msg += `  7d: ${fmtUsd(pnl7d)}\n`;
      msg += `  30d: ${fmtUsd(pnl30d)}\n`;
      msg += `  all-time: ${fmtUsd(combinedTotal)}\n`;
      if (ttLive && Math.abs(ttUnrealized) >= 0.01) {
        msg += `  _open position unrealized: ${fmtUsd(ttUnrealized)}_\n`;
      }
      msg += `\n`;

      // Trade tally for the window — replaces the per-trade Telegram pings.
      const fmtQty = (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n === 0) return '0';
        if (n >= 1) return n.toFixed(2);
        if (n >= 0.01) return n.toFixed(4);
        return n.toFixed(6);
      };
      const windowSwaps = (state.swapLog || []).filter(s => s.ts && new Date(s.ts) > windowStart);
      msg += `🔄 *Trades (${dayLabel}):* ${windowSwaps.length}`;
      if (windowSwaps.length > 0 && gasWindow !== null && gasWindow > 0) msg += ` | gas $${gasWindow.toFixed(2)}`;
      msg += `\n`;
      if (windowSwaps.length > 0) {
        // Per-strategy counts
        const byStrategy = {};
        for (const s of windowSwaps) {
          const key = (s.strategy || 'other').replace(/_/g, ' ');
          byStrategy[key] = byStrategy[key] || { buys: 0, sells: 0 };
          if (/buy|bought/.test(s.action || '')) byStrategy[key].buys++;
          else byStrategy[key].sells++;
        }
        for (const [name, c] of Object.entries(byStrategy)) {
          msg += `  ${name}: ${c.buys} buys / ${c.sells} sells\n`;
        }
        // Individual trades (compact), newest last, capped
        const maxLines = 10;
        const shown = windowSwaps.slice(-maxLines);
        if (windowSwaps.length > maxLines) msg += `  _…${windowSwaps.length - maxLines} earlier trades omitted_\n`;
        for (const s of shown) {
          const t = new Date(s.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const arrow = /buy|bought/.test(s.action || '') ? '📈' : '📉';
          let line = `  ${arrow} ${t} ${(s.action || '').replace(/_/g, ' ')}: ${fmtQty(s.amountIn)} ${esc(s.symbolIn)}→${fmtQty(s.amountOut)} ${esc(s.symbolOut)}`;
          if (s.gain !== null && s.gain !== undefined) {
            line += ` (${s.gain >= 0 ? '+' : ''}${fmtQty(s.gain)} ${esc(s.symbolOut)})`;
          }
          msg += `${line}\n`;
        }
      }
      msg += `\n`;

      // Token trader per-token breakdown
      const allTraders = strategyRegistry.getAllTokenTraders();
      if (allTraders.size > 0) {
        msg += `*Token Trader:*\n`;
        for (const [, instance] of allTraders) {
          const status = instance.getTokenTraderStatus();
          if (!status?.token?.symbol) continue;
          const pnl = status.pnl || {};
          const pos = status.position || {};
          const lifetime = (pnl.lifetimeRealized != null ? pnl.lifetimeRealized : pnl.realized || 0) + (pnl.unrealized || 0);
          const lifetimeEmoji = lifetime >= 0 ? '🟢' : '🔴';
          const balStr = pos.tokenBalance > 0 ? `${pos.tokenBalance.toFixed(2)} ` : 'No pos ';
          msg += `  ${lifetimeEmoji} ${esc(status.token.symbol)}: ${balStr}| P&L $${lifetime.toFixed(2)} | ${status.regime || 'Idle'}\n`;
        }
        msg += `\n`;
      }

      // DM positions
      msg += `*Positions:*\n`;
      for (const [network, pos] of Object.entries(positions)) {
        const netConfig = networks[network];
        const symbol = netConfig?.symbol || network;
        const status = pos.inStablecoin ? `In ${netConfig?.stablecoin || 'stablecoin'}` : `Holding ${symbol}`;
        const baseline = baselines[network]?.price ? `$${parseFloat(baselines[network].price).toFixed(2)}` : '-';
        msg += `  ${network}: ${status} (base: ${baseline})`;
        if (pos.inStablecoin && pos.stablecoinAmount) {
          msg += ` | $${parseFloat(pos.stablecoinAmount).toFixed(2)}`;
        }
        msg += `\n`;
      }

      msg += `\n_Strategy: ${(config.activeStrategy || 'dollar_maximizer').replace(/_/g, ' ')}_`;

      // Snapshot closure — pnlHistory is the one-point-per-day series the 7d/30d
      // DM windows diff against. Caller invokes this only after a successful send.
      const commitSnapshot = async () => {
        const todayKey = new Date().toISOString().slice(0, 10);
        const history = pnlHistory.filter(p => p.date !== todayKey);
        history.push({ date: todayKey, tt: ttTotalPnL, dm: dmTotalPnL });
        await this.updateState({
          lastDailyReport: {
            at: new Date(),
            ttTotalPnL,
            dmTotalPnL,
            ttGasLifetime
          },
          pnlHistory: history.slice(-60)
        });
      };

      return { text: msg, commitSnapshot };
    } catch (err) {
      logger.error(`Failed to build daily P&L report: ${err.message}`);
      return null;
    }
  }

  // ==================== CROSS-DEX ARBITRAGE EXECUTION ====================

  /**
   * Start the arbitrage scan off the heartbeat's critical path.
   *
   * The scan (7+ tokens × V2/V3/V4 quotes, sequential with RPC-spacing delays)
   * takes 80s–12min on production. It used to be awaited behind a 45s
   * Promise.race: every tick logged "Arb scan timed out after 45s", stalled 45s,
   * DISCARDED the result — and the abandoned promise kept running anyway, so a
   * profitable scan could still have traded with nothing recording it. 9+ days
   * of a fixed 100% timeout rate (~140/day) — a ceiling, not a flake.
   *
   * Now: one scan in flight at a time; a tick that finds one running skips.
   * The result is handled when it lands. A scan older than the hard ceiling is
   * abandoned as a guard (its own completion still records any trade).
   * Returns the tick-level summary synchronously.
   */
  _runArbScanDetached(arbExecutor, decision, marketData) {
    const ARB_SCAN_HARD_CEILING_MS = 15 * 60 * 1000;
    const now = Date.now();
    if (this._arbScanInFlight) {
      const ageMs = now - this._arbScanInFlight.startedAt;
      if (ageMs < ARB_SCAN_HARD_CEILING_MS) {
        logger.info(`Arb scan still running (${Math.round(ageMs / 1000)}s) — skipping this tick`);
        return { action: 'hold', reason: 'arb_scan_in_progress', ageMs };
      }
      logger.error(`Arb scan exceeded ${ARB_SCAN_HARD_CEILING_MS / 60000}min (${Math.round(ageMs / 1000)}s) — abandoning it and starting a fresh scan`);
      this._arbScanInFlight = null;
    }

    const startedAt = now;
    const run = Promise.resolve()
      .then(() => arbExecutor.execute(decision, marketData))
      .then(async (result) => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        if (result?.action && result.action !== 'hold') {
          logger.info(`Arbitrage result: ${result.action}, profit=$${result.profit?.toFixed(2) || '?'} (${secs}s)`);
          await this.recordTrade({ strategy: 'arbitrage' }, result);
        } else {
          logger.info(`Arb scan complete: no profitable opportunities (${secs}s)`);
        }
        return result;
      })
      .catch((err) => {
        logger.warn(`Arbitrage scan error: ${err.message}`);
        return null;
      })
      .finally(() => {
        if (this._arbScanInFlight?.promise === run) this._arbScanInFlight = null;
      });
    this._arbScanInFlight = { promise: run, startedAt };
    return { action: 'hold', reason: 'arb_scan_started', fastMode: !!decision.fastMode };
  }

  /**
   * Execute the arbitrage strategy: scan for opportunities and execute round-trip trades.
   */
  async executeArbitrage(decision, marketData) {
    const arbStrategy = strategyRegistry.get('arbitrage');
    if (!arbStrategy) {
      return { success: false, action: 'hold', reason: 'Arbitrage strategy not found' };
    }

    const config = this.getConfig();
    const networkMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode];

    // Handle stuck positions first (leg 1 succeeded but leg 2 failed previously)
    if (arbStrategy.state.stuckPosition) {
      const stuck = arbStrategy.state.stuckPosition;
      const stuckAge = Date.now() - new Date(stuck.timestamp).getTime();
      logger.info(`Arb: attempting to sell stuck ${stuck.symbol} position (${stuck.amount} tokens, age: ${Math.round(stuckAge / 60000)}min)`);
      try {
        const stablecoins = swapService.getStablecoins(stuck.network);
        const stablecoinAddr = stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
        const sellResult = await swapService.swap(
          stuck.token, stablecoinAddr, stuck.amount.toString(),
          stuckAge > 3600000 ? 5 : arbStrategy.config.slippageTolerance, // Wider slippage if stuck >1hr
          stuck.network, { gasCheck: true }
        );
        if (sellResult?.success) {
          logger.info(`Arb: sold stuck ${stuck.symbol} for $${parseFloat(sellResult.amountOut || sellResult.expectedOut).toFixed(2)}`);
          arbStrategy.state.stuckPosition = null;
        }
      } catch (err) {
        logger.warn(`Arb: failed to sell stuck position: ${err.message}`);
        if (stuckAge > 7200000) { // 2 hours — give up tracking
          logger.warn('Arb: abandoning stuck position tracking after 2 hours');
          arbStrategy.state.stuckPosition = null;
        }
        return { success: false, action: 'hold', reason: `Stuck position: ${err.message}` };
      }
    }

    // Build extra scan tokens from all token trader instances
    const extraScanTokens = [];
    try {
      for (const [, ttInstance] of strategyRegistry.getAllTokenTraders()) {
        if (ttInstance?.isConfigured?.() && ttInstance.config.tokenAddress) {
          extraScanTokens.push({
            address: ttInstance.config.tokenAddress,
            symbol: ttInstance.config.tokenSymbol || 'TOKEN',
            decimals: ttInstance.config.tokenDecimals || 18,
          });
        }
      }
    } catch { /* ignore */ }

    // Scan for opportunities
    const fastMode = decision.fastMode || false;
    logger.info(`Arb: scanning networks (mode=${networkMode}, networks=${Object.keys(networks).join(',')}${fastMode ? ', FAST MODE' : ''})`);
    const allAnalyses = [];
    for (const [network] of Object.entries(networks)) {
      if (!arbStrategy.config.scanNetworks.includes(network) &&
          !arbStrategy.config.scanNetworks.includes(network.replace('-testnet', ''))) {
        continue;
      }
      try {
        const analysis = await arbStrategy.analyze(marketData, { extraScanTokens }, network, networkMode, { fastMode });
        analysis.fastMode = fastMode;
        allAnalyses.push(analysis);
        logger.info(`Arb scan [${network}]: ${analysis.reason} (${analysis.tokensScanned} tokens)`);
      } catch (err) {
        logger.warn(`Arb scan failed on ${network}: ${err.message}`);
      }
    }

    // Decide
    const decisions = await arbStrategy.decide(allAnalyses, {});
    if (!decisions.length) {
      return { success: true, action: 'hold', reason: 'No profitable arbitrage found' };
    }

    const trade = decisions[0];
    logger.info(`Arb executing: ${trade.reason}`);

    // Leg 1: Buy token with stablecoin
    let buyResult;
    try {
      buyResult = await swapService.swap(
        trade.stablecoinAddr, trade.token, trade.buyInput.toString(),
        arbStrategy.config.slippageTolerance, trade.network,
        { gasCheck: true, enableRetry: true, maxRetries: 2 }
      );
      if (!buyResult?.success) {
        arbStrategy.state.failedArbs++;
        logger.warn(`Arb leg 1 failed: ${buyResult?.error || 'unknown'}`);
        return { success: false, action: 'hold', reason: `Leg 1 failed: ${buyResult?.error}` };
      }
    } catch (err) {
      arbStrategy.state.failedArbs++;
      logger.warn(`Arb leg 1 error: ${err.message}`);
      return { success: false, action: 'hold', reason: `Leg 1 error: ${err.message}` };
    }

    const tokensReceived = buyResult.amountOut || buyResult.expectedOut;
    const buyGas = buyResult.gasCostNative || 0;
    logger.info(`Arb leg 1 done: bought ${tokensReceived} ${trade.tokenSymbol} for $${trade.buyInput} (gas: ${buyGas} native)`);

    // Re-quote leg 2 to verify still profitable
    try {
      const verifyQuote = await swapService.getQuote(
        trade.token, trade.stablecoinAddr, tokensReceived, trade.network
      );
      const verifyOutput = parseFloat(verifyQuote?.amountOut || '0');
      const bnbPrice = marketData?.prices?.[trade.network]?.price || 600;
      const estimatedTotalGas = 2 * arbStrategy.config.estimatedGasPerSwap * bnbPrice;
      const verifyProfit = verifyOutput - trade.buyInput - estimatedTotalGas;

      if (verifyProfit < 0) {
        logger.warn(`Arb: leg 2 no longer profitable after leg 1 (verify: $${verifyOutput.toFixed(2)}, need: $${(trade.buyInput + estimatedTotalGas).toFixed(2)}). Tracking stuck position.`);
        arbStrategy.state.stuckPosition = {
          token: trade.token,
          symbol: trade.tokenSymbol,
          amount: parseFloat(tokensReceived),
          network: trade.network,
          timestamp: new Date().toISOString(),
        };
        arbStrategy.state.failedArbs++;
        return { success: false, action: 'hold', reason: 'Spread disappeared after leg 1' };
      }
    } catch (err) {
      logger.warn(`Arb: leg 2 verify quote failed: ${err.message}. Proceeding anyway.`);
    }

    // Leg 2: Sell token for stablecoin
    let sellResult;
    try {
      sellResult = await swapService.swap(
        trade.token, trade.stablecoinAddr, tokensReceived,
        arbStrategy.config.slippageTolerance, trade.network,
        { gasCheck: true, enableRetry: true, maxRetries: 2 }
      );
      if (!sellResult?.success) {
        logger.warn(`Arb leg 2 failed: ${sellResult?.error || 'unknown'}. Tracking stuck position.`);
        arbStrategy.state.stuckPosition = {
          token: trade.token,
          symbol: trade.tokenSymbol,
          amount: parseFloat(tokensReceived),
          network: trade.network,
          timestamp: new Date().toISOString(),
        };
        arbStrategy.state.failedArbs++;
        return { success: false, action: 'hold', reason: `Leg 2 failed: ${sellResult?.error}` };
      }
    } catch (err) {
      logger.warn(`Arb leg 2 error: ${err.message}. Tracking stuck position.`);
      arbStrategy.state.stuckPosition = {
        token: trade.token,
        symbol: trade.tokenSymbol,
        amount: parseFloat(tokensReceived),
        network: trade.network,
        timestamp: new Date().toISOString(),
      };
      arbStrategy.state.failedArbs++;
      return { success: false, action: 'hold', reason: `Leg 2 error: ${err.message}` };
    }

    // Calculate realized P&L
    const stableOut = parseFloat(sellResult.amountOut || sellResult.expectedOut || '0');
    const sellGas = sellResult.gasCostNative || 0;
    const bnbPrice = marketData?.prices?.[trade.network]?.price || 600;
    const totalGasUsd = (buyGas + sellGas) * bnbPrice;
    const grossProfit = stableOut - trade.buyInput;
    const netProfit = grossProfit - totalGasUsd;

    logger.info(`Arb complete: ${trade.tokenSymbol} — in=$${trade.buyInput.toFixed(2)}, out=$${stableOut.toFixed(2)}, gross=$${grossProfit.toFixed(2)}, gas=$${totalGasUsd.toFixed(2)}, NET=$${netProfit.toFixed(2)}`);

    // Update strategy state
    arbStrategy.state.lastArbExecution = new Date().toISOString();
    arbStrategy.state.successfulArbs++;
    arbStrategy.state.totalArbPnL += netProfit;
    arbStrategy.state.totalGasCost += totalGasUsd;
    arbStrategy.recordTrade({
      type: 'arbitrage',
      token: trade.tokenSymbol,
      network: trade.network,
      stableIn: trade.buyInput,
      stableOut,
      pnl: netProfit,
      gasCost: totalGasUsd,
      spread: trade.spreadPercent,
    });

    // Send Telegram notification
    try {
      const msg = `Arbitrage executed: ${trade.tokenSymbol}\n` +
        `Buy: $${trade.buyInput.toFixed(2)} → ${parseFloat(tokensReceived).toFixed(4)} tokens\n` +
        `Sell: ${parseFloat(tokensReceived).toFixed(4)} tokens → $${stableOut.toFixed(2)}\n` +
        `Profit: $${netProfit.toFixed(2)} (spread: ${trade.spreadPercent?.toFixed(1)}%, gas: $${totalGasUsd.toFixed(2)})`;
      await this.sendTelegramAlert(msg);
    } catch { /* notification is best-effort */ }

    return {
      success: true,
      action: 'arbitrage_executed',
      token: trade.tokenSymbol,
      profit: netProfit,
      spread: trade.spreadPercent,
      trades: [buyResult, sellResult],
    };
  }

  // ==================== ARBITRARY TOKEN PRICE FETCHING ====================

  /**
   * Fetch price for any ERC20 token by contract address
   * Primary: DEX getAmountsOut via swapService
   * Fallback: CoinGecko contract endpoint
   * @param {string} tokenAddress - Token contract address
   * @param {string} network - Network name (bsc, ethereum, polygon, base)
   * @param {number} decimals - Token decimals (default 18)
   * @returns {Promise<{price: number, source: string}>}
   */
  async fetchTokenPrice(tokenAddress, network, decimals = 18) {
    const cacheKey = `token_price_${tokenAddress.toLowerCase()}_${network}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.priceCacheTTL) {
      return cached.data;
    }

    let chainlinkPrice = null;
    let dexPrice = null;

    // Primary: Chainlink oracle (free on-chain read, authoritative price)
    const checksumAddress = tokenAddress.startsWith('0x') ? tokenAddress : `0x${tokenAddress}`;
    const feedAddress = TOKEN_CHAINLINK_FEEDS[network]?.[checksumAddress];
    if (feedAddress) {
      try {
        const ethers = await import('ethers');
        const provider = await contractServiceWrapper.getProvider(network);
        const contract = new ethers.Contract(feedAddress, PRICE_FEED_ABI, provider);
        const [, answer, , updatedAt] = await contract.latestRoundData();
        const feedDecimals = await contract.decimals();
        const price = Number(answer) / Math.pow(10, Number(feedDecimals));
        const staleness = Date.now() - Number(updatedAt) * 1000;
        if (price > 0 && staleness < 3600000) { // Accept if < 1 hour old
          chainlinkPrice = price;
          logger.debug(`Chainlink price for ${tokenAddress}: $${price.toFixed(4)} (age: ${Math.round(staleness / 1000)}s)`);
        } else if (price > 0) {
          logger.warn(`Chainlink price for ${tokenAddress} is stale (${Math.round(staleness / 60000)}min old): $${price.toFixed(4)}`);
          chainlinkPrice = price; // Still use as reference but prefer DEX
        }
      } catch (err) {
        logger.debug(`Chainlink price feed failed for ${tokenAddress}: ${err.message}`);
      }
    }

    // Secondary: DEX quote via swapService (actual trading price)
    try {
      const config = this.getConfig();
      const netMode = config.domainConfig?.networkMode || config.networkMode || 'testnet';
      const netConfig = NETWORK_CONFIG[netMode]?.[network];
      const stablecoins = swapService.getStablecoins(network);
      const stablecoinAddr = (netConfig?.stablecoinAddress) || stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
      if (stablecoinAddr) {
        const stablecoinDecimals = (network === 'ethereum' || network === 'base') &&
          (stablecoinAddr.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' || // USDC
           stablecoinAddr.toLowerCase() === '0xdac17f958d2ee523a2206206994597c13d831ec7')   // USDT
          ? 6 : 18;
        const tokenDecimals = decimals || 18;
        const quote = await swapService.getQuote(tokenAddress, stablecoinAddr, '1', network, 'uniswapV2', {
          decimalsIn: tokenDecimals,
          decimalsOut: stablecoinDecimals
        });
        if (quote && parseFloat(quote.amountOut) > 0) {
          dexPrice = parseFloat(quote.amountOut);
        }
      }
    } catch (dexErr) {
      logger.debug(`DEX price fetch failed for ${tokenAddress} on ${network}: ${dexErr.message}`);
    }

    // Cross-source validation: detect significant price discrepancies
    if (chainlinkPrice && dexPrice && chainlinkPrice > 0 && dexPrice > 0) {
      const discrepancy = Math.abs(chainlinkPrice - dexPrice) / chainlinkPrice;
      if (discrepancy > 0.05) { // >5% difference
        logger.warn(`Price discrepancy for ${tokenAddress}: Chainlink=$${chainlinkPrice.toFixed(4)} vs DEX=$${dexPrice.toFixed(4)} (${(discrepancy * 100).toFixed(1)}% diff) — potential arbitrage opportunity`);
      }
    }

    // Return best price: prefer DEX (actual trading price) if available, Chainlink as reference
    if (dexPrice && dexPrice > 0) {
      const result = { price: dexPrice, source: 'dex', network, tokenAddress, chainlinkPrice: chainlinkPrice || undefined };
      this.priceCache.set(cacheKey, { timestamp: Date.now(), data: result });
      return result;
    }

    if (chainlinkPrice && chainlinkPrice > 0) {
      const result = { price: chainlinkPrice, source: 'chainlink', network, tokenAddress };
      this.priceCache.set(cacheKey, { timestamp: Date.now(), data: result });
      return result;
    }

    // Tertiary: CoinGecko contract endpoint
    try {
      const platform = COINGECKO_PLATFORMS[network];
      if (platform) {
        const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${tokenAddress}&vs_currencies=usd`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          const tokenData = data[tokenAddress.toLowerCase()];
          if (tokenData?.usd) {
            const result = { price: tokenData.usd, source: 'coingecko', network, tokenAddress };
            this.priceCache.set(cacheKey, { timestamp: Date.now(), data: result });
            return result;
          }
        }
      }
    } catch (geckoErr) {
      logger.debug(`CoinGecko price fetch failed for ${tokenAddress}: ${geckoErr.message}`);
    }

    return { price: 0, source: 'none', network, tokenAddress };
  }

  /**
   * Fetch price history for a token (last N hours)
   * Uses CoinGecko market_chart endpoint
   * @param {string} tokenAddress - Token contract address
   * @param {string} network - Network name
   * @param {number} hours - Hours of history (default 24)
   * @returns {Promise<Array<{price: number, timestamp: number}>>}
   */
  async fetchTokenPriceHistory(tokenAddress, network, hours = 24) {
    const cacheKey = `token_history_${tokenAddress.toLowerCase()}_${network}_${hours}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5-min TTL
      return cached.data;
    }

    try {
      const platform = COINGECKO_PLATFORMS[network];
      if (!platform) return [];

      const days = Math.max(1, Math.ceil(hours / 24));
      const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${tokenAddress}/market_chart?vs_currency=usd&days=${days}`;
      const response = await fetch(url);

      if (!response.ok) {
        logger.warn(`CoinGecko price history ${response.status} for ${tokenAddress}`);
        return [];
      }

      const data = await response.json();
      if (!data.prices || data.prices.length === 0) return [];

      // Filter to requested hours and convert format
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const history = data.prices
        .filter(([ts]) => ts >= cutoff)
        .map(([timestamp, price]) => ({ price, timestamp }));

      this.priceCache.set(cacheKey, { timestamp: Date.now(), data: history });
      return history;
    } catch (error) {
      logger.warn(`Failed to fetch token price history for ${tokenAddress}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get full metadata for a token (on-chain name/symbol/decimals + tax detection)
   * @param {string} tokenAddress - Token contract address
   * @param {string} network - Network name
   * @returns {Promise<{name: string, symbol: string, decimals: number, tax: number, address: string, network: string}>}
   */
  async getTokenMetadata(tokenAddress, network) {
    return swapService.getTokenMetadata(tokenAddress, network);
  }

  /**
   * Get stablecoin balances for all active networks
   */
  async getStablecoinBalances() {
    const config = this.getConfig();
    const networkMode = config.networkMode || 'testnet';
    const networks = NETWORK_CONFIG[networkMode] || {};
    const balances = {};

    try {
      const wallet = await walletService.getWallet();
      const addresses = wallet?.addresses || [];

      for (const [network, netConfig] of Object.entries(networks)) {
        if (!netConfig.stablecoinAddress) continue;

        // Find wallet address for this network
        const chainMap = { ethereum: 'eth', sepolia: 'eth', bsc: 'bsc', 'bsc-testnet': 'bsc', polygon: 'polygon' };
        const chain = chainMap[network];
        const addrEntry = addresses.find(a => a.chain === chain);
        if (!addrEntry) continue;

        try {
          const result = await contractServiceWrapper.getTokenBalance(
            netConfig.stablecoinAddress,
            addrEntry.address,
            network
          );
          if (!balances[network]) balances[network] = {};
          balances[network][netConfig.stablecoin] = result.formatted;
        } catch (err) {
          logger.debug(`Failed to get ${netConfig.stablecoin} balance on ${network}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`Failed to get stablecoin balances: ${err.message}`);
    }

    return balances;
  }
}

export default CryptoStrategyAgent;
