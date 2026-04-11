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
  }

  async initialize() {
    await super.initialize();

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
      const prefetchedPrices = options.eventData?.prices || null;
      const marketData = await this.gatherMarketData(prefetchedPrices);

      // Update cached P&L from revenueService for web UI display
      if (eventName === 'crypto:heartbeat') {
        try {
          const revService = (await import('../crypto/revenueService.js')).default;
          const todayPnL = revService.getTodayPnLSummary();
          if (todayPnL && todayPnL.dailyNet !== undefined) {
            this._cachedDailyPnL = todayPnL.dailyNet;
            this._cachedTTTotalPnL = todayPnL.cumulativePnL || 0;
          }
        } catch { /* non-critical */ }
      }

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
          await this.scanForDeposits();
        } catch (depositErr) {
          logger.warn('Deposit scan error (non-fatal):', depositErr.message);
        }
        // Sweep residual tokens (BUSD, reflection tokens, etc.) that aren't caught by delta-based deposit scan
        try {
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

          // Scan on-chain for registry fee income (from self + external reporters)
          await scammerRegistry.scanFeeIncome();

          // Route accumulated registry fees to staking rewards (flywheel)
          const feeRoute = await scammerRegistry.routeFeesToStaking();
          if (feeRoute.routed) {
            logger.info(`Fee→Staking flywheel: funded ${feeRoute.amount.toLocaleString()} SKYNET — tx=${feeRoute.txHash}`);
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
      }

      // Step 1.5: Check for stale baselines and reset if needed
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
          const result = await dedicatedExecutor.execute(decision, marketData, indicators);
          primaryResult = result;
          const action = result?.action === 'hold' ? 'hold' : 'trade';
          logger.info(`Strategy ${activeStrategy} result: action=${action}, reason=${result?.reason || 'none'}`);
          if (result?.networkAnalysis) {
            for (const [net, analysis] of Object.entries(result.networkAnalysis)) {
              logger.info(`  ${net}: price=$${analysis.currentPrice}, baseline=$${analysis.baselinePrice}, change=${analysis.priceChange?.toFixed(2)}%, opportunity=${analysis.opportunity ? analysis.opportunity.action : 'none'}, reason=${analysis.reason || 'n/a'}`);
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
              // Wrap in 45s timeout to prevent blocking the heartbeat (60s for fast mode — more tokens to scan)
              const arbTimeout = isHighVolatility ? 60000 : 45000;
              const arbPromise = arbExecutor.execute({ strategy: 'arbitrage', fastMode: isHighVolatility }, marketData);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Arb scan timed out after ${arbTimeout / 1000}s`)), arbTimeout)
              );
              arbResult = await Promise.race([arbPromise, timeoutPromise]);
              if (arbResult?.action && arbResult.action !== 'hold') {
                logger.info(`Arbitrage result: ${arbResult.action}, profit=$${arbResult.profit?.toFixed(2) || '?'}`);
                await this.recordTrade({ strategy: 'arbitrage' }, arbResult);
              } else {
                logger.info(`Arb scan complete: no profitable opportunities`);
              }
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
      logger.error(`CryptoStrategyAgent execution error:`, error);
      await this.log('execution_error', { error: error.message });
      throw error;
    } finally {
      this.running = false;
      this.lastSuccessfulExecution = Date.now();

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
          data.balances[network].stablecoin = 0;
          logger.warn(`Could not fetch ${netConfig.stablecoin} balance on ${network}: ${err.message}`);
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

      // Minimum $1 USD trade value
      const currentPrice = marketData.prices?.[network]?.price || 0;
      const usdValue = parseFloat(tradeAmount) * currentPrice;
      if (usdValue > 0 && usdValue < 1) {
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

        // Update position
        await this.updateState({
          positions: {
            ...(state.positions || {}),
            [network]: {
              inStablecoin: true,
              entryPrice: marketData.prices[network].price,
              stablecoinAmount: stablecoinReceived,
              timestamp: new Date()
            }
          }
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
          received: stablecoinReceived,
          txHash: swapResult.hash
        };

        await this.notifySwap({
          action: 'sold_to_stablecoin',
          network,
          amountIn: tradeAmount,
          amountOut: stablecoinReceived,
          symbolIn: networkConfig.symbol,
          symbolOut: networkConfig.stablecoin || 'USDC',
          txHash: swapResult.hash,
          strategy: decision.strategy || 'native_maximizer'
        });

        return sellResult;
      }

      return { success: false, error: swapResult.error || 'Swap failed' };

    } else if (direction === 'buy' && position.inStablecoin && position.stablecoinAmount > 0) {
      // Buy back native with stablecoin
      // Verify actual wallet balance before using recorded stablecoinAmount
      let stableAmount = position.stablecoinAmount;
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
          if (actualAmount < stableAmount * 0.01) {
            // Actual balance is less than 1% of expected - position state is stale
            logger.warn(`Buy aborted: recorded ${stableAmount} ${networkConfig.stablecoin} but wallet only has ${actualAmount}. Resetting position.`);
            await this.updateState({
              positions: {
                ...(state.positions || {}),
                [network]: { inStablecoin: false, entryPrice: null, stablecoinAmount: 0 }
              }
            });
            return { success: false, error: `Stablecoin balance mismatch: expected ${stableAmount}, actual ${actualAmount}` };
          }
          if (actualAmount < stableAmount) {
            logger.warn(`Adjusting buy amount from ${stableAmount} to actual balance ${actualAmount}`);
            stableAmount = actualAmount;
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
        // Calculate gain (handle null entryPrice from initial/reset positions)
        const originalNative = position.entryPrice ? (position.stablecoinAmount / position.entryPrice) : 0;
        const newNative = parseFloat(swapResult.expectedOut) || 0;
        const gain = originalNative > 0 ? (newNative - originalNative) : 0;

        // Update position
        await this.updateState({
          positions: {
            ...(state.positions || {}),
            [network]: {
              inStablecoin: false,
              lastGain: gain,
              timestamp: new Date()
            }
          }
        });

        // Learn from this trade
        if (gain > 0) {
          await this.addLearning('trade_success',
            `Profitable trade: gained ${gain.toFixed(6)} ${networkConfig.symbol}`,
            0.8
          );
        } else {
          await this.addLearning('trade_loss',
            `Unprofitable trade: lost ${Math.abs(gain).toFixed(6)} ${networkConfig.symbol}`,
            0.6
          );
        }

        const buyResult = {
          success: true,
          action: 'bought_native',
          spent: stableAmount,
          received: swapResult.expectedOut,
          gain,
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
          gain,
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
  async executeDollarMaximizer(decision, marketData, indicators) {
    const config = this.getConfig();
    const state = this.getState();
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
          // Persist the fix
          const fixPositions = { ...(state.positions || {}) };
          fixPositions[network] = { ...agentPosition };
          await this.updateState({ positions: fixPositions });
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
      const pricePair = `${netConfig.symbol}/USD`;
      const currentPrice = transformedMarketData.prices[pricePair]?.price;

      // Pre-calculate native excess value for all checks
      const actualNativeBalance = parseFloat(balance.native) || 0;
      const gasReserve = dollarStrategy.getGasReserve(netConfig.symbol);
      const excessNative = Math.max(0, actualNativeBalance - gasReserve);
      const excessNativeValueUSD = excessNative * (currentPrice || 0);

      // Determine which asset is dominant by USD value
      const stableDominant = actualStable > excessNativeValueUSD;
      const nativeDominant = excessNativeValueUSD > actualStable;

      // Wallet has stablecoins but position says NOT in stablecoin
      // Only flip if stablecoin is the dominant value (prevents flip-flop when both have value)
      if (!position.inStablecoin && actualStable > 1 && stableDominant) {
        logger.info(`Position reconciliation [${network}]: wallet has ${actualStable} ${netConfig.stablecoin} (dominant over ~$${excessNativeValueUSD.toFixed(2)} native) but position says native. Updating to stablecoin position.`);
        const reconciled = {
          inStablecoin: true,
          stablecoinAmount: actualStable,
          entryPrice: position.entryPrice || currentPrice || 0,
          nativeAmount: actualNativeBalance,
          timestamp: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reconciledFromWallet: true
        };
        dollarStrategy.setPosition(network, reconciled);
        // Persist to agent state
        const currentPositions = this.getState().positions || {};
        currentPositions[network] = reconciled;
        await this.updateState({ positions: currentPositions });
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
        const currentPositions = this.getState().positions || {};
        currentPositions[network] = reconciled;
        await this.updateState({ positions: currentPositions });
      }
      // Position stablecoin amount differs significantly from wallet reality
      else if (position.inStablecoin && actualStable > 0.01 &&
               Math.abs(actualStable - (position.stablecoinAmount || 0)) / Math.max(actualStable, 1) > 0.1) {
        logger.info(`Position reconciliation [${network}]: stablecoin mismatch. State: ${position.stablecoinAmount}, Wallet: ${actualStable}. Using wallet amount.`);
        const reconciled = { ...position, stablecoinAmount: actualStable, nativeAmount: actualNativeBalance, updatedAt: new Date().toISOString() };
        dollarStrategy.setPosition(network, reconciled);
        const currentPositions = this.getState().positions || {};
        currentPositions[network] = reconciled;
        await this.updateState({ positions: currentPositions });
      }
      // Position says IN stablecoin but wallet has significant native above gas reserve
      // Only flip if native is the dominant value (prevents flip-flop when both have value)
      else if (position.inStablecoin && nativeDominant) {
        if (excessNative > gasReserve && excessNativeValueUSD > 5) {
          logger.info(`Position reconciliation [${network}]: native ~$${excessNativeValueUSD.toFixed(2)} dominant over $${actualStable.toFixed(2)} stablecoin. Switching to native position.`);
          const reconciled = {
            inStablecoin: false,
            stablecoinAmount: actualStable,
            entryPrice: currentPrice || position.entryPrice || null,
            nativeAmount: actualNativeBalance,
            timestamp: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            reconciledFromWallet: true
          };
          dollarStrategy.setPosition(network, reconciled);
          const currentPositions = this.getState().positions || {};
          currentPositions[network] = reconciled;
          await this.updateState({ positions: currentPositions });
        }
      }

      // Always sync nativeAmount to actual wallet balance
      const currentPos = dollarStrategy.getPosition(network);
      const actualNative = parseFloat(balance.native) || 0;
      if (Math.abs(actualNative - (currentPos.nativeAmount || 0)) > 0.0001) {
        currentPos.nativeAmount = actualNative;
        currentPos.updatedAt = new Date().toISOString();
        dollarStrategy.setPosition(network, currentPos);
        const currentPositions = this.getState().positions || {};
        currentPositions[network] = currentPos;
        await this.updateState({ positions: currentPositions });
      }
    }

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
        // Swap enough stablecoins to cover 2x gas reserve (small swap to minimize market impact)
        const nativePrice = transformedMarketData.prices[`${symbol}/USD`]?.price || 0;
        if (nativePrice <= 0) continue;

        const targetNative = gasReserve * 2;
        const deficit = targetNative - nativeBalance;
        const swapAmountUsd = Math.min(deficit * nativePrice, stableBalance * 0.5, 50); // Cap at $50 or 50% of stablecoins

        if (swapAmountUsd < 2) continue; // Not worth the gas

        logger.info(`Auto gas top-up [${network}]: native ${nativeBalance.toFixed(6)} ${symbol} below 50% of ${gasReserve} reserve. Swapping ~$${swapAmountUsd.toFixed(2)} stablecoin → ${symbol}`);

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
            balance.native = (nativeBalance + nativeReceived).toString();
            balance.stablecoin = Math.max(0, stableBalance - swapAmountUsd);

            // Update position to reflect reduced stablecoins
            const pos = dollarStrategy.getPosition(network);
            if (pos.inStablecoin && pos.stablecoinAmount) {
              pos.stablecoinAmount = Math.max(0, pos.stablecoinAmount - swapAmountUsd);
              pos.nativeAmount = nativeBalance + nativeReceived;
              pos.updatedAt = new Date().toISOString();
              dollarStrategy.setPosition(network, pos);
              const currentPositions = this.getState().positions || {};
              currentPositions[network] = pos;
              await this.updateState({ positions: currentPositions });
            }
          } else {
            logger.warn(`Auto gas top-up [${network}]: swap failed — ${swapResult.error || 'unknown error'}`);
          }
        } catch (err) {
          logger.warn(`Auto gas top-up [${network}]: error — ${err.message}`);
        }
      }
    }

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
        logger.info(`DollarMaximizer [${network}]: price=$${analysis.currentPrice}, baseline=$${analysis.baselinePrice}, change=${analysis.priceChange?.toFixed(2)}%, opportunity=${analysis.opportunity ? analysis.opportunity.action : 'none'}, reason=${analysis.reason || 'n/a'}`);
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
              const priceChange = Math.abs(tradeDecision.priceChange || 0) / 100;
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

          results.push({ ...result, network });
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
            tradeParams: { direction: 'buy', percentOfBalance: stratConfig.maxTradePercentage }
          }, marketData);

          results.push({ ...result, network: tradeDecision.network });
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
            // Check actual V3/V4 liquidity (not just price existence)
            let hasLiquidity = false, liquidityDepth = 0;
            try {
              const stablecoins = swapService.getStablecoins(net);
              const stablecoinAddr = stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
              if (stablecoinAddr) {
                const quotes = await swapService.getQuotesByProtocol(stablecoinAddr, addr, '10', net);
                const v2Out = parseFloat(quotes.v2?.amountOut) || 0;
                if (quotes.v3 && (parseFloat(quotes.v3.amountOut) || 0) >= v2Out) { hasLiquidity = true; liquidityDepth = (parseFloat(quotes.v3.amountOut) || 0) * pd.price; }
                if (quotes.v4 && (parseFloat(quotes.v4.amountOut) || 0) >= v2Out) { hasLiquidity = true; liquidityDepth = Math.max(liquidityDepth, (parseFloat(quotes.v4.amountOut) || 0) * pd.price); }
              }
              if (!hasLiquidity) {
                const nativeQuotes = await swapService.getQuotesByProtocol('native', addr, '0.01', net);
                const nativeV2Out = parseFloat(nativeQuotes.v2?.amountOut) || 0;
                if (nativeQuotes.v3 && (parseFloat(nativeQuotes.v3.amountOut) || 0) >= nativeV2Out) { hasLiquidity = true; liquidityDepth = (parseFloat(nativeQuotes.v3.amountOut) || 0) * pd.price; }
                if (nativeQuotes.v4 && (parseFloat(nativeQuotes.v4.amountOut) || 0) >= nativeV2Out) { hasLiquidity = true; liquidityDepth = Math.max(liquidityDepth, (parseFloat(nativeQuotes.v4.amountOut) || 0) * pd.price); }
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

          // Calculate total portfolio value on this network (native value + stablecoins)
          const nativeBalance = parseFloat(marketData.balances?.[tokenNetwork]?.native) || 0;
          const nativePrice = marketData.prices?.[tokenNetwork]?.price || 0;
          const nativeValue = nativeBalance * nativePrice;
          const totalPortfolioValue = nativeValue + totalStable;

          // Apply per-instance capital allocation to total portfolio value
          const capitalAlloc = tokenStrategy.config.capitalAllocationPercent || 20;
          const allocated = totalPortfolioValue * (capitalAlloc / 100);
          // Update reserve if entering, empty, or allocation changed by >10% (picks up new deposits sooner)
          const currentReserve = tokenStrategy.state.stablecoinReserve || 0;
          const reserveDiff = Math.abs(allocated - currentReserve);
          const shouldUpdate = tokenStrategy.state.regime === 'ENTERING' || currentReserve <= 0 || reserveDiff > Math.max(1, currentReserve * 0.1);
          if (shouldUpdate) {
            tokenStrategy.setStablecoinReserve(allocated);
            logger.info(`TokenTrader: Set stablecoin reserve to $${allocated.toFixed(2)} (${capitalAlloc}% of $${totalPortfolioValue.toFixed(2)} portfolio [${nativeBalance.toFixed(4)} native @ $${nativePrice.toFixed(2)} + $${totalStable.toFixed(2)} stable])`);
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
      // Check V3/V4 liquidity — return data with hasLiquidity flag instead of null
      // so the caller can apply fail-count policy instead of instant removal
      let hasLiquidity = false;
      let liquidityDepth = 0;
      let liquidityPaths = 0;
      try {
        const stablecoins = swapService.getStablecoins(network);
        const stablecoinAddr = stablecoins.USDT || stablecoins.USDC || stablecoins.BUSD;
        if (stablecoinAddr) {
          const quotes = await swapService.getQuotesByProtocol(stablecoinAddr, address, '10', network);
          // V3/V4 must beat V2 output to count as viable (forceV3 requires this at swap time)
          const v2Out = parseFloat(quotes.v2?.amountOut) || 0;
          if (quotes.v3 && (parseFloat(quotes.v3.amountOut) || 0) >= v2Out) { hasLiquidity = true; liquidityPaths++; liquidityDepth = Math.max(liquidityDepth, (parseFloat(quotes.v3.amountOut) || 0) * pd.price); }
          if (quotes.v4 && (parseFloat(quotes.v4.amountOut) || 0) >= v2Out) { hasLiquidity = true; liquidityPaths++; liquidityDepth = Math.max(liquidityDepth, (parseFloat(quotes.v4.amountOut) || 0) * pd.price); }
        }
        if (!hasLiquidity) {
          // Try native→token path (e.g., WBNB→SKYNET)
          const nativeQuotes = await swapService.getQuotesByProtocol('native', address, '0.01', network);
          const nativeV2Out = parseFloat(nativeQuotes.v2?.amountOut) || 0;
          if (nativeQuotes.v3 && (parseFloat(nativeQuotes.v3.amountOut) || 0) >= nativeV2Out) { hasLiquidity = true; liquidityPaths++; liquidityDepth = Math.max(liquidityDepth, (parseFloat(nativeQuotes.v3.amountOut) || 0) * pd.price); }
          if (nativeQuotes.v4 && (parseFloat(nativeQuotes.v4.amountOut) || 0) >= nativeV2Out) { hasLiquidity = true; liquidityPaths++; liquidityDepth = Math.max(liquidityDepth, (parseFloat(nativeQuotes.v4.amountOut) || 0) * pd.price); }
        }
        if (!hasLiquidity) {
          logger.debug(`Watchlist: ${address} on ${network} has no V3/V4 liquidity`);
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
      prices: marketData.prices
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
                // Reserve gas buffer (0.005 BNB ~$3, enough for several swaps)
                const gasReserve = 0.005;
                const nativeBalance = parseFloat(marketData.prices?.[tokenNetwork]?.nativeBalance || 0);
                const nativeEquivalent = parseFloat((buyAmount / nativePrice).toFixed(6));
                const maxNativeAvailable = Math.max(0, nativeBalance - gasReserve);

                if (nativeEquivalent <= maxNativeAvailable) {
                  logger.info(`TokenTrader: Insufficient stablecoins ($${actualStableBal.toFixed(2)} < $${buyAmount.toFixed(2)}), using ${nativeEquivalent} native ($${buyAmount.toFixed(2)} worth, reserve ${gasReserve} for gas)`);
                  swapFromToken = 'native';
                  swapAmount = nativeEquivalent.toFixed(6);
                  usedNative = true;
                } else {
                  logger.warn(`TokenTrader: Insufficient native for buy+gas (need ${nativeEquivalent} + ${gasReserve} reserve, have ${nativeBalance.toFixed(4)})`);
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
                // Native path has better liquidity — switch to it
                logger.info(`TokenTrader: Native path has lower impact (${nativeImpactPct.toFixed(1)}%) vs stablecoin (${stableImpactPct === Infinity ? 'no path' : stableImpactPct.toFixed(1) + '%'}) — using native`);
                swapFromToken = 'native';
                swapAmount = nativeEquivalent;
                usedNative = true;
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
          tokenStrategy.recordBuy(buyAmount, tokenReceived, effectivePrice, actualGasCostUsd, tradeDecision);

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
        const sellAmount = tradeDecision.amountToken;
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
        const isEmergencySell = tradeDecision.isEmergency || tradeDecision.sellAll || tradeDecision.isStopLoss;
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

            const costBasis = sellAmount * tokenStrategy.state.averageEntryPrice;
            const expectedOutput = swapOptions.expectedOutputUsd || (sellAmount * priceData.price);
            const expectedNetProfit = expectedOutput - costBasis - sellGasCostUsd;

            // Grid sells use lower threshold since they're small incremental trades
            const minProfit = tradeDecision.isGrid ? 0.25 : 1.0;
            if (expectedNetProfit < minProfit) {
              logger.info(`TokenTrader: Sell skipped — net profit $${expectedNetProfit.toFixed(4)} after gas ($${sellGasCostUsd.toFixed(4)}) below $${minProfit.toFixed(2)} minimum (output: $${expectedOutput.toFixed(2)}, cost: $${costBasis.toFixed(2)})`);
              return { success: false, error: `Net profit $${expectedNetProfit.toFixed(2)} after gas below $${minProfit.toFixed(2)} minimum` };
            }
            logger.info(`TokenTrader: Gas check OK — expected net profit $${expectedNetProfit.toFixed(4)} after gas $${sellGasCostUsd.toFixed(4)}`);
          } catch (gasErr) {
            logger.warn(`TokenTrader: Sell gas profitability check failed (proceeding): ${gasErr.message}`);
          }
        }

        logger.info(`TokenTrader: Selling ${sellAmount.toFixed(4)} ${tokenSymbol} (${tradeDecision.reason})`);

        const swapResult = await swapService.swap(
          tokenAddress,
          stablecoinAddr,
          sellAmount.toString(),
          swapOptions.maxSlippage,
          tokenNetwork,
          swapOptions
        );

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
          tokenStrategy.recordSell(sellAmount, stableReceived, effectiveSellPrice, tradeDecision, actualGasCostUsd);

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
        // Check if this is a system token (like SIREN) — never remove system tokens
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

      if (Math.abs(actualStable - (position.stablecoinAmount || 0)) > 0.5) {
        position.stablecoinAmount = actualStable;
        position.updatedAt = new Date().toISOString();
        dollarStrategy.setPosition(tokenNetwork, position);
        const currentPositions = this.getState().positions || {};
        currentPositions[tokenNetwork] = position;
        await this.updateState({ positions: currentPositions });
        logger.info(`DM position refreshed after TT trade: ${tokenNetwork} stablecoin=$${actualStable.toFixed(2)}`);
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

      // Run deep scan and WAIT for it before checking deposits.
      // Without this, detectNewDeposits runs against an empty knownTokens map
      // and finds 0 deposits on every restart (the old fire-and-forget bug).
      try {
        logger.info('Deposit scan: awaiting initial deep scan to populate token map...');
        await tokenScanner.runDeepScanAll(['bsc', 'ethereum']);
        logger.info(`Deposit scan: deep scan complete, knownTokens=${tokenScanner.knownTokens.size}`);
      } catch (err) {
        logger.warn('Initial deep scan error (non-fatal, will retry next heartbeat):', err.message);
      }
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
      '0xf3def3534eec3195e0c217938f710e6f2838694a', // Cake-LP SKYNET/WBNB (BSC)
      '0x3f8d1a1c568ba520e05a35ac31040976828aa5a1', // LOTTO (BSC)
      // Skynet ecosystem — never auto-sell
      '0x8ef0ece5687417a8037f787b39417eb16972b04f', // SKYNET token (BSC)
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
    const MAX_SWEEPS_PER_CYCLE = 5; // Limit sells per heartbeat to conserve gas

    // Build a unified list of token addresses to check from ALL sources:
    // 1. lastKnownBalances (tokens previously detected by deposit scanner)
    // 2. tokenScanner.knownTokens (tokens found by explorer API / deep scan / balance probe)
    // This ensures pre-existing tokens that were never flagged as "deposits" still get swept.
    for (const network of ['bsc', 'ethereum']) {
      if (swept >= MAX_SWEEPS_PER_CYCLE) break;

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
        // Skip if gas exceeds value — suppress for 24h to avoid log noise every heartbeat
        if (existing?.action === 'skipped_gas_exceeds_value') {
          const hoursSince = (Date.now() - new Date(existing.timestamp).getTime()) / (1000 * 60 * 60);
          if (hoursSince < 24) continue;
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
            const result = await this.autoSellUnknownToken(deposit);
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
          await new Promise(r => setTimeout(r, 5000));
        } catch (err) {
          logger.debug(`Residual sweep: could not check ${tokenAddr} on ${network}: ${err.message}`);
        }
      }
    }

    if (swept > 0) {
      logger.info(`Residual sweep: sold ${swept} token(s)`);
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

    for (const deposit of deposits) {
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
                result = await this.autoSellUnknownToken(deposit);
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

        case 'safe_unknown':
          logger.info(`Unknown safe token: ${deposit.symbol} — attempting auto-sell to stablecoin`);
          try {
            result = await this.autoSellUnknownToken(deposit);
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

    // Update last known balances after processing
    await this.updateLastKnownBalances(deposits);

    await this.log('deposits_processed', {
      count: results.length,
      actions: results.map(r => `${r.deposit?.symbol || '?'}: ${r.action}`)
    });

    return results;
  }

  /**
   * Auto-sell an unknown safe token to stablecoin via V3/V2 routing
   */
  async autoSellUnknownToken(deposit) {
    const { network, tokenAddress, symbol, amount, decimals } = deposit;
    const result = { action: 'auto_sell_attempted', deposit };

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
          // No swap path at all on native route too — token is dead, bail immediately
          if (isNoPathError(nativeErr.message)) {
            logger.error(`No viable swap path for ${symbol} on any route — token has no DEX liquidity, stopping`);
            break;
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
   * Record trade for learning
   */
  async recordTrade(decision, result) {
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
      if (result.success && result.gain) {
        updates.tokenTraderPnL = (state.tokenTraderPnL || 0) + result.gain;
      }
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
    this.agentDoc.config.domainConfig = {
      ...currentConfig,
      ...updates
    };
    await this.agentDoc.save();

    logger.info('Crypto Strategy Agent config updated:', Object.keys(updates));
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
    const state = this.getState();
    const { inStablecoin, entryPrice, stablecoinAmount } = positionData;

    const positions = state.positions || {};
    positions[network] = {
      inStablecoin: !!inStablecoin,
      entryPrice: entryPrice || null,
      stablecoinAmount: stablecoinAmount || 0,
      timestamp: new Date()
    };

    await this.updateState({ positions });

    logger.info(`Position updated for ${network}:`, positions[network]);
    return { success: true, network, position: positions[network] };
  }

  /**
   * Get positions for all networks
   */
  getPositions() {
    const state = this.getState();
    return state.positions || {};
  }

  /**
   * Get decision journal
   */
  getJournal(limit = 20) {
    const state = this.getState();
    const journal = state.decisionJournal || [];
    return journal.slice(-limit);
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

      // State — combined P&L (DM + token traders)
      state: {
        dailyPnL: this._cachedDailyPnL || state.dailyPnL || 0,
        totalPnL: (state.totalPnL || 0) + (this._cachedTTTotalPnL || state.tokenTraderPnL || 0),
        dmPnL: state.totalPnL || 0,
        tokenTraderPnL: this._cachedTTTotalPnL || state.tokenTraderPnL || 0,
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

      // Journal
      journalEntries: (state.decisionJournal || []).length,
      recentTrades: this.tradeJournal.slice(-5),

      // Secondary strategy
      secondaryStrategy: strategyRegistry.getSecondary()?.name || null,
      capitalAllocation: config.domainConfig?.capitalAllocation || { primary: 80, secondary: 20 },

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

      const state = this.getState();
      const positions = state.positions || {};
      const baselines = state.priceBaselines || {};

      // Get token trader P&L from DailyPnL collection (same source as web UI)
      let ttDailyPnL = 0;
      let ttTotalPnL = 0;
      let ttGasCost = 0;
      try {
        const { default: DailyPnL } = await import('../../models/DailyPnL.js');
        const today = new Date().toISOString().slice(0, 10);
        const todayRecord = await DailyPnL.findOne({ date: today }).lean();
        if (todayRecord) {
          ttTotalPnL = todayRecord.cumulativePnL || 0;
          ttDailyPnL = todayRecord.dailyNet || 0;
          ttGasCost = todayRecord.gasCost || 0;
        }
      } catch { /* fallback below */ }

      // Get dollar_maximizer P&L from state
      const dmTotalPnL = state.totalPnL || 0;

      // Combined P&L
      const combinedTotal = ttTotalPnL + dmTotalPnL;
      const combinedDaily = ttDailyPnL; // DM doesn't track daily separately

      const dmTradesExecuted = state.tradesExecuted || 0;
      const ttTradesExecuted = state.tokenTraderTradesExecuted || 0;
      const totalTrades = dmTradesExecuted + ttTradesExecuted;

      const networkMode = config.networkMode || 'testnet';
      const networks = NETWORK_CONFIG[networkMode] || {};

      let msg = `*Daily Crypto Report*\n`;
      msg += `Mode: ${networkMode}\n\n`;

      // Combined P&L
      const pnlEmoji = combinedTotal > 0 ? '🟢' : combinedTotal < 0 ? '🔴' : '⚪';
      msg += `${pnlEmoji} *Total P&L:* $${combinedTotal.toFixed(2)}\n`;
      const dailyEmoji = combinedDaily > 0 ? '📈' : combinedDaily < 0 ? '📉' : '➡️';
      msg += `${dailyEmoji} *Today:* $${combinedDaily.toFixed(2)}\n`;
      msg += `*Trades:* ${totalTrades} (DM: ${dmTradesExecuted}, TT: ${ttTradesExecuted})\n`;
      if (ttGasCost > 0) msg += `*Gas:* $${ttGasCost.toFixed(2)}\n`;
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
          msg += `  ${lifetimeEmoji} ${status.token.symbol}: ${balStr}| P&L $${lifetime.toFixed(2)} | ${status.regime || 'Idle'}\n`;
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

      msg += `\n_Strategy: ${config.activeStrategy || 'dollar_maximizer'}_`;

      await telegram.sendNotification(msg, { parse_mode: 'Markdown' });
      logger.info('Daily P&L report sent via Telegram');
    } catch (err) {
      logger.error(`Failed to send daily P&L report: ${err.message}`);
    }
  }

  // ==================== CROSS-DEX ARBITRAGE EXECUTION ====================

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
