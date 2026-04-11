You are diagnosing and maintaining the crypto strategy sub-agent for LANAgent. This prompt gives you the context needed to check health,
identify issues, and fix problems.

=== PRODUCTION ACCESS ===
Credentials: See CLAUDE.local.md or scripts/deployment/deploy.config
Server timezone: PST (UTC-8). Log timestamps are PST.

SSH pattern: sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no $PRODUCTION_USER@$PRODUCTION_SERVER "command"

PM2: process name is "lan-agent", config file is ecosystem.config.cjs
pm2 restart ecosystem.config.cjs (always use config file)
pm2 logs lan-agent
Web UI takes ~3 minutes to fully launch after restart.

=== DIAGNOSTIC SCRIPT ===
A reusable diagnostic script exists at scripts/diag-crypto.sh. Use it instead of raw SSH commands:

./scripts/diag-crypto.sh health - Full health check (process, API status, errors, recent cycles, price monitor)
./scripts/diag-crypto.sh status - Token trader + strategy status via API
./scripts/diag-crypto.sh trades 50 - Recent BUY/SELL trades from crypto.log
./scripts/diag-crypto.sh errors 20 - Recent errors
./scripts/diag-crypto.sh sanity 20 - Sanity check & V3 routing logs
./scripts/diag-crypto.sh regime 20 - Token trader regime & decisions
./scripts/diag-crypto.sh balances - Wallet balances via API
./scripts/diag-crypto.sh config - Strategy config via API
./scripts/diag-crypto.sh pnl 30 - PnL history
./scripts/diag-crypto.sh activity 50 - Raw tail of activity log
./scripts/diag-crypto.sh grep "pattern" 30 [filename] - Custom grep across log dirs
./scripts/diag-crypto.sh cat-file src/path/file.js - Read remote file

The script searches both /root/lanagent-deploy/logs and /logs on production. Edit the script for new commands rather than running raw SSH — avoids repeated permission prompts.

=== CRITICAL ROUTING RULE ===
DEX version preference: V4 > V3 > V2. NEVER allow V2 fallback for token_trader swaps.
V3 has dramatically better liquidity for small-cap tokens. V2 can have 1000x+ less liquidity.
forceV3: true must always be set in token_trader swap options. This aborts the swap if V3 fails rather than silently falling back to V2.

The forceV3 enforcement is in:
- src/services/subagents/CryptoStrategyAgent.js (~line 2563): swapOptions.forceV3 = true
- src/services/crypto/swapService.js (~line 791-798): throws error if V3 fails and forceV3 is set

Output sanity check (swapService.js ~line 809-818):
- Compares best quote output to expectedOutputUsd at 70% threshold
- expectedOutputUsd must always be set (spot-price fallback if getQuote fails)
- If output < 70% of expected, swap is aborted

=== CURRENT STATE (as of 2026-02-23 08:12 PST) ===

— Token Trader (SIREN on BSC) —
Token: SIREN (0x997a58129890bbda032231a52ed1ddc845fc18e1) on BSC
Regime: MOON (+32.3% from entry)
Position: 1,299.44 SIREN
Average entry: $0.2200
Current price: $0.2910
Peak price: $0.2953
Trailing stop: $0.2820 (4.5% below peak — tightened from 6% on Feb 23)
Stablecoin reserve: $117.02 USDT
Realized PnL: +$183.64
Unrealized PnL: +$87.56
Total PnL: +$271.21
Total gas costs: $1.13
Circuit breaker: Clean (0 consecutive stop-losses)

Scale-out levels hit: [10, 20, 30]
Scale-out config: {10: 10%, 20: 15%, 30: 20%, 40: 20%, 50: 35%}
Next level: 40% (needs $0.3080)

Config version: 5 (migrated from v4 on Feb 23)
Config changes in v5:
- Added 40% scale-out level (closes gap between 30% and 50%)
- Tightened pumpTrailingStopPercent: 6% → 4.5%
- Added pump stall detection: sells 10% if in PUMP 6+ hours without hitting next level

Configured: 2026-02-14

— Dollar Maximizer (BNB on BSC) —
Position: Holding stablecoins (not in BNB)
BNB price: ~$607, baseline: $614.08
Regime: downtrend (score: -45.7)
In downtrend: buy threshold raised to -8.75% (needs ~$561)
In sideways: buy threshold at -5% (needs ~$583)
Stablecoins: ~$314.84 USDT on BSC, ~$32.69 USDC on ETH
ETH position: holding stablecoins, entry was $1,984.79
Ethereum network: disabled for DollarMaximizer
No trades executed recently

— Wallet —
BSC: ~0.12 BNB, ~$314.84 USDT, ~$117 USDT (token trader reserve), 1,299 SIREN
ETH: ~0.023 ETH, ~$32.69 USDC

=== KEY RISK THRESHOLDS (Token Trader) ===

Current: +32.3% from entry ($0.2200)

+40.0% ($0.3080): NEW scale-out level → sells 20% of position
+50.0% ($0.3300): Final scale-out → sells 35% of position
Trailing stop: $0.2820 (4.5% below peak) — triggers full exit if breached
PUMP stall: 6hrs without next level → sells 10% (new feature)

Downside:
-5.0% ($0.2090): Enters DIP regime → DCA buys begin (gated by trend check)
-8.0%/hr rate: Emergency sell 50% (hourly spike detection, NO cooldown)
-10.0% ($0.1980): dipBuyMaxDepth → stops DCA buying
-15.0% ($0.1870): DUMP stop-loss → sells 100%, 2hr cooldown

Recovery: 15% above dump sell price + 3 confirmations clears cooldown early

=== API ENDPOINTS (key ones) ===
Base: http://localhost:3000/api/crypto
Auth header: x-api-key: your-api-key

Strategy:
GET /strategy/status - Current strategy state, regime, positions
GET /strategy/list - All available strategies
POST /strategy/switch - Change active strategy {strategy: "name"}
POST /strategy/trigger - Force a strategy execution cycle
GET /strategy/config - Current strategy config
POST /strategy/config - Update strategy config

Token Trader:
GET /strategy/token-trader/status - Token trader state, regime, PnL, cooldowns, pumpEnteredAt, lastPumpStallSell
POST /strategy/token-trader/configure - Configure token {tokenAddress, tokenNetwork, ...}
POST /strategy/token-trader/detect-tax - Detect fee-on-transfer tax for a token
POST /strategy/token-trader/exit - Exit position and stop trading

Swap:
POST /swap/quote - Get swap quote {tokenIn, tokenOut, amount, network}
POST /swap/execute - Execute swap {tokenIn, tokenOut, amount, slippage, network, forceV3}
GET /swap/networks - Supported networks
GET /swap/pending - Pending/recent swaps

Balances:
GET /balances - All wallet balances
GET /balances/:network - Balances for specific network
GET /wallet/address - Wallet addresses per network

Sub-agents:
GET /api/subagents/status - All sub-agent health/status

=== STRATEGY ARCHITECTURE ===

Two strategies run concurrently:
1. Primary: dollar_maximizer (ETH/BNB swing trading)
2. Secondary: token_trader (SIREN or other configured token, regime-based)

— Dollar Maximizer —
- Buys ETH/BNB when price drops below baseline by threshold
- Sells when price rises above entry by take-profit threshold
- Uses regime detection (uptrend/downtrend/strong_downtrend) to gate buys
- Dynamic thresholds based on 72-hour price trends (raises buy threshold in downtrends)
- Key config: buyThreshold, sellThreshold, regimeThresholds

— Token Trader (critical) —
- Regime-based state machine: ENTERING → SIDEWAYS → DIP/PUMP/MOON/DUMP → COOLDOWN
- Tracks: regime, tokenBalance, stablecoinReserve, averageEntryPrice, peakPrice, trailingStopPrice
- Key config:
  tokenAddress, tokenNetwork, tokenSymbol, tokenDecimals, tokenTaxPercent
  capitalAllocationPercent (currently 30%)
  sidewaysRange: 5% - Range for SIDEWAYS regime
  dipThreshold: -5% - Triggers DIP regime
  dumpThreshold: -15% - Hard stop-loss (sells 100%)
  emergencyDropRate: -8%/hr - Hourly spike detection (sells 50%)
  pumpThreshold: +10% - Triggers PUMP regime
  moonThreshold: +30% - Triggers MOON regime (trailing stop)
  dumpCooldownMs: 7200000 - 2hr cooldown after DUMP sell
  dipBuyMaxDepth: -10% - Stops DCA buying below this (buffer before stop-loss)
  dcaBuyPercent: 10% - % of reserve to spend per DCA buy
  gridTradePercent: 5% - % of reserve/position for grid trades
  gridBuyDip: -2% - Grid buy trigger in SIDEWAYS
  gridSellPump: +2% - Grid sell trigger in SIDEWAYS
  maxSlippage, enableRetry, maxRetries

  Scale-out levels: [10, 20, 30, 40, 50] (v5: added 40%)
  Scale-out sizing: {10: 10%, 20: 15%, 30: 20%, 40: 20%, 50: 35%} (v5: rebalanced from 25% at 30)

  Trailing stops (regime-aware):
    Standard (SIDEWAYS/DIP): 8% below peak
    PUMP/MOON: 4.5% below peak (v5: tightened from 6%)
    MOON above +50%: 5% below peak (tightTrailingStopPercent)

  Pump stall detection (v5 new):
    pumpStallHours: 6 - Hours without next scale-out level before taking profit
    pumpStallSellPercent: 10 - % of position to sell on stall
    State: pumpEnteredAt, lastPumpStallSell (tracked in API status)

DUMP behavior (graduated):
  Hourly spike (emergencyDropRate exceeded): sells 50%, NO cooldown
  Absolute stop-loss (dumpThreshold breached): sells 100%, triggers cooldown

DIP behavior (with trend gate):
  Enters at -5% from entry
  DCA buys 10% of reserve per cycle (1hr cooldown between buys)
  Checks _calculateTrend() — blocks buy if short-term trend < -0.5 (bearish)
  Checks _calculateLongTermTrend() — blocks buy if long-term trend < -10%
  Stops buying below -10% (dipBuyMaxDepth buffer)

Recovery-aware cooldown:
  Records lastDumpSellPrice when stop-loss DUMP sells
  Requires 15% recovery above dump price + 3 consecutive confirmations
  Escalating cooldowns: 2hr (1st stop), 6hr (2nd), 24hr (3rd+)

Circuit breaker:
  3 consecutive stop-losses OR cumulative PnL < -$150 trips the breaker
  Auto-reset: 4hr + stable trend, 15% price recovery, or 2hr + uptrend reversal

Balance reconciliation:
  Every executeTokenTrader() call syncs on-chain token balance with state
  Catches manual deposits sent to wallet

=== KEY SOURCE FILES ===

Strategy logic:
  src/services/crypto/strategies/TokenTraderStrategy.js - Token trader regime logic (CONFIG_VERSION=5)
  src/services/crypto/strategies/DollarMaximizerStrategy.js - Dollar maximizer
  src/services/crypto/strategies/BaseStrategy.js - Base class

Execution:
  src/services/subagents/CryptoStrategyAgent.js - Orchestrates strategies, executes trades
  src/services/crypto/swapService.js - DEX swap execution (V2/V3 routing)

API:
  src/api/crypto.js - All crypto API routes

Logging:
  src/utils/logger.js - Logger config (all-activity.log: 30MB maxsize, 5 maxFiles, tailable)

Deposit detection:
  src/services/crypto/tokenScanner.js - Scans for ERC-20 Transfer events

=== SWAP SERVICE DETAILS ===

Key function: swap(tokenIn, tokenOut, amountIn, slippageTolerance, network, options)

Options:
  forceV3: boolean - MUST be true for token_trader. Aborts if V3 fails.
  expectedOutputUsd: number - For output sanity check (70% threshold). Always set this.
  enableRetry: boolean - Retry with higher slippage on revert
  tokenTaxPercent: number - Fee-on-transfer tax percentage
  maxSlippage: number - Max slippage tolerance

Supported networks: ethereum, bsc, polygon, base (mainnet) | sepolia, bsc-testnet (testnet)
V3 fee tiers: ETH [500, 3000, 10000, 100], BSC [2500, 500, 10000, 100]

DEX routers:
  ETH: Uniswap V2 (0x7a25...), Uniswap V3 (0xE592...), SushiSwap
  BSC: PancakeSwap V2 (0x10ED...), PancakeSwap V3 (0x13f4...)
  Polygon: Uniswap V2 (0x4752...)
  Base: Uniswap V2 (0xC532...)

Quote comparison: _compareV2V3() gets quotes from both, logs "V3 wins" or "V2 wins"
V3 consistently wins by ~12% over V2 for SIREN

=== LOG PATTERNS FOR GREP ===

Strategy cycles:
  "Strategy dollar_maximizer result:"
  "Secondary strategy token_trader result:"
  "TokenTrader [SIREN]:" / "TokenTrader [FHE]:"
  "DollarMaximizer:"

Routing:
  "V3 wins quote:" / "V2 wins quote:"
  "V3 selected" / "V3 quote found:"
  "forceV3 is enabled — refusing V2 fallback"

Safety:
  "Output sanity check failed:" / "Output sanity OK:"
  "STOP-LOSS:" / "emergency_sell"
  "Post-dump cooldown active"
  "Price recovered +X% from dump price"
  "early re-entry allowed"
  "SELL ABORTED" (no price reference for sanity check)
  "Spot price unavailable" (using entry price fallback)
  "bearish trend" / "bearish short-term trend" (DIP buy blocked by trend gate)
  "strong long-term downtrend" (DIP buy blocked by long-term trend)
  "Skipping DCA"
  "Circuit breaker" / "CIRCUIT BREAKER"

Trades:
  "TokenTrader SELL:" / "TokenTrader BUY:"
  "Best swap: V3 path" / "Best swap: V2 path"
  "Swap confirmed:" / "swap.*fail"

Scale-out & profit-taking:
  "Scale-out at" / "scale-out level hit"
  "Pump stall detected" (v5 new - time-based profit-taking)
  "Moon scale-out"
  "trailing stop" / "Trailing stop hit"

Config migration:
  "Config migration v" (version upgrades)
  "Post-migration config"

Reconciliation:
  "Syncing token balance"
  "deposit.*detected" / "strategy.managed"

Prices:
  "Crypto price monitor:"
  "Crypto heartbeat:"
  "significant move"

=== DEPLOYMENT ===

Always syntax-check before deploying:
  source ~/.nvm/nvm.sh && nvm use 20
  node --check src/path/to/file.js

Deploy scripts (from dev machine):
  ./scripts/deployment/deploy-files.sh src/path/file.js - Single file
  ./scripts/deployment/deploy-quick.sh - Fast full deploy
  ./scripts/deployment/deploy-check.sh - Health check
  ./scripts/deployment/deploy-rollback.sh - Rollback

After deploy, restart PM2:
  sshpass -p "$PRODUCTION_PASS" ssh root@$PRODUCTION_SERVER "cd /root/lanagent-deploy && pm2 restart ecosystem.config.cjs"

=== CHECKLIST WHEN DIAGNOSING ===

Run: ./scripts/diag-crypto.sh health (covers most checks)

1. Is the process running? (pm2 list, uptime)
2. Are logs being written? (check file mod times — timestamps are PST)
3. Any errors in logs? (errors.log, pm2 error log)
4. Is the strategy cycling? (look for "Strategy ... result:" in activity log)
5. Are V3 quotes winning? (look for "V3 wins quote:")
6. Is forceV3 still set? (grep forceV3 in CryptoStrategyAgent.js on production)
7. What regime is token_trader in? (token-trader/status API)
8. Is the trend gate working? (look for "bearish trend" in DIP regime)
9. Any recent trades? (grep SELL/BUY in crypto log)
10. Are prices being tracked? (grep "price monitor" in activity log)
11. Output sanity checks passing? (grep "sanity" in activity log)
12. Any "SELL ABORTED" entries? (safety net triggered)
13. Is trailing stop at correct value? (should be peak * 0.955 for PUMP/MOON, peak * 0.95 for MOON>50%)
14. Has pump stall detection triggered? (look for "Pump stall detected" or check pumpEnteredAt in API)
15. Config version correct? (should be 5, check for "Config migration" in logs after restart)

=== KNOWN ISSUES ===

- The /api/crypto/balances and /api/crypto/strategy/config endpoints sometimes return "Plugin 'crypto' not found" even when the app is running. Use token-trader/status and strategy/status endpoints instead — those work reliably.
- The selfModification service has recurring errors ("feature.toUpgradeFormat is not a function", dead imports, invalid paths) — unrelated to crypto, ignore these.
- "Balance verification failed" errors appear after some swaps — cosmetic, the swap itself succeeds.
- Faucet claim errors for testnets (sepolia, amoy, bsc-testnet) — cosmetic, unrelated to mainnet trading.
- pumpEnteredAt will be null after a restart until the next regime transition into PUMP/MOON. This means the 6hr stall timer resets on restarts — acceptable since restarts are infrequent.

=== LOSS HISTORY ===

FHE losses (Feb 1-14): -$297.16 realized
  Feb 3 09:40: -$217.47 — Catastrophic V2 sale (FIX: sanity check + abort if no price ref)
  Feb 2-4: Multiple stop-losses from DCA into downtrends (FIX: trend gate added)
  Feb 11-14: Continued FHE decline, multiple stop-losses

SIREN gains (Feb 14-present): +$183.64 realized, +$87.56 unrealized
  Feb 15: Switched to SIREN, immediate PUMP
  Feb 15-22: Scale-outs at 10%, 20%, 30% levels
  Feb 22: Last major sell — 433 SIREN @ $0.2866 (+$28.84)
  Feb 23: Holding at +32.3%, waiting for 40% level

Net position: -$297.16 (FHE) + $271.21 (SIREN) = -$25.95 total

=== WHAT TO NEVER DO ===

NEVER allow V2 fallback for token_trader swaps
NEVER remove or weaken the output sanity check (70% threshold)
NEVER remove the expectedOutputUsd fallback chain (spot → entryPrice → abort)
NEVER remove the trend gate on DIP buys
NEVER sell 100% on hourly volatility spikes (only on absolute stop-loss)
NEVER skip expectedOutputUsd — always set it, use spot-price fallback if getQuote fails
NEVER deploy without syntax check (node --check)
NEVER push to production without verifying the fix in logs after restart
NEVER add co-author lines or your name to git commits
NEVER reduce the trailing stop percent below 4% (too tight causes premature exits on noise)
NEVER remove the pump stall sell mechanism (prevents indefinite holding during consolidation)
