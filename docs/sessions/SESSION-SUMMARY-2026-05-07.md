# Session Summary — 2026-05-07 / 2026-05-08

**Versions shipped:** v2.25.30 → v2.25.31 → v2.25.32 (two patches, both deployed to ALICE production).

## 1. Investigation — stale `lastAnalysis` on the SIREN token-trader

Operator pointed out that the crypto strategy agent's `tokenTraderStatus.0x997a58…18e1.lastAnalysis` was reading `2026-05-06T03:57:46.364Z` — ~36 hours stale — even though the agent itself was healthy and ticking `dollar_maximizer` every 10 minutes against ETH and BSC. Asked to look at it and fix it.

### Verifying the symptom

`GET /api/crypto/strategy/status` confirmed the agent was running, last successful execution was minutes ago, dollar_maximizer was the active strategy, ETH (-2.90% from baseline) was being held against a -3% stop-loss, BSC was holding stablecoin waiting for a -10.5% drop. PnL: $6.84 total, $0.07 from DM, $6.78 from token-trader. SIREN's `tokenTraderStatus` block showed full position data — but `lastAnalysis: 2026-05-06T03:57:46.364Z`. Stale.

`GET /api/crypto/strategy/token-trader/status` was the smoking gun:

```json
{
  "activeInstances": 0,
  "instances": {},
  "heartbeats": {
    "started": false,
    "tokenCount": 0,
    "concurrentTicks": 0,
    "ticksThisMinute": 0,
    "tokens": {}
  }
}
```

The token-trader registry was **empty** at the runtime layer — no instances, heartbeat manager not started. The `tokenTraderStatus` block surfaced by `/strategy/status` was a stale display cache in `domainState`, not live state.

### Root cause

Cross-referencing `git log` and the previous day's session report: commit `2853417f` ("fix(crypto): restore genesis-only strategy registrations in StrategyRegistry") landed on 2026-05-06 21:39 to fix the registry that the 2026-04-10 public→genesis sync had inadvertently scrubbed. That hotfix restored the strategy *class* registrations (`NativeMaximizer`, `DollarMaximizer`, `TokenTrader`, etc.) — but the runtime `tokenTraders` Map and `secondaryStrategy` field were not in scope of that fix.

Verified directly in MongoDB:

```js
domainState.strategyRegistry.activeStrategy:    'native_maximizer'  // pre-2853417f baseline
domainState.strategyRegistry.secondaryStrategy: null
domainState.strategyRegistry.tokenTraders:      undefined           // no SIREN instance
domainState.strategyRegistry.strategies.token_trader.config.tokenAddress: null
domainState.tokenTraderStatus:
   '0x997a58…': { token: { symbol: 'SIREN' }, lastAnalysis: '2026-05-06T03:57:46.364Z', ... }
```

The cached display block in `tokenTraderStatus` is what the operator was seeing. The actual SIREN token-trader instance was wiped from the registry sometime around the 2026-05-06 03:57 timestamp (last good `lastAnalysis`) and never came back. Since `CryptoStrategyAgent.initialize()` only calls `tokenHeartbeatManager.startAll()` when `allTokenTraders.size > 0` at agent init, and the persisted state had no token traders, the heartbeat manager never started after the 2026-05-06 21:21 restart that ran the registry-restore hotfix.

**The wallet still held 363.32 SIREN tokens entirely unmanaged**: no trailing stop, no scale-out logic, no monitoring, no exit on a dump. Just sitting there.

## 2. Recovery — re-arming SIREN with `configure` + `restore-state`

Confirmed the plan with the operator before touching real funds, then ran:

**Step 1** — register the instance:

```bash
POST /api/crypto/strategy/token-trader/configure
{
  "tokenAddress": "0x997a58129890bbda032231a52ed1ddc845fc18e1",
  "tokenNetwork": "bsc",
  "capitalAllocationPercent": 50,
  "tokenTaxPercent": 0
}
```

Response: `{ activeInstances: 1, regime: 'ENTERING', capitalAllocation: { primary: 50, secondary: 50 } }`. Good — instance back, secondary strategy set.

**Step 2** — restore state from the cached display block before any heartbeat tick fires (regime=ENTERING would auto-buy more SIREN otherwise):

```bash
POST /api/crypto/strategy/token-trader/restore-state?token=0x997a58…18e1
{
  "position": {
    "tokenBalance": 363.31518946072714,
    "stablecoinReserve": 433.13245462157687,
    "averageEntryPrice": 0.7521288198312241,
    "totalInvested": 2035.4501114048785,
    "totalReceived": 1812.4469991158373
  },
  "pnl": { "realized": 50.429423409351585, "unrealized": -2.3417734331205704, "lifetimeRealized": 50.429423409351585 },
  "tracking": { "peakPrice": 0.8727790018637857, "trailingStopPrice": 0.8029566817146828, "scaleOutLevelsHit": [10] },
  "circuitBreaker": { "consecutiveStopLosses": 0, "tripped": false },
  "regime": "SIDEWAYS"
}
```

Response: success, position restored.

## 3. Same-day rescue: catching a +37% pump mid-recovery

Unbeknownst to the operator (and to the offline trader for the past 36 hours), SIREN had **pumped from a $0.75 baseline to $1.024 — +37%** while the trader was offline. The very next strategy tick (manually triggered) ran the secondary path and the trader fired three consecutive scale-outs in seven minutes:

| Time         | Level     | Amount sold        | Price    | Realized PnL |
|--------------|-----------|--------------------|----------|--------------|
| 09:44:47 PT  | +20%      | 36.3315 SIREN      | $1.020   | +$9.74       |
| 09:45:17 PT  | +25%      | 49.0476 SIREN      | $1.017   | +$13.01      |
| 09:51:47 PT  | +30%      | 41.6904 SIREN      | $1.009   | +$10.71      |
| **Total**    |           | **127.07 SIREN**   |          | **+$33.46**  |

Lifetime realized PnL: **$50.43 → $83.89 in 7 minutes**. Trailing stop updated from $0.803 → $0.978 (8% below new peak $1.024). MongoDB confirms persistence: `realizedPnL: 73.18` after the first two sells (the third happened during PM2 restart and was reflected in the post-restart status: `realizedPnL: 83.89`).

Catching this pump was an unintended side-effect of the rescue — the trader had been silently broken for 36 hours and would have continued to be broken if not for the operator's eye on the stale `lastAnalysis` timestamp.

## 4. Two latent bugs surfaced during the rescue

### Bug 1 — Heartbeat manager doesn't auto-start when first token-trader is added at runtime

After step 1 + step 2, the API said `activeInstances: 1` but `heartbeats.started: false, tokenCount: 0`. The per-token heartbeat manager **wasn't running**, even though SIREN was now in the registry. SIREN was only ticking via the 10-min main-heartbeat fallback path (`CryptoStrategyAgent.js:567-589`) — meaningful coverage but not the regime-based interval (3 min during PUMP, 1 min during DUMP).

Reading `src/api/crypto.js:1441`:

```js
// Start independent heartbeat for this token if manager is available
if (handler.tokenHeartbeatManager?.started) {
    handler.tokenHeartbeatManager.startToken(tokenAddress);
}
```

Reading `TokenTraderHeartbeatManager.startAll()` and the agent's `initialize()`:

```js
// CryptoStrategyAgent.js:184
this.tokenHeartbeatManager = new TokenTraderHeartbeatManager(this);
if (allTokenTraders.size > 0 && this.agentDoc.enabled) {
  this.tokenHeartbeatManager.startAll();
}
```

`.started` only flips to `true` inside `startAll()`. If the agent boots with an empty `tokenTraders` map, `startAll()` is never called, `.started` stays `false`, and any later `configure` call hits the `?.started` guard at line 1441 and silently skips starting the heartbeat. Then `_tick()` at `TokenTraderHeartbeatManager.js:159` is `if (!this.started) return;` — even if `startToken()` *were* called somehow, ticks would be no-ops.

For a token-trader sitting in PUMP regime that's a 7× degradation — should be 3-min ticks, gets 10-min ticks. For a DUMP regime (1-min ticks) it's a 10× degradation, and DUMP exists precisely because emergency sells need speed.

**Fix:**

```js
// Start independent heartbeat for this token if manager is available.
// If the manager was never started (registry was empty at agent init),
// bring it up now — startAll() picks up the newly registered instance.
if (handler.tokenHeartbeatManager) {
    if (!handler.tokenHeartbeatManager.started) {
        handler.tokenHeartbeatManager.startAll();
    } else {
        handler.tokenHeartbeatManager.startToken(tokenAddress);
    }
}
```

`startAll()` is idempotent and reads the registry fresh each time — picking up the newly-registered instance is exactly what we want.

### Bug 2 — `/strategy/token-trader/restore-state` mutated state in-memory only

After step 2, MongoDB still showed `SIREN balance: 0, avgEntry: 0` despite the API response confirming the restore. The endpoint at `src/api/crypto.js:1568-1642` writes:

```js
tokenStrategy.state.tokenBalance        = position.tokenBalance || 0;
tokenStrategy.state.stablecoinReserve   = position.stablecoinReserve || 0;
tokenStrategy.state.averageEntryPrice   = position.averageEntryPrice || 0;
// ... etc
res.json({ success: true, ... });
```

No `persistRegistryState()` call. Compare `/configure` at line 1436:

```js
// Persist registry state to DB immediately so the token survives restarts
if (handler.persistRegistryState) {
    await handler.persistRegistryState();
}
```

The restored cost basis / realized PnL / trailing-stop / peak-price values lived only in memory until the next full `execute()` cycle ran, where the `finally` block at `CryptoStrategyAgent.js:747` finally calls `persistRegistryState()`. If the agent restarted before that — say, during a deploy — the restore was lost.

In our case the next `execute()` cycle did persist (we verified `realizedPnL: 73.18` in MongoDB after the first sells). But that was luck of timing.

**Fix:**

```js
logger.info(`TokenTrader state restored for ${tokenStrategy.config.tokenSymbol}: ...`);

// Persist registry so the restored cost basis / PnL / tracking survive a restart
if (handler.persistRegistryState) {
    await handler.persistRegistryState();
}

res.json({ ... });
```

## 5. Deploy + verification

`node --check src/api/crypto.js` → OK. `./scripts/deployment/deploy-files.sh src/api/crypto.js` → rsync + PM2 restart. Waited ~3 min for web UI warmup, then re-checked.

Post-restart status:

```json
{
  "activeInstances": 1,
  "heartbeats": {
    "started": true,
    "tokenCount": 1,
    "concurrentTicks": 0,
    "ticksThisMinute": 1,
    "tokens": {
      "0x997a58129890bbda032231a52ed1ddc845fc18e1": {
        "symbol": "SIREN",
        "regime": "PUMP",
        "interval": 180,
        "intervalLabel": "3m",
        "running": false,
        "lastRun": "2026-05-07T16:51:54.599Z",
        "consecutiveErrors": 0,
        "backedOff": false
      }
    }
  }
}
```

Crypto log confirms:

```
09:48:38 [INFO] Secondary strategy set: none → token_trader
09:48:38 [INFO] Price monitor: registered SIREN for DEX price tracking
09:48:38 [INFO] TokenHeartbeat: Starting 1 independent heartbeats (staggered over 5s)
09:48:38 [INFO] TokenHeartbeat: Started SIREN — interval 180s (PUMP)
09:51:47 [INFO] TokenTrader: Selling 41.6904 SIREN (Scale-out at +30% level (current: +34.3%, selling 15%))
09:51:53 [INFO] TokenTrader SELL: 41.6904 SIREN @ $1.009114 (received $42.07, PnL: $10.71, gas: $0.0042)
09:51:54 [INFO] TokenHeartbeat: SIREN tick complete — sell_token (15915ms)
```

Final SIREN state:

- Balance: 236.25 SIREN (was 363.32, sold 127.07 into the pump)
- Reserve: $562.18 (was $433.13, captured $129.05)
- avgEntry: $0.7521 (preserved)
- peakPrice: $1.024 (was $0.873)
- trailingStop: $0.978 (8% below new peak — protects gains)
- realizedPnL: $83.89 (was $50.43)

## 6. Files changed

- `src/api/crypto.js` — heartbeat-manager auto-start in `/strategy/token-trader/configure`; `persistRegistryState()` in `/strategy/token-trader/restore-state`
- `package.json` — 2.25.30 → 2.25.31
- `CHANGELOG.md` — v2.25.31 entry
- `docs/api/API_README.md` — v2.25.31 section under "Recent Updates (May 7, 2026)"
- `docs/api/LANAgent_API_Collection.postman_collection.json` — version bump + description rewrite
- `docs/feature-progress.json` — `cryptoTokenTraderHeartbeatFix_2026_05_07` entry, `lastUpdated` / `status` / `milestone` updated
- `docs/sessions/SESSION-SUMMARY-2026-05-07.md` — this report

## 7. Pickup notes for next session

- **Genesis-only fix.** Per memory entry `crypto_strategy_registry_genesis_only.md` and the v2.25.26 strategy-name scrub — do not sync this to public. The public repo's `StrategyRegistry.js` and `strategies/index.js` are the scrubbed versions and should stay that way. Only `src/api/crypto.js` itself is in scope of the public repo, but the fix is generic enough that it would still work there if synced — defer that decision until next public sync.
- **`tokenTraderStatus` display cache is misleading after a registry rebuild.** The block stays populated from `domainState.tokenTraderStatus` even after the live `tokenTraders` Map has been wiped, with a stale `lastAnalysis` that looks like the strategy is just sleeping. Worth thinking about whether the cache should self-invalidate when the corresponding instance is missing from the registry — or whether `/strategy/status` should fall back to the live registry instead. Out of scope for this session.
- **Watchlist regression.** Pre-incident the SIREN token-trader had `tokenWatchlist: ["SKYNET", "SIREN", "KITE", "RIVER", "BASED"]`. Post-restore the watchlist is empty (the base `token_trader` instance had its config reset, and instances copy the watchlist from the base on creation). If watchlist rotation matters for SIREN's strategy (e.g., during CIRCUIT_BREAKER or COOLDOWN regimes), repopulate via `/api/crypto/strategy/token-trader/watchlist` — but the operator marked SIREN with `userConfigured: true` via the configure endpoint, so watchlist rotation is suppressed for this instance anyway.
- **SIREN is in PUMP regime with trailing stop at $0.978.** Current price ~$1.01. If price drops 8% from peak, trailing stop fires and the trader sells. If price keeps pumping, more scale-outs happen at +40% and +50% levels.
- **DM ETH position rebalanced during the session.** ETH stop-loss didn't fire (price recovered from -2.90% to +0.50%) but the position is fresh: 0.1042 ETH @ $2297 entry, $145 stable reserve. This is unrelated to the SIREN work — the dollar_maximizer has been running cleanly throughout.

---

# v2.25.32 — ALICE-authored PR triage (#2116–#2126)

11 ALICE self-modification PRs sitting open. Reviewed one by one.

## 8. Triage outcome summary

| PR | Target | Decision |
|---|---|---|
| #2116 | `agentAccessor.js` | Closed — placeholder validation that always returns false (would block agent boot) |
| #2117 | `ContractABI.js` | Closed — projects out `abi` from `getByAddressAndNetwork`, defeating the method's purpose |
| #2118 | `cookiesAdmin.js` | Closed + manually re-implemented (actor identity in audit logs) |
| #2119 | `selfHealing.js` | Closed + manually re-implemented (Agenda-backed schedule/list/cancel) |
| #2120 | `documentLoader.js` | Closed — conditional GET branch unreachable behind cache-first early-return |
| #2121 | `ModelCache.js` | **Merged** — read-side aggregation correct (write-side is dead infrastructure but the method works the moment something populates it) |
| #2122 | `lpMarketMaker.js` | Closed + manually re-implemented (public `/health` mounted above auth middleware) |
| #2123 | `UserPreference.js` | Closed — placeholder templates unrelated to any real plugin's preference shape |
| #2124 | `outputSchemas.js` | Closed — same defect as previously-closed #2113 (inert `version` field, no version-aware logic) |
| #2125 | `checkly.js` | Closed + manually re-implemented (Agenda-backed recurring polls) |
| #2126 | `metricsUpdater.js` | Closed — wraps a write operation in a 5-min result cache, defeats the cron |

Net: **1 merged + 4 features manually re-implemented + 6 closed without salvage**. Per-PR rationale on each closed PR.

## 9. The four manual salvages

The pattern across all four was: ALICE had a real idea, named the right primitive, but invented or misused a method that doesn't exist (`TaskScheduler.scheduleJob`, `req.user.username`, `validateStatus` ignoring 304s). Implemented the same intent correctly, in less surface area than the PR.

### `selfHealing.js` (was #2119) and `checkly.js` (was #2125) — Agenda-backed scheduling

Both PRs imported `TaskScheduler` from `src/services/scheduler.js` and called either `TaskScheduler.scheduleJob(...)` (#2125, static, doesn't exist) or `new TaskScheduler().scheduleJob(...)` (#2119, fresh uninitialized instance). The `TaskScheduler` class wraps Agenda; the actual primitives are `agenda.schedule(time, name, data)` (one-shot), `agenda.every(interval, name, data)` (recurring), and the singleton lives at `this.agent.services.get('taskScheduler')`. The canonical example is `src/api/plugins/integromatnowmake.js:80-95, 261`.

Both PRs also captured anonymous closures as job handlers — those don't survive a restart since Agenda needs a *named* job whose handler is re-registered on every boot.

**Replaced with** `selfHealing.schedule/listScheduled/cancelScheduled` and `checkly.schedule_check/list_scheduled_checks/cancel_scheduled_check`. Both:

- Get `taskScheduler` from `this.agent.services.get('taskScheduler')` in `initialize()`
- Define a *named* Agenda job (`'self-healing-action'` / `'checkly-scheduled-poll'`) at init so the handler is registered on every restart
- Use `agenda.schedule()` for one-shot (selfHealing — `actionType` + `time`) or `agenda.every()` for recurring (checkly — `interval` like `"5 minutes"`)
- Provide `list*` and `cancel*` actions for visibility/control (the PR was half-feature)
- The job handler `throws` on operation failure so Agenda records `failReason` on the job document, surfaced via `list*`
- All actions return `{ success: false, error: 'Scheduler not available' }` if the scheduler service didn't initialize, rather than throwing

The checkly version also makes re-scheduling idempotent: `agenda.cancel({ name, 'data.checkId': checkId })` first, then `agenda.every(...)`. Otherwise re-running `schedule_check` would create duplicate pollers.

### `lpMarketMaker.js` (was #2122) — public `/health`

PR title claimed *"exponential backoff retry logic"* but the actual diff added a single `router.get('/health', (req, res) => res.json({ success: true, message: 'Service is healthy' }))`. The endpoint:

1. Is mounted *after* `router.use(authenticateToken)` at line 12 — so it 401s without a JWT, defeating the only reason a health check would exist (external monitor pinging without credentials).
2. Returns success unconditionally — no actual probe.
3. Doesn't implement the retry logic the title claims.

(`retryOperation` already implements exponential backoff with jitter; that "feature" shipped long ago.)

**Replaced with** a `/health` route mounted *above* the `authenticateToken` line that calls `lpMarketMaker.getConfig()` to verify the underlying service is responsive, returns `{ success, enabled, initialized }` on 200, and 503 with the error message if the config fetch throws. Same pattern as `src/api/avatar.js:274` and `src/api/faucets.js:281`. No position details leak since the endpoint is unauthenticated.

### `cookiesAdmin.js` (was #2118) — actor identity in audit logs

PR added a flat-file `audit.log` with `${user.username} ${action} ${host}` lines. Two breakages:

1. `req.user.username` doesn't exist — the JWT payload at `webInterface.js:326` is `{ user: 'admin' }`, so the field is `req.user.user`. Every audit line would log `User: undefined`.
2. `req.user` itself is undefined when the request authenticates via API key (`auth.js:165` sets `req.apiKey` instead, no `req.user`). `req.user.username` would throw a `TypeError` and 500 the upload/delete handler even though the actual file write succeeded.

The flat-file approach is also redundant — the existing `logger.info('[cookies-admin] uploaded cookies for ${host}…')` lines already land in the project's organized service-specific log files (per `docs/LOGGING.md`). A second hand-rolled file with no rotation, no structured fields, and no query layer is strictly worse than what's there.

**Replaced with** a `actorOf(req)` helper that handles both auth modes (`jwt:<user>` / `apikey:<name>` / `unknown`) and inlined the actor into the existing `logger.info` lines via `by=${actorOf(req)}`. Same audit trail, same file the operator already tails, no duplicate file, no crashes for API-key callers.

## 10. The six clean closures

These six had no salvageable feature:

- **#2116 agentAccessor** — `validateAgent()` checks `agent.someMethod` and `agent.someProperty` — placeholder property names the AI didn't fill in. Always false. Would block `setGlobalAgent(this)` at `agent.js:114`, agent never registers, all services that depend on the global accessor (P2P, crypto strategies) break. Also makes `setGlobalAgent` async without awaiting at the call site (race condition by design), wraps a local-variable assignment in `retryOperation` (can't fail), and adds a `NodeCache` layer duplicating the singleton. Nothing to keep.
- **#2117 ContractABI** — `getByAddressAndNetwork` adds `projection: { abi: 0 }` to the `findOne`. The method's whole purpose per its docstring is *"Retrieves a ContractABI by address and network"* — projecting out the ABI returns the wrong shape. The hot ABI-fetch path at `abiManager.js:135-159` doesn't even use this method, so the "optimization" is moot anyway.
- **#2120 documentLoader** — `WebLoader.load:130-132` returns the cached document *before* any HTTP request runs. The new `If-None-Match` / `If-Modified-Since` headers below only fire on cache miss — exactly when there's no etag/last-modified to send. Empty conditional headers when cache is empty. Axios's default `validateStatus` rejects 304 as error. The 304 handler reads from a `cached` object that's `undefined` on the only path that reaches it. Eight lines that can't run together correctly.
- **#2123 UserPreference** — three hardcoded "templates" `{ theme, notifications }` that don't match any real plugin's preference schema. `applyTemplate('youtube', userId, 'subscriptions', 'darkMode')` would overwrite YouTube subscription preferences with `{ theme: 'dark', notifications: true }` — gibberish. No template registry, no caller, no API exposure.
- **#2124 outputSchemas** — adds `version: 1` to every schema but doesn't add version-aware logic to `adjustSchema` or `validateData`. `version` isn't a JSON Schema keyword. No consumer reads `schema.version`. Same defect as previously-closed #2113.
- **#2126 metricsUpdater** — wraps `ImprovementMetrics.updateMetrics(date)` (a *write* operation) in a 5-minute NodeCache result cache. The whole reason the 15-min cron exists is to *re-run* the rebuild. Caching the result means the DB stops getting updated. Backfill cache key strips time, causing date-boundary bugs. Description claims exponential backoff (already shipped in `retryOperation`) but doesn't touch retry logic at all.

## 11. Files changed in v2.25.32

- `src/models/ModelCache.js` — PR #2121 merged as-is
- `src/api/lpMarketMaker.js` — public `/health` (manual salvage of #2122)
- `src/api/plugins/selfHealing.js` — `schedule` / `listScheduled` / `cancelScheduled` (manual salvage of #2119)
- `src/api/plugins/checkly.js` — `schedule_check` / `list_scheduled_checks` / `cancel_scheduled_check` (manual salvage of #2125)
- `src/interfaces/web/cookiesAdmin.js` — `actorOf(req)` helper + `by=<actor>` in upload/delete log lines (manual salvage of #2118)
- `package.json` — 2.25.31 → 2.25.32
- `CHANGELOG.md` — v2.25.32 entry
- `docs/api/API_README.md` — v2.25.32 section
- `docs/api/LANAgent_API_Collection.postman_collection.json` — version + description
- `docs/feature-progress.json` — `alicePRTriage_2026_05_08` entry
- `docs/sessions/SESSION-SUMMARY-2026-05-07.md` — this section

## 12. Pickup notes for the next session (v2.25.32)

- **`trackUsage()` wire-up.** The merged `ModelCache.getUsageAnalyticsData()` returns zeros until something starts calling `ModelCache.methods.trackUsage(responseTime, isError)` from the request path — most natural place is `BaseProvider.recordRequest()` after every model call, with the per-provider ModelCache document as the target. Pair it with adding `$group: { _id: '$provider', ... }` to the new aggregation so we get per-provider breakdown instead of just a global rollup. That's a small follow-up PR worth doing.
- **`AGENT_REPO_PATH` self-modification cycle.** The agent will keep generating capability-upgrade PRs on its own schedule. The triage pattern is now well-established: closed PRs need a comment explaining what defect was found and (if salvageable) what the manual fix was. The Agenda-scheduling pattern (`integromatnowmake.js:80-95, 261`) is the canonical example for any "schedule X" feature ALICE proposes — closed PRs that try to invent their own scheduler should always be re-implemented against the agent's existing `taskScheduler` singleton.
- **Public sync.** All five v2.25.32 source-file changes are public-safe (none of them touch crypto-strategy infrastructure that's been scrubbed out of the public repo per the v2.25.26 strategy-name scrub). Sync to `PortableDiag/LANAgent` after the genesis push.

## 13. Post-deploy follow-up: mount-order fix for `/api/crypto/lp/mm/health`

Verified the v2.25.32 deploy by hitting the new public health endpoint:

```
$ curl http://192.168.0.52/api/crypto/lp/mm/health
{"success":false,"error":"Authentication required"}
```

That's wrong — the whole point of moving `/health` *above* the `router.use(authenticateToken)` line in `lpMarketMaker.js` was to make the endpoint reachable without a JWT for external monitors (Cloudflare uptime, gateway liveness probes). But it was 401'ing.

### What was actually happening

`webInterface.js` mounts the routers in this order (pre-fix):

```js
this.app.use('/api/crypto', cryptoRoutes);              // line 242
// ... other routers ...
this.app.use('/api/crypto/lp/mm', lpMarketMakerRoutes); // line 254
```

`cryptoRoutes` (`src/api/crypto.js:53`) has a router-level auth middleware:

```js
router.use(authMiddleware);
```

That middleware fires for *any* request matching the `/api/crypto/*` prefix and 401s without credentials. Because `cryptoRoutes` was mounted at the broader prefix `/api/crypto` and *before* `lpMarketMakerRoutes`, every `/api/crypto/lp/mm/*` request hit `cryptoRoutes` first. The auth middleware ran, terminated the response with 401, and Express never had a chance to fall through to the deeper `/api/crypto/lp/mm` mount where the public `/health` was sitting.

### Fix

Swapped the mount order in `webInterface.js` so `lpMarketMakerRoutes` mounts *before* `cryptoRoutes`:

```js
// lpMarketMakerRoutes must mount BEFORE the broader /api/crypto router —
// cryptoRoutes applies router-level authMiddleware that 401s any request
// hitting `/api/crypto/*` before it can fall through to deeper mounts. Mount
// the LP MM router first so its public /health endpoint (defined above the
// auth middleware in lpMarketMaker.js) is reachable without a JWT. The
// remaining /api/crypto/lp/mm/* routes still gate on lpMarketMaker.js's
// own router-level authMiddleware.
this.app.use('/api/crypto/lp/mm', lpMarketMakerRoutes);
this.app.use('/api/crypto', cryptoRoutes);
```

Now `/api/crypto/lp/mm/*` paths hit `lpMarketMaker.js` first. Inside that file the routing is:

1. `router.get('/health', ...)` — public, no auth
2. `router.use(authMiddleware)` — gates every following route
3. `router.use(async (req, res, next) => { ... lazy-init ... })` — same
4. `router.get('/status', ...)` etc. — all authenticated

So only `/health` is public; the rest of the LP MM API is still locked.

Verified post-deploy (`./scripts/deployment/deploy-files.sh src/interfaces/web/webInterface.js`):

```
$ curl http://192.168.0.52/api/crypto/lp/mm/health
{"success":true,"enabled":true,"initialized":false}
HTTP 200
```

Committed as `4638e0cb` (genesis) and `eb63c63f` (public) — both pushed.

### Why I missed this in code review

When I implemented the salvage of #2122 I checked `lpMarketMaker.js` itself and confirmed `/health` was mounted *above* `router.use(authMiddleware)` — which is correct *inside that router file*. What I didn't check was the mount order at the app level, where a sibling router mounted at a less-specific prefix can catch the request first if its own middleware terminates the response without falling through.

The general lesson: **router-level auth middleware on a less-specific mount path acts as auth on every deeper mount that shares the prefix**, regardless of what those deeper routers think they're doing internally. Worth a quick audit of any other `/api/*` route that has this nested-prefix shape — `/api/crypto` is the only one in the codebase right now with deeper sibling mounts under it.

Pickup note: if any future ALICE-generated PR adds a new public health/probe endpoint under an existing auth-gated prefix, the same trap applies. Always verify the *external* HTTP behavior, not just the source code.
