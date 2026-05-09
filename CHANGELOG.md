# Changelog

All notable changes to LANAgent will be documented in this file.

## [2.25.33] - 2026-05-08

LP market-maker accounting fixes prompted by a routine status audit. The position had been showing `'0/0'` lifetime fees and an `openedAt` timestamp that didn't match the active tokenId.

### Fixed

- **LP MM: 70 days of zero fee accounting.** `lpManager.collectFeesV3` returned only `{txHash, success}` — never the actual amounts collected. `lpMarketMaker.collectFees` updated `lastFeeCollectAt` but never incremented `totalFeesCollectedSKYNET` / `totalFeesCollectedWBNB`. Status payloads displayed `0/0` lifetime fees no matter how many on-chain Collects had happened. Fix: `collectFeesV3` now reads `tokensOwed0/1` just before the collect tx (free view call already in the function), formats to ether-units, and returns `{txHash, success, amount0, amount1}` (same value the chain withdraws, modulo trailing-block accruals). `lpMarketMaker.collectFees` reads those, increments the lifetime totals, persists in one `saveState` call, and logs `+X SKYNET, +Y WBNB (lifetime: ...)` per collection. Pool ordering is canonical (token0 < token1 by address); for SKYNET/WBNB on BSC, SKYNET = token0, WBNB = token1.
- **LP MM: `openedAt` stale across rebalances.** `rebalancePosition` correctly updated `state.tokenId` when it minted a new position, but never refreshed `openedAt` — so the displayed value stuck on the very first position's mint time, even after rebalances created several new tokenIds. Fix in `rebalancePosition` adds `openedAt: now` to the `saveState` call alongside the new tokenId. Comments document why `rebalanceCount` (strategy-lifetime telemetry) and `rebalancesLast24h` (the rolling window the circuit breaker reads to enforce `maxRebalancesPerDay`) intentionally stay rolling — zeroing the latter would let the strategy spam-rebalance.

### Added

- **`scripts/backfill-lpmm-fees.js`** — one-shot tool that walks NPM Collect events for a tokenId across a 70-day window. Uses NodeReal's free-tier archive RPC (50k-block range cap, ~272 chunks in ~30s for a 70-day window). Print-only; produces a paste-ready mongosh update if amounts are non-zero. Re-runnable any time. The first run found `0` Collect events for the active LP MM position (`IncreaseLiquidity` × 1 at the mint, no `DecreaseLiquidity`, no `Collect`, on-chain `tokensOwed=0` and `feeGrowthInside last=0`) — the `'0/0'` lifetime totals were factually correct, just for a different reason than the audit assumed (no fees were ever collected because no Collects ever fired, not because they fired and weren't tracked).

### Files changed

- `src/services/crypto/lpManager.js` — `collectFeesV3` returns formatted `amount0`/`amount1`
- `src/services/crypto/lpMarketMaker.js` — `collectFees` increments lifetime totals; `rebalancePosition` resets `openedAt` on new tokenId
- `scripts/backfill-lpmm-fees.js` — new tool
- `package.json` — 2.25.32 → 2.25.33
- `CHANGELOG.md` — this entry

## [2.25.32] - 2026-05-08

ALICE-authored capability-upgrade PR triage (#2116–#2126) — 11 PRs reviewed one by one. 1 merged, 4 manually re-implemented, 6 closed.

### Added (manual salvage of closed PRs)

- **`POST /api/crypto/lp/mm/health`** — public unauthenticated liveness probe for the LP market maker. Mounted above `router.use(authenticateToken)`. Calls `lpMarketMaker.getConfig()` to verify the underlying service is responsive; returns `{ success, enabled, initialized }` on 200, 503 if the config fetch throws. (Replacement for #2122.)
- **Self-healing service: scheduled actions.** `selfHealing` plugin gains three new actions backed by the existing Agenda `taskScheduler` singleton:
  - `schedule({ actionType, time, reason?, force?, targetPaths? })` — one-shot future healing action. The named Agenda job `'self-healing-action'` is registered at plugin init so the handler is present on every restart. Persisted in MongoDB.
  - `listScheduled` — `{ jobId, actionType, scheduledFor, reason, lastRunAt, failCount, failReason }`.
  - `cancelScheduled({ jobId })` — `ObjectId`-validates the id and calls `agenda.cancel({ name, _id })`.
  - (Replacement for #2119.)
- **Checkly plugin: scheduled polls.** Same Agenda pattern, recurring instead of one-shot:
  - `schedule_check({ checkId, interval })` — uses `agenda.every(interval, 'checkly-scheduled-poll', { checkId })`. Idempotent re-scheduling.
  - `list_scheduled_checks` — `{ jobId, checkId, interval, nextRunAt, lastRunAt, failCount, failReason }`.
  - `cancel_scheduled_check({ checkId })`.
  - (Replacement for #2125.)

### Merged (PR #2121)

- **`ModelCache.getUsageAnalyticsData()`** — static aggregation across all ModelCache documents producing `{ totalRequests, averageResponseTime, errorRate }` global rollup. Mirrors the existing per-document `getUsageAnalytics()` instance method. Underlying `usageAnalytics` field is currently dead infrastructure (no caller invokes `trackUsage()`), so the method returns zeros until something starts populating the data. (genesis #2121.)

### Closed without salvage

- **#2116 agentAccessor.js** — `validateAgent()` placeholder property names that would always return false, blocking `setGlobalAgent` at agent boot.
- **#2117 ContractABI.js** — projection that strips the `abi` field, defeating the only reason to call `getByAddressAndNetwork`.
- **#2120 documentLoader.js** — conditional GET branch unreachable behind cache-first early-return; axios default `validateStatus` rejects 304 anyway.
- **#2123 UserPreference.js** — placeholder templates `{ theme, notifications }` unrelated to any real plugin's preference schema.
- **#2124 outputSchemas.js** — adds inert `version: 1` field with no version-aware logic. Same defect as previously-closed #2113.
- **#2126 metricsUpdater.js** — wraps `ImprovementMetrics.updateMetrics(date)` (a write operation) in a 5-min result cache, defeating the recurring metrics rebuild.

### Follow-up: mount-order fix for `/api/crypto/lp/mm/health`

Post-deploy verification surfaced that the new public `/health` endpoint was returning `401 Authentication required` instead of the liveness payload. `cryptoRoutes` (mounted at `/api/crypto`) has `router.use(authMiddleware)` at line 53 that 401s any request matching the `/api/crypto/*` prefix before Express can fall through to the deeper `/api/crypto/lp/mm` mount. Fixed by swapping mount order in `src/interfaces/web/webInterface.js` so `lpMarketMakerRoutes` mounts before `cryptoRoutes`. Verified: `curl http://…/api/crypto/lp/mm/health` returns `{"success":true,"enabled":true,"initialized":false}` HTTP 200 unauthenticated.

## [2.25.31] - 2026-05-07

Crypto token-trader heartbeat-manager auto-start fix and restore-state persistence fix.

Operator noticed that the `tokenTraderStatus` block on the crypto strategy agent reported a stale `lastAnalysis` — ~36 hours old — despite the agent itself being healthy and ticking dollar_maximizer every 10 minutes. Investigation surfaced that the runtime token_trader instance for a configured token had been wiped from the registry during a registry-rebuild incident; the wallet still held the tokens entirely unmanaged (no trailing stop, no scale-out logic, no monitoring). Fixing it via `/strategy/token-trader/configure` + `/strategy/token-trader/restore-state` exposed two latent bugs in `src/api/crypto.js`:

### Fixed

- **Token-trader heartbeat manager doesn't auto-start when first instance is added at runtime.** `src/api/crypto.js:1441` guarded the `startToken()` call on `if (handler.tokenHeartbeatManager?.started)` — but `started` only flips to `true` inside `TokenTraderHeartbeatManager.startAll()`, which `CryptoStrategyAgent.initialize()` only calls when `allTokenTraders.size > 0` at agent init. Configure on a fresh registry registered the new instance and persisted it, but never started the per-token heartbeat. The token then only ticked via the slower main-heartbeat fallback. Configure now calls `startAll()` if the manager exists but isn't started yet (idempotent; picks up the newly-registered instance).
- **`/strategy/token-trader/restore-state` mutated state in-memory only, never persisted.** The endpoint at `src/api/crypto.js:1568-1642` writes restored `position`, `pnl`, `tracking`, `circuitBreaker`, `regime` directly to `tokenStrategy.state.*` and returned 200 — but no `persistRegistryState()` call, so the restored cost basis / realized PnL / trailing-stop / peak-price values only survived in memory until the next full `execute()` cycle ran. Compare `/configure` at line 1436 which does call `persistRegistryState()` before returning. `/restore-state` now matches.

## [2.25.30] - 2026-05-06

ALICE-authored capability upgrades — 12 PRs triaged, fixed where needed, merged.

23 open PRs from ALICE's self-modification system were reviewed one by one. 12 merged with corrections; 11 closed with substantive comments explaining why (each PR comment lists the specific defect — hallucinated endpoint, dead code, security regression, redundant with existing functionality, etc.). Per-PR rationale lives on the closed PRs themselves and in `docs/sessions/SESSION-SUMMARY-2026-05-06.md`.

### Added

- **`GET /api/avatar/gallery` — filtering** by `owner`, `createdAfter`, `createdBefore` query params; route-level cache (5 min TTL) and 3× retry on the underlying lookup. (genesis #2095)
- **`GET /api/avatar/health`** — service liveness probe. (genesis #2095)
- **`GET /api/scammer-registry/report-history/:address`** — chronological audit trail of every `ScammerRegistered` event targeting an address (resolves block timestamps in parallel; sorts oldest → newest). Useful for revoke-and-re-flag scenarios where `getReport()` only shows current state. (genesis #2103)
- **`NetworkDevice.lifecycleStatus`** field (`active|deprecated|retired`) + `markAsDeprecated(days)` / `markAsRetired(days)` instance methods. (genesis #2096)
- **`BaseProvider.getDetailedTokenUsageStats()`** — focused token-usage view alongside the existing `getMetrics()`. (genesis #2098)
- **`Email.batchProcessEmails`** — chunked bulkWrite (100/chunk) with results aggregated into a single BulkWriteResult-shaped object. **`Email.getEmailsByConversation(id, page, limit)`** — pagination support (default 50/page). (genesis #2105)
- **`DevelopmentPlan.filterItems`** — new `creationDateRange={startDate,endDate}` filter. (genesis #2108)
- **`AutoAccount.archiveInactiveAccounts(inactivityMs)`** + Agenda `auto-account-archive` job (daily 00:00, 30-day default threshold) that survives restarts. The original PR scheduled this via an in-process timer that would have been lost on restart; rewired through Agenda. (genesis #2114)
- **`selfModLock` `lockExpiring` event** — fired 5 min before `lockTimeout` (default 30 min), cancelled on release, race-guarded so it doesn't fire for a lock acquired by a different service. (genesis #2115)

### Changed

- **`selfDiagnostics` startup interval is now adaptive** — picks 3h / 4h / 6h based on host load average and memory pressure at boot, rather than a fixed 6h. (genesis #2093)
- **`gravatarHelper.fetchGravatarProfile` retry-wraps the upstream fetch** so transient Gravatar API failures don't bubble. (genesis #2101)
- **`bitnet` provider retries chat + streaming completions** on transient network/5xx errors via `retryOperation` (default 3 retries; 4xx logical errors not retried). (genesis #2110)
- **`/api/admin/system-reports/export`** now caches per-query results (5 min TTL) with both body and `Content-Type` / `Content-Disposition` headers preserved on cache hits. Original PR cached only the body and re-emitted via `res.json()`, which JSON-encoded CSV exports into quoted strings. Also adds `compression` middleware on the report router. (genesis #2107)

### Closed without merging

11 PRs closed with explanations on each: #2094 (placeholder code), #2097 (duplicates winston native rotation), #2099 (hallucinated NASA endpoint — `api.nasa.gov/planetary/data` returns 404), #2100 (rate-limit middleware in a Mongoose model file), #2102 (`getPluginConfig` template change would expose credentials via external gateway), #2104 (`cache.options.stdTTL` mutation only affects new writes; module-level `setInterval`), #2106 (`TaskScheduler.scheduleJob` doesn't exist; in-process timers lose state on restart), #2109 (ordering bug — `adjustThreshold()` already prunes to 5 min before the new analyzer runs), #2111 (redundant with existing `globalLimiter`), #2112 (deletes working IP rate limiter, calls non-existent service methods), #2113 (`version` is not a JSON Schema keyword and no consumer reads it).

## [2.25.29] - 2026-05-06

ALICE auto-post lockout fix — 5-day silence on Twitter/X and MindSwarm.

### Fixed

- **5 days of zero auto-posts on Twitter/X and MindSwarm** (last post on both: 2026-05-01). The schedule gates were passing every 5–10 min (visible in logs), but every cycle silently bailed at one of two `pluginLogger.debug(...)` skip paths that aren't visible in the default log level. Root cause: the dedup filter in `_gatherPostContext()` (twitter.js, mindswarm.js) checks the last 8 posts against a catalog of 7 topic categories (`scammer`, `plugins`, `p2p`, `uptime`, `selfmod`, `email`, `upgrades`). Once recent posts cover all 7, every candidate item gets stripped, `filteredItems.length === 0`, `hasContent: false`, silent skip — and because posting stops, the recent-8-posts window never advances, so the same topics keep matching. Self-perpetuating deadlock.

### Changed

- **Visibility:** silent `pluginLogger.debug(...)` skip messages converted to `.info()` with diagnostic context — raw item count, post-dedup count, which `recentTopics` matched, and the first 60 chars of each raw item. Same treatment for the AI-returned-invalid-content path. Future silent skips now show their cause in `logs/plugins/{twitter,mindswarm}.log`.
- **Topic catalog expanded** from 7 to 12 categories in both plugins. Five new candidate items added to `_gatherPostContext()`, each pulling from data the agent already collects:
  - `healing` — `selfHealing.getStatus().stats24h` last-24h auto-fix count
  - `skynetEcon` — `p2pFederation.getSkynetServiceStats()` peer-to-peer service revenue/requests
  - `shipped` — `selfModification.getStats().today` self-authored PRs shipped today (separate from cumulative `merged`)
  - `capabilities` — `apiManager.apis.size` integrated plugin count, framed as "Operating with N integrated capabilities" (avoids the old "Running 99/100 plugins" flip-flop pattern)
  - `providers` — `providerManager.getProviderList()` AI provider redundancy
- Each new item has corresponding keyword groups in `topicToKeywords` so dedup detects them.

The dedup filter intent is preserved (don't tweet about the same topic twice in a row), but with a wider catalog of categories the filter can no longer collapse to empty when the agent has been busy.

## [2.25.28] - 2026-05-06

External media-download fixes — clients couldn't actually fetch downloaded files.

### Fixed

- **`/api/external/service/ytdlp/download` returned `file.path: "[redacted]"`** — plugin returned a real on-disk path (`/root/lanagent-deploy/downloads/<file>`) which the response sanitizer correctly redacted. Net effect: external clients paid 3 credits, the agent downloaded the file successfully, but the client got no fetchable URL. Fixed in `src/api/external/routes/plugins.js` by minting a short-lived download token URL (mirroring `/youtube/download`) before the response goes through the sanitizer. Applies to any plugin in `FILE_PRODUCING_PLUGINS` (ytdlp, ffmpeg, imageTools, pdf): when the result includes `file.path` (object) or `file` (string path), it is rewritten to `{ filename, size, downloadUrl: "/api/external/download/<token>", tokenExpires, maxDownloads }`. The `command` field is also stripped — it was always 100% redacted internal paths anyway.
- **`/api/external/youtube/download` returned 502 (`ytdlp.execute is not a function`)** — `apiManager.apis.get('ytdlp')` returns a wrapper `{ instance, enabled, ... }`, not the plugin instance directly. Fixed in `src/api/external/routes/youtube.js` by unwrapping `.instance` before calling `.execute()`, matching the pattern already in `plugins.js`.

### Why this matters

`/service/ytdlp/download` is a paid 3cr endpoint — partners were being charged for downloads they couldn't retrieve. The dedicated `/youtube/download` wrapper (10cr, includes the download-URL flow) was also broken since the wrapper-vs-instance bug landed, leaving zero working paths for paid media downloads through the gateway.

## [2.25.27] - 2026-05-05

Gateway repo workflow established + today's gateway-side fixes pulled into source control.

### What this is

The gateway code (the Node.js source that serves `api.lanagent.net` — landing page, customer portal, admin console, Stripe webhook, scrape proxies) is a separate repo from `LANAgent` and `LANAgent-genesis`. It lives at `/media/veracrypt3/Websites/LANAgent_Website/api-lanagent-net/` (remote `PortableDiag/api-lanagent-net`, private) and deploys to `/opt/api-gateway/` on `137.184.2.62`. Multiple sessions had been editing files directly on the production host with `ssh root@gateway "sed -i …"` patches; the local repo had fallen six commits behind. This release consolidates: rsynced prod → local, committed all the drift, added a proper deploy script, and persisted memory notes so it doesn't recur.

### Gateway commits (`PortableDiag/api-lanagent-net`)

| Commit | Title | Summary |
|---|---|---|
| `0a0c5a0` | v2.25.25-bundle: gateway recovery, logging coverage, admin/portal UX | Reconciles local with prod after a session of in-place patches. Includes every fix below. |
| `d75969a` | `deploy.sh`: rsync source files + pm2 restart + health check | Whitelisted rsync (`*.mjs`, `package.json`, `package-lock.json`, `ecosystem.config.cjs`); `.env` / `*.bak*` / `node_modules/` excluded. `--dry-run`, `--no-restart`, `--no-poller` flags. |
| `28e132e` | fix: double-escape regex backslashes inside getLandingPage template literal | Promo strikethrough regexes never matched anything because `\d`, `\s`, `\$` got silently stripped from the JS template literal at evaluation time. |

### Specific fixes bundled in `0a0c5a0`

- **`express.urlencoded`** middleware added — admin login form was POSTing `application/x-www-form-urlencoded` but the gateway only had `express.json()`, so the email field never reached the handler and every magic-link request fell into the anti-enumeration tarpit.
- **Strict primary/fallback `pickBestAgent`** — replaced weighted-random over funded agents with deterministic ALICE-first/BETA-fallback by reputation. Capability gating untouched at the DB query level so render-tier scrapes still cannot route to BETA.
- **`RequestLog.create` at every credit-debiting code path** — was previously only in `proxyServiceToAgent` success/failure branches. `/scrape`, `/scrape/batch`, `/agents/:agentId/:service`, and the catch branch of `proxyServiceToAgent` silently debited credits without logging. That's why `web-scraping` never appeared in the admin Top Services panel and customer dashboard charts showed empty for users with real usage.
- **`agentUrl` → `agentName` fix** in admin scrapes Top Agents aggregation + user-detail recent-requests cell. The RequestLog schema field is `agentName`; aggregations were matching/grouping on a field that doesn't exist, so byAgent always came back empty.
- **Mobile responsive admin system** — `nav-toggle` hamburger drawer; `dash-grid`, `grid-aside`, `grid-2` named responsive grid classes (replacing inline `grid-template-columns` on Promotions/Scrapes pages); `.row-flex` mobile-wrap rule for the Grant Credits admin-actions card.
- **HTML5 responsive scrolling tables** — `html, body { overflow-x: hidden }` to clip page-level horizontal overflow; every `<table>` (15 sites) wrapped in `<div class="table-wrap">` with `overflow-x: auto`; the table itself uses `min-width: max-content` so columns size naturally and the wrapper scrolls. `.mono { word-break: break-all; overflow-wrap: anywhere }` so tx hashes and wallet addresses don't widen their column.
- **Portal "Enter your email first" amber warning** — was rendering in `var(--muted)` grey on the dark theme and was hard to see; now `#fbbf24` and resets to default on subsequent status/error messages.
- **Promo strikethrough on price cards** — credit packages show `~~400~~ 600 credits (+200 bonus)`-style; subscriptions show `~~$25~~ $12.50/mo first month` with a "then $25/mo" subtitle. Renders only when `/promotion` returns an active promo; reverts cleanly when it doesn't.
- **Dashboard usage chart fixes** — `<h3 id="usage-chart-title">` updates with the active range so the label reflects the user's selection (24 hours / 7 days / 14 days) instead of always saying "14 days"; `switchRange` now prefers JWT auth (matches initial-render) and falls back to API key, was silently failing for users with a stale `portal_api_key` in localStorage but a valid JWT; clearer empty-state copy ("No usage in this range") instead of returning silently and leaving the previous chart visible.

### Workflow change

- **`CLAUDE.md` added to `api-lanagent-net`** documenting the local-first workflow + rsync deploy + what NOT to do (the 2026-05-05 in-place-edits incident is the cautionary tale).
- **Memory persisted** in `~/.claude/projects/-media-veracrypt1-NodeJS-LANAgent-genesis/memory/`: `gateway_repo.md` (reference) and `feedback_gateway_no_prod_edits.md` (rule + reason + how to apply).

### Why a separate repo

The gateway is a different deployment unit from the agent: runs on one host (the gateway VPS), serves the public landing/portal/admin/Stripe surface, holds different secrets (Stripe keys, admin email, JWT). The agent runs on every customer/operator host with its own concerns. Sharing a repo would muddy both.

### What this means for users

- Customer portal dashboards now actually show usage data — every credit-debiting endpoint writes a RequestLog. Existing data isn't backfilled (charris's pre-fix 106 credits of usage stays missing) but new traffic populates immediately.
- Admin "Top Agents" and "Top Services" populate correctly going forward.
- The promo banner now visibly shows old-vs-new credit counts and old-vs-new subscription prices instead of just a "50% off first month" badge.
- Admin pages don't horizontally scroll on phones; wide tables scroll inside their own card with all columns intact.
- Magic-link admin login works (form posts now parse).

## [2.25.26] - 2026-05-05

Operational hardening pass — same-day follow-up to v2.25.25 covering downstream rollout to the public repo and beta agent, plus a small comment fix in the gateway scrape route.

### Code

- `src/api/external/routes/scraping.js` — comment above `TIER_COSTS` corrected from `(v2.25.21: render dropped from 5 → 3...)` to `(v2.25.25: ...)`. The render cut landed in v2.25.25, not v2.25.21 (which was the gateway/BETA-recovery work). Pure comment fix, no behavior change.

### Public repo (`PortableDiag/LANAgent`)

- Synced v2.25.25 from genesis: render-tier cut, `/extract` `/crawl` proposal, full session report, all updated docs. Public commit `e45fb98f`.
- **Scrubbed proprietary strategy mentions from `feature-progress.json`.** 46 string mentions across `changes`, `filesModified`, and `closedPRs` arrays referencing genesis-only crypto strategy classes (`ArbitrageStrategy`, `DollarMaximizerStrategy`, `NativeMaximizerStrategy`, `RuleBasedStrategy`, `TokenTraderStrategy`, `VolatilityAdjustedStrategy`, `ArbitrageScan`) removed. 2 wholly-proprietary feature entries removed (`tokenTraderGridCooldownTighten2026_05_01`, `tokenTraderHeartbeatCleanup2026_05_01`). Public-shipped strategies (`BaseStrategy`, `DCAStrategy`, `GridTradingStrategy`, `MeanReversionStrategy`, `MomentumStrategy`, `StrategyRegistry`) untouched. Public commit `6dd2c5f5`.
- File reformatted to consistent 2-space indentation as a side-effect (some `files` arrays were inline, others multi-line).

### Beta agent (`beta.lanagent.net`)

- Deployed v2.25.25 image via `scripts/deployment/deploy-beta.sh` after the public-repo sync. Verified `TIER_COSTS.render = 3` and `'web-scraping': { … render: 3 }` inside the running container. Reported version: v2.25.25.
- **Disk-space recovery during build.** Beta VPS is 25 GB total, was at 86% pre-deploy. First two build attempts failed at the `unpack to overlayfs` step with `no space left on device` (Docker's containerd snapshotter needs to extract every layer to `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/` before the image is usable). Recovered by stopping the running BETA container mid-build to free its writable layer (~3 GB accumulated over weeks of operation). The third attempt then succeeded: 354.9s exporting + 67.6s unpacking. Final disk: 85% used, 3.6 GB free. Worth scripting an opportunistic prune into `deploy-beta.sh` if this recurs.
- **Fixed duplicated-PAT in beta's `origin` git remote.** The `origin` URL had `https://ghp_…@ghp_…@github.com/beta-lanagent/LANAgent` — the GitHub PAT was concatenated twice with a stray `@` in the middle, which made every `git fetch origin` from `simple-git` fail with `URL using bad/illegal format` and crashed the scheduled self-modification cycle every 5 minutes. Fixed via `git remote set-url origin <correctly-formatted-URL>`. Verified `git fetch origin --dry-run` from inside the running container exits 0. `upstream` was already correctly formatted.

### Production (`192.168.0.52` / ALICE)

- v2.25.25 code was deployed earlier today (TIER_COSTS render: 3 confirmed in the running file at `src/api/external/routes/scraping.js`) but **`package.json` on production was not updated** — version on disk was still `2.25.11`. Likely cause: the previous run of `deploy-quick.sh` (auto-detect mode) didn't pick up `package.json`. v2.25.26 deploys via the full `deploy.sh` sync which guarantees `package.json` lands.

### Why

This release captures operational work that didn't change genesis behavior but mattered for the downstream rollout. Spinning a version bumps the release tag, the postman collection, and the production `package.json` so all four surfaces (genesis, public, beta, ALICE) report the same version after the day's work is done.

## [2.25.25] - 2026-05-05

Render-tier price cut: **5 credits → 3 credits**, matching the `full` tier. Headline price story is now **1¢ to 3¢ per scrape** (was 1¢ to 5¢). Companion ScraperAPI → LANAgent migration on the work scraper at `dry-scraperservice.dry.ai` (separate repo).

### Why

FlareSolverr cost-to-serve is well under $0.001/call (long-running Docker container, no per-call cost on top of fixed VPN/server overhead). The 5cr sticker was almost entirely margin and read expensive next to:

- **ScraperAPI** ultra_premium: $0.03+/call at the cheapest plan, plus a $49/mo floor
- **ScrapeGraphAI** stealth-extract: $0.034/call on their $425/mo Pro plan

Cutting render to 3cr eliminates the per-call price gap with `full` while keeping render semantically distinct (FlareSolverr-backed; handles real CF JS challenges that `full`'s puppeteer-stealth path doesn't). Under a `full → render` escalation pattern (which is the standard work-scraper fallback strategy), the average per-fallback cost converges on $0.03 instead of $0.05.

### Changed

- `TIER_COSTS` in `src/api/external/routes/scraping.js` — `render: 5` → `render: 3` with comment explaining the rationale
- `SERVICE_CREDIT_COSTS['web-scraping']` in `src/api/external/routes/catalog.js` — `render: 5` → `render: 3`
- `/scrape` endpoint docstring updated to reflect new render price (3 credits, +HTML+screenshot+FlareSolverr)
- Pricing tables in `docs/api/API_README.md`
- Batch tier range `1-5 each` → `1-3 each`
- `docs/api/LANAgent_API_Collection.postman_collection.json` — version `2.25.24` → `2.25.25`, top-level description rewritten with render-cut summary, `/scrape` endpoint description updated
- `docs/feature-progress.json` — new `renderTierPriceCut_2026_05_05` entry, `lastUpdated` bumped, status preamble rewritten
- `package.json` version → `2.25.25`
- Gateway portal at `api.lanagent.net` — render demo card label updated (5 cr → 3 cr) + service catalog price (`/opt/api-gateway/portal.mjs` on the gateway VPS, untracked)
- `docs/proposals/gateway-extract-and-crawl.md` — render-tier pricing references in `/extract` and `/crawl` cost models updated
- `/media/veracrypt2/AICodeLogs/2026-05-03-lanagent-vs-scraperapi-comparison.md` — pricing addendum table updated with new render rate

### Unchanged

- Subscription bucket counts. Scraper Starter ($10/mo): 100K basic + 2.5K render. Pro ($25): 500K + 15K. Business ($50): 2M + 50K. Subscribers see **no difference** — render still draws from the smaller render-bucket regardless of credit-pool price.
- VPN auto-rotation, FlareSolverr availability check, subscription tier-mapping, `_testBlock` E2E hook.

### Verification

- Direct `/scrape` POST with `tier: 'render'` returned `creditsCharged: 3` post-deploy.
- Live work-scraper fallback that fired earlier today logged `[LANAGENT] PASS https://www.foxnews.com/politics/rfk-jr-... (tier=full, credits, charged=3)` — that path uses the `full → render` escalation introduced in the same session, so the new render price will hit the existing happy path and the escalated path identically.

### Companion work (work scraper repo at `/media/veracrypt2/NodeJS/ScraperService`)

Not in this repo, but landed the same day:

- `scrapeWithScraperApi(url)` migrated from ScraperAPI ultra_premium to LANAgent. Original preserved as a `/* */` reference block right under the new live function. Function signature and return shape unchanged so all 7 internal call sites continued to work without modification.
- `/raw-fetch` endpoint also migrated to LANAgent. Both paths now share `callLANAgentScrape(url, tier)` as the single integration point.
- `LANAGENT_API_KEY` const added to env loading. `SCRAPERAPI_KEY` retained but now unused. ScraperAPI's monthly credit budget was found exhausted during testing — every old `/raw-fetch` ScraperAPI fallback was silently failing with `"You have exhausted the API Credits available in this monthly cycle"`.

## [2.25.24] - 2026-05-05

Per-page audit of every admin body for the same class of inline-style mobile-overflow issues fixed in v2.25.22 / v2.25.23. One remaining offender found and fixed.

### Fixed (gateway — `/opt/api-gateway/admin.mjs`, untracked)
- **User-detail and Wallet-detail "Grant credits" row overflowed on mobile.** The admin-actions card uses `<div class="row-flex">` with hardcoded inline widths on its inputs (`<input style="width:160px;">`, `<input style="flex:1;">`). `.row-flex` is `display: flex` with no wrap, and the inline widths sit on the same elements at higher specificity than any responsive override, so the row spilled outside its card on phone widths. Added a `@media (max-width: 880px)` block that makes `.row-flex` wrap, gives `<label>` its own row, and forces `<input>` / `<select>` / `<textarea>` children to `flex: 1 1 100% !important; width: auto !important;` (the `!important` is the only way to override the inline declarations without rewriting markup).

### Audit results (no further fixes needed)

| Page | Layout primitive | Status |
|---|---|---|
| Dashboard | `dash-grid` + `grid-6` KPIs | already responsive |
| Users / Wallets | `grid-4` KPIs + single-col list | OK |
| User detail / Wallet detail | `grid-4` KPIs + `row-flex` admin actions | **fixed in this release** |
| Agents | single-col card | OK |
| Payments | `grid-3` KPIs + 7-col table | OK (table scrolls inside card) |
| Subscriptions | 6-col table with embedded progress bars | OK (table scrolls inside card) |
| Promotions | `grid-aside` | fixed in v2.25.23 |
| Tickets | wide table + `<dialog width=min(720px,90vw)>` with internal `row-flex` | OK (dialog viewport-bound, `row-flex` now wraps) |
| Scrapes | `grid-2` | fixed in v2.25.23 |
| Audit | single-col card + 6-col table | OK (table scrolls inside card) |

No remaining inline `grid-template-columns` declarations exist anywhere in `admin.mjs`. All multi-column layouts now use named responsive grid classes (`.grid-2`, `.grid-3`, `.grid-4`, `.grid-6`, `.grid-aside`, `.dash-grid`) or already-handled flex containers.

## [2.25.23] - 2026-05-05

Admin dashboard mobile follow-up — Promotions and Scrapes pages were still rendering as wide multi-column layouts on phone screens.

### Fixed (gateway — `/opt/api-gateway/admin.mjs`, untracked)
- **Promotions page (`/admin/promotions`) scrolled horizontally on mobile.** The page used inline `style="grid-template-columns: 1fr 360px"` which doesn't collapse — the 360px sidebar form forced the page wider than any phone viewport, so the whole page (including the sticky header) had to scroll horizontally. Replaced the inline rule with a new `.grid-aside` class that's `1fr 360px` on desktop and `1fr` (form drops below the table) on screens ≤880px.
- **Scrapes page (`/admin/scrapes`) had Top Services and Top Agents side-by-side on mobile.** Same root cause: inline `style="grid-template-columns: 1fr 1fr"` overrode the responsive grid rules. Replaced with a new `.grid-2` class that's `1fr 1fr` on desktop and stacked on screens ≤880px.

### Principle going forward
"Always stack on mobile unless they're small." Multi-column layouts in `admin.mjs` should now use one of the responsive grid classes — `.grid-2`, `.grid-3`, `.grid-4`, `.grid-6`, `.grid-aside`, `.dash-grid` — instead of inline `grid-template-columns`. The class defines both the desktop layout and the breakpoint at which it collapses, so the page can never end up wider than the viewport regardless of what's inside.

## [2.25.22] - 2026-05-05

Gateway admin dashboard responsive overhaul. Same-day follow-up to v2.25.21 after operator reported the Recent Payments table was crammed even on desktop and the top nav was unusable on mobile.

### Fixed (gateway — `/opt/api-gateway/admin.mjs`, untracked)
- **Recent Payments table was crammed.** The dashboard used `grid-3` (three equal columns), so the four-column payments table (When / Email / Amount / Credits) had to fit in ~33% of the page width — long emails like `portablediag@protonmail.com` shoved the numeric columns into a sliver. Replaced with a new `dash-grid` template that gives Payments `2fr` and Agents/Tickets `1fr` each on desktop. On tablet (≤980px) Payments spans both columns. On phone (≤600px) all three stack. Email cell now has `email-cell` class with `text-overflow: ellipsis` and a `title=` tooltip showing the full address on hover, so even the longest emails render cleanly.
- **Top nav was unusable on mobile.** Nine `topnav` links wrapped onto multiple lines and shoved the user/sign-out block off the visible header. Added a hamburger toggle (`☰` button, hidden on desktop) that collapses the nav into a vertical drawer below the header on screens ≤880px. Click outside or any link auto-closes via the same toggle.
- **Tables on narrow screens** now `overflow-x: auto` instead of overflowing the card, so any wide table (Wallets, Payments page, Audit log) scrolls horizontally inside its container with momentum on touch devices instead of forcing the whole page to scroll.
- **General mobile polish** — reduced card padding, smaller h1, `kv` grid drops to single-column, KPI value font shrinks at ≤600px, toolbar inputs flex to fill, bar-row labels narrow.

No markup changes outside `layout()` and `dashboardBody()`; the fix is almost entirely additive CSS appended to `SHARED_STYLE` plus a single `<button class="nav-toggle">` injection.

## [2.25.21] - 2026-05-05

Gateway and BETA agent recovery: fixed silently-broken admin login, reconnected gateway↔BETA after a 24-day stale-key outage, made BETA a real fallback in routing, and stood up backup tooling for BETA. Full incident analysis in `docs/sessions/SESSION-SUMMARY-2026-05-05.md`.

### Fixed (gateway — `/opt/api-gateway/index.mjs`, untracked)
- **Admin login form silently dropped the email field.** `app.use(express.json())` was registered without `express.urlencoded()`, so the HTML form's `application/x-www-form-urlencoded` POST to `/admin/auth/request` arrived with `req.body = {}`. The handler fell into the anti-enumeration tarpit branch and logged `magic link refused (non-admin) email=` — operator received `?sent=1` in the URL but no email. Added `app.use(express.urlencoded({ extended: true, limit: '1mb' }))` after the JSON parser. Confirmed end-to-end: form POST → 302 → `magic link issued` → `[email] sent to=…`.
- **Gateway↔BETA paired with a never-valid API key.** BETA's `externalcreditbalances` collection was empty (0 docs) since the April 11 ransomware incident; the gateway's stored key (`lsk_af05eb64…`) had nothing to authenticate against. 6,917 calls to `/credits/balance` failed 401 over 24 days, BETA was excluded from the funded pool, and `Agent BETA refresh failed: 401` filled the gateway error log. Inserted the missing `externalcreditbalances` doc on BETA pairing the existing wallet (`0x40b03c8b…`) with the gateway's existing key. 401 spam stopped, BETA enters refresh cycle normally.
- **PM2 restart counter reset** on `api-gateway` (was 50, now 0 plus 2 from today's deploys). Process state preserved.

### Changed (gateway routing — `/opt/api-gateway/index.mjs`, untracked)
- **`pickBestAgent` is now strict primary/fallback by reputation.** Was weighted-random across funded agents; with ALICE at rep=187 and BETA at rep=0, BETA still had ~0.5% probability of selection — enough to surface failures since BETA lacks several services (web-scraping with tiers, media-transcode, image-generation, etc.). New behavior: among funded agents, prefer online (`lastSeen < 10min`), sort by `successCount - failCount` descending, return the top. ALICE always wins when online and funded; BETA only sees traffic when ALICE is offline or out of credits. Capability gating untouched (`getAvailableAgents` filters by `services: service` at the DB query level), so render-tier scrapes still cannot route to BETA — there's no fallback for render tier when ALICE is down, which is correct since BETA has no FlareSolverr.

### Operations
- **BETA bootstrapped with $5 of on-chain credits.** Gateway wallet swapped 0.008 BNB → 268,770 SKYNET via PancakeSwap V2 then transferred 268,433 SKYNET ($5 at $0.00001863 each) to BETA's recipient address. BETA's `/credits/purchase` verified the transfer and credited the gateway with 503 credits. Tx `0xca0942a0d5f91d787d8cf3bcb69b0a5a1f48c1857d9854eaf27c73a6427b9ae7`. `gatewayagents.BETA.credits: 0 → 503`, `agentId: null → 2931` (so `POST /agents/2931/:service` direct-route works).

### Added (BETA — `164.92.79.184`)
- **`/root/backup-beta.sh`** + cron `15 3 * * *` — daily `mongodump --gzip --archive` to `/root/lanagent-backups/beta-YYYY-MM-DD.archive.gz`, 14-day retention. Restore: `docker exec -i BETA-mongodb mongorestore --gzip --archive --drop < beta-YYYY-MM-DD.archive.gz`.

### Added (genesis repo)
- **`scripts/deployment/backup-beta.sh`** — local pull script run from the dev machine. Streams a fresh `mongodump` over SSH, rsyncs config + data dirs (excludes `logs/`, `node_modules/`), writes a manifest with git rev / container statuses / wallet addresses, and seals everything into `/media/veracrypt1/NodeJS/_BackUps_/beta-backup-<UTC-stamp>.tar.gz`. 30-day local retention. First run: 14M archive. Safe to run while BETA is live.

### Notes
- **Pre-April-11 wallet seed is unrecoverable.** The ransomware wipe destroyed `cryptowallets`. Whatever address the original BETA wallet had, we no longer know it and can't sign for it. The current wallet `0x40b03c8b…` was auto-generated 18 minutes after the wipe; it has 200 SKYNET on-chain (negligible) plus the 268,433 SKYNET we just sent. Future-proofing: backups now in place.
- **Render-tier fallback gap** — if ALICE goes down, render scrapes have no fallback because BETA lacks FlareSolverr. Adding it to BETA's compose is a separate piece of work; flagged.

## [2.25.20] - 2026-05-04

PR review pass on 10 AI-generated PRs (#2083–#2092). One merged, five salvaged manually with corrected implementations, four closed as unimplementable.

### Merged
- **#2086** — `FeatureRequest.statusHistory` field. Small clean schema addition (array of `{status, timestamp, notes}`) populated automatically inside the existing `updateStatus` method. No breaking changes; data starts accumulating immediately and can be surfaced later.

### Salvaged manually (PR closed, feature implemented correctly)
- **#2084** — `SystemLog` pagination. PR added cache + retry + rate-limit-middleware-export with three blockers (no cache invalidation on insert, retry around in-memory `cache.get`, express middleware in a model file). Salvaged just the pagination piece: `findRecent(hours, filters, limit, skip)` and `findErrors(unresolved, limit, skip)` matching the existing `Journal.js` convention. Defaults preserve previous behaviour and methods still return chainable Mongoose Queries.
- **#2088** — `scammerRegistry` compression middleware. PR also wrapped on-chain writes (`reportScammer`, `removeScammer`, `setReportFee`, etc.) in `retryOperation`, which can double-submit BSC transactions when an RPC reply is just slow. Salvaged just the safe part: added `router.use(compression())` matching the pattern in `src/api/{contracts,signatures}.js`.
- **#2089** — `PluginDevelopment.calculateEvaluationAnalytics`. PR's instance method read `previousAttempts[].apiDetails.evaluation.score` but the `previousAttempts` schema only has `{prNumber, branchName, attemptedAt, status, rejectionReason}` — score lives at the document level. Always returned the empty default. Rewrote as a static method that aggregates across documents: `PluginDevelopment.calculateEvaluationAnalytics({status, since})` returns `{count, averageScore, scoreTrend, topPerformingPlugins}` with chronological score trend and descending-score top performers.
- **#2091** — Payment notification retry. PR's `await notifyOwner(agent, message)` blocked the request lifecycle for up to ~7s of backoff before responding. Salvaged the retry wrapped fire-and-forget: `retryOperation(() => agent.notify(message), {retries: 3, context: 'paymentNotify'}).catch(...)` keeps the same retry semantics without delaying the user's payment confirmation.
- **#2092** — MCP tool usage analytics. PR added `logToolUsage` and `generateUsageReport` to `mcpToolRegistry` but: (a) `toolUsageLog` was unbounded (slow OOM on long-running processes), (b) nothing called `logToolUsage` so the feature was dead infra. Salvaged with full integration: bounded ring buffer (`MAX_USAGE_LOG = 1000`, drops oldest), proper logging fields (`{intentId, toolName, serverName, executionTime, success, error, timestamp}`), per-tool aggregation (totalExecutions, successes/failures, avg/min/max execution time, lastUsedAt), wired the call from `mcp.js:/api/tools/execute` route in both success and failure paths, and exposed via new `GET /api/tools/usage` JWT-protected endpoint.

### Closed without salvage
- **#2083** — WHOIS history. Calls `whoisjson.lookup(domain)` and reads `result.history`, but the `@whoisjson/whoisjson` SDK has no history endpoint (only `/whois`, `/nslookup`, `/ssl-cert-check`, `/domain-availability`). Always returned `data: undefined`. Salvaging would require a different paid API or a substantial new local-snapshot store.
- **#2085** — Currency conversion in revenue reports. `getRevenueSummary` returns `{totalRevenue, totalUSD, count, breakdown, records}` (object), not an iterable array — the PR's `for (let item of data)` would crash. Plus N+1 FX API calls, no rate cache, no timeout, and a semantic mismatch with the existing time-of-txn `usdValue` accounting.
- **#2087** — Multilingual email templates. `sendMultilingualEmail` calls `agent.getUserLanguage(to)` but no such method exists, no user/identity model has a language preference field, and the 1-line template strings aren't customizable. Would need user-language storage as prerequisite work.
- **#2090** — WebSocket "adaptive" backoff. Only real change was `Math.min(reconnectDelay * 2, MAX) → Math.min(reconnectDelay * 1.5, MAX)`. Still pure exponential backoff, just less aggressive. No actual adaptiveness, plus an unused `NodeCache`. The 2× multiplier is the RFC 5681 / TCP convention; lowering should be deliberate, not a side effect of an aspirational "adaptive" claim.

## [2.25.19] - 2026-05-04

SKYNET API bot gains BYOK (bring-your-own-key) so users hitting the daily free-tier limit can load their own gateway API key and bill their own credit balance instead of consuming the bot's pool.

### Added (SKYNET API Telegram bot — `SkynetAPIBot`)
- **Encrypted per-user API key** in `BotUser` schema. AES-256-GCM blob (`apiKey.{iv,encrypted,authTag}`) using the existing `WALLET_ENCRYPTION_KEY`. Plaintext `apiKeyHint` stores last 4 chars only — used by `/mykey` to identify which key is loaded without ever decrypting and echoing the secret. `apiKeySetAt` timestamp.
- **`src/services/userKey.js`** — `setUserKey`, `getUserKey`, `clearUserKey`, `validateKey`, `isValidKeyFormat`, `redactKey`. `validateKey` hits the gateway's `/credits/balance` with the candidate key before storing so typos and revoked keys are rejected up front instead of failing at command time. `KEY_REGEX` matches `gsk_` + 32 hex chars.
- **`src/services/access.js`** — centralized `checkPaidAccess(ctx, category)` returning `{ allowed, apiKey }`. BYOK users skip both the bot-disabled gate and the daily-limit check entirely (the gateway does its own metering on their account); free-tier users get the original limit message with `/setkey` instructions added.
- **`/setkey gsk_…`** — validates against gateway, deletes the source message immediately to scrub the key from chat history, then stores encrypted. Replies with last-4 hint and live credit balance.
- **`/mykey`** — shows last 4 + load timestamp + live gateway balance (no decryption beyond what the balance call needs).
- **`/clearkey`** — wipes the stored key, returns user to free tier.
- **Auto-detect for pasted keys** — when a user posts a message containing `gsk_…` (without using `/setkey`), the autoDetect handler captures it first, deletes the source message, validates, stores, and confirms — same flow as `/setkey` but works for "here's my key gsk_…" natural phrasing.

### Refactored
- **`src/services/gateway.js`** — `callService`, `socialDownload`, `getCreditsBalance` accept an `opts.apiKey` per-call override. Replaced the global request-interceptor pattern (which forced one key for the lifetime of the bot) with `buildAuthHeaders(opts)` that picks user key → bot key → JWT in priority order. Bot's own key remains the fallback.
- **All paid command files** (`src/commands/{ai,code,crypto,media,meta,price,search}.js`, `src/handlers/autoDetect.js`) — replaced 7 duplicated local `checkPaidAccess` definitions with a single import from `services/access.js`. Threaded `{ apiKey: access.apiKey }` through ~30 `callService`/`socialDownload` callsites. `incrementUsage` now gated on `!access.apiKey` so BYOK calls don't tick the free-tier counters. Cashtag passive auto-replies stay on the bot pool (users didn't explicitly ask).

### Verified end-to-end on prod (143.198.76.178)
- Format validation: `gsk_short` rejected, arbitrary text rejected, real key accepted
- `validateKey` against gateway: real key returns `{ ok: true, credits: 435 }`, fake-but-well-formed key returns `unauthorized`
- Encrypt → decrypt roundtrip: stored bytes match original key exactly
- `checkPaidAccess` flow: free-tier under-limit allowed (no key), free-tier over-limit blocked with `/setkey` hint, BYOK user over-limit still allowed with key threaded, BYOK user under-limit allowed without ticking counter

## [2.25.18] - 2026-05-04

Two follow-ups to the social-media download work landed in v2.25.17: ALICE intent coverage extended to the new platforms, and a Rumble 403 regression fixed.

### Fixed
- **Rumble 403 after Cloudflare bypass** (`src/api/plugins/ytdlp.js:917,920`) — pinned `--impersonate chrome-131` for Cloudflare and stored-cookie paths. Bare `--impersonate chrome` picks curl_cffi's default target (chrome-99), whose JA3/JA4 TLS fingerprint no longer matches the cf_clearance cookies that FlareSolverr (Chrome 142) issues. Sweep across available targets confirmed `chrome-124` and `chrome-131` work; `chrome-99/110/116/133` all 403. End-to-end re-test through ALICE's NL command: Rumble (`Bannon_s_Warroom...`, 7.1 MB) and BitChute (`Nima_R._Alkhorshid...`, 259 MB) both download cleanly.

### Added
- **Platform-named training examples for `downloadVideo` and `downloadAudio` intents** (`src/core/aiIntentDetector.js:661,710`) — 22 new `downloadVideo` examples (tiktok, rumble, bitchute, streamable, dailymotion, x.com, twitch, bilibili) and 8 new `downloadAudio` examples covering the same platforms plus soundcloud. Without these, "grab that rumble clip" or "save this tiktok" matched too weakly because every intent example was YouTube-only. Vector store auto-rebuilds on next agent restart (`indexAllIntents` in `src/core/agent.js:553`).

### Verified end-to-end via ALICE NL command
- **YouTube** ✅ `Me_at_the_zoo.mp4`
- **TikTok** ✅ `Scramble_up_ur_name…` (Real video, full filename + caption)
- **Rumble** ✅ `Bannon_s_Warroom_Is_Targeting_Specific_RINOs_to_Oppose_in_Primaries.mp4` (7.1 MB)
- **BitChute** ✅ `Nima_R._Alkhorshid…` (259 MB)
- Vector intent search: all 9 test phrasings (URL-only and natural-language) top-rank `ytdlp.download` or `ytdlp.audio` with similarity 0.52–0.64

## [2.25.17] - 2026-05-04

Phase 2 + 3 of the social-media download expansion. Same `POST /social/download` and `POST /social/audio` endpoints from v2.25.16 now also handle Cloudflare-gated sites (Rumble, BitChute) and cookie-required sites (Instagram, Facebook), and the SKYNET API Telegram bot auto-downloads any supported social-media link dropped into a chat.

### Added
- **Cloudflare-bypass plumbing in `ytdlp` plugin** (`src/api/plugins/ytdlp.js`) — for hosts in the Cloudflare allow-list (Rumble, BitChute, fb.watch). The plugin obtains `cf_clearance` cookies via a long-lived FlareSolverr browser session, persists them to a temp Netscape cookies file, and runs yt-dlp with `--cookies <file> --user-agent <fs-ua> --impersonate chrome`. The matching TLS fingerprint via `--impersonate` is required — Cloudflare's cf_clearance is bound to the issuing client's TLS, and `--cookies` alone gets re-challenged. Persistent FS sessions (`fsEnsureSession(host)` in `src/utils/flareSolverr.js`) avoid re-solving on every request, which Cloudflare escalates in difficulty until FS times out.
- **Cookie-jar pipeline for stored-cookie sites** — Phase 3 hosts (`instagram.com`, `facebook.com`, `fb.watch`) read pre-stored Netscape cookies from `~/.config/lanagent/cookies/<host>.txt` (configurable via `LANAGENT_COOKIES_DIR`). Outside the deploy dir so cookies survive deployments.
- **Agent admin endpoints for cookie management** — `src/interfaces/web/cookiesAdmin.js` mounted at `/api/admin/cookies` on the agent. JWT-protected: `GET /api/admin/cookies` lists configured hosts with file size + mtime; `POST /api/admin/cookies/:host` accepts a Netscape cookies body (text/plain ≤256 KB) and writes it with mode 0600, validating the host is in the allow-list and the body parses as Netscape format; `DELETE /api/admin/cookies/:host` removes the file. Allow-list rejects bogus hosts and malformed files with 400.
- **`src/utils/ytdlpCookieJar.js`** — shared constants (`STORED_COOKIES_DIR`, `STORED_COOKIE_HOSTS`, `FLARESOLVERR_HOSTS`) + helpers (`hostMatches`, `extractHost`, `ensureCookiesDir`) used by both the plugin and the admin route.
- **`fsEnsureSession(key)` / `fsDestroySession(key)`** in `src/utils/flareSolverr.js` — keyed in-memory cache of FlareSolverr session IDs so successive requests reuse the same browser context (and the same cf_clearance cookie), instead of solving fresh challenges every time.

### SKYNET API Telegram bot (`SkynetAPIBot`)
- **Auto-download on social-media link drops** (`src/handlers/autoDetect.js`) — when a TikTok, Rumble, BitChute, Streamable, Dailymotion, Bilibili, or Twitch URL appears in chat, the bot calls `POST /social/download` via the gateway and posts the resulting MP4 inline (≤45 MB) or as a direct download link if larger. YouTube and Instagram intentionally excluded — YouTube already has the info-card flow and full downloads spam channels with long videos; Instagram requires per-host cookies the operator may not have set yet. Charges 10 credits from the bot's gateway balance per download. Falls back to `replyWithDocument` when Telegram refuses the codec, then to a plain link if even that fails.
- **New `/dl <url> [mp3|mp4]` command** (`src/commands/media.js`) — manual variant of the same pipeline, also supports MP3 audio extraction (8 credits).
- **`socialDownload(url, format)` helper** (`src/services/gateway.js`) — POSTs to `/social/download` (mp4) or `/social/audio` (mp3) on the gateway with a 3-min timeout; `gatewayBaseUrl()` exposes the base URL for resolving relative `downloadUrl` tokens returned by the gateway.
- **BotFather command menu updated** with the new `/dl` entry.

### Improved
- **Public landing on api.lanagent.net** (`portal.mjs`) — added a "Social Media Downloads" service card listing all supported sites with pricing, and updated the headline service count from 25 to 27.
- **`/stats`** now counts `social-download` + `social-audio` in `dedicatedRoutes`, so the auto-loaded badges/counters on the landing reflect the real number.

### Verified end-to-end
- **Phase 2:** BitChute mp4 download via `POST /social/download` on the agent (`Who_The_Fed_Actually_Serves.mp4`, 2.22 MB). Rumble: ✅ FlareSolverr session bypass works (yt-dlp gets the page through the CF wall and starts streaming HLS at 1.05x); the test URLs available at the time of testing happened to be livestreams (DVR-style HLS that doesn't terminate), so a complete VOD download wasn't captured but the cookie+impersonate path is proven by the BitChute test plus the partial Rumble HLS read.
- **Phase 3:** Admin endpoints round-trip — empty list → upload Instagram dummy cookies → list shows entry → DELETE → empty again. Validation rejects non-allow-listed hosts (400) and malformed cookies files (400). yt-dlp consumes the stored cookies file when present (verified `--cookies` flag in the executed command for `https://www.instagram.com/p/CL-GW9TBA0G/`); actual extraction failed because the dummy cookie isn't a real Instagram session — expected, the operator uploads real cookies via the admin endpoint to enable downloads.
- **Bot:** code-level (gateway flow already verified at the API layer in v2.25.16; the bot just translates a chat URL into a `socialDownload(url)` call and a `replyWithVideo` send).

## [2.25.16] - 2026-05-04

Phase 1 of the social-media download expansion: a generic `/social/download` route on both the agent and the gateway that dispatches any URL to the right extractor, so the SKYNET API bot (and other gateway customers) can hand the gateway any video URL instead of being limited to YouTube.

### Added
- **Agent route `POST /api/external/social/download`** (`src/api/external/routes/social.js`) — accepts `{ url, format: "mp4"|"mp3", quality? }`. URLs on `x.com` / `twitter.com` route to the bespoke twitter plugin's `download` action; everything else routes to yt-dlp's ~1800-site extractor list. Returns the same `{ success, downloadUrl, filename, size, … }` token shape as `/youtube/download` so existing downstream consumers only need to swap the path. Same auth/payment chain as `/youtube/download` — credit auth first, falling back to legacy `externalAuth` + `paymentMiddleware` for non-credit clients.
- **Agent route `POST /api/external/social/probe`** — given a URL, returns which extractor would handle it and (for yt-dlp URLs) basic metadata. No download, no credit charge — useful for checking whether a URL is supported before debiting credits.
- **Gateway proxy routes `POST /social/download` (10 credits) and `POST /social/audio` (8 credits)** in `api-lanagent-net/index.mjs`. Same `proxyServiceToAgent` pattern as `/youtube/download` and `/youtube/audio`. mp3 requests sent to `/social/download` get a 400 with a hint pointing at `/social/audio`, so the cheaper rate isn't accidentally bypassed.
- **`social-download` and `social-audio` registered in ALICE's `serviceCatalog`** on the gateway so `pickBestAgent` resolves them.

### Improved
- **`ytdlp` plugin curl-cffi impersonation** (`src/api/plugins/ytdlp.js`) — `_buildBaseCommand` now adds `--impersonate chrome` for hosts that block default-fingerprint HTTP (TikTok, Instagram, Facebook). Confirmed fix for TikTok HTTP 403 on the actual download phase. YouTube/SoundCloud paths unchanged so already-working extractors don't regress.

### Verified end-to-end
- **Direct agent (`192.168.0.52` via `lsk_*` key):** YouTube mp3 (`Me_at_the_zoo.mp3`, 653 KB), SoundCloud mp3 (`Flickermood.mp3`, 6.50 MB), TikTok mp4 (1.91 MB), Streamable mp4 (`me_irl.mp4`, 2.90 MB), Dailymotion mp4 (`Midnight_Sun_｜_Iceland.mp4`, 8.53 MB). Bilibili probe succeeded; download skipped because the test clip was large and China-hosted. Twitter and Twitch routing both dispatched correctly; specific test URLs happened to be deleted/expired.
- **Gateway (`api.lanagent.net` via `gsk_*` key):** Streamable via `POST /social/download` charged 10 credits, returned downloadable mp4. SoundCloud via `POST /social/audio` charged 8 credits, returned downloadable mp3.

### Phase 2/3 deferred
Cloudflare-gated sites (Rumble, BitChute) need FlareSolverr; cookie-required sites (Instagram videos, Facebook, X.com video tweets that aren't public-API-accessible) need a cookie-jar pipeline. Both are scoped for follow-up sessions once Phase 1 has soaked.

## [2.25.15] - 2026-05-04

Gateway-side release. Agent code unchanged. All work lives in the `api-lanagent-net` gateway repo deployed to `api.lanagent.net`; this entry tracks it from the platform-level changelog.

### Added
- **Gateway admin console** (`/admin`) — magic-link sign-in for the operator only, allow-list driven by `ADMIN_EMAIL` env var (default `portablediag@protonmail.com`). Sessions are short-lived JWTs in an `HttpOnly; SameSite=Lax; Secure` cookie scoped to `/admin`. Existing `X-Admin-Key` header auth is preserved alongside cookie auth on every `/admin/api/*` endpoint, so curl-driven scripts keep working. Brute-force protection on the login submit endpoint (10/15min per IP). Non-admin email lookups get a 250–450ms tarpit + identical 200 response so timing/output can't enumerate which address is allow-listed. Every admin write action (grant credits, revoke key, mark verified, agent toggle/delete, promotion CRUD, ticket status, sign-in events) is recorded to a new `AdminAudit` collection visible at `/admin/audit`.
- **Admin nav (9 sections)** — Dashboard (KPIs + 14-day request bar chart + recent payments + agents + open tickets), Users (paginated/searchable list of `portalusers`), Wallets (paginated/searchable list of `creditbalances` — crypto-bootstrapped accounts that didn't surface anywhere before), Agents (toggle/delete), Payments (Stripe USD + on-chain BNB/SKYNET merged chronologically with source filter), Subscriptions, Promotions (full CRUD), Tickets, Scrapes (volume/success/top-services/top-agents over 7–90 days), Audit. Per-account detail pages for both portal users and wallets include 30-day request totals, top failing services, payment history, recent requests, threshold-notification state, and admin actions (grant credits, revoke key, mark verified, BscScan tx links).
- **Public portal: magic-link sign-up and sign-in** — `POST /portal/magic-link` accepts an email and emails a 15-minute single-use link. New email auto-creates a passwordless account with a default `gsk_*` API key + welcome email (stub bcrypt hash so the only way in is via magic links until the user opts to set a password through the standard reset flow). Existing email receives a sign-in link. `GET /portal/magic-verify?t=...` consumes the token, marks `emailVerified=true`, sets the JWT, and redirects to the dashboard. Auth modal updated: toggle link now correctly flips between "Already have an account? Log in" / "Don't have an account? Sign up" depending on mode; magic-link button reads "Email me a sign-up link" or "Email me a sign-in link" depending on mode.
- **Email templates** — `notifyAdminMagicLink(email, url, ip, ua)` and `notifyPortalMagicLink(email, url, isNewAccount)` matching the existing branded layout (single button, expires-in line, paste-URL fallback, "you can ignore this email" reassurance). Both fire-and-forget through the existing `nodemailer` transport on `mail.lanagent.net:587`.
- **SupportTicket persistence** — `support-poller.mjs` now writes each new email to a `supporttickets` collection (idempotent on Message-ID) so the admin Tickets page has real data alongside the existing Telegram notifications. Operator can change ticket status (open/pending/closed) and add notes from the admin UI.

### Improved
- **Wallet accounts visible** — Mindswarm and other crypto-bootstrapped accounts (separate `creditbalances` collection, no email) had no admin view at all before. They now have parallel coverage to portal users, including an "is this a real on-chain wallet vs. a `portal_*` bridge stub vs. a test record" type classifier.
- **On-chain payment display fixed** — `GatewayPayment.amount` is the USD value at time of transaction (not raw BNB); previous admin display showed e.g. "2.2 BNB" which read as ~$1,300 instead of the correct $2.20. Payments page and wallet detail page now render `$2.20` with "paid in BNB" shown as a subtitle. Stripe + crypto totals roll up to a single Total revenue figure on the dashboard ($36.40 lifetime as of this release).
- **`ecosystem.config.cjs`** — fixed stale `cwd: /opt/scrape-gateway` → `/opt/api-gateway`, app name `scrape-gateway` → `api-gateway` to match production. Added `ADMIN_EMAIL`, `ADMIN_JWT_SECRET`, `ADMIN_SESSION_HOURS` env vars.

### Removed
- **Redundant `/admin/agents` (GET), `/admin/wallet`, `/admin/promotions` (GET/POST/DELETE) endpoints** in `index.mjs` — replaced by `/admin/api/*` equivalents in `admin.mjs` which accept both cookie auth and the existing `X-Admin-Key` header. `POST /admin/agents` (agent registration with reachability + price negotiation) is preserved unchanged.

## [2.25.14] - 2026-05-03

ALICE PR review pass: 18 auto-generated PRs (#2065-#2082) reviewed one by one. 1 merged, 1 salvaged, 16 closed. Each closed PR has an explanatory comment so the LLM can learn the failure pattern next time.

### Added
- **ipstack `getTimezones` batch command** (PR #2065 merged) — accepts an array of IPs and returns timezone info for each, mirroring the existing `fetchGeolocationBatch` pattern. Reuses the plugin's `fetchTimezone(ip)` and `getCachedData()` helpers; no new dependencies. Cleanly extends what was already there.

### Improved
- **`repoInfo.js` git-remote fallback observability** (salvaged from closed PR #2067) — replaced silent `} catch {}` with `logger.debug(\`repoInfo: git remote lookup failed, falling back: ${error.message}\`)` so the rare path of "no origin remote / git not installed" is visible in debug logs without changing the fallback behaviour. Closed the original PR because its other proposals (making `getOriginRepo` async, wrapping `execSync` in `retryOperation`, importing an unused NodeCache, deleting the file's docstring) were breaking and unnecessary.

### PR review breakdown (16 closures with explanatory comments)
- **Breaking changes**: #2068 (wraps `mongoose.model` in custom class breaking `.findOne`/`.create` callers), #2070 (infinite recursion in pre-save hook + hook never fires because writers use `findOneAndUpdate`), #2071 (replaces `error.message` with generic strings — frontend surfaces these to authenticated users)
- **Would crash on import/run**: #2069 (`__dirname` in ESM is undefined), #2080 + #2081 (call `TaskScheduler.schedule` as a static method — `TaskScheduler` is exported as a class), #2082 (calls non-existent AviationStack `/delays` endpoint)
- **Stubs returning `success: true`**: #2074 (statuscake notification methods are `// Implement the logic here` followed by `return { success: true }`), #2077 (every action case in `EventRule.executeActions` is empty)
- **Financial / safety hazards**: #2073 (wraps on-chain `stake`/`unstake`/`claimRewards`/`fundRewards` in 3× retry — broadcast-then-timeout would re-broadcast and double-spend), #2078 (wraps paid AI image generation + NFT mint in 3× retry — quadruples cost on a transient hiccup)
- **Misuses of utilities**: #2075 (treats `validateJsonSchema` as boolean — it returns Array of errors; also validates `{}` against the schema instead of validating the schema itself)
- **Redundant / no consumer**: #2066 (paid Zenserp duplicates free websearch + news plugins), #2076 (duplicates `searchAuditLogs` with worse semantics — no pagination, unbounded query risk), #2079 (custom risk hook has no entry point — strategies are auto-loaded from a registry, no JS-function input channel)
- **Description ≠ diff**: #2071 (says "more specific errors", does opposite), #2078 (says "implement avatar versioning", adds retry wrapping)
- **Operational doc loss**: #2069 + #2072 delete file-level docstrings with operational instructions (FlareSolverr's `docker run` invocation in the latter — load-bearing setup info)

## [2.25.13] - 2026-05-03

Gateway-side release. Agent code unchanged. All work lives in the `api-lanagent-net` gateway repo deployed to the public portal at `api.lanagent.net`; this entry tracks it from the platform-level changelog.

### Added
- **Gateway: usage-threshold notification emails** — `email.mjs` module on the gateway with `nodemailer` SMTP transport over `mail.lanagent.net:587` via a dedicated `noreply@lanagent.net` mailbox (provisioned with a 100MB quota). Three transactional templates fire automatically as users cross 80% / 90% / 100% of their subscription bucket (basic + render, separately) or their credit-pool balance (relative to the most recent top-up — each top-up resets the alert window). PortalUser schema extended with `creditAlertBaseline` (post-top-up baseline) and `notifications.{credits,subBasic,subRender}{80,90,100}` (per-threshold timestamps). Fire-once-per-cycle enforced via atomic `findOneAndUpdate` so concurrent debits can't double-send. Send is fire-and-forget — `/scrape` request handlers never block on SMTP. Sub thresholds reset on `invoice.paid` `billing_reason: subscription_cycle`; credit thresholds reset on each completed `checkout.session.completed`. End-to-end verified: 6 emails fired correctly through the production code path; idempotency verified by replaying with the flag already set (no resend).
- **Gateway: password reset + email verification + transactional emails** — full account-management email suite. New routes: `POST /portal/forgot-password` (always returns 200 to avoid leaking registered addresses), `POST /portal/reset-password` (consumes single-use token + sets new password), `GET /portal/reset?token=…` (HTML form), `GET /portal/verify?token=…` (one-shot verification page that flips `emailVerified=true`), `POST /portal/resend-verification` (JWT-gated). Hooks into existing routes: `/portal/signup` now fires welcome + email-verification on completion; `/portal/api-keys` POST/DELETE/regenerate fires create/revoke notifications with name/prefix/source-IP/timestamp; `/portal/cancel-subscription` fires cancellation confirmation with the period-end date. New `PortalToken` collection with TTL index — Mongo auto-removes expired tokens. Tokens are SHA-256 hashed in DB; raw value only ever leaves in the email URL. Minting a fresh token invalidates prior unused tokens of the same purpose so stale links can't be replayed. Polished HTML wrapper template with brand-color top stripe, monospace code blocks for keys/curl examples, two-column footer, and preheader text for inbox preview. Sender displays as `LANAgent API <noreply@lanagent.net>` (was `LANAgent` — risked reading as the agent itself running out of credits).
- **Gateway: support inbox v1 + v2** — `support@lanagent.net` mailbox provisioned (500MB quota) and monitored by a new `support-poller` PM2 service on the gateway VPS (`/opt/api-gateway/support-poller.mjs`). Polls IMAPS every 60s for `UNSEEN` messages. v1 (notification-only): for each new message, sends a Telegram alert to the operator with from / subject / body snippet; skips bouncebacks (`Auto-Submitted` header), `Precedence: bulk/junk/list`, and noreply-pattern senders. v2 (context-enriched): same flow + looks up the `From:` address in `PortalUser`, builds a 7-day usage context (sub state with bucket %, credits, recent request totals, top failing routes, most recent failure with error message + age, last payment), and includes that in the Telegram message. So instead of "new email from jane@x.com" the operator sees "Pro plan, 4,200 credits, 47 calls last 24h, 3 failures all on `reddit.com/r/aliens/.rss`" — enough context to answer from a phone without opening the dashboard. Marks messages `\Seen` after notify so each ticket pings once. Both matched-sender and unmatched-sender paths verified end-to-end.

### Documentation
- **Comparison doc updated** at `/media/veracrypt2/AICodeLogs/2026-05-03-lanagent-vs-scraperapi-comparison.md` — clarifies that FlareSolverr was *not* invoked in any of the 16/16 shootout wins (those were all decided at `basic`/`stealth` tier). Adds an "Anticipated questions" section addressing why FlareSolverr wasn't ported to the work scraper (3 reasons: it's not what's failing, FS without IP rotation doesn't help, it's a Docker dep we don't currently run). Reorders priority: VPN/IP rotation is the real differentiator; FlareSolverr is the long-tail tool.
- **New proposal**: `docs/proposals/ai-support-system.md` documents the v3 → v5 roadmap for AI-driven support — LLM-drafted replies with operator approval (v3), auto-send for trusted categories (v4), proactive outreach on internal events (v5). Covers architecture split (gateway owns customer state, ALICE owns LLM), prompt design with hard escalation rules, failure modes + mitigations, calibration loop, kill-switch env var, recommended sequence (sit on v2 for 2 weeks first).

## [2.25.12] - 2026-05-03

### Added
- **Paid-scrape: VPN auto-rotation on block** — `executeScrapeWithVpnRotation` wrapper around `executeScrape` in `src/api/external/routes/scraping.js`. When a `stealth`/`full`/`render` scrape returns a block-shaped failure (403/406/429/503/Cloudflare challenge/access-denied/rate-limit signature in the error string), the agent's ExpressVPN exit is rotated to the next region in a curated 10-location pool (US East/West/Central, Toronto, London, Amsterdam, Frankfurt, Paris, Tokyo, Singapore), the URL's scrape cache is invalidated, and the scrape is retried — up to `MAX_VPN_ROTATIONS = 2` times. On recovery the response surfaces `vpnRotation: { location, rotations }`. Skipped on `tier='basic'` because cheerio fetches are too cheap/fast to justify the 3–5s VPN reconnect cost. Test hook `_testBlock: 'once' | 'always'` in the request body forces simulated blocks for E2E verification without needing a real blocked target. Verified end-to-end: simulated block on `tier=stealth` rotated `smart → usnj` and recovered on attempt 1; `_testBlock=always` correctly exhausted both rotations (`smart → usnj → usla`) and refunded credits.
- **Gateway: Scraper Subscriptions** — three monthly Stripe subscription tiers on the public gateway portal at `api.lanagent.net`, **additive** to the existing one-time credit packages and BNB/SKYNET crypto purchases:
  - **Scraper Starter ($10/mo)**: 100,000 basic + 2,500 render scrapes
  - **Scraper Pro ($25/mo)**: 500,000 basic + 15,000 render scrapes
  - **Scraper Business ($50/mo)**: 2,000,000 basic + 50,000 render scrapes
  Subscriptions cover only the `/scrape` and `/scrape/batch` routes; all 25 services still bill from the credit pool. New routes: `GET /portal/scrape-plans`, `GET /portal/subscription`, `POST /portal/subscribe`, `POST /portal/cancel-subscription`. PortalUser schema extended with `scrapeSubscription { active, plan, stripeSubId, basicLimit, basicUsed, renderLimit, renderUsed, periodStart, periodEnd, cancelAtPeriodEnd }`. Atomic mongo ops `consumeScrapeQuota(userId, bucket)` / `refundScrapeQuota(userId, bucket)` use `$expr` to enforce the limit at the DB level (no race conditions). Tier mapping: `basic`/`stealth`/`full` → basic counter, `render` → render counter (separate independent buckets). When a subscriber's bucket is exhausted, `/scrape` falls back to the credit pool automatically — never hard-fails as long as the user has either subscription quota or credits. Quota resets on `invoice.paid` webhook events tagged `billing_reason: subscription_cycle`.
- **Stripe webhook: subscription lifecycle** — webhook handler at `/portal/webhook` extended with handlers for `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.paid` (in addition to the existing `checkout.session.completed`). Activates/refreshes/deactivates `scrapeSubscription` state on the user record from Stripe events. Renewal events reset usage counters and update `periodStart`/`periodEnd`. Webhook endpoint updated via Stripe API to subscribe to all 5 events (was only listening to `checkout.session.completed`).
- **Gateway: first-month promo discount on subscriptions** — when an active `Promotion` document exists, `/portal/subscribe` attaches a Stripe coupon (idempotently created via `getOrCreateStripeCoupon(percentOff)` with deterministic ID `lanagent_promo_${pct}pct_once`, `duration: 'once'`) to the Checkout session. Discount applies to first invoice only; renewals revert to full base price. Existing `Launch Special` (50% off) promo now reduces the first month of any sub from $10/$25/$50 to $5/$12.50/$25. Landing-page subscription cards get a "{N}% off first month" badge injected via the existing `/promotion`-fetching JS. After promo expires, no code changes needed — coupon is no longer attached to new checkouts and the badge no-ops.
- **Gateway: defensive Stripe customer recovery** — `getOrCreateStripeCustomer(user)` helper validates a stored `stripeCustomerId` against Stripe before use. If the customer is missing (left over from test mode after switching to live keys, or deleted in the dashboard), a new customer is created and the user record is updated. Used by both `/portal/checkout` (one-time credits) and `/portal/subscribe`. Reproduced the bug by planting `cus_doesnotexist_FAKE_TEST` on a test user, confirmed the helper detects the stale ID, creates a fresh customer, and persists it.

### Fixed
- **Portal landing-page price labels** — three subscription-eligible service cards on `api.lanagent.net` were showing prices that didn't match what the gateway actually charged: `Web Scraping — 2 cr` (real cost is tier-priced 1/2/3/5 by basic/stealth/full/render), `YouTube — 3 cr` (real cost is `/youtube/download` 10 cr or `/youtube/audio` 8 cr; the 3 cr was the cheaper `plugin-ytdlp` route shown alongside misleadingly), `Media Processing — 5 cr` (real `/transcode` cost is 20 cr; 5 cr was the `plugin-ffmpeg` route). Updated portal HTML to show the real tier breakdown and added three discrete demo cards for scraping (Basic 1 cr / Stealth 2 cr / Render 5 cr) — the Render demo points at a JS-heavy SPA target with `tier:"render", screenshot:true` to showcase the headless-Chromium + JS-rendering tier. Removed the redundant `Advanced Scraper` card (functionally overlapped with the tier-priced `Web Scraping` route — kept the `/service/scraper/scrape` plugin endpoint working for backwards compatibility, just hidden from marketing). Split the YouTube demo into two cards: Video (MP4) 10 cr and Audio (MP3) 8 cr, both pointing at the dedicated routes.

## [2.25.11] - 2026-05-01

### Improved
- **TokenTrader watchlist: per-token lifetime PnL bias** — `TokenTraderStrategy._computeWatchlistScore` now applies an asymmetric history adjustment from a new `state.tokenPnLLedger` (per-token cumulative realized PnL, updated on every `recordSell`). Chronic losers get penalized down to -20 points (clamped at $-100 cumulative), modest winners get up to +5 points (clamped at $+25 cumulative). Asymmetry is intentional: past losses on a given token tend to predict future losses (illiquid pool, persistent downtrend, reflexive seller pressure) more strongly than past wins predict future wins. Score breakdown now exposes a `history` component alongside V/L/M for diagnosis. Migrated via config v9 → v10 (initializes empty ledger; existing tokens accrue from next sell onward). Motivated by BASED's recent grind-down behaviour: kept being picked despite repeated stop-losses because the prior scorer had no memory of past trades.
- **swapService V4 quote sanity log demoted to debug** — reverting V4 hooks return bytes that decode to a sentinel ~8.22e58 uint256, tripping the "amountOut > 1000× input" guard. The guard is correct (discards the quote) but the WARN-level log was generating ~200 entries/day of unactionable noise. Now `debug` only — the rejection still happens, just doesn't pollute the warn stream.

## [2.25.10] - 2026-05-01

PR review pass — 8 AI-generated PRs (#2057–#2064), all closed. 4 implemented manually with corrections, 4 closed without code (broken, dead, or speculative).

### Added
- **Shazam: lyrics command** — new \`getLyrics({ songId })\` (or \`{ artist, title }\`) action on the Shazam plugin. Resolves songId via \`Shazam.track_info\` to get artist + title, then queries \`https://api.lyrics.ovh/v1/{artist}/{title}\` (the actual lyrics.ovh endpoint shape, with both args URL-encoded). Caches by songId or artist+title using the existing plugin \`NodeCache\` so repeats don't re-hit Shazam or lyrics.ovh. Distinguishes 404 (not in lyrics.ovh) from other HTTP errors and from empty-lyrics responses.
- **LP Market Maker: scheduled operations** — \`POST /api/crypto/lp/mm/schedule\`, \`GET /schedule\`, \`DELETE /schedule/:jobId\`. \`when\` accepts ISO date, natural-language strings ("in 5 minutes"), or a 5/6-field cron expression (auto-detected via regex; recurring goes through \`agenda.every\`, one-shots through \`agenda.schedule\`). Operations: \`rebalance\`, \`collect\`, \`open\`, \`close\` — all wrapped in \`retryOperation\` (3 retries) calling the existing \`lpMarketMaker.*\` methods. Persistent across restarts via Agenda's MongoDB store. Uses the project's existing TaskScheduler/Agenda integration via \`req.app.locals.agent.scheduler.agenda\` (not direct \`agenda\` import — repo convention).
- **P2P peers: persisted session/reconnection counters** — new \`sessionCount\` and \`reconnectionCount\` fields on \`P2PPeer\` model. \`PeerManager.markOnline\` increments \`sessionCount\` always, and \`reconnectionCount\` only when there were prior sessions (so first-ever connect is not counted as a reconnect). \`getActivityReport()\` now exposes \`sessionCount\`, \`reconnectionCount\`, and \`averageSessionSeconds\` (computed from completed sessions only — currently-open session doesn't drag long-lived peers' average to zero).
- **External-auth: adaptive rate limiter tied to circuit breaker** — \`POST /api/external/*\` now goes through an \`express-rate-limit\` instance whose \`max\` is read from the identity-verification circuit breaker each request. Defaults: 60/min CLOSED, 10/min HALF_OPEN, 5/min OPEN. Tunable via \`EXTERNAL_AUTH_RATE_CLOSED\`/\`EXTERNAL_AUTH_RATE_HALFOPEN\`/\`EXTERNAL_AUTH_RATE_OPEN\` env. Keys by \`X-Agent-Id\` first (so misbehaving callers don't poison neighbours behind the same NAT), forwarded-IP fallback. Sets \`standardHeaders: true, legacyHeaders: false\` for RFC-compliant \`RateLimit-*\` headers (matching the pattern in \`deviceAliasRoutes.js\`). 429 response body includes \`circuitBreakerState\` so callers can correlate the throttle with our health.

## [2.25.9] - 2026-05-01

### Fixed
- **Watchlist liquidity check rejected V2-only tokens (including our own SKYNET)** — `CryptoStrategyAgent.watchlistPriceFetcher` set `hasLiquidity=true` only when a V3 or V4 quote was **at least as good as** the V2 quote. For tokens that only have a PancakeSwap V2 pool (every small-cap, including the SKYNET system token), V3/V4 returned `null` so `hasLiquidity` stayed false; the watchlist evaluator counted that as a miss and incremented `_failCount` every cycle. SKYNET was sitting at `_failCount: 16` — making *our own token* look like a failed/illiquid asset in the strategy's view. The check now treats the token as liquid if **any** of V2/V3/V4 returns a non-zero `amountOut` (still preferring deeper pools via `liquidityDepth = max(out * price)`); the V3-preference logic for actual swap routing is unchanged. Reset SKYNET's persisted `_failCount` to 0 in the live state.

## [2.25.8] - 2026-05-01

### Fixed
- **TokenTrader: orphaned heartbeats wasted CPU and produced confusing logs** — `TokenTraderHeartbeatManager._executeTick()` looked up the trader instance with `strategyRegistry.getTokenTrader(address)` and assumed it always existed. After a token was removed (manual exit, stale-entry cleanup, or hot-reload) the heartbeat timer kept firing and the tick threw "trader not found" deep in the swap logic. Now each tick checks for the instance up-front; if it's gone, the manager logs a single info-level line and calls `stopToken(address)` to cancel the timer cleanly.

### Tuned
- **TokenTrader: grid-trade cooldown 30 min → 10 min** — the 30-minute cooldown was too conservative for grid trading in sideways regime; on volatile small-caps it caused the strategy to miss multiple legitimate dip-buy opportunities per hour. Lowered to 10 min, which still prevents whipsaw entries but lets the grid actually work the range. DIP-buy cooldown (1 hr) and emergency-sell cooldowns are unchanged — those need the longer windows to avoid catastrophic re-entries.

## [2.25.7] - 2026-05-01

### Fixed
- **Render-tier scraping (paid API): 500 on Cloudflare-protected sites** — `POST /api/external/scrape` with `tier: render` was returning HTTP 500 for sites guarded by Cloudflare Turnstile / managed challenges (Rumble, Bitchute, etc.) — Puppeteer + puppeteer-extra-stealth couldn't bypass the managed-challenge variant, so the route refunded credits and returned 500. The render tier now routes through a local FlareSolverr Docker container as its primary fetch path, which solves the challenge headlessly and returns the real HTML + CF clearance cookies. Cookies are then injected into Puppeteer's screenshot pass so the render tier still produces a real screenshot of CF-protected pages. Verified end-to-end against Rumble (5 credits charged, 677 KB HTML, 863 KB screenshot, 17s wall) and Bitchute (5s).

### Added
- **`src/utils/flareSolverr.js`** — small client for the FlareSolverr v1 API (`request.get`, `sessions.list`) with a 30-second availability cache so the render-tier path doesn't probe on every request.
- **`scraper.scrapeWithFlareSolverr(url, options)`** — new fetch path on the scraper plugin. Returns the same `{ success, content: { title, description, ogImage, text, links, images, jsonld, microdata } }` shape as the existing cheerio/puppeteer paths, plus `_rawHtml` / `_cookies` / `_userAgent` for the render tier to attach.
- **`scraper.takeScreenshot` cookies option** — the screenshot path now accepts a `cookies` array (Puppeteer cookie objects) which it injects via `page.setCookie` before navigation. This lets the render tier produce real screenshots of CF-protected pages by carrying clearance cookies from the FlareSolverr solve.
- **`renderTier` flag in the external scrape route's `executeScrape()`** — render-tier requests try FlareSolverr first, then fall back to cheerio/puppeteer if it's unreachable, and finally escalate to FlareSolverr as a last resort if Puppeteer hits a managed challenge.
- **Production**: FlareSolverr 3.4.6 running as `docker run --restart unless-stopped` on `127.0.0.1:8191`. Documented in `.env.example` under a new `SCRAPING — RENDER TIER (FlareSolverr)` section (FLARESOLVERR_URL).

## [2.25.6] - 2026-04-30

### Fixed
- **Auto-post 99/100 plugin flip-flop** — Twitter and MindSwarm autopost both injected `"Running ${pluginCount} plugins — ..."` as a candidate context item whenever `pluginCount > 50`. The plugin map oscillates by 1 (auto-improve toggles a capability on/off) so the AI saw a "fresh number" each cycle and picked it; the dedup keyword `['Running','plugins']` couldn't tell it was the same topic. Worse, when the recent-posts filter would have emptied the candidate list, the code reset `filteredItems` back to the unfiltered list ("the AI prompt will still have recentPosts to avoid"), guaranteeing a duplicate. Removed the plugin-count item entirely (static metadata, bad content) and changed the empty-filter fallback to return `hasContent: false` so the auto-post slot is skipped — better silence than a duplicate.
- **Hardhat install loop** — `hardhatService.initialize()` was running `npm install hardhat` against the agent's own `package.json` every time it was called, but the install always failed (`@huggingface/inference@4` peer-dep conflict with `@langchain/community@0.0.38`), so `this.initialized` stayed false and the next caller retried. The cycle ran every ~30s, flooding `errors.log`. Initialize now only ensures the projects dir exists; per-project installs go into the project's own `node_modules` with `--legacy-peer-deps`. Pinned `hardhat@^2 + hardhat-toolbox@^5` (hardhat 3 dropped non-interactive `init` and the rest of the service uses hardhat 2 conventions). Also dropped the `npx hardhat init --no-interactive` step entirely — `--no-interactive` was deprecated in hardhat 2.22+; we write `hardhat.config.js` and `contracts/` directly, which is everything `init` produced that we used.
- **Etherscan V2 migration** — `walletProfiler` and `contractAudit` were calling deprecated V1 hosts (`api.bscscan.com`, `api.etherscan.io/api`) which now return `{status:"0", message:"NOTOK"}` regardless of API key. Migrated both plugins to the unified V2 endpoint (`https://api.etherscan.io/v2/api`) with `chainid` parameter — a single `ETHERSCAN_API_KEY` now serves all chains. Legacy `BSCSCAN_API_KEY` env var still honored as a fallback.
- **walletProfiler: RPC rate-limit resilience** — Replaced the single hard-coded RPC URL per network with a 6+ endpoint fallback list (env-overridable via `BSC_RPC_URL` / `ETHEREUM_RPC_URL`). Wraps every on-chain call in `_withProviderFallback()` which rotates to the next URL on 429/403/5xx/timeout/socket errors. Pins `staticNetwork` and disables JSON-RPC batching to avoid the `id: null` rate-limit response bug in ethers.js.
- **contractAudit: explorer key from DB** — Now looks up the explorer API key from `PluginSettings('crypto', 'explorer_api_keys')` (the same encrypted store the crypto plugin UI writes to) before falling back to env vars. Error messages on missing-key now name the env var and signup URL.
- **Gateway: defensive serialization** — `/api/external/service/:plugin/:action` was theoretically able to 500 a successful plugin response if `res.json` itself threw (circular ref, etc.) and the outer catch ran after `headersSent`. Now wraps `res.json` in its own try/catch and skips the 500 path when the response already went out.

### Upgraded
- **Node.js 20 → 24.12.0 LTS** on production. Node 20 hit EOL in April 2026. Native modules (canvas, sharp, serialport, ssh2, bcryptjs) rebuilt against the new ABI; pm2 daemon restarted under Node 24. Required installing canvas build deps (`pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`) since canvas v2.11 has no Node 24 prebuild.

### Operations
- **Beta deploy infrastructure** — Added `scripts/deployment/deploy-beta.sh` (upstream-aware git pull → `docker compose build` → `up -d` → health poll) and `scripts/deployment/check-beta.sh` (read-only status: containers, app health, version drift, disk, top errors). Beta runs as Docker Compose against the public LANAgent fork; the deploy script auto-detects an `upstream` remote (canonical public repo) and falls back to `origin` for direct-clone setups. Auto-cleans logs + `docker system prune` before build to free disk on the small VPS. Documented full topology in `docs/deployment/BETA.md`.

### Added
- **Calendar: SMS, push, and recurring reminders** — `CalendarEvent.reminders` enum gained `sms` and `push`. New `customInterval` field fires recurring reminders every N minutes from `firstFireTime` until event start (auto-finalized when the event begins). New `target` field overrides the destination per-reminder (phone/FCM token), falling back to `PHONE_OF_MASTER` / `FCM_TOKEN_OF_MASTER`. SMS routes through vonage/sinch/messagebird; push through firebasecloudmessagingfcm.
- **SubAgent: runtime updateConfig** — New `updateConfig({ config, enabled, status })` method deep-merges into the nested `config` subdoc using `set()` per leaf path, so partial updates (e.g. `{ budget: { dailyApiCalls: 200 } }`) preserve sibling fields. Records before/after via `addHistory`.
- **UPS: escalation policies** — New `escalationPolicies` array on `UpsConfig` (`minDurationMinutes`, `severity`, `channels`, `messagePrefix`). `UpsService` now tracks `alertStartTimes` per `upsName:eventType`, computes alert duration, and applies the highest-threshold matched policy in `sendNotifications` — prepends `messagePrefix` to the alert. Resolution events (`power_restored`, `communication_restored`) clear the tracking.
- **P2P: safe DH key rotation** — New `cryptoManager.rotateDhKeys()` regenerates only the X25519 ECDH keypair while preserving the Ed25519 signing keypair (and therefore the peer fingerprint / trust relationships). Persists to `PluginSettings`, clears session-key cache so peers renegotiate.
- **P2P: persistent peer activity report** — `P2PPeer` gains `totalConnectionSeconds`. `peerManager` records session start on `markOnline`, persists session duration on `markOffline`. New `getActivityReport()` returns persisted stats plus current-session seconds for online peers.
- **Whois: domain expiration alerts** — New `setExpirationAlert({ domain, daysBefore })` and `cancelExpirationAlert({ domain })` actions. Defines an Agenda job `whois-expiration-alert` that calls `agent.notify` N days before WHOIS expiry. Cancels existing alerts for the same domain before scheduling so repeat calls don't duplicate. Persisted by Agenda's MongoDB store.
- **Email signatures: vCard QR codes** — `generateProfessionalSignature` now accepts `includeQRCode: true` and emits an embedded data-URL vCard QR (errorCorrection H, 200px) into all three templates (modern/classic/minimal). Empty vCard fields are omitted.
- **DevPlan: batch archive** — New `archiveOldCompletedItemsBatch(days, batchSize)` paginates by `_id` and runs `updateMany` per batch with retry, returning `{ matched, modified, batches }`. Bounded memory on large collections. Wired into the existing `commands`/`execute` dispatch surface.
- **Coordination: bulk participant ops** — `AgentCoordination.bulkAcceptParticipants(intentHash, accepts)` and `batchUpdateExecutionResults(intentHash, updates)` use `intentHash`-scoped filters with `arrayFilters` so only matching participant subdocs are touched within one coordination — no cross-coordination scope leak.
- **DeviceAliases: advanced search** — `GET /api/device-aliases` accepts `deviceName`, `userId`, `sortBy`, `sortOrder` query params. Cache key reflects all filter/sort params so cached responses don't bleed between queries.
- **Skynet referrals: source tracking** — New `referralSource` field on `SkynetReferral` (enum: `p2p`/`web`/`email`/`social_media`/`cli`/`other`). `handleReferralReward` now reads optional `referralSource` from the P2P message (defaults to `p2p`). New `getReferralSourceStats(fingerprint)` aggregation.
- **KnowledgePack: usage analytics** — New `trackUsage(packId, peerFingerprint, importTime)` and `getAnalytics(filter)` methods on the model. Wired into `knowledgePackSharing.importPack` to record real data on every import.
- **HealingEvent: lifecycle logging** — `start`/`complete`/`fail`/`skip` now emit structured `logger.info`/`logger.error` entries.

### Improved
- **Auth: rate limiting** — `/nonce` and `/verify` endpoints rate-limited to 10 req/min per IP via `express-rate-limit`. Mongoose calls wrapped with `retryOperation` for transient errors.
- **MqttHistory: retry on reads** — `getTimeSeries` and `getStatistics` wrap their queries with `retryOperation`.
- **CreditDebit middleware: error resilience** — Wrapped credit operations in try/catch (previously could throw unhandled rejections, killing the request without a response). `findByWallet` and `debitCredits` use `retryOperation`.
- **Vector intent: /search caching + rate limit** — POST `/search` results cached 5 minutes by SHA-1 of `(query, k, filters)`. All routes rate-limited to 100 req per 15 minutes (embedding/search are expensive).

### PR Review
- Reviewed 26 AI-generated PRs (#2031–#2056): merged 5 directly, manually implemented 11 (good idea, broken implementation — closed with detailed rationale), closed 10 as fundamentally broken or duplicative.

## [2.25.5] - 2026-04-24

### Fixed
- **Scraper: bad image extraction** — Scrape responses returned ad tracking pixels (e.g., `ads.rmbl.ws/t?a=...`) as the og:image. Now filters known ad/tracker domains (doubleclick, googlesyndication, Rumble ads, etc.) and validates images with HEAD requests (must return 2xx with `content-type: image/*`).
- **Scraper: polluted titles** — Title extraction fell back to `document.title` which included concatenated logo alt text and nav items. Now prefers `og:title` meta tag in both Cheerio and Puppeteer paths.
- **Scraper: no quality-based tier escalation** — Basic tier accepted garbage results from Cloudflare-blocked or ad-heavy pages without retrying. Now auto-escalates to Puppeteer when results contain tracking pixel images, corrupted titles, or only ad images.

### Added
- **Scraper: stealth tier** — New `stealth` tier (2 credits) forces Puppeteer rendering from the start for known difficult sites. Available alongside basic (1), full (3), render (5).
- **Firewall: scheduled rule changes** — `POST /firewall/api/schedule-rule` endpoint for scheduling UFW rule changes at a future time via Agenda. Supports allow/deny/delete actions with input sanitization.
- **Whois: bulk domain lookup** — `bulkLookup` command for up to 20 domains at once, processed in chunks of 5 with `Promise.allSettled` to avoid API rate limits.
- **Challenge questions: performance tracking** — `trackPerformance` command records per-user accuracy stats and recommends difficulty levels (easy/medium/hard) for adaptive challenge generation.
- **Task reminders: configurable intervals** — `TaskReminderService` constructor now accepts `config.checkInterval` and `config.reminders` array for custom reminder thresholds. Defaults preserved for backwards compatibility.

### Improved
- **MarketIndicators** — Historical data fallback when cached indicator values expire and fetch fails, instead of returning null.
- **memoryVectorStore** — Added `source` and `context` metadata fields for memory tagging and filtering.
- **Database** — MongoDB connection pool settings (`maxPoolSize`, `minPoolSize`, `maxIdleTimeMS`) now configurable via environment variables.
- **BugReport** — `advancedSearch` now supports filtering by arbitrary metadata fields.

### PR Review
- Reviewed 27 AI-generated PRs: merged 4, implemented 4 manually (good ideas with broken code), closed 19 with detailed comments.

## [2.25.4] - 2026-04-19

### Fixed
- **Port scan on undefined host** — `extractPortScanParams()` returned empty object when no target was specified, causing `portScan()` to scan "undefined". Now defaults to `localhost` when no host is found. Added input validation in `portScan()` to return a helpful error message instead of scanning an invalid target.
- **Self-modification pipeline stuck on first candidate** — Pipeline always selected `prioritized[0]`, checked its fingerprint, and returned immediately on duplicate without trying remaining candidates. Now iterates through the entire prioritized array, skipping duplicates until a valid candidate is found.

### Improved
- **Zapier plugin** — Added `pause_zap` and `resume_zap` commands for pausing/resuming Zaps by ID.
- **DeviceAlias retry resilience** — Wrapped Mongoose queries in `retryOperation()` for `resolveAlias`, `setAlias`, and `cleanupExpiredAliases`, consistent with existing patterns.
- **ProviderStatsArchive retry** — Wrapped archive save in `retryOperation()` with error logging.
- **Project context caching** — Added `NodeCache` (5-minute TTL) for active projects list in `projectContext.js`, reducing redundant API calls.

## [2.25.3] - 2026-04-18

### Fixed
- **25% slippage hard ceiling on tax token swaps** — Tax token retry logic allowed slippage to escalate up to 25%, creating MEV/sandwich attack risk. Lowered hard ceiling from 25% to 15% (`tokenTaxPercent + 5%`, capped at 15%). Tax tokens rarely exceed 10% tax, so this still covers legitimate cases.
- **Hardcoded 500k gas limit on V3/V4 swaps** — All V3 (Uniswap/PancakeSwap SmartRouter) and V4 (PancakeSwap Infinity, Uniswap V4) swap executions used a fixed `gasLimit: 500000n` regardless of path complexity. Multi-hop paths can exceed 500k gas (reverts), and simple swaps overpay. Replaced with dynamic `estimateGas()` + 25% buffer, falling back to 500k if estimation fails. Matches the existing 1inch path which already used dynamic gas estimation.
- **Chainlink stale price data accepted silently** — Chainlink plugin calculated price age but never flagged stale data. Added `stale` boolean and `ageSeconds` fields to response; logs a warning when price is >10 minutes old or ≤ 0. Consumers can now check `data.stale` before acting on the price.
- **SKYNET price oracle accepts stale Chainlink data** — `skynetPrice.js` (used for P2P auto-pricing and scammer registry fees) read Chainlink BNB/USD without checking freshness. Now returns `null` (skip cycle) when price data is >10 minutes stale, preventing pricing decisions on outdated oracle data.
- **Social media SKYNET spam** — Twitter and MindSwarm post generators were promoting SKYNET tokens in ~25-33% of all posts due to a hardcoded staking context item injected into the context pool and explicit "shill enthusiastically" instructions in MindSwarm engagement rules. Removed staking context items, stripped promotional language from engagement rules, added explicit "NEVER promote tokens" rule to post generation prompts.

## [2.25.2] - 2026-04-16

### Fixed
- **Download URLs showing localhost instead of LAN IP** — Telegram download links, avatar URLs, email signatures, and web dashboard links all fell back to `localhost` when `AGENT_HOST` was not set. Added `getServerHost()` utility in `src/utils/paths.js` that auto-detects the server's LAN IP from `os.networkInterfaces()` as a fallback (priority: `AGENT_HOST` > `SERVER_IP` > auto-detect > `localhost`). Applied across `telegramDashboard.js`, `agent.js`, and `email.js`.
- **AI image detector false positives** — Switched from `Ateeqq/ai-vs-human-image-detector` to `umm-maybe/AI-image-detector`. The Ateeqq model classified virtually all images as AI-generated (99.9%+ AI score on real photos, screenshots, and all non-noise images). The umm-maybe model correctly identifies real photos as human (~98%). Label handling updated to support both model formats (`artificial`/`human` and `ai`/`hum`).

### Added
- **Download token revocation** — `revokeDownloadToken(token)` in `downloadTokenService.js` for invalidating active download tokens.
- **MCP custom request timeouts** — Optional `customTimeout` parameter on `mcpTransport.request()` for long-running MCP tool calls (default unchanged at 30s).
- **MQTT device lifecycle state** — `lifecycleState` field (`active`/`inactive`/`decommissioned`) on MqttDevice model with indexed queries and `transitionLifecycleState()` method.

### Improved
- **Sentry error context** — `withErrorHandler` now tags Sentry errors with `user_id` and `session_id` when available.
- **Oracle route error logging** — All catch blocks in oracle routes now log via `logger.error` instead of silently returning 500s.
- **Email lease retry** — Expiration notification emails now retry up to 3 times on transient SMTP failures.

## [2.25.1] - 2026-04-14

### Fixed
- **skynettoken.com og:image broken** — Link preview images were broken because `og:image` used a relative path (`assets/skynet-256.png`). Changed to absolute URL (`https://skynettoken.com/assets/skynet-full.png`). Added `og:url`, `og:image:width/height`, and Twitter card meta tags (`twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`).
- **skynettoken.com hardcoded service count** — "69 services" was hardcoded in hero text and API gateway card. Now dynamically fetches from `api.lanagent.net/stats` on page load, matching lanagent.net's existing sync pattern. Static fallback updated to 25 (actual count).
- **Stale service counts in docs** — API README and project README had outdated service counts (87+, 97+). Updated to match live `/stats` endpoint (25 services: 17 plugins, 8 dedicated routes).
- **Orphaned MongoDB collection** — Dropped `agendaJobs` collection (5 records from Jan/March) that was left behind when Agenda was reconfigured to use `scheduled_jobs`.

## [2.25.0] - 2026-04-13

### Changed
- **Three.js r140 → r183** — Upgraded Three.js from r140 (2022) to r183 (2026) across all 3D pages (visualizations, avatar designer, playground). Single-file UMD bundle with ES module bridge for addon compatibility. Import maps resolve addon imports (`OrbitControls`, `GLTFLoader`, `XRControllerModelFactory`).
- **three-vrm v1.0.0 → v3.5.1** — Upgraded @pixiv/three-vrm to v3.x for r183 compatibility. Fixes removed `sRGBEncoding`/`LinearEncoding` constants. `VRMUtils.removeUnnecessaryJoints` deprecated in favor of `combineSkeletons`.
- **Color space API** — Replaced `renderer.outputEncoding = THREE.sRGBEncoding` with `renderer.outputColorSpace = THREE.SRGBColorSpace` in avatar.html and playground.html.
- **Clock → Timer** — Replaced deprecated `THREE.Clock` with `THREE.Timer` across all 11 visualization scripts, avatar designer, and playground. Added required `timer.update()` calls in render loops.
- **VRM bounding box fix** — Model is now temporarily set visible during `Box3.setFromObject()` calculation, fixing empty bounds when model starts hidden (prevents camera framing on origin instead of model center).
- **lanagent.net Three.js upgrade** — Website updated from Three.js r128 (CDN) to r183 via import map.
- **lanagent.net feature accuracy** — Removed private-only trading strategies from website (DollarMaximizer, Arbitrage, NativeMaximizer, VolatilityAdjusted). Replaced lip sync/eye tracking claims with tested features (expressions, spring bone physics, TTS).

## [2.24.9] - 2026-04-12

### Added
- **Twitter/X plugin v3.0** — Profile management (update name, bio, avatar, banner via v1.1 API), media upload (v2 chunked), auto-posting 2x/day with AI-generated content from real agent activity, credit/rate limit alerts via Telegram. Credential labels match X developer portal exactly.
- **Twitter auto-posting scheduler** — `twitter-engagement` job runs every 10 minutes, posts during waking hours (8am-10pm) with 4-hour gap, topic deduplication against recent tweets, same content safety rules as MindSwarm.
- **Local AI (Ollama) as first-class installer option** — Step 3 now asks cloud vs local AI. Auto-detects Ollama on localhost, supports remote Ollama URL. New flags: `--ollama-url`, `--local-ai`. Ollama-only installs work with no cloud API costs.
- **GitHub CLI in installer and Dockerfile** — `gh` CLI auto-installed during setup (required for self-modification PR creation). Added to Docker image for container-based installs.
- **Post-install security checklist** — Reminds users to change default password, secure `.env`, keep MongoDB off the internet, and protect wallet keys. Includes wiki link.
- **GitHub Wiki** — 25-page wiki covering installation, configuration, troubleshooting, self-modification, P2P, API gateway, plugins, AI providers (local + cloud), crypto, FAQ, and architecture.
- **Gateway `/stats` endpoint** — Single source of truth for all websites. Returns live service counts, agent counts, per-plugin credit costs, version. Websites fetch dynamically instead of hardcoding numbers.
- **Gateway dynamic service pricing** — Per-plugin credit costs fetched from agent catalogs every 5 minutes instead of hardcoded. Uses lowest agent price across the network.
- **Gateway promotion system** — Time-limited discount promotions. Bonus credits applied to both Stripe and crypto purchases. Auto-expires. Portal shows promotion banner with countdown.
- **Gateway replenishment fix** — Fixed race condition where multiple concurrent requests could trigger duplicate agent credit replenishments.

### Fixed
- **Docker installer SSL/Caddy port conflict** — The SSL/HTTPS step (Step 10) was skipped for `--docker` installs, so `AGENT_PORT` was never changed from 80 to 3000 when Caddy was configured. Docker containers failed silently because Caddy already occupied port 80. The SSL step now runs for both native and Docker install modes.
- **Self-modification disabled on all fresh installs** — The Agent mongoose schema had `selfModification.enabled` defaulting to `false` and `analysisOnly` to `true`. Every fresh install had self-modification silently disabled. Changed schema defaults.
- **Self-modification scan never running (lock collision)** — `self-mod-scan` and `git-monitor` fired at the same second, git-monitor always grabbed the lock first. Staggered self-mod by 5 minutes to break the collision.
- **PR creation failing on forks (missing labels)** — `gh pr create --label` fails when labels don't exist on the target repo. Now retries without labels as fallback.
- **Gateway low balance Telegram alert silently failing** — The alert used `parse_mode: "Markdown"` which caused Telegram API parse failures because the wallet address contains underscores. Removed Markdown parse mode.
- **Twitter OAuth 401 on query params** — OAuth 1.0a signature wasn't including URL query parameters. Fixed signature generation to include query params in the base string.

### Changed
- **Gateway balance alert** — Cooldown reduced from 6 hours to 4 hours for faster notification when BNB runs low.
- **api.lanagent.net portal** — 25 service cards with live availability indicators (dimmed when offline), sorted alphabetically. 30 curl demos, 6 language examples (Python, JS, Go, Rust, PHP, Java) with 13 examples each. Dynamic credit costs from agent catalogs.
- **Twitter media upload** — v2 API single-request image upload with auto-attach to tweets and replies. Posts with images via `filePath` parameter.
- **Installer auto-installs Docker** — Docker mode now auto-installs Docker via `get.docker.com` and Docker Compose when not found.
- **Installer auto-installs Ollama** — Local AI mode auto-installs Ollama and pulls `tinyllama` default model when not found locally.
- **Ollama env var precedence** — `.env` variables now override saved database config for Ollama provider, fixing Docker installs where `host.docker.internal` was overwritten by localhost defaults.
- **Ollama timeout** — Increased from 2 minutes to 10 minutes for CPU-only inference on modest hardware.
- **Dashboard branch overflow fix** — Self-modification "Current Branch" field truncates long branch names with ellipsis.
- **MindSwarm media upload fix** — Upload field name changed from `file` to `media` to match MindSwarm API.
- **Docker localhost binding** — `docker-compose.yml` uses `DOCKER_BIND_HOST` env var. Installer sets `127.0.0.1` when Caddy/SSL is configured, preventing Docker ports from being publicly accessible.
- **Server firewall hardening** — UFW installed and configured on all production VPS servers. Services bound to `127.0.0.1` behind nginx/Caddy reverse proxies.
- **Twitter engagement system** — Mention monitoring, AI auto-reply with safety guards (max 5/cycle, 10/day, 2-deep thread limit), auto-like mentions, auto-follow back with blocklist. All features OFF by default (opt-in).
- **MindSwarm pin post** — Updated to v2 toggle API (`POST /posts/:id/pin`), added `reorderPins` action.
- **Calendar date fix** — Events no longer show one day early due to UTC-to-local timezone conversion.
- **Telegram media conversion** — Send a video or audio file with a caption like "convert to mp3" and the bot converts via FFmpeg and sends back the result. Supports mp3, mp4, wav, aac, flac, ogg. 20MB Telegram API limit with clear error message for oversized files.
- **MindSwarm media upload fix** — Upload field name corrected from `file` to `media` to match MindSwarm API.
- **Skynet Telegram bot** — Fixed channel link markdown escaping in @skynet_tracker messages.

## [2.24.8] - 2026-04-10

### Added
- **MIT License and Disclaimer** — `LICENSE` (MIT) and `DISCLAIMER.md` covering financial risk, autonomous operation, self-modification, smart contracts, P2P network, and third-party services.
- **Installer auto-fork** — Step 8 now detects GitHub username from PAT, auto-forks the LANAgent repo, and configures both `origin` and `upstream` git remotes with authentication. No manual fork creation needed.
- **Installer auto-installs dependencies** — Step 1 detects missing Node.js, MongoDB, FFmpeg, and Git, then offers to install them automatically. Node.js via nvm, MongoDB via native packages with Docker fallback for unsupported OS versions (e.g., Debian 13), FFmpeg via apt.
- **Installer auto-generates wallet** — Step 7 always creates a crypto wallet (needed for P2P payments and API credits), with option to import existing. Previously skippable, which broke networking.
- **Installer auto-detects public IP** — Step 9 sets `AGENT_SERVICE_URL` automatically via ipify, so the P2P registry can route traffic. Previously missing from install, causing agents to not appear on the network.
- **Installer PM2 auto-start** ��� Direct installs now offer to start via PM2 with auto-save and systemd startup hook.
- **Docker self-modification support** — `docker-compose.yml` mounts the host git repo at `/app/repo` and sets `AGENT_REPO_PATH=/app/repo`. `Dockerfile` adds `/app/repo` as a git safe directory. Docker instances can now branch, commit, push, and create upstream PRs.
- **PancakeSwap slippage protection** — Gateway BNB-to-SKYNET swaps now use `getAmountsOut()` to calculate expected output and set `amountOutMin` to 95% (5% slippage tolerance). Previously set to 0, allowing front-running.

### Fixed
- **`DeviceAlias.cleanupExpiredAliases is not a function`** — Production was missing the method added in development. Deployed the updated model file.
- **Installer `AGENT_SERVICE_URL` not written to `.env`** — P2P agents couldn't be discovered by the gateway because the service URL was never configured during install.
- **Installer git remotes never configured** — `GITHUB_REPO` was written to `.env` but `git remote add origin` was never executed, so self-modification couldn't push branches.
- **Docker installs had no `.git` directory** — `Dockerfile` used `COPY` which excluded `.git`, making self-modification impossible inside containers.

## [2.24.7] - 2026-04-09

### Added
- **WireGuard tunnel status in Web UI** — VPN tab now shows a WireGuard card below the ExpressVPN status card, displaying endpoint, last handshake, transfer stats, and peer ping latency. Health state (green/red) matches the API's `healthy` field. "Bounce Tunnel" button triggers `wg-quick down/up` via the API. Both providers visible at a glance: ExpressVPN for outbound privacy, WireGuard for inbound tunnel.

## [2.24.6] - 2026-04-09

### Added
- **VPN plugin v2.0 — dual-provider WireGuard + ExpressVPN management.** WireGuard methods: `wireguardStatus` (handshake age, transfer stats, peer ping), `wireguardBounce` (wg-quick down/up with PostUp hooks for ExpressVPN coexistence), `wireguardHealth` (auto-recover stale tunnels). Status endpoint now returns both providers: ExpressVPN (outbound privacy) and WireGuard (inbound tunnel for api.lanagent.net). Troubleshoot diagnostics check both. New API routes: `GET /api/wireguard/status`, `POST /api/wireguard/bounce`, `POST /api/wireguard/health`.
- **`vpn-wireguard-watchdog` Agenda job** — runs every 2 minutes, checks WireGuard handshake age and peer reachability. If tunnel is stale (>3 min since last handshake) or peer unreachable, auto-bounces wg0. Silent no-op when healthy. PostUp hooks in wg0.conf re-add the static route and iptables exception for ExpressVPN coexistence automatically after every bounce.
- **Dual-VPN coexistence** — WireGuard and ExpressVPN now run simultaneously on production. WireGuard handles inbound traffic (api.lanagent.net reverse proxy via VPS tunnel), ExpressVPN handles outbound traffic (IP privacy for scrapes/API calls). wg0.conf PostUp hooks add a static route (`VPS_IP/32 via GATEWAY_IP`) and an iptables exception in ExpressVPN's kill-switch chain (`evpn.r.100.blockAll`) so WG UDP packets bypass the VPN tunnel. PostDown cleans up both.
- **netcheck watchdog** — systemd service (`netcheck.service`) on production running `/root/netcheck.sh` (from the netcheck project). Monitors ExpressVPN connection state every 30s, verifies both ping AND DNS, auto-recovers via disconnect/reconnect cycle, locks `/etc/resolv.conf` with `chattr +i` to prevent DNS hijacking by NetworkManager/DHCP.

### Fixed
- **VPS WireGuard persistence** — `wg-quick@wg0` service on VPS (VPS_IP) was `enabled` but `inactive (dead)` (interface was up via manual `wg-quick up`). Restarted under systemd so it survives VPS reboots.

## [2.24.5] - 2026-04-09

### Changed
- **Scammer registry auto-pricers now ON by default.** `skynet.scammerFee.autoPrice` and `skynet.immunityThreshold.autoPrice` default to `true` instead of `false`. The opt-in gate in v2.24.3 was belt-and-suspenders — the `_isGenesisInstance()` pre-flight already makes non-genesis instances silently no-op, so the master toggle is really just a kill switch for the genesis operator rather than a safety gate. Once deployed, the canonical genesis instance will start anchoring `reportFee` to $0.50 and `immunityThreshold` to $50 automatically, with the 25% drift gate and 24h rate limit still in place. Forks remain safe because they fail the owner check.

## [2.24.4] - 2026-04-09

### Added
- **AdminViewFacet deployed + cut into SkynetDiamond** — new facet at `0x37414cb701831947C1967f4CbFCB843E67A60212` exposing 4 admin-settable params that previously had setters but no getters: `immunityThreshold()`, `commerceFeeBps()`, `trustStakeThreshold()`, `trustLPThreshold()`. Diamond cut tx: [`0xc1d2d96ec8e4cf8f4b867fb9956959b4f6b377a8190a41a25c7db69f2e18cef0`](https://bscscan.com/tx/0xc1d2d96ec8e4cf8f4b867fb9956959b4f6b377a8190a41a25c7db69f2e18cef0) (230k gas, pure Add action, zero selector collisions). Total facets on diamond now 16. `contracts/skynet-diamond/scripts/add-admin-view-facet.mjs` is the idempotent-ish deploy+cut script used for this (pre-flight checks owner + existing selectors, post-flight verifies via loupe + functional reads).

### Changed
- **Scammer registry immunity auto-pricer now reads on-chain** — the v2.24.3 auto-pricer used a `skynet.immunityThreshold.lastSetValue` SystemSettings key as a drift baseline because the deployed diamond had no public `immunityThreshold()` view. With AdminViewFacet now cut in, `autoUpdateImmunityThreshold` reads the value directly off-chain, same shape as `autoUpdateScammerFee` reads `reportFee()`. The SystemSettings bandaid was removed; only `lastSetAt` (rate limiter timestamp) remains in SystemSettings for both auto-pricers.
- **`setReportFee` / `setImmunityThreshold`** no longer persist `lastSetValue` into SystemSettings — the on-chain views are the source of truth. `lastSetAt` is still written for the 24h rate limit (no on-chain timestamp exists).

## [2.24.3] - 2026-04-09

### Added
- **Scammer registry fee auto-pricer** — new opt-in Agenda jobs `skynet-auto-price-fee` and `skynet-auto-price-immunity` (both hourly) that anchor the on-chain `RegistryFacet.reportFee` and `immunityThreshold` to a USD target via the shared SKYNET/USD oracle. Defaults: $0.50 flag fee, $50 immunity threshold, 25% drift gate, 24h hard rate limit, opt-in (off by default), with min/max SKYNET clamps. Pre-flight `_isGenesisInstance()` check (compares signer to `OwnershipFacet.owner()`) so non-genesis instances no-op silently. See `docs/proposals/scammer-fee-auto-pricing.md` for the full design.
- **Shared SKYNET/USD oracle** — extracted the LP-reserves + Chainlink BNB/USD path from `src/interfaces/web/p2p.js` into `src/services/crypto/skynetPrice.js#getSkynetUsdPrice()` with a 60s in-process cache. P2P auto-pricer and the new fee auto-pricer now both call the helper instead of duplicating contract reads.

### Fixed
- **`REGISTRY_ABI` missing entries** — `setReportFee`, `setImmunityThreshold`, `owner`, and the `ReportFeeUpdated`/`ImmunityThresholdUpdated` events were missing from the ABI in `scammerRegistryService.js`, which meant the existing `POST /api/scammer-registry/set-fee` and `POST /api/scammer-registry/set-immunity-threshold` endpoints would have thrown `TypeError: contract.setReportFee is not a function` on first use. Both endpoints now work end-to-end.

### Changed
- **`setReportFee` / `setImmunityThreshold`** now persist `lastSetValue` and `lastSetAt` into `SystemSettings` after a successful tx (`skynet.scammerFee.*`, `skynet.immunityThreshold.*`) so the auto-pricer's drift gate has a baseline immediately, even when the value was set manually via the HTTP endpoint. This is also the only way to read the immunity threshold off-chain — the deployed diamond does not expose a public `immunityThreshold()` view.

## [2.24.2] - 2026-04-09

### Added
- **RuntimeError correlation** — `RuntimeError` model now has an indexed `correlationId` field plus a `getErrorsByCorrelationId(id)` static, so related errors from a single request/operation can be grouped and queried together.
- **TrustAttestation caching + retry** — `getTrustLevel`, `getTrustGraph`, `getBySource` are now wrapped in `retryOperation` (3 retries) and a 10-minute NodeCache to absorb read load on the trust graph.
- **Donations API hardening** — `/donations/*` routes now sit behind an express-rate-limit (100 req / 15 min / IP), `/addresses` is cached for 5 min, and the `/track` retry loop adds jitter (`randomize: true`).
- **MCPServer status webhooks** — optional `webhookUrl` field on MCP server documents. When set, `updateStatus()` POSTs `{serverName, status, error, timestamp}` to the URL on every status change. Failures are logged but don't block the status update.
- **Uncensored provider error categorization** — `generateResponse` now distinguishes API errors (status + body), network errors (no response), and unexpected errors in the log output.
- **Git hosting MFA scaffolding** — GitHub, GitLab, and Bitbucket provider configs in `GitHostingSettings` now have an optional `mfa: { enabled, method }` subdocument (`method` ∈ `sms`/`authenticator`/`email`). `getActiveProviderConfig` returns the MFA settings; new `checkAndEnforceMFA()` instance method (logging stub for now, ready to wire to actual enforcement).
- **DevelopmentPlan auto-archive** — new `archiveOldCompletedItems(days)` static archives `completed` items older than N days. Driven by a new `archive-old-dev-items` Agenda job, daily at 02:30. Default 30 days.
- **EmailLease expiration warnings** — new `sendExpirationNotifications(daysAhead)` static warns lease holders 7 days before expiry via the existing email plugin (no new SMTP transport). Driven by a new `email-lease-expiration-warnings` Agenda job, daily at 09:00.
- **Zapier `schedule_zap` action** — schedules a one-shot Zap run at a specific ISO 8601 time via `agent.scheduler.agenda.schedule(date, 'zapier-run-zap', { zapId })`. Past times rejected. Backed by a new `zapier-run-zap` Agenda job that dispatches to the live zapier plugin instance.

### Notes on PR review pass
- ALICE PRs #1925 (agentAccessor validation), #1929 (abiManager fallback), and #1931 (encryption Argon2) were closed without merging — `validateJsonSchema` returns an array (not `{valid}`) and the Agent class had no matching shape; the abi "fallback" was an empty-array loop; and Argon2 would have converted `encrypt`/`decrypt` to async, breaking every existing call site.
- ALICE PRs #1927, #1930, #1932 had good ideas but called `TaskScheduler.scheduleJob()` on the imported class (which is instantiated, not static). The good ideas were reimplemented correctly via Agenda in PR #1933.

## [2.24.1] - 2026-04-09

### Added
- **Image Tools plugin** (`imageTools`) — Sharp-powered image processing API. Commands: `optimize` (compress + format convert), `resize` (with fit modes), `crop` (region or smart attention-based), `convert` (png/jpeg/webp/avif/tiff), `watermark` (text overlay with position/opacity), `metadata` (dimensions, format, EXIF, color space), `transform` (chain up to 10 ops in one call: resize, rotate, flip, flop, sharpen, blur, grayscale, negate, tint, trim). 2 credits per call. Max 20MB input, 8192px max dimension.
- **Adding Paid Services guide** (`docs/ADDING_PAID_SERVICES.md`) — step-by-step checklist for wiring a new plugin into all 3 paid channels (credit API, P2P Skynet, gateway). Covers all files, gateway re-registration, testing layers, and common mistakes.

### Changed
- **External API catalog** — now includes plugin services in the main `services` array (gateway reads this to discover what the agent offers). Previously plugins were in a separate `pluginServices` array the gateway ignored.
- **Agent identity registration** — `generateRegistrationFile()` now includes approved plugin services from `ALLOWED_PLUGINS`, not just the 8 legacy services. Gateway re-registration picks up new plugins automatically.
- **Skynet service auto-sync on startup** — `syncServicesFromPlugins()` runs 30s after web server starts, registering new plugins into the Skynet DB catalog automatically. New services default to `skynetEnabled: true`. Auto-pricing also enables disabled services.
- **Self-modification prompt improvements** — added third-party API/SDK verification rules (prevents hallucinated API calls), "never remove existing methods" rule, "never output non-code" rule, 7 new anti-pattern examples. 3 new blocking validation checks: leaked LLM reasoning detection, removed methods detection, file shrinkage detection. Thresholds tuned to avoid false positives.
- **SKYNET Bot** — added `/tokenscan`, `/honeypot`, `/wallet`, `/audit` commands for token/wallet/contract analysis. Added `/imgoptimize`, `/imgresize` for image processing. Added `/caption`, `/ner`, `/language`, `/spam` AI commands. Bare 0x address auto-detection in chat. Simplified from 9 crypto commands to 4. Updated /help and service counts.
- **SKYNET Bot token tracker** — rewrote from deprecated BscScan V1 API to direct RPC `getLogs` with ERC20 Transfer event topic. Added 4-RPC fallback rotation for both event watcher and token tracker.

### Fixed
- **Gateway service discovery** — agent catalog was returning plugin serviceIds with `plugin:` prefix (colon) but gateway expected `plugin-` prefix (hyphen). Fixed to use hyphen format matching gateway convention.
- **Gateway re-registration requirement** — documented that `POST /admin/agents` must be called after adding new services (gateway does NOT auto-refresh service lists, only pricing).
- **BscScan V1 API deprecation** — token tracker was silently failing because BscScan deprecated V1 endpoints. Migrated to on-chain RPC getLogs.

## [2.24.0] - 2026-04-07

### Added
- **Twitter plugin v2.0** — X API v2 write support with OAuth 1.0a HMAC-SHA1 signing. New commands: `post`, `reply`, `deleteTweet`, `like`, `getMe`. Existing FxTwitter read commands unchanged. Credentials via web UI settings (not offered as paid service — internal use only).
- **Challenge Questions plugin** (`challengeQuestions`) — bot-filtering questions that humans and AI pass but scripts fail. 8 question types: word arithmetic, sequences, letter counting, odd-one-out, reverse, logic puzzles, geography, general knowledge. Two flows: `generateWithAnswers` (single request) and `generate`→`verify` (server-side validation with token). 70% pass threshold, 3 max attempts.
- **Token Profiler plugin** (`tokenProfiler`) — ERC20 token scam/safety analysis via GoPlus Security API. Commands: `audit` (full analysis), `honeypotCheck` (quick), `holderAnalysis` (top holder concentration), `score` (0-100 safety rating). Detects honeypots, high tax, unrenounced ownership, whale concentration, low liquidity, mintable supply.
- **Wallet Profiler plugin** (`walletProfiler`) — crypto wallet analysis. Commands: `profile` (balance, age, tx count, risk flags), `tokens` (ERC20 holdings), `riskScore` (0-100 with weighted flags for new wallets, high-value transfers, scam interactions).
- **Contract Audit plugin** (`contractAudit`) — static Solidity security analysis via regex pattern matching. Commands: `audit` (full finding list with severity), `quickCheck` (critical/high only), `explain` (plain-English contract description). Detects selfdestruct, reentrancy, unprotected mints, tx.origin auth, unchecked calls, floating pragma, missing zero-address checks. Supports inline code or on-chain source fetch from BSCScan/Etherscan.
- **HuggingFace 5 new commands** — `imageCaption` (BLIP model), `namedEntityRecognition` (BERT NER), `languageDetection` (XLM-RoBERTa), `textSimilarity` (sentence-transformers cosine similarity), `spamDetection` (SMS spam classifier). All exposed as paid external services.
- **External API expansion** — tokenProfiler (3 cr), walletProfiler (3 cr), contractAudit (5 cr), challengeQuestions (2 cr) added to external paid API allowlist and P2P service catalog.
- **Puppeteer stealth on production** — installed `puppeteer-extra` and `puppeteer-extra-plugin-stealth` for browser automation with anti-detection.

### Changed
- **api.lanagent.net** — service count updated to 77 (now 88+ with new plugins), added challenge question example cards, Python/JS code samples, "bot-filtering challenge questions" in feature description.
- **P2P pricing** — all new plugins added to `SKYNET_ELIGIBLE_CATEGORIES` and `SERVICE_USD_TIERS` with auto-pricing from PancakeSwap + Chainlink oracle.
- **Release repo strategy** — updated audit: `.git` 312MB→398MB, 1875→1903 commits, reorganized checklist, added files-to-review section, post-release steps.

## [2.23.1] - 2026-04-06

### Added
- **Telegram `/aidetect` in bot menu** — added to BotFather command list for both ALICE Dashboard and SKYNET Bot.
- **SKYNET Bot command menu** — registered 23 commands with BotFather `setMyCommands` (previously had no menu at all).
- **api.lanagent.net AI detection examples** — 4 curl example cards (text, image, audio, video detection), Python and JavaScript code samples on the landing page.
- **numverify `batchValidatePhoneNumbers`** — validate up to 50 phone numbers in a single call. Processes in chunks of 10 with rate-limit delays. Returns per-number results with aggregate success/failure counts.
- **LP Market Maker retry resilience** — all 6 remaining route handlers (enable, disable, openPosition, closePosition, rebalancePosition, collectFees) now wrapped in `retryOperation` with 3 retries, matching the existing pattern for initialize and getStatus.
- **Memory model compound index** — added `{ metadata.userId: 1, createdAt: -1 }` index for efficient user-scoped memory queries.
- **Postman collection** — added AI Content Detector (5 requests), Numverify Batch Validate, and LP Market Maker (7 requests) folders.

### Changed
- **api.lanagent.net service count** — updated from "69 Services" / "61 plugin commands" to "73 Services" to reflect actual catalog count including AI detection.
- Reviewed and closed 12 AI-generated PRs: implemented 3 features manually with fixes, closed 9 with broken or hallucinated implementations.

## [2.23.0] - 2026-04-05

### Added
- **AI Content Detector plugin** (`aiDetector`) — detect AI-generated text, images, video, and audio. Text detection uses the agent's selected AI provider (Claude, GPT-4o, etc.) with a structured analysis prompt for high accuracy (~90%+). Image detection uses `Ateeqq/ai-vs-human-image-detector` ViT model (Dec 2025, trained on 60K AI + 60K human images, 99%+ accuracy). Video detection extracts frames via FFmpeg and runs per-frame image analysis. Audio detection transcribes via Whisper then analyzes the transcript.
- **Python FastAPI microservice** (`ai-detector`) managed by PM2 for image/audio ML inference on port 5100. Auto-detects CPU/GPU, lazy-loads models on first use.
- **Telegram `/aidetect` command** — enter detection mode, send text/photos/voice/audio/video for analysis.
- **External paid API** — AI detector available at `POST /api/external/service/aiDetector/{action}` (5 credits per call). Listed on api.lanagent.net service catalog.
- **P2P Skynet service** — 5 detection commands registered as paid P2P services (configurable pricing via web UI).
- **MCP tool execution timing** — debug-level logging of execution time for MCP tool calls.
- **Compute job priority** — numeric priority field (1-3) on ComputeJob model with compound index. Active jobs sort by priority descending.
- **Token usage batching** — BaseProvider now queues token usage records and flushes via `insertMany()` (threshold: 10 items or 5 seconds) instead of per-request `create()`.

### Fixed
- **Self-modification Claude compatibility** — rewrote capability scanner JSON parser, increased timeout, disabled unnecessary web search for code analysis.
- **Bug detection Claude compatibility** — same JSON parser fix applied to bugDetector, bugFixing, and outputParser.
- **Bug detector storage** — fixed missing `title`/`bugId` fields and invalid status enum values when storing bugs from AI responses.
- **Bug detector duplicate prevention** — fixed false duplicates where just-stored bugs were immediately flagged as duplicates in the same scan run.
- **Stale discovered feature handling** — file existence validation before upgrades, rejected features auto-cleanup.
- **Dollar Maximizer thresholds** — tightened sell (3%→2%) and buy (-5%→-3%) to execute trades in low-volatility markets.
- **Strategy agent timeout** — increased from 10 to 20 minutes to prevent AI analysis timeouts.

### Changed
- **AI provider API key** — updated production Anthropic API key and verified end-to-end Claude usage after 3+ weeks of silent OpenAI fallback.
- Reviewed and processed 17 AI-generated PRs: merged 4, reimplemented 3 with fixes, closed 10.

## [2.22.0] - 2026-04-05

### Fixed
- **Self-modification capability scanner — Claude API compatibility** — the JSON response parser used a non-greedy regex that failed to extract upgrade suggestions from Claude's responses (worked with GPT-4o by coincidence). Rewrote parser to strip code fences, use first/last brace extraction, and fall back to regex-based individual object extraction when JSON is malformed. Also increased analysis timeout from 30s to 60s and disabled unnecessary web search for code analysis calls.
- **Stale discovered feature handling** — self-mod would crash with ENOENT when targeting files that don't exist (e.g. `src/services/llm.js`). Now validates file existence before attempting upgrades, marks stale features as rejected in the database, and validates AI-suggested target files before accepting them.
- **Discovered feature cleanup** — expanded cleanup to remove rejected features (3 days), stale unimplemented features (30 days), in addition to existing implemented feature cleanup (7 days).

### Changed
- **AI provider fallback visibility** — production was silently falling back from Anthropic to OpenAI/GPT-4o for 3+ weeks due to an invalid API key. Updated production API key and verified end-to-end Claude usage. The `providerInfo` debug logs now correctly reflect the provider that actually serves responses.
- **Capability scanner maxTokens** — increased from 1000 to 2000 to prevent Claude responses from being truncated mid-JSON.

## [2.21.9] - 2026-04-03

### Added
- **ARR service update monitoring** — daily scheduled job (`arr-update-check`, 8 AM) checks all configured *arr services (Prowlarr, Radarr, Sonarr, Lidarr, Readarr) for available updates. Sends Telegram notification when updates are found, flags major version bumps. Uses built-in *arr `/update` API endpoint with GitHub releases fallback.
- **`check_updates` action** on all *arr plugins — manually check any *arr service for updates via natural language ("check prowlarr for updates", "are my arr services up to date").
- **`ArrBasePlugin.checkForUpdate()`** — instance method on all *arr plugins. Compares installed version against latest available, detects major version jumps, includes changelog snippets.
- **`ArrBasePlugin.checkAllArrUpdates(agent)`** — static method to check all configured *arr services at once, used by scheduler and available for subagents.

## [2.21.8] - 2026-04-03

### Added
- **Auto-post sensitive content filter** — shared utility (`src/utils/autoPostFilter.js`) prevents the agent from posting about business plans, outreach campaigns, partnership proposals, monetization strategy, release plans, investor relations, or internal documentation. Filters at three layers: git pathspec exclusions (`docs/proposals/`, `docs/sessions/`), commit message keyword filtering, and AI prompt rules. Designed for reuse across MindSwarm, Telegram, and X auto-posting.

### Fixed
- **MindSwarm auto-post leaking internal topics** — `_gatherPostContext()` was feeding raw git commit messages (including proposal/outreach commits) as AI context, causing the agent to post about private business plans on MindSwarm. Now filtered at input (git pathspecs + keyword filter) and output (explicit prompt rules).

## [2.21.7] - 2026-03-31

### Added
- **SKYNET Welcome Package** — new P2P system automatically provisions new agents. Genesis (ALICE) sends 200 SKYNET + creates @lanagent.net email after 60-min uptime verification. Toggle: `skynet.welcomePackageEnabled`. Tested end-to-end on Docker VPS.
- **Identity wallet funding flow** — Identity tab shows wallet address, BNB/SKYNET balances, "Convert BNB to SKYNET" one-click swap, PancakeSwap link, step-by-step instructions.
- **Email plugin auto-config from lease** — when no GMAIL/EMAIL env vars set, plugin auto-configures SMTP+IMAP from P2P-leased credentials (welcome package). Zero manual email setup needed.
- **Docker installation tested** — full end-to-end test on clean Debian VPS: Dockerfile with Chromium, Xvfb, FFmpeg, Tesseract, crypto wallet libs. docker-compose with MongoDB. Interactive setup wizard.
- **Identity API** — `GET /api/identity/status`, `POST /api/identity/ens`, `POST /api/identity/email`, `GET /api/identity/wallet`, `POST /api/identity/buy-skynet`, `GET /api/identity/welcome-status`

### Fixed
- **Default AI models** — Agent.js schema defaults updated from retired claude-3-opus-20240229/gpt-4-turbo-preview to claude-sonnet-4-5-20250929/gpt-4o. Fixes 404 on fresh installs.
- **Docker Chromium deps** — `libasound2t64` → `libasound2` for Bookworm. Added `iproute2`, `procps`. Xvfb lock cleanup.
- **Crypto wallet libs** — bitcoinjs-lib, bip39, hdkey, siwe added as optionalDependencies for first-run wallet generation.
- **Welcome package resilience** — checks SKYNET+BNB balance before transfer, retries on funding issues (30 min), retries if no response (15 min timeout), handles genesis offline gracefully, genesis skips self-request.
- **Welcome email** — ALICE sends a welcome email to each new agent's leased address with getting-started links.
- **Scam report auto-detection** — reports now check on-chain bytecode (`getCode`) to determine contract vs wallet. Fixes token contracts getting SCAMMER badge instead of SCAMTOKEN.
- **Agent identity endpoint** — `/api/agent/identity` now returns leased email from P2P welcome package when no env var email is set.

## [2.21.6] - 2026-03-31

### Added
- **SKYNET Telegram Bot** (`@SkynetAPIBot`) — public API showcase bot deployed to VPS VPS_IP. 20 source files, 69 service commands. BSC wallet with auto-credit purchase. Free with daily limits per user.
  - Commands: /price, /compare, /feeds, /stock, /crypto, /sentiment, /summarize, /translate, /qa, /classify, /fillmask, /search, /weather, /news, /yt, /lyrics, /nasa, /anime, /run, /skynet, /staking, /vault, /contract, /chart, /swap, /import, /about, /api, /credits
  - Auto-detect: MindSwarm rich embeds, Twitter/X fixupx, Instagram/Facebook URL cleaning, YouTube info cards
  - Cashtag price tooltips ($BTC, $ETH in group chats)
  - On-chain event broadcasting to @skynet_events (Diamond + Vault events)
  - Token transfer tracking to @skynet_tracker (BscScan API, BUY/SELL/BURN classification)
  - Gateway wallet auth (not portal email) for crypto credit purchases
  - Scheduled jobs: credit check (30min), daily reset, daily report, cache refresh (15min), event watcher (2min), token tracker (2min)
- **Telegram channels** — @skynet_events (on-chain events), @skynet_tracker (token transfers), @skynet_api (community group)
- **Outreach proposals** — Anthropic and OpenAI professional outreach documents

### Fixed
- **Bot /price command** — was sending `symbol` param instead of `pair`, response parsed from wrong nesting level
- **Bot /feeds command** — feeds are plain strings, not objects with `.name` property
- **Bot /vault command** — cache used non-existent `stakerCount()` and `totalCompounded()`, fixed to `getStakerCount()`, `getLPStakerCount()`, `getPendingRewards()`, `getPendingLPRewards()`
- **Bot credit purchase** — was using portal email auth (wrong), switched to wallet signature auth
- **Event watcher rate limits** — reduced polling to 2min, switched to bsc.publicnode.com RPC

### Removed
- **Bot network commands** — /ping, /check, /resolve, /mx, /ns, /host, /unshorten removed (exposed VPS IP behind proxy)

## [2.21.5] - 2026-03-30

### Added
- **Auto-price toggle** — replaces manual "Set Market Prices" button on both External Services and Skynet Services tabs. Toggle controls `skynet.autoPriceEnabled` SystemSetting. When ON, prices auto-update every 15 min from PancakeSwap LP + Chainlink BNB/USD. "Update Now" button for immediate refresh.
- **API endpoints** — `GET/POST /api/skynet/services/auto-price-status` and `/auto-price-toggle`

### Fixed
- **Stale AI model configs** — ALICE DB had retired `claude-3-opus-20240229` (404) and stale `gpt-4o`. Updated to `claude-opus-4-5-20251101` and `gpt-4o`. Model-update scheduler job now auto-validates saved configs and resets retired models to current defaults.
- **CSS toggle conflict** — duplicate `.toggle-slider` definition was overriding `.plugin-toggle` toggles, making them render as circles instead of pill-shaped tracks. Scoped second definition to `.toggle-label` parent.

## [2.21.4] - 2026-03-30

### Added
- **SkynetVault contract** — deployed at `0x220dCBd455161435897eE083F95451B3f7eC20E6` (BSC mainnet, verified on BscScan). Auto-compounding staking vault wrapping SkynetDiamond. Users deposit SKYNET or LP with auto-compound toggle. Anyone calls `compound()` to re-stake rewards for all users — caller earns 0.1% bounty.
- **skynettoken.com staking DApp redesign** — auto-compound toggle (SKYNET), LP compound mode selector (Manual/Stake/Compound LP), vault info panel, position detail panels showing tier/lock/rewards/mode, smart Stake/Unstake/Claim buttons (auto-detect vault vs direct), confirmation dialogs, MAX buttons, "Add to MetaMask" button, emergency withdraw for locked positions
- **Vault scheduler job** — `skynet-vault-compound` runs every 12 hours, compounds both SKYNET and LP rewards. Multi-instance ready via `skynet_vault_address` SystemSetting.
- **Vault API routes** — `/api/staking/vault/stats`, `/vault/compound`, `/vault/compound-lp`, `/vault/address`
- **Vault staking service methods** — `vaultCompound()`, `vaultCompoundLP()`, `getVaultStats()`, `getVaultAddress()`, `getVaultContract()`

### Fixed
- **SystemSettings import** — was using `.default` (undefined) instead of named export `{ SystemSettings }`
- **Staking DApp wallet reconnect** — uses `eth_accounts` instead of deprecated `selectedAddress`, listens for account/chain changes
- **Staking position display** — reads from vault when user staked via vault (was showing 0/No Lock from empty diamond position)
- **Stats bar** — switches between SKYNET and LP stats when changing tabs; includes vault deposits in totals
- **PancakeSwap LP link** — fixed to V2 (`/v2/add/`) instead of V3
- **Gateway graceful failure** — `{success: false}` returns HTTP 200 (not 500) on both ALICE and gateway

## [2.21.3] - 2026-03-29

### Added
- **Chainlink price feeds expanded** — 97 verified oracle feeds across 7 networks (Ethereum, BSC, Arbitrum, Polygon, Optimism, Base + testnets). Auto-discovers across networks. CoinGecko fallback for tokens without Chainlink feeds (free — auto-refunded). Dedicated gateway routes: `/price/:pair`, `/price/feeds`, `/price/:pair/info`, `/price/:pair/history`, `/price/compare`.
- **HuggingFace plugin v2.0** — fully rewritten for new `router.huggingface.co` API (old `api-inference` deprecated). 8 NLP tasks: textClassification, sentimentAnalysis, textSummarization, questionAnswering, translation, fillMask, zeroShotClassification, featureExtraction. Sensible default models, lazy credential loading.
- **WebSearch plugin v2.0** — `search` action now uses real web search via Anthropic/OpenAI built-in search tools (was routing to AI model that couldn't search). Caller can specify `"provider": "anthropic"` or `"provider": "openai"`. `weather` action now uses wttr.in (real data, no API key).
- **MindSwarm plugin v2.0** — 82 new commands (153+ total), full MindSwarm API coverage. Added: AI features (13 endpoints), full groups CRUD (12), extended drafts (5), push notifications (3), notification preferences (2), post extras (4), follow requests (2), user extras (2), moderation appeals (2), data export (2), admin endpoints (28), developer app extras (2). Reference implementation for the MindSwarm API.
- **Arbitrum and Optimism networks** added to contractServiceWrapper (RPC endpoints, chain IDs)
- **Autonomous LP staking cycle** — daily scheduled job + CryptoStrategyAgent heartbeat: auto-claim LP rewards, auto re-stake LP at Tier 3 (3x) on lock expiry, auto-compound claimed SKYNET into regular staking, auto-stake new LP tokens found in wallet. All thresholds configurable per instance via SystemSettings.
- **PancakeSwap liquidity deepened** — added 0.25 BNB + 8M SKYNET to LP, pool value $341 → $1,209. Swapped 0.25 BNB → 13.7M SKYNET, added as V2 LP. All 6,261 LP tokens staked at Tier 3 (180 days, 3x multiplier).
- **Token economics documentation** — `docs/contracts/SKYNET-Token-Economics.md` with runway analysis (4.7 years at current emissions), revenue sources, sustainability levers, decision log
- **api.lanagent.net portal** — 11 new code example cards (Chainlink, HuggingFace, WebSearch, weather, stocks, news), updated Python/JS SDK examples, service count updated to 69
- **lanagent.net** — updated to v2.21.3, 69 services, added Chainlink/HuggingFace/WebSearch cards
- **skynettoken.com** — expanded utility section with 8 cards (Chainlink oracle fees, ERC-8183 commerce, ERC-8107 trust, ERC-8033 oracle council), API gateway link, updated meta descriptions

### Fixed
- **Gateway 500 on graceful failures** — when a plugin returned `{success: false}` (e.g. "no lyrics found"), both ALICE and the gateway returned HTTP 500. Fixed both layers to return HTTP 200 with `{success: false}`. Prevents false agent failure counts.
- **Lyrics plugin** — intermittent 500 errors. Added top-level error handling, retry logic with backoff for LRCLIB rate limits (429/5xx), Array.isArray guards for non-JSON responses.
- **HuggingFace stale DB credentials** — old encrypted API key in MongoDB was overriding valid env var. Cleared on deploy.
- **Chainlink invalid feed addresses** — removed 6 non-functional addresses after on-chain verification
- **External services dashboard** — request counts now aggregated from audit log (was always 0). Prices shown in BNB, SKYNET, and USD.

## [2.21.2] - 2026-03-29

### Added
- **Chainlink price feed plugin** — 5 commands (price, feeds, historical, compare, info) exposed as paid service. No API key needed — reads BSC oracles directly. 1 credit per call.
- **Revenue summary dashboard** — consolidated view on External Services tab showing on-chain payments, SKYNET/BNB totals, API request count, P2P payments
- **Usage chart range toggle** — 24h (hourly), 7d, 14d views with proper hourly aggregation for 24h
- **API key regeneration** — `POST /portal/api-keys/regenerate` revokes all old keys, creates new one. Dashboard button with confirmation.
- **Payment log** on External Services tab — shows service, amount, currency (SKYNET/BNB), chain, BscScan tx links
- **Request logging** on gateway — per-request: service, credits, response time, success/failure
- **Generic plugin service proxy** — `POST /service/:plugin/:action` for all 52+ plugin services
- **Auto-pricing** — services priced every 15 minutes from PancakeSwap LP + Chainlink BNB/USD oracle
- **P2P service filtering** — `offerAsService` flag on plugin commands, server-side blocklist for admin/internal actions

### Fixed
- **api.lanagent.net usage chart** — proper 14-day line chart with area fill, was not rendering (chart code never inserted)
- **Stripe live mode** — cleared stale test-mode customer ID, live purchases working ($5 → 400 credits confirmed)
- **Payment log dates** — server normalizes to ISO strings (was returning empty objects)
- **Payment log currency** — server detects SKYNET vs BNB (field added to API response)
- **External services revenue label** — shows SKYNET for large amounts, removed hardcoded "BNB"
- **Portal auth** — accepts X-API-Key (gsk_*) as fallback when JWT expired
- **Dashboard auth** — tries API key from localStorage when Bearer token fails
- **NASA plugin** — loads API key from plugin settings DB (was env-var only)
- **News plugin** — loads credentials from DB, old-style execute(action, params) compatibility
- **HuggingFace** — circular JSON in error logging fixed; upstream API deprecated (HTTP 410)
- **Plugin credential loading** — `altEnvVars` support in basePlugin.loadCredentials()
- **Service catalog** — filters disabled plugins AND plugins missing required credentials
- **Mobile overflow** — peer cards word-break, body overflow-x hidden on all sites
- **skynettoken.com** — contract box mobile layout, staking grid responsive, utility section updated
- **lanagent.net** — email form stacks on mobile, services section updated to 50+
- **api.lanagent.net** — responsive grids, mobile media query, favicon added
- **ALICE crash** — trailing garbage bytes in p2p.js cleaned

### Changed
- **Service count**: 8 → 52+ across all channels (P2P, ERC-8004, API gateway)
- **19 AI-generated PRs reviewed** — all closed (breaking changes, security issues, missing deps, dead code)
- Webmail links removed from all public sites

## [2.21.1] - 2026-03-29

### Added (Generic Plugin Service Proxy)
- **52 plugin services** available via `POST /service/:plugin/:action` on ALICE and gateway
- 10 plugins exposed: anime, lyrics, nasa, news, websearch, huggingface, scraper, ytdlp, ffmpeg, weatherstack
- `GET /service/catalog` returns all available services with descriptions and credit costs
- Service catalog dynamically filters disabled plugins and those missing required API keys
- Credit costs per plugin based on USD compute cost (1-10 credits)
- Auto-refund on all failures

### Added (Auto-Pricing)
- Services auto-priced every 15 minutes from PancakeSwap LP reserves + Chainlink BNB/USD oracle
- Cost-based formula: `baseCostUsd × margin / skynetPriceUsd`
- Updates P2P prices (SkynetServiceConfig) and external prices (ExternalServiceConfig) simultaneously
- Configurable: `skynet.autoPriceEnabled`, `skynet.priceMargin` (default 1.2 = 20% margin)
- Enabled by default — agents don't need to configure

### Added (P2P Service Filtering)
- `offerAsService` boolean flag on plugin command definitions
- Server-side blocklist: admin/settings/version/diagnostic actions never exposed
- Pattern matching for common internal operations
- Sync removes previously imported blocked services
- Updated plugins: ytdlp, news, music, ffmpeg, scraper with explicit flags
- Plugin development docs updated with flag documentation

### Added (skynettoken.com Web3 Staking DApp)
- Connect Wallet (MetaMask, BSC auto-switch)
- SKYNET token staking with 4 lock tiers
- LP token staking with lock tiers
- Live dashboard: stake, rewards, APY, total staked, LP staked
- Auto-refresh every 30s

### Added (api.lanagent.net Dashboard Improvements)
- Request logging (per-request: service, credits, response time)
- `/portal/usage` endpoint with daily/service aggregated stats
- 4-stat dashboard cards (credits, purchased, used, requests)
- SVG bar chart (14-day usage history)
- Service breakdown with progress bars
- Rich code examples with syntax highlighting, copy buttons, Python/JS tabs
- 8 service example cards with individual copy buttons
- Favicon added

### Fixed
- NASA plugin: now loads API key from plugin settings DB (was env-var only)
- News plugin: loads credentials from DB + old-style execute(action, params) compatibility
- HuggingFace: circular JSON in error logging fixed; upstream API deprecated (HTTP 410)
- Plugin credential loading: `altEnvVars` support in basePlugin.loadCredentials()
- Service catalog filters disabled plugins AND plugins missing required credentials
- Gateway security: webhook rejects unsigned events, PORTAL_JWT_SECRET persisted, nginx headers
- ALICE crash: trailing garbage bytes in p2p.js cleaned
- Webmail links removed from all public-facing sites

## [2.21.0] - 2026-03-28

### Added (SkynetDiamond — ERC-2535 Diamond Proxy)
- **Deployed:** `0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7` (BSC mainnet)
- **14 facets, 134 selectors** — all verified on BscScan
- Replaces SkynetHub, AgenticCommerceJob, AgentCouncilOracle, AgentCoordination, ENSTrustRegistry
- StakingFacet + LPStakingFacet: token and LP staking with lock tiers (1x/1.5x/2x/3x)
- RegistryFacet: scammer registry with fee routing to staking pools (98 scammers migrated)
- CommerceFacet: ERC-8183 job escrow, accepts BNB or SKYNET
- OracleFacet: ERC-8033 council oracle, BNB/SKYNET bonds
- CoordinationFacet: ERC-8001 agent coordination with optional bonds and slash conditions
- TrustFacet: ERC-8107 trust attestations with staking-based trust boost
- CredentialFacet: ERC-1155 soulbound credentials
- SwapFacet: PancakeSwap BNB<>SKYNET with reserve management
- FeeRouterFacet: 40% token staking / 50% LP staking / 10% reserve (all adjustable)
- AdminFacet: full emergency recovery (no restrictions), all params owner-adjustable, mutable token addresses
- DiamondInit: sets all defaults on deployment
- 40 tests passing, on-chain stake/unstake verified
- Staking epoch funded: 20K SKYNET (7 days), LP epoch: 10K SKYNET (7 days)
- ALICE restaked 30K SKYNET on diamond

### Added (TreasuryFacet — On-Chain Token Allocation)
- **15th facet** deployed and verified: `0x207373c6994D261a8b816F41BC5c73C25045945D`
- 4 allocation pools: Staking Rewards (18.9M), Bounty (9.4M), Treasury (9.4M), Reserve (9.4M)
- **Auto-fund staking epochs** — when epoch ends, auto-funds from staking pool (capped 20K/epoch, stops below 1M)
- Owner can withdraw, transfer between pools, unlock reserve — no restrictions
- 47.15M SKYNET total deposited on-chain (proportional to ALICE's holdings)
- ALICE wallet retains ~100K SKYNET for operations

### Migration
- Unstaked from V2 (10,500 + 2,672 rewards) and SkynetHub (20,500 + 10,538 rewards)
- Recovered all recoverable SKYNET from old contracts (~172K). ~5.2K phantom-locked (same V1 bug, smaller scale)
- 98 scammers batch-imported from SkynetHub
- All 6 SystemSettings DB entries updated to diamond address
- All service code updated: scammerRegistryService, agent.js, CryptoStrategyAgent, mindswarm.js
- All 4 websites updated: lanagent.net, skynettoken.com, api.lanagent.net, registry.lanagent.net
- ERC-8004 NFT registration updated
- Old contracts decommissioned (still deployed, no longer referenced by service code)

## [2.20.8] - 2026-03-28

### Fixed (External API Routes — Gateway Compatibility)
- **Image generation** — service wasn't initialized; now uses agent's `providerManager` to initialize on first request
- **PDF text extract** — gateway routes to `/pdf/text` but agent only had `/pdf/extract`; added `/text` alias
- **Documents OCR** — gateway sends JSON but route expected multipart file upload; now accepts `fileUrl` and `fileBase64` in JSON body
- **File upload middleware** — skips magic byte validation when `fileUrl`/`fileBase64` provided instead of multipart
- **Document plugin** — used wrapper object instead of `.instance`; fixed plugin instance unwrap
- **File extension detection** — temp files from URL downloads now preserve extension from URL path or Content-Type header
- **Gateway agent URL** — was pointing to `api.lanagent.net` (itself); fixed to `http://10.8.0.2:80` (ALICE via VPN)

### Verified (Auto-Replenishment — Real Tokens)
- Full payment loop confirmed on-chain: BNB→SKYNET swap via PancakeSwap V2 → send to agent → agent credits gateway
- Swap tx: `0x8b9ede...` (0.008 BNB → 707,739 SKYNET)
- Transfer tx: `0x7c16e3...` (707,739 SKYNET → ALICE → +491 credits)
- Service call succeeded using real token-funded credits (no manual DB injection)

### Fixed (Email, Notifications, Infrastructure)
- **Email auto-reply blocklist** — scheduler now checks the existing `emailContactManager` blocklist before replying to inbound emails
- **Domain-level email blocks** — supports `*@domain.com` wildcard blocks (e.g. `*@moralis.com` blocks all senders from that domain)
- **Credit purchase Telegram notification** — full wallet address and TX hash with clickable BscScan links (was truncated and unlinkable)
- **Document OCR circular JSON** — `result.content = result` created circular reference; fixed to `result.content = ocrResult.text`
- **Gateway download proxy** — rewrites agent-relative download URLs to gateway-proxied `/download/{agentId}/token` paths; clients no longer need agent URLs
- **Gateway low-balance alert** — checks BNB balance every 15 min, sends Telegram alert when below 0.01 BNB (6-hour cooldown)
- **Gateway security hardening** — rate limiting on portal login/signup (10/15min), CORS restricted to project domains, webhook rejects unsigned events, nginx security headers (HSTS, X-Frame, X-Content-Type, Referrer-Policy)
- **Stripe live mode** — gateway switched from test keys to live Stripe keys
- **mail-api** moved out of LANAgent repo to website infrastructure directory

### Improved (Scraper Stealth)
- **puppeteer-extra + stealth plugin** — 16 evasion modules now active (navigator.webdriver, chrome.runtime, WebGL vendor, plugins, languages, etc.)
- **Non-headless mode via Xvfb** — auto-starts virtual display for better browser fingerprinting
- **Persistent Chrome profile** — reuses cookies and session data between scrapes
- **Realistic browser headers** — sec-ch-ua Client Hints, Accept-Language, Sec-Fetch-* headers
- **Extended Cloudflare challenge wait** — 30s timeout (up from 15s) with proper resolution detection
- **Clean Cloudflare error reporting** — returns `cloudflareBlocked: true` when Turnstile managed challenge can't be bypassed, instead of returning challenge page HTML
- **Limitation**: Sites using Cloudflare Turnstile managed challenges (e.g. Rumble) remain blocked — this requires per-instance CAPTCHA solving services

## [2.20.7] - 2026-03-27

### Added (Unified API Gateway — api.lanagent.net)
- **All 8 services routed through gateway** — scrape, YouTube, transcode, image gen, OCR, code sandbox, PDF toolkit
- **Agent directory** — `GET /agents`, `GET /agents/:id`, `GET /agents/:id/catalog`, `POST /agents/:id/:service`
- **ERC-8004 endpoint** — each agent's on-chain endpoint is now `api.lanagent.net/agents/{agentId}`
- **Auto-discovery from P2P registry** — gateway polls `registry.lanagent.net` every 5 min for new agents
- **Generic service proxy** — all services share the same auth, credit, routing, and refund logic
- **nginx migration** — `api.lanagent.net` now serves the gateway; `scrape.lanagent.net` is an alias

### Changed (P2P Registration)
- Agent P2P registration now includes `serviceUrl`, `agentId`, `walletAddress` for gateway auto-discovery
- Registry server stores and exposes these fields in peer lists
- ERC-8004 registration file includes `gateway` URL pointing to `api.lanagent.net/agents/{id}`

### Changed (Agent Knowledge)
- System prompt updated: references unified gateway, Stripe portal, agent directory
- Features output includes agent directory and all payment methods
- Service endpoint references updated from direct ALICE to gateway pattern

### Added (Stripe Portal — api.lanagent.net/portal)
- Email/password signup + login with 7-day JWT
- Stripe checkout: $5/400, $15/1300, $50/4700 credits
- Dashboard with credits, API keys, payment history
- Landing page with all 8 services, pricing, code examples
- Webhook for instant credit delivery on payment

## [2.20.6] - 2026-03-27

### Added (External Service Credit System)
- **Wallet signature auth** — clients prove wallet ownership via ECDSA signature, get JWT for key management
- **API keys** — `lsk_*` keys for automated service access, tied to wallet, revocable
- **Credit system** — purchase credits via BNB or SKYNET on-chain payment (1 credit = $0.01 USD)
- **Dynamic pricing** — credit-to-crypto conversion pegged to USD via Chainlink (BNB) and DexScreener (SKYNET)
- **Auto-refund** — failed service calls (target 4xx/5xx, timeout) automatically refund credits
- **Batch scraping** — `POST /api/external/scrape/batch` with up to 100 URLs, controlled concurrency, per-URL refund
- **Hybrid auth** — all 8 services accept both credit-based (API key) and legacy (X-Payment-Tx) payment
- **ExternalCreditBalance model** — atomic debit/refund with `$gte` guard against race conditions

### Added (API Endpoints)
- `GET /api/external/auth/nonce` — get signing nonce
- `POST /api/external/auth/verify` — verify wallet signature, get JWT
- `POST /api/external/auth/api-key` — generate API key (JWT auth)
- `DELETE /api/external/auth/api-key/:key` — revoke API key
- `GET /api/external/auth/api-keys` — list API keys
- `GET /api/external/credits/price` — current credit prices in BNB/SKYNET
- `POST /api/external/credits/purchase` — purchase credits with tx hash
- `GET /api/external/credits/balance` — check credit balance
- `POST /api/external/scrape/batch` — batch URL scraping

### Fixed (External Scraping)
- Circular JSON from axios errors (TLSSocket) — now catches and extracts message only
- Plugin instance access — `apiManager.apis.get()` returns wrapper, use `.instance`
- Response returns structured data object instead of raw plugin internals

### Added (Proposals)
- `docs/proposals/monetization-model.md` — SKYNET-native revenue model (no paid tiers)
- `docs/proposals/installation-improvement.md` — frictionless install plan (Docker, simplified .env, web wizard)
- `docs/proposals/credit-system-design.md` — full credit system design document
- `docs/proposals/paid-scraping-service.md` — updated to final design with all 8 services + SKYNET pricing

## [2.20.5] - 2026-03-26

### Added (Moralis Token Scanner)
- Optional Moralis API integration for enhanced token discovery — finds all ERC-20 holdings in one call including airdrops the RPC scanner misses
- `possible_spam` flag from Moralis auto-classifies scam tokens
- Runs as Step 0 in deep scan pipeline (before Explorer API, RPC, receipt scan, balance probe)
- API: `POST /api/crypto/tokens/moralis/api-key`, `GET .../moralis/status`
- Web UI: Moralis API Key input in Wallet Settings on crypto page (stored encrypted in DB)
- Falls back to `MORALIS_API_KEY` env var if no DB key

### Fixed (contractCommands)
- `tokenTransfer` passed `{network}` object instead of `"network"` string to `getTokenInfo` — caused "Unknown network: [object Object]"
- `tokenTransfer` called nonexistent `writeContract` — now uses `getSigner` + direct ethers.js contract call
- Plugin route: nested `params` object now properly unwrapped before passing to plugin execute

### Fixed (Staking History UI)
- "Invalid Date" — reads `tx.date` instead of nonexistent `tx.createdAt`
- "Unknown" type — reads `tx.transactionType` with friendly labels and emoji icons
- Added BscScan transaction links and description display

### Fixed (MindSwarm Auto-Post)
- Post URL now uses `shortId` and `@username` format (`mindswarm.net/@user/shortId`)

### Added (Agent Knowledge)
- Agent system prompt and engagement rules now include `lanagent.net` and `skynettoken.com`
- Features output includes Project Links section with all public URLs

## [2.20.4] - 2026-03-26

### Added (Uncensored AI Provider)
- New AI provider: Uncensored AI (`src/providers/uncensored.js`) — OpenAI-compatible API via axios
- Registered in providerManager, selectable in web UI
- Added `uncensored` to TokenUsage model enum

### Added (MindSwarm Plugin — 130 commands, +33 new)
- **Posts**: `getGifs` (Giphy search), `getBoostedPosts`, `blurReply` + `scheduledAt`/`replyAudience`/`contentWarning` params on createPost, `ai`/`human` feed types
- **Users**: `getBlockedUsers`, `getMutedUsers`, `getUserLikes`, `updateSettings`
- **Messages**: `createGroupConversation`, `reactToMessage`, `deleteMessage`, `getUnreadMessages`
- **Lists**: `updateList`, `deleteList`, `subscribeToList`, `unsubscribeFromList`
- **Support Tickets**: `createTicket`, `getMyTickets`, `getTicket`, `replyToTicket`
- **Developer Apps**: `getApps`, `createApp`, `getApp`, `updateApp`, `regenerateAppKey`
- **Data Export**: `requestDataExport`, `getExportHistory`, `downloadExport`
- **Analytics**: `getAnalyticsDashboard`, `compareAnalytics`, `getAnalyticsInsights`, `exportAnalytics`, `trackEvent`
- **Ads**: `trackAdEvent`

### Added (PR Review — 4 PRs, all implemented manually)
- #1819 resourceManager: resource usage prediction (fixed div-by-zero)
- #1820 UpsConfig: status caching with redundant-write skipping (fixed return types)
- #1821 LPPosition: cached getActivePositions with retry (added cache invalidation)
- #1822 sanitizer: SSN + credit card PII detection (fixed overly broad CC regex)

## [2.20.3] - 2026-03-25

### Added (MindSwarm Plugin)
- **Multi-post auto-posting** — 1-3 posts/day (configurable `maxAutoPostsPerDay`), 4-hour minimum gap, PST timezone
- **Rich post context** — draws from real agent activity: recent git commits, scam detections, services offered, self-modification PRs, plugin count, P2P federation, uptime milestones
- **Topic deduplication** — fetches recent posts to avoid repeating topics
- **Service promotion** — agent can mention its offered services (scraping, image gen, code execution)
- **Following tab default** — Following feed tab now first and default in web UI
- **Auth fallback** — 401 handler tries token refresh, then falls back to full re-login with saved credentials

### Fixed (MindSwarm Plugin)
- **Banner width** — banner image now spans full card width (`calc(100% + 3rem)` with `-1.5rem` negative margin)
- **Engagement loop** — moved from unreliable `setInterval` to Agenda scheduler for reliable execution across restarts

### Fixed (Crypto)
- **Daily report P&L** — now includes both dollar_maximizer AND token trader P&L with per-token breakdown
- **Web UI P&L** — `totalPnL` in getStatus() combines DM + token trader instead of showing DM-only

### Added (PR Review — 13 PRs: 2 merged, 6 implemented manually, 5 closed)
- **DCA risk tolerance** (#1808) — risk-adjusted buy amounts using volatility index (merged)
- **Custom indicator registration** (#1815) — safe duplicate-checked `registerCustomIndicator()` wrapper (merged)
- **Scammer registry rate limiting** (#1814) — `express-rate-limit` on registry API endpoints
- **TokenUsage error handling** (#1811) — try/catch on 4 unprotected aggregation methods

### Added (Other)
- **Scraping service proposal** — `docs/proposals/paid-scraping-service.md` for SKYNET-paid web scraping via `scrape.lanagent.net`

## [2.20.2] - 2026-03-24

### Fixed (Token Trader)
- **5th token not persisting** — configure endpoint now calls `persistRegistryState()` immediately so new tokens survive PM2 restarts
- **Exit endpoint persistence** — exit also persists so removed tokens don't reappear
- **Reconfigure wipes position** — `configure()` no longer resets position/P&L when reconfiguring the same token (only resets on token switch)

### Added (Staking)
- **Auto-claim rewards** — CryptoStrategyAgent heartbeat claims staking rewards every 6 hours when above 1,000 SKYNET threshold
- **Staking history tracking** — claims, fund events, and fee routing logged to HistoricalTransaction model. History endpoint now queries actual data instead of nonexistent revenueService method
- **Manual claim tracking** — POST /api/staking/claim records claimed amount to historical transactions

### Added (MindSwarm Plugin)
- **Daily auto-post** — agent posts once per day (9am-9pm UTC) about non-sensitive recent activity (scam registry, staking, uptime, trading, P2P, tech topics). AI-composed, respects engagement rules
- **Telegram notification** — owner receives Telegram message with post content and direct link (`mindswarm.net/{username}/{postId}`)
- **Agenda-driven engagement** — engagement loop moved from unreliable `setInterval` to Agenda scheduler (every 5 min, MongoDB-backed, survives restarts)
- **Engagement reinit safety** — `initialize()` stops stale engagement intervals before starting fresh

### Fixed (MindSwarm Plugin)
- **PluginSettings import** — `_dailyAutoPost` used wrong dynamic import (`default` instead of named export). Now uses top-level import

### Added (Fee Routing)
- **Staking fund history** — fee-to-staking routing now logs to HistoricalTransaction for staking history dashboard

## [2.20.1] - 2026-03-23

### Added (Merged PRs — AI-generated, reviewed and approved)
- **SignalWire batch messaging** (`signalwire.js`) — send multiple messages in a single API call
- **HuggingFace text summarization** (`huggingface.js`) — new `textSummarization` action
- **MCP tool parallel registration** (`mcpToolRegistry.js`) — `Promise.all` instead of sequential loop
- **SkynetTokenLedger audit logging** (`SkynetTokenLedger.js`) — historical transaction tracking with HistoricalTransaction model
- **Hardhat API rate limiting** (`hardhat.js`) — rate limiter on API routes using existing express-rate-limit
- **GitHostingProvider branch protection** (`GitHostingProvider.js`) — abstract method stubs for create/update/delete
- **AgenticCommerceJob priority** (`AgenticCommerceJob.js`) — priority field with enum validation and sorted queries
- **StatusCake bulk operations** (`statuscake.js`) — bulk pause/resume/delete via Promise.all
- **UserPreference rollback** (`UserPreference.js`) — rollback to previous preference using existing history model
- **DiscoveredFeature aggregation** (`DiscoveredFeature.js`) — optimized queries with MongoDB aggregate pipelines
- **Vonage message tracking** (`vonage.js`) — message status tracking via Search API
- **Google Cloud Functions triggers** (`googlecloudfunctions.js`) — trigger management following existing patterns
- **CryptoWallet transaction analysis** (`CryptoWallet.js`) — read-only transaction analysis method
- **DeviceGroup cached aggregation** (`DeviceGroup.js`) — cached `aggregateDeviceGroups` with retry

### Fixed (MindSwarm Web UI)
- **Plugin page script execution** — escaped quotes in onclick handlers broke when main app re-executed scripts via textContent/appendChild. Replaced with data-attributes
- **Profile images** — proxied through LANAgent (`/api/mindswarm/img`) to avoid CORS/auth issues. Query token auth for img tags
- **Tab switching** — `event.currentTarget` doesn't work in dynamically injected scripts, now uses explicit `this` param
- **Feed filter buttons** — Algorithm/Following swap highlight on click
- **Mobile layout** — tabs wrap into grid (3-per-row/2-per-row), inputs stack full-width
- **MindSwarm info intent** — "What is MindSwarm?" no longer routes to engagement config

### Added (MindSwarm Plugin — 91 commands total)
- **Lists** — `createList`, `getLists`, `getListTimeline`, `addToList`, `removeFromList`
- **Drafts** — `saveDraft`, `getDrafts`, `publishDraft`, `deleteDraft`
- **Block/Mute** — `blockUser`, `unblockUser`, `muteUser`, `unmuteUser`
- **Groups (extended)** — `createGroup`, `getGroupMembers`, `getMyGroups`
- **Search (extended)** — `searchHashtags`
- **Analytics** — `getAnalytics`, `getPostAnalytics`
- **Media** — `uploadMedia` (separate upload before posting)
- **Boost** — `boostPost` (crypto-paid content promotion)
- **Moderation** — `reportContent`, `getModQueue`, `reviewReport`, `issueWarning`, `banUser`, `liftBan`, `getModStats`, `getUserWarnings`, `getBanStatus`. Graceful 403 handling for non-moderator instances

### PR Review (53 PRs reviewed)
- 14 merged (clean implementations, real value, no breaking changes)
- 28 closed (runtime crashes, dead code, breaking changes, bad API usage, architecture violations)
- Each PR received a detailed comment explaining the decision

## [2.20.0] - 2026-03-22

### Added
- **MindSwarm Social Network Plugin** (`src/api/plugins/mindswarm.js`) — Full integration with the MindSwarm social platform. 61 commands across 11 categories. The agent autonomously registers, logs in, posts, replies, and engages on MindSwarm as itself.
  - **Autonomous engagement loop** — polls notifications every 5 min, auto-replies to replies using AI, auto-follows back, auto-likes mentions. Configurable and persistent across restarts
  - **Auto-registration** — derives email from `EMAIL_USER`, username from `AGENT_NAME`, generates deterministic password. No manual setup needed
  - **Auto-profile setup** — after registration, sets display name, AI-generated bio, uploads agent's VRM bust avatar and banner from `data/agent/`
  - **Email verification via IMAP** — requests verification email, reads it from agent's inbox, extracts token, completes verification automatically
  - 61 commands: auth (login, register, logout, configure), posts (create, feed, get, replies, reply, edit, delete, like, repost, save, vote), users (profile, update, follow, unfollow, followers, following, change username, change email), groups (search, join, leave, post), tipping (send, history, stats, supported tokens, tips on post, verify, status, crypto addresses), DMs (conversations, send, get, start), notifications (get, unread, mark read), search (posts, users, trending, suggested), referrals (code, stats), account (getMe, check availability, user posts, edit history, saved posts, pin post, social links, upload avatar, upload banner, verify email, resend verification), engagement config, status
  - Multi-instance safe: configurable `MINDSWARM_API_URL`, no hardcoded agent names or URLs, per-instance credentials/tokens/processed notifications
  - Encrypted credential storage via PluginSettings (DB-first, env var fallback)
  - Auto token refresh on 401 (fires once per request, not per retry)
  - All API calls wrapped in `retryOperation` (3 retries, exponential backoff 1s-8s)
  - Session logout on cleanup (frees MindSwarm's 3-session limit)
  - In-memory feed/notification cache (60s TTL), processed notification IDs persisted to DB
  - AI parameter extraction with action-specific prompts for NL commands
  - Web UI dashboard with 7 tabs: Feed, Compose, Notifications, Search, Trending, Profile, Settings
  - 10 REST routes for direct UI interaction
  - All posts marked `isAiGenerated: true` for platform transparency
  - **AI-driven engagement decisions** — all interactions use AI analysis instead of blind auto-actions. Replies: AI decides like/reply/both/ignore. Mentions/quotes: sentiment analysis before reacting. Follows: profile check before following back
  - **DM auto-reply** — reads DMs via conversation API, generates contextual AI replies with conversation history. Intent classification (friendly/hostile/spam/phishing) with appropriate responses. Daily limit of 5 DM replies to prevent token abuse
  - **18 notification types** — handles reply, like, follow, follow_request, follow_accepted, mention, quote, repost, dm, tip_received, tip_verified, group_invite, group_mention, group_role_change, group_post, poll_ended, badge_granted, warning
  - **Financial deflection** — refuses to discuss wallet addresses, trading positions, P&L, or financial activity. Promotes Skynet project (token address, hub contract, staking, scammer registry) when relevant
  - **Token abuse protection** — AI output capped at 120-150 tokens, responses truncated at 280-500 chars, user input capped at 500 chars, daily DM limit

### Fixed
- **Crypto daily P&L** — daily P&L now reads from DailyPnL collection (was always $0). Token trader sell results include `gain` field for `recordTrade()`. Gas costs tracked in DailyPnL (was hardcoded $0). Telegram daily report shows real data
- **Post reply scanning** — engagement loop scans recent posts for unreplied replies (MindSwarm doesn't always send reply-type notifications)
- **P2P encrypted messaging after peer restart** — Buffer vs String key comparison always failed for known peers. Fixed TOFU re-keying, session key invalidation, and auto re-introduction on encrypted send failure. Peers can now restart without breaking encrypted communications
- **ENS subname creation** — `setAddr` on PublicResolver reverted because subname was owned by the requesting peer (not genesis). Fixed: genesis creates subname as self, sets address record, then transfers ownership. Steps 2-3 are non-blocking so the P2P response returns immediately
- **`/api/crypto/send` endpoint** — was a Phase 1 stub that logged but didn't send. Now performs real ERC-20 token transfers and native sends on any supported chain
- **Email lease payment fallbacks** — `recipientWallet` and `tokenAddress` fell through to null when `skynetServiceExecutor` couldn't resolve them. Added fallback to `contractService.getSigner()` and hardcoded SKYNET token address
- **P2P capability race condition** — capabilities re-broadcast to all online peers 60s after init (ENS/email services may not be ready during initial introductions)
- **P2P service reference** — agent handler looks for `p2pFederation` (correct registered name) instead of `p2p`
- **Skynet badge tokens whitelisted** — SENTINEL and SCAMTOKEN soulbound badges added to token scanner safe list. Scanner was logging swap errors trying to sell non-tradeable soulbound badges
- **TokenTrader gas buffer** — native buy path now reserves 0.005 BNB for gas before swapping. Was spending entire native balance on the swap, leaving nothing for gas (INSUFFICIENT_FUNDS errors)
- **MindSwarm "What is MindSwarm?" misroute** — general questions about MindSwarm routed to engagement config instead of AI. Added `mindswarmInfo` intent (plugin:null) to route to conversational AI answer
- **MindSwarm NLP post content extraction** — vector detector passes `fromAI` + `_context.originalInput` but plugin only checked `needsParameterExtraction`. Now checks both paths
- **MindSwarm bare topic posts** — NLP posts like "post about automation" dumped raw text. Now AI composes a proper social media post with opinion and hashtags when content looks like a topic

### Added (MindSwarm)
- **AI-composed posts** — topics given via NLP are composed into natural social media posts by AI
- **Thread context for replies** — engagement loop fetches full thread (original post + all replies) before deciding how to respond
- **Conversational context tracking** — in-memory buffer (10 messages, 30-min expiry) detects follow-up messages and routes them to AI with conversation history instead of re-triggering intent detection
- **Username convention** — registration derives username as `agentname_lanagent`, auto-increments if taken
- **Referral link in engagement rules** — cached on login, AI shares it naturally when relevant

### Added (P2P Services)
- **Email lease intent + handler** — `emailLeaseRequest` and `emailLeaseStatus` intents with NLP examples. Full handler in agent.js with user instructions for SKYNET funding (token address, hub address, how to acquire)
- **Email lease env config** — `EMAIL_LEASE_ENABLED`, `MAIL_API_URL`, `MAIL_API_SECRET` added to `.env.example` and production
- **SKYNET payment verification** — on-chain verification of SKYNET BEP-20 transfers: double-spend check, 3+ confirmations, Transfer event parsing, recipient/amount validation, payment recording in `SkynetPayment` collection

### Tested (P2P End-to-End)
- Email lease: BETA → ALICE, free + paid (1 SKYNET auto-pay on BSC mainnet), account created via mail API
- ENS subname: `beta.lanagent.eth` created on Ethereum mainnet (tx `0x407094e...`)
- P2P key exchange: bidirectional encrypted messaging survives peer restarts
- Capability discovery: ALICE advertises `ens_provider` + `email_provider`, BETA receives both
- Total test cost: ~$3 (ETH gas + BSC gas), 1 SKYNET transferred (BETA → ALICE)

## [2.19.2] - 2026-03-21

### Added
- **P2P Auto-Introduction Protocol** — New peers automatically exchange public keys via cleartext introduction messages through the registry relay. Eliminates manual peer introduction — tested between ALICE and BETA instances with automatic discovery
- **Token Balance API** — `GET /api/crypto/token-balance?token=&network=` returns ERC-20 balance for agent wallet
- **SKYNET Balance in Web UI** — Balance list now shows SKYNET holdings alongside native/stablecoin balances
- **SKYNET Balance in Telegram Report** — Positions line includes SKYNET token count
- **Separated Crypto Counters** — Daily report and status API now show dollar\_maximizer and token trader stats independently (trades, P&L)
- **Telegram Interface Gating** — Agent no longer crashes when `TELEGRAM_BOT_TOKEN` is missing; skips Telegram init gracefully (enables headless/BETA instances)

### Fixed
- **Polygon RPC** — Removed dead `polygon.llamarpc.com` (ENOTFOUND every 10min since v2.19.1)
- **Trade Counter Inflation** — Token trader trades were inflating dollar\_maximizer's global counters (9,700+ shown as primary, actually 0 executed). Counters now tracked separately per strategy
- **Token Trader P&L** — Now computed from actual instance data (lifetimeRealizedPnL - gasCost) instead of broken accumulator that showed $0.0004 instead of real ~-$70
- **Telegram Report Markdown** — Underscore in `dollar_maximizer` was parsed as italic by Telegram; now escaped
- **DollarMaximizer Thresholds** — Downtrend multiplier reduced (1.75→1.35), strong\_downtrend (2.5→1.75). Idle capital easing starts at 3 days (was 7), max 60% (was 50%), ramps over 14 days (was 21)
- **ScammerRegistry getReport** — Missing `targetType` in return destructuring caused all fields after category to shift. Now returns `targetType` and `targetTypeName`
- **ScammerRegistry getStats** — Now includes `totalFeesRoutedToStaking` and badge contract addresses from Hub
- **Auto-Epoch Renewal** — Verified working with 24h epochs on SkynetHub. Scheduler funds new epoch from ledger when `timeUntilEnd < 1 day`

### BETA Test Results
- Successfully ran two instances (ALICE port 80, BETA port 8180) on same server
- P2P auto-discovery confirmed working — both agents found each other automatically
- Required: separate DB, `PM2_PROCESS` name, `ENABLE_MQTT=false`, `TELEGRAM_ENABLED=false`, fork mode PM2
- BETA instance shut down after testing; configuration preserved at `/root/lanagent-instance2/`

## [2.19.1] - 2026-03-20

### Added
- **BitNet LLM Controls** — Start/stop/status on AI Providers page (no SSH needed)
- **Multi-Instance Support** — Branch naming namespaced by agent name, dynamic repo resolution
- **BETA Instance** — Second instance configured at /root/lanagent-instance2 (port 8180)

### Fixed
- **Plugin Log Dropdown** — Frontend now renders plugin category (41 per-plugin logs visible)
- **Token Whitelist** — All Skynet ecosystem tokens added (SKYNET, Hub, badges, decommissioned contracts)
- **Polygon RPC** — Removed dead polygon-rpc.com (401 tenant disabled)
- **Git Branch Naming** — Branches include agent name to prevent multi-instance collisions
- **Hardcoded Repo Refs** — 4 locations replaced with dynamic git remote resolution
- **PR Reviewer** — Enabled by default for fork instances
- **Upstream Contributions** — Enabled by default (set UPSTREAM_CONTRIBUTIONS=false to disable)
- **Installer** — UPSTREAM_REPO always written to .env, vector intent enabled by default

## [2.19.0] - 2026-03-20

### Added
- **SkynetHub** — Unified on-chain contract combining staking, scammer registry, and soulbound badges
  - Synthetix-style staking with fully adjustable rate, duration, and epoch control
  - Scammer report fees (50K SKYNET) route directly to staking reward pool
  - Three soulbound ERC-20 badge tokens: SCAMMER (wallets), SCAMTOKEN (contracts), SENTINEL (reporters)
  - ERC-1155 internal credentials for future types (bounty proofs, trust attestations)
  - Lock tiers with reward multipliers (No lock 1x, 30d 1.5x, 90d 2x, 180d 3x — all adjustable)
  - P2P fee deposit support (5% adjustable to staking)
  - Token migration support (setStakingToken for future token replacement)
  - Pause, recovery, emergency withdraw, approved depositors
  - batchImport for registry migration (83 scammers imported from V1)
- **SkynetBadge** — Distinct soulbound ERC-20 for Skynet Trust System visibility on BscScan
- **Web UI: Skynet Hub Dashboard** — Lock tier selector, multiplier display, lock status, effective stake, scammer count, fees routed to staking
- **Staking API: /api/staking/tiers** — Lock tier query endpoint
- **Staking API: tierId param** — Stake with lock tier via POST /api/staking/stake

### Fixed
- **Swap Sanity Check** — Output sanity check converts to USD before comparing (was comparing raw BNB against USD)
- **Memory isPermanent** — Root field now synced from metadata on store
- **Memory Junk** — Preference regex tightened, AI filter unblocked for question-word messages
- **Memory Recall** — Personal questions recall from memory before intent routing
- **Staking V1 phantom totalStaked** — Investigated, decommissioned, redeployed as V2 then Hub
- **Scammer cache sync** — Smaller batches (5) with RPC fallback and delays
- **Staking epoch scheduler** — Changed from weekly to daily to catch mid-week expiries

### Changed
- Staking contract: V1 → V2 → SkynetHub (unified)
- Scammer Registry: V1 → SkynetHub (unified, with targetType: wallet vs contract)
- Default registry address updated to Hub
- Soulbound tokens: generic SoulboundToken → SkynetBadge with distinct names
- 18 junk/duplicate memories cleaned from production
- LanceDB vector index rebuilt (130 stale → 48 clean)

### Deployed Contracts
- SkynetHub: `0x72f2E5b2FfA9A391e0c4BEFD9C61A909F6AE099C`
- SCAMMER badge: `0x7D5a345B25163EDcFdcE16b08D0fddd19263Dd72`
- SCAMTOKEN badge: `0xB752e44E1E67E657Cf0553993B4552644ce2C352`
- SENTINEL badge: `0xAE1908C7d64562732A25E7B55980556514d46C35`

### Decommissioned
- SkynetStaking V1 (`0x9205b5E1...`) — phantom totalStaked bug, 4.9M SKYNET locked
- SkynetStaking V2 (`0x8A3c9872...`) — interim, replaced by Hub
- ScammerRegistry V1 (`0xEa68dad9...`) — replaced by Hub
- SkynetHub V1 (`0x0b9271fB...`) — ERC-1155 mint revert on contract addresses, replaced


## [2.18.1] - 2026-03-20

### Fixed
- **Swap Sanity Check** — Output sanity check was comparing raw token amounts (e.g. 0.078 BNB) against expected USD values ($50), causing false failures on stablecoin→native swaps. Added `outputTokenPriceUsd` option to convert output to USD before comparing. Gas top-up and native buy swaps now pass correctly.
- **Memory `isPermanent` Mismatch** — `metadata.isPermanent` was never synced to root-level `isPermanent` field. Cleanup logic checked the root field, so memories marked permanent via metadata could theoretically be deleted. Fixed: `store()` now copies metadata flag to root level. Patched 66 existing documents.
- **Memory Junk Storage** — Preference regex matched questions ("what do I like to eat?") as preferences. Tightened pattern to require statement form at sentence start. AI memory filter was skipping all question-word messages ("what/who/how/why") — removed question words from the skip list so the AI can evaluate personal info in question-style messages.
- **Memory Not Recalled for Personal Questions** — "What is my name?" routed to song identification, "favorite color?" to smart home, because intent detection ran before memory recall. Added early personal-question detector that checks memory before intent routing.

### Changed
- Removed 18 junk/duplicate memories from production database (questions stored as preferences, duplicate contacts, one-time commands stored as instructions)
- Rebuilt LanceDB vector index from 130 stale entries to 48 clean knowledge memories

## [2.18.0] - 2026-03-19

### Added
- **Dance Mode** — Playground dance activity with avatar animation cycling (ballet, hip hop, samba) and fallback animations
- **Music Player (Playground)** — Play/pause, prev/next, shuffle, volume controls, progress tracking while avatar dances
- **Music Player (Web UI)** — Dedicated Music page with full player, audio visualizer, search/filter, folder navigation
- **Music Library System** — Configurable music source (local dir, NAS/SMB mount, SSH remote, HTTP URL)
  - SMB URL support (`smb://server/share/path`) with auto-mount
  - Auto-remount on agent restart
  - Browse Local, Samba Mounts, and SSH Remote directory browsers
  - Paginated folder-by-folder navigation for large libraries
  - NL search: "do I have any Beatles in my music?"
  - NL download: "save Bohemian Rhapsody to my music library"
  - API: `/api/music-library/search`, `/api/music-library/save`, `/api/music-library/browse`, `/api/music-library/stream/*`
- **Backup Strategy v2** — Complete overhaul of backup plugin
  - Automated daily backups via Agenda scheduler (1 AM default, configurable)
  - Backup history persisted in MongoDB
  - Dynamic web UI page (Backups tab) with status cards, config panel, history table
  - Configurable primary, secondary, and offsite backup locations
  - AES-256-CBC encryption using BACKUP_ENCRYPTION_KEY env var
  - Real SHA-256 checksum verification + tar integrity test
  - Max backup limit (default 10) with auto-cleanup
- **Mobile Webcam Mirror Mode** — Phone front/rear camera support with camera flip button, adaptive resolution, lite pose model on mobile
- **VR Music Controls** — Play/Pause, Next Track, Dance Mode buttons in VR floating menu
- **Per-Plugin Logs in Web UI** — 104 individual plugin log files now visible in Logs dropdown

### Fixed
- **Intent Detection** — "Alice?" no longer triggers restart (system plugin threshold raised to 0.6, dangerous actions require 0.7)
- **RPC Batching** — Disabled ethers.js JSON-RPC batching on all providers (BSC public RPCs return null IDs in rate-limit responses)
- **Dry-AI Intent** — "Add to space" no longer creates new space (disambiguation for add-to-space vs create-space)
- **Telegram Markdown** — Falls back to plain text when Telegram rejects malformed markdown
- **Log Viewer** — Rotated files no longer clutter the dropdown (Winston file1.log naming pattern)
- **Mobile UX** — Touch scroll no longer triggers folder clicks, seek slider uses native range input

### Changed
- Music Library setting moved from Settings page to dedicated Music page
- Backup plugin uses dynamic plugin UI system (auto-registers nav tab)


## [2.17.2] - 2026-03-18

### Added
- **Deploy script safeguards** — `deploy-files.sh` and `deploy-quick.sh` now block deployment of 0-byte files and JS files with syntax errors, preventing production outages from empty file deploys
- **Shazam getSongDetails command** — fetch detailed song metadata by Shazam track ID using the correct `track_info` API (title, artist, genre, album, cover, Shazam link) with caching
- **Hardhat API caching** — 5-minute NodeCache on GET `/projects`, `/projects/:name`, `/templates` with proper invalidation on all mutating POST routes
- **WebLoader URL caching** — module-level NodeCache (1-hour TTL) for RAG web document fetches, avoiding redundant HTTP requests for the same URL
- **Skynet partial unstaking** — `unstakePercentage(percentage)` method for percentage-based unstaking (1-100%), complements existing fixed-amount unstake
- **MCP token configurable usage threshold** — per-token `usageThreshold` field replaces hardcoded 1000 limit
- **ContractABI extended query filters** — `findByMetadata` now supports `deploymentTx`, `deployer`, and `blockNumber` filters
- **Accounts API rate limiting** — 100 req/15min per IP, consistent with other API routes

### Fixed
- **Crypto trading system offline** — `CryptoStrategyAgent.js` was deployed as 0-byte empty file on Mar 17, taking all 4 token traders (BANANA, RIVER, BTW, SIREN) offline for ~16 hours. Positions were safe in MongoDB; restored by redeploying intact file

### Changed
- Reviewed 26 AI-generated PRs: merged 4, manually implemented 3 (Shazam getSongDetails, Hardhat caching, WebLoader caching), closed 19 with detailed feedback

## [2.17.1] - 2026-03-17

### Fixed
- **Auto-sell honeypot detection** — reverted swap transactions were incorrectly reported as successful
  - `autoSellUnknownToken` checked only `swapResult?.hash` instead of also checking `swapResult.success`
  - Reverted on-chain transactions (status=0) still have a hash, causing false success notifications
  - Now checks `swapResult.success !== false` before reporting success and sending Telegram notifications
  - Reverted transactions are treated as honeypot indicators and fall through to retry/skip logic
- **Vector intent threshold for high-confusion plugins** — Dry.AI CRUD actions (create/update/delete/list) now use 0.65 similarity threshold instead of 0.5 to reduce misrouting between similar operations
- **Dry.AI destructive action safety net** — delete-intent keywords in user input now override vector similarity when matched to a non-delete action, preventing accidental creates/updates when user meant delete

### Changed
- Dry.AI intent examples expanded across 10+ actions (register, verify, createType, createAppSpace, createFolder, bulkAddItems, listSpaces, listItems, bulkUpdate, etc.) for better vector matching accuracy
- VRM manifest: removed cascade and sentinel models

## [2.17.0] - 2026-03-16

### Added
- **Playground** — New interactive 3D page for user-agent interaction
  - Activities system: Free Play (chat), Emote Studio, Mirror Mode
  - Chat with agent in 3D — responses trigger random animations
  - Mirror Mode: VR headset/controller tracking mirrors your movements onto avatar, webcam fallback
  - VR floating menu: press B/Y to open, point-and-click animations & expressions
  - Collapsible side panel for mobile responsive layout
  - Agent status bar with name from API
  - Scale/position controls for agent model
- **VRM avatar persistence** — Active model saved in MongoDB (`Agent.activeVRMModel`)
  - `GET /api/agent/vrm` — public endpoint returns active VRM model ID
  - `PUT /api/agent/vrm` — set active model (persists across browsers/devices)
- **"Update Agent Avatar Everywhere" button** — renders bust portrait and pushes to:
  - Agent profile image (`/api/agent/avatar`)
  - Gravatar (via API sync)
  - Telegram bot (sends photo with BotFather instructions)
  - ERC-8004 on-chain NFT (re-uploads to IPFS, updates `setAgentURI`)
- **Telegram file & photo handlers** — bot now receives documents and images
  - Downloads via `getFileLink`, stores as base64
  - Files persist 5 minutes, auto-attach to next NL command
  - Caption on file = auto-processes as command with file attached
- **49 VRMA animations** from VRoid Hub, vrm-studio, DavinciDreams
  - Categories: idle, dance, gestures, emotions, activities
  - Avatar designer loads 10 core, playground loads 21
- **4 new VRM models** (Fdl, Actor8, Miku, Nekomaid) + Cyber, Smg — total 10 models
- **VRM Avatar Guide** (`docs/VRM_AVATAR_GUIDE.md`) + inspect tool (`scripts/inspect-vrm.py`)
- **Dry.AI plugin improvements**
  - `uploadFile`, `regeneratePage`, `modifyPage` commands
  - All handlers use `_context.originalInput` fallback for NLP parameter extraction
  - Graceful error returns instead of throws for all 14+ handlers
  - Space name resolution for delete and share operations
  - App space invite retry with 15s delay + hidden error detection

### Fixed
- VRM model orientation — removed incorrect PI rotation so model faces camera
- T-pose flash — model hidden until idle animation loads and ticks
- Double model load on page init (race between switchTab and loadVRMManifest)
- 2D gravatar overlay showing over VRM model on load
- Event listener leak in playAnimation one-shot handler
- Telegram bot launch timeout — set `isRunning=true` after validation, not after long-polling resolves
- Telegram document handler markdown parsing error (underscores in filenames)
- Email `findContact` handles self-referential queries (me/my → owner, your/alice → agent)
- Dry.AI `shareItem` no longer silently picks wrong space when name doesn't match
- Dry.AI `deleteItem` resolves space by name from original input
- Dry.AI `createAppSpace` detects hidden `data.error` in success response
- Playground chat response parsing (`data.data.content` not `data.result`)
- Playground token key matches main dashboard (`lanagent_token`)
- Log file binary data corruption causing grep to skip results
- Nav order: Playground before Plugin Development (alphabetical)

## [2.16.0] - 2026-03-14

### Added
- **CoW Protocol (CoW Swap) integration** — Intent-based DEX aggregator for Ethereum, Base, and Arbitrum swaps
  - `getCowQuote()` — Fetches aggregated quotes from CoW Protocol API (no API key needed)
  - `executeCowSwap()` — Signs EIP-712 orders and submits to CoW order book for solver execution
  - `ensureCowApproval()` — Handles token approval to CoW VaultRelayer contract
  - Competes in 5-way price comparison: V2, V3, V4, CoW, 1inch — best price wins
  - MEV/sandwich attack protection via batch auctions
  - Urgent sells (stop-loss, trailing stop, emergency) skip CoW for instant on-chain execution
  - $10 minimum order value filter — solvers won't fill orders below gas cost threshold
  - Successfully sold BKN ($49) and FHE ($49) tokens that had no Uniswap V2/V3 liquidity
- **3D visualization click info cards** — Click any node in all 5 Three.js visualizations to show a detailed info panel
  - Network Topology: IP, MAC, vendor, OS, ports, ping, trust level
  - Agent Brain: service type, status, connections
  - Crypto Token Space: value, balance, price, 24h change, volatility
  - Wallet Graph: address, tx count, total value, networks, scammer warnings
  - Trust Graph: trust level, scopes, sources, relationships
  - Uses pointerdown/pointerup tracking to distinguish clicks from OrbitControls drag
- **P2P Network visualization** — New tab showing agent at center with federation peers as orbiting nodes
- **Email Contacts visualization** — New tab showing agent email at center with contacts from sent+received history
- **Plugin Constellation visualization** — New tab showing 93 plugins grouped by category, sized by command count
- **Avatar auto-rigging** — Blender headless integration for adding humanoid skeletons to 3D avatar models
  - `POST /api/avatar/:avatarId/rig` — Triggers auto-rigging via Blender subprocess
  - `scripts/blender-autorig.py` — Creates 19-bone humanoid armature with automatic weight painting
  - "Auto-Rig" button in avatar designer Actions tab
- **Avatar rename and delete** — Gallery management for avatar models
  - `PUT /api/avatar/:avatarId/rename` — Rename avatars (max 100 chars)
  - `DELETE /api/avatar/:avatarId` — Delete avatar with all associated files
  - Pen and trash icons on each gallery item
- **WebXR VR mode with full controller interactions** — All Three.js visualizations and avatar designer
  - "Enter VR" button auto-shown when WebXR headset detected
  - Grip + trigger to grab and drag the scene; two-grip to scale and rotate
  - Trigger to select/click nodes (shows info cards)
  - Left thumbstick for smooth locomotion (requires trigger held)
  - Right thumbstick for 30-degree snap turns (requires trigger held)
  - 3D info cards rendered as canvas texture sprites — visible inside headset
  - Memory cards show full content, category, importance, tags
  - Plugin cards show commands list, version, status, description
  - Hover highlighting: ray turns green, nodes glow on point
  - Valve Index pressure-sensitive grip handled (requires trigger+grip combo)
  - Shared `vr-controls.js` utility — one implementation for all 9 visualizations + avatar

- **VRM animated avatar system** — Interactive 3D avatars with motion-captured animations
  - 6 bundled VRM models (VRM 0.x and 1.0) from VRoid Hub
  - VRMA animation retargeting — loads VRoid Hub motion-captured animations and retargets to any VRM model
  - Idle animation with natural body movement, periodic blinking, breathing
  - Facial expressions: dynamically built from each model's presets (happy, angry, sad, relaxed, etc.)
  - Eye tracking: avatar eyes follow mouse cursor or VR headset position
  - Spring bone physics for hair and clothing movement
  - Lip sync via Web Audio FFT → VRM visemes (aa, oh, ee, ih, ou), works with agent TTS
  - Upload custom VRM files from VRoid Studio or VRoid Hub
  - Model attribution display for credited models
  - Three.js upgraded r128 → r140, self-hosted in `public/lib/` (no CDN dependency)
  - `@pixiv/three-vrm` v1.0 for VRM loading (supports both VRM 0.x and 1.0 formats)
- **Memory system cleanup** — Removed 20,998 junk memories, only stores learnable knowledge now
  - Conversations no longer stored as raw memories (was 13K+ junk entries)
  - Scheduler no longer stores hourly heap dumps (was 2K+ entries)
  - Query intent now recalls relevant knowledge memories for AI context
- **BitNet provider** — Local CPU-only 1-bit LLM inference via Microsoft's BitNet.cpp
  - Runs 1.58-bit quantized models entirely on CPU — zero API cost, no GPU required
  - OpenAI-compatible API via llama.cpp server (`/v1/chat/completions`, streaming)
  - Registers even when server is offline — always visible in Web UI and Telegram
  - Auto-reconnect: checks server health on first request if previously offline
  - Model selector: BitNet b1.58 2B-4T, Large 0.7B, Llama3 8B 1.58-bit
  - Token usage tracking and monitoring with configurable thresholds
  - Config: `ENABLE_BITNET`, `BITNET_BASE_URL`, `BITNET_CHAT_MODEL`

### Changed
- **P2P federation enabled by default** — New installs have P2P on (opt-out with `P2P_ENABLED=false`)
- **Email API pagination** — `/api/emails` now accepts `limit` (up to 1000) and `skip` query params instead of hardcoded 100
- **1inch API gated** — 1inch calls now require `ONEINCH_API_KEY` env var (prevents wasted 401 requests on free tier)
- **Visualization cache busting** — Script loading adds timestamp query param so updates take effect without hard refresh

### Fixed
- **AI provider not persisting across restarts** — `switchProvider` saved to wrong Agent document (`updateOne({})` with no filter hit "LANAgent" instead of "ALICE"). Now filters by `AGENT_NAME`
- **Dry.AI shareItem missing itemId** — When user says "share a space with me" without an ID, now auto-searches spaces by name or uses most recent. Also auto-uses owner email for invite
- **Dry.AI owner auto-invite** — New `setOwnerEmail` action stores user's email; `createAppSpace` and `createSpace` auto-invite owner as admin after creation
- **Avatar 3D generation JSON parsing** — Gradio/HuggingFace `"Loaded as ..."` stdout messages no longer corrupt JSON output
- **Avatar model visibility** — Clamped metalness/roughness, forced doubleSide, added fallback color for HF-generated models
- **Avatar auth for viewer/export** — Model and export endpoints accept `?token=` query param for img tags and GLTFLoader
- **Avatar GLB export** — Export button now fetches with auth token instead of opening unauthorized window
- **Self-modification pipeline fully unblocked** — Multiple issues preventing PRs from being created:
  - `analysisOnly` was `true` in DB (DB conflict) — set to `false`
  - FeatureRequest status `'approved'` not a valid enum — changed to `'planned'`
  - Hardcoded `allowedTypes` filter ignored DB config — now uses `config.allowedUpgrades`
  - `applyImprovement()` switch missing `github_discovered_feature` and `feature_request` cases
  - AI file discovery added for features without a target file
  - Misleading `"(DISABLED)"` log message now shows actual state

## [2.15.13] - 2026-03-13

### Changed
- **Dry.AI plugin rewrite** — Complete rewrite of the `dry-ai` plugin removing all AI service dependencies
  - Removed `_queryWithMCP`, `DRY_AI_SYSTEM_PROMPT`, and AI service config (`aiServiceUrl`, `aiServiceToken`, `mcpServerUrl`) — these required a private s2s key that couldn't work for public multi-instance deployments
  - All 26 operations now use direct Dry.AI REST API endpoints with the user's MCP Bearer token
  - **Auth**: `autoAuth`, `register`, `verify`, `status`, `setToken`, `clearToken`
  - **Create**: `createAppSpace`, `createItem`, `createType`, `createSpace`, `createFolder`, `importItems`
  - **Read**: `listSpaces`, `search`, `listItems`, `getItem`, `help`, `prompt`, `report`
  - **Update**: `updateItem`, `updateItems`, `updateType`, `updateSpace`, `updateFolder`, `shareItem`
  - **Delete**: `deleteItem`, `deleteByQuery`
  - Dynamic version from `package.json` instead of hardcoded `1.0.0`
  - Retry with exponential backoff (3 attempts, 2s × 1.5^n) on transient errors (424, 502-504, 522, ECONNRESET, ETIMEDOUT)
  - `User-Agent: LANAgent/<version>` header on all requests (required by Cloudflare WAF)
  - Flexible parameter handling: accepts `name`/`type`/`title`, `itemId`/`item`
  - Added `scripts/test-dry-ai.sh` — automated test suite covering all 18 testable operations (all passing)

## [2.15.12] - 2026-03-13

### Added
- **Wallet Interactions API** — `GET /api/crypto/interactions` returns wallet counterparty interaction data for the Wallet Graph visualization, sourced from local swap transaction history (tokenIn/tokenOut contract addresses, USD values from USDT swaps)
- **Wallet Graph ENS Name** — dynamic ENS name lookup for the center node using multi-key cascade (`ens.mySubname` → `ens.subnames` → `ens.registered.*`)

### Fixed
- **Avatar 3D Generation** — switched from JS `@gradio/client` to Python `gradio_client` bridge for HuggingFace Space calls. The JS client fails to authenticate with ZeroGPU Pro quotas; the Python client handles it correctly
  - New cascade: Hunyuan3D-2.1 → Hunyuan3D-2 → TRELLIS via `scripts/hf-3d-generate.py`
  - Proper quota-exhaustion error messages with daily reset and Pro upgrade guidance
  - `texture_size` type fix (int → string) for TRELLIS community Space
- **BSCScan API** — migrated from deprecated V1 to V2 endpoint with encrypted API key fallback from PluginSettings
- **Swap transaction counterparties** — fixed local transaction processing to extract `tokenIn`/`tokenOut` as counterparty addresses (previously only checked `tx.to` which is undefined for swaps)

## [2.15.11] - 2026-03-13

### Added
- **P&L History Line Chart** — D3 cumulative P&L line chart in the Crypto P&L Dashboard card with area gradient fill, hover tooltips (cumulative + daily), and configurable time range (7d/30d/90d/1yr)
  - `GET /api/revenue/report/daily-pnl` — new API endpoint returning daily P&L with cumulative totals
  - `DailyPnL` MongoDB model for persistent daily P&L records
  - `scripts/backfill-pnl.js` — log parser that extracts TokenTrader BUY/SELL trades from PM2/app logs, deduplicates, computes daily realized P&L + gas costs, and calibrates cumulative totals against live token trader P&L
  - Automatic live updates: `updateTodayPnL()` runs every 15 minutes, computing today's P&L from yesterday's cumulative baseline + current token trader positions
- **Network Topology Trust Coloring** — device nodes in 3D network visualization colored by trust status: green for trusted, red for untrusted, cyan for self. Self node has pulsing glow rings, bracketed label, and brighter emissive. Tooltip shows trust status and "This Server" badge.

## [2.15.10] - 2026-03-13

### Added
- **Email Lease Service** — P2P email account provisioning via `mail.lanagent.net` (docker-mailserver). Genesis agent (ALICE) provisions `username@lanagent.net` accounts for fork agents, paid in SKYNET tokens.
  - Mail Management API: standalone Express app on mail server (`/opt/mail-api/`) with HMAC-SHA256 signed requests, rate limiting, safe `execFile` for docker commands
  - `EmailLease` MongoDB model: lease tracking with status (pending/active/expired/revoked), payment history, renewal payments, quota management
  - `emailLeaseService.js`: genesis-side lease/renew/revoke handlers, fork-side provider discovery and lease requests, on-chain SKYNET payment verification
  - 5 P2P message handlers: `email_lease_request`, `email_lease_response`, `email_lease_payment_required`, `email_lease_renew`, `email_lease_revoke`
  - `email_provider` capability advertised in P2P capabilities exchange
  - Auto-pay: fork agents automatically pay SKYNET when `email.autoPayLease` is enabled
  - Admin API: 6 endpoints under `/p2p/api/email-leases/` (list, stats, config get/put, revoke, reset-password)
  - Configurable pricing via SystemSettings: lease price, renewal price, duration, quota, max leases per peer
  - Username validation: alphanumeric + dots/hyphens, 3-30 chars, reserved names blocked
  - Credential delivery: passwords generated with `crypto.randomBytes(16)`, delivered via encrypted P2P channel
  - Expired lease cleanup: automatic account deletion when leases expire

## [2.15.9] - 2026-03-13

### Added
- **Avatar Designer page** — Full 3D avatar viewer/designer at `/avatar.html` with Three.js GLB model loading, OrbitControls, wireframe toggle, auto-rotate, ACES filmic tone mapping, 3-point studio lighting, ground grid
  - Gallery tab: browse all created avatars, click to load in 3D viewer
  - Create tab: upload photo or enter text prompt to generate 3D model via TRELLIS
  - Customize tab: expression, outfit, accessories, effects selection
  - Actions tab: export GLB, mint as NFT, view unlockable items
- **Avatar model endpoint** — `GET /api/avatar/:avatarId/model` serves raw GLB binary for Three.js viewer
- **Portfolio API** — `GET /api/crypto/portfolio` returns combined holdings (native tokens, stablecoins, token trader positions) with balances, prices, 24h change, and network info
- **Avatar Designer sidebar link** — accessible from main dashboard sidebar between Visualizations and VPN

### Changed
- **Agent Brain visualization** — now dynamically builds nodes from live `/api/system/status` instead of hardcoded 12-node layout; shows all running services and interfaces with hover tooltips
- **Trust Graph visualization** — parses real `/api/external/trust/admin/graph` attestation data (trustorName/trusteeName/level/scope/source) and converts to nodes+edges; shows "No attestations yet" instead of fake demo data
- **Crypto Token Space visualization** — fetches real portfolio from `/api/crypto/portfolio`; tokens sized by USD value, colored by performance, orbit by volatility; total portfolio value at center

## [2.15.8] - 2026-03-13

### Added
- **ERC protocol dashboard cards** — ERC-8033 Oracle, ERC-8107 Trust Registry, and ERC-8001 Coordination now visible in Web UI crypto page with live status, stats, domain/type tags, and graceful "Not Configured" fallback
- **Auto gas top-up** — CryptoStrategyAgent automatically swaps small stablecoin amounts to native (ETH/BNB) when gas reserves drop below 50%, preventing strategies from getting stuck with no gas
- **Token decimal auto-detection** — `swapService._resolveDecimals()` fetches on-chain decimals via `getTokenMetadata()`, fixing incorrect quotes for 6-decimal tokens (USDT/USDC on Ethereum)
- **WETH/WBNB unwrap endpoint** — `POST /api/crypto/swap/unwrap` converts wrapped native tokens back to ETH/BNB with balance validation
- **Visualizations sidebar link** — 3D Visualizations page accessible from Web UI sidebar navigation

### Fixed
- **"Unknown network: undefined"** in cryptoMonitor — `checkBalances()` now skips non-EVM chains (btc, nano), maps `addr.chain` correctly ('eth' → 'ethereum'), uses correct property name
- **Three.js CDN 404** — Downgraded from r160 (removed `/examples/js/`) to r128 (last version with legacy globals) in visualizations.html
- **ERC-8004 fields showing "—"** — Added `.lean()` to Mongoose query in `agentIdentityService.getIdentityStatus()` to bypass subdocument serialization; fixed AGENT_NAME mismatch (ALICE vs LANAgent) in MongoDB

## [2.15.7] - 2026-03-12

### Added
- **5 BSC mainnet contracts deployed** — All proposal contracts live on BSC mainnet:
  - AgenticCommerceJob (ERC-8183): `0x9aFD27822be743f28703325cC5895C9e83160dE5` — on-chain job escrow with 2.5% fee
  - ENSTrustRegistry (ERC-8107): `0x0C75d229de505175B75E0553d7CA54358a6d300c` — trust graph with genesis node `lanagent.eth`
  - AgentCoordination (ERC-8001): `0xFFeD9F5775278Bb04856caE164C94A7D976372f1` — multi-agent intent coordination
  - AvatarNFT: `0x91Eab4Dd5C769330B6e6ed827714A66136d24842` — ERC-721 avatar NFTs
  - AgentCouncilOracle (ERC-8033): `0xF839287DDFeaD0E9D19bdD97D7F34F2f925ba274` — commit-reveal oracle with judge aggregation
- **Agent Coordination API** — `/api/coordination` endpoints (types, active, history, stats, propose, accept, execute, cancel)
- **VR Avatar API** — `/api/avatar` endpoints (create, gallery, stats, customize, export, mint, items)
- **TRELLIS 3D generation** — Zero-config photo/text-to-3D via HuggingFace Gradio Spaces (no API key required)
- **Trust registry scammer sync** — Scheduled Agenda job every 6 hours syncs scammer registry to on-chain trust registry
- **Contract deployment script** — `scripts/deploy-contracts.js` unified deployer with MongoDB wallet, dry-run support
- **Three.js 3D visualizations** — 5 interactive visualizations at `/visualizations.html`:
  - Agent Brain: neural network of 12 agent services with pulsing connections
  - Network Topology: force-directed 3D graph of LAN devices
  - Crypto Token Space: 3D portfolio with orbiting tokens sized by value
  - Trust Graph: ERC-8107 trust attestation visualization
  - Log Waterfall: matrix-rain style log display by service
- **Coordination use case handlers** — Concrete execution logic for all 6 coordination types (joint monitoring, coordinated trade, shared cost, code upgrade, oracle consensus, collective stake)
- **IPFS pinning for avatars** — nft.storage integration for permanent avatar model/metadata hosting, used as tokenURI when minting NFTs

### Changed
- **Multi-instance naming** — Replaced all ALICE-specific references with `process.env.AGENT_NAME || 'LANAgent'`
- **Avatar service default provider** — TRELLIS (free) as default, Meshy.ai and Tripo3D as optional paid alternatives
- **AvatarNFT Solidity version** — Bumped from 0.8.20 to 0.8.27 with cancun EVM for OpenZeppelin 5.x compatibility
- **Oracle service ABI** — Updated to match deployed AgentCouncilOracle contract split view functions

### Fixed
- **SystemSettings key mismatches** — Deploy script saved `_contract_address` keys but services expected `_address` keys; fixed both deploy script and production database

## [2.15.6] - 2026-03-12

### Added
- **Dry.AI `createAppSpace` command** — Create AI-powered app spaces with custom types and interactive pages via Dry.AI API
  - Natural language app creation: "build me a bug tracker on dry.ai"
  - Uses absolute URL endpoint (`https://dry.ai/api/custom-gpt/create_app_space`)
  - Returns created space name, ID, and URL
- **6 implementation proposals** — ERC-8183 (Agentic Commerce), ERC-8107 (ENS Trust Registry), ERC-8033 (Agent Council Oracles), ERC-8001 (Agent Coordination), 1inch DEX aggregator, VR Avatar system

### Changed
- **Plugin directory consolidation** — Migrated 5 plugins from legacy `src/plugins/` to `src/api/plugins/`
  - Rewrote `contractCommands` and `cryptoMonitor` from old `Plugin` class to `BasePlugin` pattern (ethers v5 → v6)
  - Migrated `ipgeolocation`, `jsonplaceholder`, `numbersapi` with corrected import paths
  - Removed duplicate `cloudwatch.js` (already existed as `amazoncloudwatch.js`)
  - Deleted legacy `src/plugins/` directory

## [2.15.5] - 2026-03-12

### Added
- **ENS Name Service** — Register, manage, and auto-renew `.eth` names on Ethereum mainnet
  - Commit/reveal registration flow via ETHRegistrarController (wrapped names via NameWrapper)
  - Subname creation for multi-agent setups (e.g., `alice.lanagent.eth`)
  - Address record and reverse resolution management
  - Auto-renewal via daily Agenda job (renews when <30 days until expiry)
  - Registered `lanagent.eth` as base name with `alice.lanagent.eth` subname
  - Cross-chain resolution: names resolve on BSC, Ethereum, and all EVM chains
- **ENS API** — Full REST API for ENS management
  - `GET /api/ens/status` — configuration, expiry, subnames, resolved address
  - `GET /api/ens/available/:name` — check availability with pricing
  - `GET /api/ens/expiry/:name` — check name expiry
  - `POST /api/ens/commit` — step 1 of registration (submit commitment)
  - `POST /api/ens/register` — step 2 of registration (complete after 60s wait)
  - `POST /api/ens/subname` — create subname under base name
  - `POST /api/ens/reverse` — set reverse resolution (address → name)
  - `POST /api/ens/renew` — manually renew a name
  - `POST /api/ens/settings` — toggle auto-renewal, set subname price
- **P2P ENS Subname Provisioning** — Forked instances auto-request subnames from genesis via P2P
  - Genesis instance advertises `ens_provider` capability with base name during peer exchange
  - Forked instances auto-detect genesis peer (via `ens_provider` capability or ERC-8004 #2930)
  - Automatic subname request 5 minutes after wallet generation (allows P2P to connect first)
  - Optional SKYNET token pricing for subname creation (configurable, default 0 = free)
  - Full payment flow: `ens_subname_request` → `ens_subname_payment_required` → auto-pay → retry
  - On-chain payment verification reuses existing Skynet payment infrastructure (double-spend protection)
  - Subname saved locally on fork via `ens.mySubname` SystemSetting
  - Name collision handling: auto-retries with `{name}-{fingerprint}` suffix if label is taken
  - Pending payment persistence: saves failed payment attempts, retries daily via renewal job
  - `POST /api/ens/request-subname` — manual subname request with custom label
- **ENS NLP Intents** — Natural language ENS management (intents 128-129)
  - "what is my ENS name", "when does my ENS expire", "show ENS status"
  - "get me an ENS subname", "request subname coolbot", "get me alpha.lanagent.eth"
  - Auto-extracts label from natural language or defaults to AGENT_NAME

### Fixed
- **Staking stats timeout** — `totalStaked()` RPC call had no error fallback, causing the entire `/api/staking/stats` endpoint to fail when BSC RPCs were slow. Added 15-second timeout wrapper with safe fallbacks on all 5 parallel RPC calls.

## [2.15.4] - 2026-03-11

### Added
- **Fee-to-Staking Flywheel** — Registry fee income automatically funds staking reward epochs
  - On-chain fee detection: scans `ScammerRegistered` events from the registry contract
  - Hybrid bootstrap: seeds ledger from `getScammerCount() × reportFee()` on first run, then scans new events going forward (BSC public RPCs prune old logs)
  - Tracks self vs external reporter income separately
  - `registryFees` ledger category isolates fee income from LP/treasury/reserve/staking allocations
  - Routes fees to staking only when: epoch ended + fee balance ≥ threshold (default 500K SKYNET)
  - Configurable: threshold, routing percent (default 100%), epoch duration (default 7 days)
  - Uses scan-friendly RPCs (BlastAPI, dRPC, nodies) with chunked queries
  - `totalFeesRoutedToStaking` SystemSetting tracks cumulative routed amount
- **Fee Routing Settings API** — Configure fee-to-staking routing
  - `GET /api/staking/fee-routing` — current settings + fee balance from ledger
  - `POST /api/staking/fee-routing` — update: `{ enabled, threshold, percent, epochDuration }`
- **SkynetTokenLedger `registryFees` category** — Tracks fee income separately from other allocations
  - `recordFeeIncome()`, `debitFeesForStaking()`, `getRegistryFeeBalance()` methods

## [2.15.3] - 2026-03-11

### Added
- **Automatic Scam Token Reporting** — Agent autonomously reports confirmed scam tokens to the on-chain scammer registry
  - Confidence scoring system: honeypot (50pts), scam name pattern (40pts), no contract code (20pts), dust amount (15pts), 3+ warnings (30pts)
  - Threshold of 50 requires 2+ signals — "no swap path" alone never triggers (prevents false positives on low-liquidity tokens like SKYNET)
  - Queues scam reports during deposit scan and residual sweep, batch-reports at end of cycle
  - Maps detection signals to registry categories: Honeypot, Phishing, Fake Contract, Dust Attack, Other
  - Stores evidence transaction hash for on-chain audit trail
  - WebUI toggle on crypto page (enabled by default), persisted via `crypto.autoReportScams` SystemSetting
- **Owned Token Whitelist** — Protects owned tokens from auto-sell (dead projects, LP tokens, minted tokens)
  - MANTIS, NAUT, STINGRAY, SENTINEL, Cake-LP (SKYNET/WBNB), LOTTO added to sweep skip list
  - Separate from scam blacklist — owned tokens are not reported to registry
- **Scam Token Auto-Report Settings API** — Toggle automatic scam reporting
  - `GET /api/crypto/settings/auto-report-scams` — check current state
  - `POST /api/crypto/settings/auto-report-scams` — enable/disable (`{ "enabled": true }`)

### Fixed
- **Scam token error spam** — ChinaHorse, SN3, WAR, BlackGold retried every sweep cycle generating 17,000+ errors; now skipped via hardcoded blacklist + scammer registry cache check
- **7-day auto-cleanup wiping permanent blacklist** — `recordProcessedDeposit()` deleted entries older than 7 days including failCount=3 entries; fixed to preserve permanently-failed tokens
- **TRANSFER_FROM_FAILED not triggering permanent blacklist** — Added to unsellable detection alongside "No viable swap path" and "no real liquidity"
- **Output sanity check failed not triggering permanent blacklist** — Added to unsellable detection patterns

## [2.15.2] - 2026-03-10

### Added
- **Upstream Sync for Forked Instances** — Forked instances now automatically receive updates from the genesis repository
  - `git-monitor` (every 30 min) fetches `upstream/main`, merges new commits, pushes to `origin/main`
  - Genesis instances auto-skip (detects `origin === UPSTREAM_REPO` with `.git` suffix and case normalization)
  - Handles merge conflicts (aborts + notifies), local changes (skips + warns), lock contention (skips gracefully)
  - Adds `upstream` remote automatically on first run if `UPSTREAM_REPO` is set
  - Closes the gap where forked instances never received updates pushed to the genesis repo
- **ERC-8004 On-Chain Recovery** — If the database loses ERC-8004 registration state, `getIdentityStatus()` auto-recovers by querying the on-chain registry
  - Calls `ownerOf()`, `tokenURI()`, and `getAgentWallet()` on the Identity Registry contract
  - Restores `status`, `agentId`, `agentURI`, and `linkedWallet` to the database
  - Triggers only when DB has `agentId` but status is `none` — zero overhead when state is intact

## [2.15.1] - 2026-03-09

### Fixed
- **Ethereum token auto-sell returning $0.00** — `getQuote()` formatted stablecoin output with 18 decimals instead of 6 (USDC/USDT on Ethereum), making every token appear worthless and triggering "gas would exceed output, skipping"
- **False scam classification on RPC errors** — `classifyToken()` returned `scam` on any RPC timeout or rate-limit error, now returns `safe_unknown` so auto-sell is attempted
- **Batch deposit classification rate limiting** — 12+ deposits classified simultaneously with no throttling caused RPC rate-limit cascade; added 2-second delay between classifications
- **Corrupted DAI address in swap routing** — `0x...EesafePromiseAllgdC3` (invalid) replaced with correct `0x...EedeAC495271d0F`, fixing all DAI-routed multi-hop swaps
- **`ignored_scam` deposits never re-evaluated** — Previously permanent, now expires after 24 hours so tokens can be re-classified with improved detection

## [2.15.0] - 2026-03-09

### Added
- **Multi-Instance Framework** — Anyone can install and run their own LANAgent instance without sharing credentials
  - Interactive install wizard (`scripts/setup/install.sh`) walks through complete setup: agent name, AI providers, crypto wallet, Telegram, P2P, self-modification
  - Docker support: `--docker` mode skips host dependency checks, auto-launches containers after setup
  - Quick-start one-liners for Linux, macOS, and Windows at the top of README
  - Centralized path utility (`src/utils/paths.js`) resolves all paths from environment variables with project-root fallbacks
  - `CLAUDE.local.md.example` for instance-specific configuration separate from the generic `CLAUDE.md`
- **Cross-Fork Upstream PRs** — Agent instances automatically contribute improvements back to the upstream repo
  - `GitHubProvider.createUpstreamPR()` creates cross-fork PRs via GitHub API (`head: "fork_owner:branch_name"`)
  - `selfModification.contributeUpstream()` wired into PR flow — fires non-blocking after fork PR creation
  - Controlled by `UPSTREAM_CONTRIBUTIONS=true` (default: enabled)
- **Docker Packaging** — Production-ready Dockerfile and docker-compose.yml
  - Node 20-slim with ffmpeg, python3, git; non-root user; health check with 180s start period
  - MongoDB 7 service with health checks, named volumes, configurable ports
- **Credential Security** — Automated scanning to prevent credential leaks in PRs
  - `.gitleaks.toml` with patterns for Anthropic, OpenAI, Telegram, GitHub, HuggingFace, ETH private keys
  - GitHub Actions CI workflow (`pr-security-check.yml`) scans all PRs to main
  - `CONTRIBUTING.md` and `SECURITY.md` documenting security practices
- **Agent Identity Isolation** — Each instance uses its own name, database, wallet, and git config
  - All 35 `Agent.findOne({ name: "LANAgent" })` DB queries parameterized to `process.env.AGENT_NAME || "LANAgent"`
  - Self-modification PR titles/bodies use agent name instead of hardcoded "ALICE"
  - P2P Skynet identity unique per instance (Ed25519/X25519 keypair, configurable display name)

### Changed
- **Credential Scrub** — Removed all hardcoded credentials from ~60 scripts and source files
  - SSH passwords (hardcoded → `$PRODUCTION_PASS`), IPs (hardcoded → `$PRODUCTION_SERVER`)
  - API keys, deploy paths, personal emails replaced with env var references
  - `ecosystem.config.cjs` fully parameterized (no hardcoded paths or emails)
- **Self-Modification Defaults** — Self-mod, upstream contributions, and P2P all enabled by default in install wizard
- **CLAUDE.md** — Rewritten as generic template; instance-specific config goes in `CLAUDE.local.md`

## [2.14.23] - 2026-03-09

### Added
- **V4 Background Hook Discovery** — Automatic discovery of PancakeSwap Infinity CLAMM pool hooks for any token pair, eliminating need for manual code changes when adding new tokens
  - `_discoverV4PoolsForPair()` scans ERC20 Transfer events to Vault, extracts pool IDs from Swap events, reads full PoolKey via `poolIdToPoolKey()`
  - Background loop: runs 90s after startup, repeats every 30 minutes via `startV4DiscoveryLoop()`
  - Hooked into CryptoStrategyAgent initialization — automatically provides token pairs from StrategyRegistry
  - Per-pair cache with deduplication against static fallback hooks
- **Dedicated V4 RPC Providers** — V4 quote and discovery use separate RPC providers to avoid rate-limit contention with V2/V3
  - V4 quotes: `bsc.publicnode.com` (dedicated `_v4QuoteProvider`)
  - V4 discovery: `bsc.drpc.org` (dedicated per-run provider)
  - Retry with backoff for getLogs calls, 5s stagger between token pairs
- **V4 Swap Execution (Plan/Actions encoding)** — PCS Infinity swaps now use the correct INFI_SWAP Plan/Actions format
  - Actions: `CL_SWAP_EXACT_IN_SINGLE(0x06)` + `SETTLE_ALL(0x0c)` + `TAKE_ALL(0x0f)` encoded as `abi.encode(bytes, bytes[])`
  - Permit2 approval chain: ERC20 → PCS Permit2 → Universal Router (auto-managed, 30-day expiry)
  - PCS-specific Permit2 at `0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768` (discovered from router bytecode)
- **Uniswap V4 Support (Ethereum + BSC)** — Full Uniswap V4 quoting and swap execution on Ethereum mainnet and BSC
  - Quoter uses PoolKey-based struct `{currency0, currency1, fee, tickSpacing, hooks}` (5 fields, no poolManager/parameters)
  - Swap execution via `_executeUniswapV4Swap()` with same action bytes (0x06, 0x0c, 0x0f) as PCS, different PoolKey encoding
  - Uniswap V4 on BSC quotes run in parallel with PCS Infinity quotes — best price wins regardless of protocol
  - Uses canonical Permit2 (`0x000...22d4`) via `permit2Override` parameter, separate from PCS's custom Permit2
  - V4 quote results tagged with `v4Protocol: 'pcs-infinity'` or `'uniswap-v4'` for correct execution routing
  - Contracts: BSC Quoter `0x9f75dd...`, Router `0x1906c1...`, PoolManager `0x28e2ea...`; ETH Quoter `0x52f0e2...`, PoolManager `0x000000000004444c...`

### Fixed
- **V4 Swap Reverts (gasUsed ~33k)** — Replaced raw swap struct encoding with Plan/Actions format per PCS Infinity docs; swaps now execute successfully through hooked V4 pools
- **Wrong Permit2 Contract** — PCS Infinity Universal Router uses its own Permit2 (`0x31c2F6fc...`), not the canonical Uniswap Permit2 (`0x000...22d4`); using wrong one caused `AllowanceExpired(0)` revert at ~121k gas
- **V4 CLAMM Quote Decode** — BSC RPC nodes sometimes return `UnexpectedCallSuccess(bytes)` revert data as a successful `eth_call` result instead of throwing; now detected and decoded before normal ABI decode, with regex fallback extraction from ethers error messages
- **Native BNB address(0) Intermediary** — PancakeSwap Infinity CLAMM pools use `address(0)` for native BNB, not WBNB; V4 multi-hop paths now try both `[WBNB, address(0)]` as intermediaries with correct `zeroForOne` sorting (address(0) always currency0)
- **forceV3 Override** — When V3 has a valid quote but V2 wins the comparison, `forceV3` now forces V3 execution instead of aborting the swap entirely; prevents "forceV3 enabled but V3 did not win" errors that blocked trades on tokens with V2+V3 liquidity
- **V4 Rate Limit Resolution** — V4 quotes no longer fail due to BSC RPC rate limiting; dedicated providers for V4 quotes and discovery prevent contention with V2/V3 quote flow
- **Token Scanner RPC Deep Scan Early Abort** — Ethereum public RPCs reject all getLogs requests, causing 2500+ chunks to churn with 100% error rate before completing; now aborts after 50 chunks if >90% error rate, falling back to explorer API results instead of blocking the deposit detection pipeline
- **Token Scanner Empty Error Messages** — `scanNetwork` logged empty error messages for network failures; now falls back to `error.code` or truncated JSON when `error.message` is empty
- **Wrong Uniswap V4 Quoter Address** — Ethereum V4 quoter was `0x52f0...852E` (wrong checksum), corrected to `0x52f0...1203` from official Uniswap V4 deployment docs
- **Wrong Uniswap V4 Quoter ABI** — Was using flat params `(tokenIn, tokenOut, amountIn, fee, tickSpacing, hooks)`, corrected to PoolKey-based struct matching actual V4Quoter contract interface

## [2.14.22] - 2026-03-08

### Added
- **PancakeSwap Infinity CLAMM Hooked Pool Support** — V4 quoter now supports custom hook contracts with dynamic fees, enabling trading on PancakeSwap Infinity concentrated liquidity pools that use hooks (e.g., BTW token's hooked pool with fee=67, tickSpacing=10)
  - `V4_HOOKED_POOLS` config for per-network hook addresses, fees, tick spacings, and hook flags
  - Raw `provider.call()` replaces ethers `staticCall` to handle CLQuoter's `vault.lock()` revert mechanism
  - Revert data decoder for `UnexpectedCallSuccess(bytes)` error selector (`0x6190b2b0`)
  - Sanity check rejects V4 quotes >1000x input amount to prevent garbage values from failed decodes

### Fixed
- **CLQuoter ABI Mismatch** — Fixed PancakeSwap Infinity CLQuoter return type from `(int128[], uint160, uint32)` to `(uint256 amountOut, uint256 gasEstimate)`
- **Stablecoin Priority (BUSD→USDT)** — All stablecoin lookup paths now prefer USDT over deprecated BUSD (6 locations across scheduler, strategy agent, and arbitrage)

## [2.14.21] - 2026-03-08

### Added
- **Per-Token Independent Heartbeats** — Each token trader instance now runs its own heartbeat timer with regime-based intervals (DUMP=1m, MOON=2m, PUMP=3m, ENTERING=5m, SIDEWAYS=10m, COOLDOWN=15m), replacing the shared sequential loop
  - Concurrency semaphore (max 3 simultaneous ticks), per-network swap mutex (prevents EVM nonce conflicts), global rate limiter (100 ops/min)
  - Error backoff: doubles interval after 3 consecutive errors (capped at 30 min)
  - Shared market data cache (60s TTL) avoids redundant Chainlink/CoinGecko calls across tokens
  - Web UI shows heartbeat info per token (interval, last run, backed-off status)
- **Per-Token Save Button** — Capital allocation and stop-loss changes require explicit Save with confirmation prompt instead of auto-submitting on change
- **V4 Multi-Hop DEX Routing** — `_getV4Quote()` now tries WBNB intermediate paths (tokenIn→WBNB→tokenOut) across all fee tier combinations, matching V3's multi-hop coverage for PancakeSwap Infinity and Uniswap V4
- **USDC Added to BSC Stablecoins** — BSC stablecoin config now includes USDC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`) alongside BUSD and USDT, improving DEX routing and arbitrage coverage
- **Native Pair Arbitrage Scanning** — Arbitrage scanner now checks WBNB↔stablecoin (USDT, USDC, BUSD) cross-protocol opportunities in addition to token↔stablecoin scans

### Fixed
- **Watchlist Rotation Overwriting User-Configured Tokens** — Tokens added via API are now flagged `userConfigured` and exempt from watchlist rotation; failed initial buys go to COOLDOWN instead of being replaced
- **Buy Price Impact Check Dual-Path** — Price impact now quotes both stablecoin→token and native→token paths, picks the path with lower impact (many BSC tokens paired with WBNB have better direct liquidity)

## [2.14.20] - 2026-03-08

### Added
- **Multi-Token Trading** — Token Trader now supports simultaneous trading of multiple tokens with independent funds, regimes, and P&L tracking
  - Each token is a fully independent `TokenTraderStrategy` instance stored in `StrategyRegistry.tokenTraders` Map
  - API endpoints support `?token=ADDRESS` query param to target specific instances
  - `POST /strategy/token-trader/configure` adds new instances (not replaces); capital allocation sums across all
  - `GET /strategy/token-trader/status` returns all instances with per-token stats, or filter with `?token=`
  - `POST /strategy/token-trader/exit?token=ADDRESS` exits specific instance; no param exits all
  - `POST /strategy/token-trader/restore-state?token=ADDRESS` restores specific instance state
  - Backward compatible: existing single-token deployments auto-migrate on first restart
  - Web UI updated with per-token cards showing regime, balance, P&L, entry/peak/stop prices, and individual exit buttons
  - Revenue service aggregates P&L across all instances; arbitrage scanner includes all active tokens
- **LP Fee Collection Gas Check** — V3 fee collection now checks `tokensOwed0`/`tokensOwed1` (free view call) before submitting on-chain `collect()` transaction, preventing gas waste on zero-fee collections

### Fixed
- **Token Trader configure() cooldown state leak** — Switching tokens via configure() now properly resets `lastDumpSell`, `lastDumpSellPrice`, `lastEmergencySell`, and `consecutiveGridBuys`. Previously, cooldown state from the old token carried over, blocking the new token's initial buy and triggering unwanted watchlist rotation.

### Improved
- **Winston log rotation convention** — Added `tailable: true` to all file transports so the base filename (e.g., `crypto.log`) is always the active log file and numbered files are older rotations, matching standard log rotation conventions
- **Plugin logger duplicate file handles** — `createPluginLogger()` no longer opens separate file handles for `all-activity.log` and `plugins.log`. Uses a `ForwardTransport` to pipe messages through the main logger, preventing rotation conflicts from multiple transports writing to the same file
- **Log filter keyword precision** — Tightened overly broad filter keywords that caused cross-contamination between log files:
  - `'analyzing'` removed from self-modification filter (was catching crypto analysis)
  - `'strategy'` narrowed to `'strategy execution'`/`'strategy result'`/`'secondary strategy'` in crypto filter
  - `'request'`/`'response'`/`'web'`/`'api'`/`'auth'` narrowed to specific phrases in api-web filter
  - `'bug'`/`'security'`/`'fixing'` narrowed to `'bug detect'`/`'bug fix'`/`'security scan'` in bug-detection filter
- **Orphaned log file cleanup** — Removed 172MB of old rotated log files that exceeded configured `maxFiles` limits

## [2.14.18] - 2026-03-07

### Added
- **Token Trader Safety Improvements (Config v8)** — Six fixes to prevent repeated losses from grid buying into downtrends
  - Grid buy trend gates: blocks grid buys when short-term trend < -0.3 or long-term trend < -5%
  - Emergency sell cooldown: 2-hour buy lockout after emergency/partial sell prevents immediate buy-back
  - Re-entry trend confirmation: requires non-negative short-term trend before re-entering after stop-loss
  - Escalating grid buy cooldown: 30min → 1hr → 2hr → 4hr after 4/8/12 consecutive grid buys without a sell
  - Consecutive grid buy cap: max 12 grid buys without a grid sell before pausing
  - Average entry price sanity check: guards against corrupted avg entry from state persistence race conditions
  - New status API fields: `gridBuyTrendGate`, `gridBuyLongTrendGate`, `maxConsecutiveGridBuys`, `emergencySellCooldownMs`, `reentryTrendGate`, `consecutiveGridBuys`, `lastEmergencySell`

## [2.14.17] - 2026-03-06

### Added
- **Sentinel Token P2P Trust Integration** — SENTINEL soulbound tokens now factor into peer trust score calculation
  - `sentinelBalance` and `sentinelBalanceVerified` fields added to P2PPeer schema
  - Sentinel balance queried on-chain during peer capabilities exchange (alongside SKYNET and ERC-8004)
  - +5 trust points per SENTINEL token held, up to +15 (3+ tokens)
  - Trust score rebalanced: longevity 15→10, activity 15→10 to accommodate Sentinel factor
  - Graceful degradation: if registry contract unreachable, Sentinel check skipped silently
- **PR Review Implementations** — Reviewed and processed 10 AI-generated PRs (#1700-#1709)
  - Merged: KnowledgePack query methods (#1700), SkynetReferral analytics (#1701), SkynetBounty difficulty/skills (#1705), embedding model registry (#1707)
  - Manually implemented: Shazam recommend command (#1709), audit log search/healthcheck (#1706), ExternalAuditLog compound indexes (#1708)
  - Fixed embedding service `dimensions` parameter bug for text-embedding-ada-002
- **Shazam Recommend Command** — Get music recommendations based on a song ID via `related_songs` API
  - Results cached for 5 minutes with NodeCache
- **Audit Log Enhancements** — Retry on save, request/response body capture, `searchAuditLogs()` and `auditLogHealthCheck()` functions
  - `requestBody` and `responseBody` fields added to ExternalAuditLog schema
  - Compound indexes on agentId+timestamp, statusCode+path, ip+method

### Fixed
- **ytdlp Intent Matching** — "send me the song X by Y as mp3" now correctly matches `ytdlp.audio` instead of `music.generate`
  - Added 6 new examples to ytdlp audio intent for "send me the song" phrasing
  - Improved query cleanup regexes to strip "from YouTube", "as an mp3", "and send it to me" from search queries

## [2.14.16] - 2026-03-06

### Added
- **On-Chain Scammer Registry** — BSC smart contract for flagging scammer addresses with soulbound token minting
  - ScammerRegistry contract (`0xEa68dad9D44a51428206B4ECFE38147C7783b9e9`) deployed and verified on BSCScan
  - SCAMMER soulbound BEP-20 token (`0x12A987e313e05bAAB38B3209c614484149D24711`) minted to flagged addresses
  - SENTINEL soulbound BEP-20 token (`0xdb700A7DF83bf4dB6e82f91f86B0c38e01645eea`) minted to reporters as reward
  - 7 scam categories: Address Poisoning, Phishing, Honeypot, Rug Pull, Fake Contract, Dust Attack, Other
  - SKYNET token fee for reporting (50,000 initial, adjustable by genesis agent)
  - 2-of-3 immunity system: ERC-8004 identity, SKYNET balance >= threshold, active stake
  - Batch reporting up to 50 addresses per transaction (skips duplicates)
  - Genesis agent authority via ERC-8004 NFT #2930 ownership (portable across wallets)
  - Evidence tx hash storage for on-chain verification
- **Scammer Registry API** — Full REST API at `/api/scammer-registry/*` with 10 endpoints
  - GET: stats, check/:address, immunity/:address, list, categories
  - POST: report, batch-report, remove, set-fee, set-immunity-threshold
  - NodeCache (120s TTL) for stats and list queries
  - Auto-approval of SKYNET token spend for fee collection
- **Scammer Registry NLP Intents** — 4 new intents (124-127) for natural language interaction
  - `scammerReport` (124): "report 0x1234 as scammer address poisoning"
  - `scammerCheck` (125): "is 0x1234 a scammer?"
  - `scammerList` (126): "show scammer registry stats"
  - `scammerRemove` (127): "remove 0x1234 from scammer registry"
  - Address extraction from input works with both AI and vector intent detectors

### Added (continued)
- **Scammer Registry Passive Safety Layer** — Local cache of flagged addresses with automatic sync and transaction guards
  - `syncScammerCache()`: fetches all flagged addresses from contract in parallel batches of 20, caches in a `Set` for O(1) lookups
  - `isAddressFlagged()`: fast local check, returns false if cache empty or registry unavailable (graceful degradation)
  - Cache auto-refreshes every 4 hours on CryptoStrategyAgent heartbeat
  - **Token scanner**: incoming tokens from flagged senders are silently ignored; flagged token contracts marked as scam immediately
  - **Swap guard**: DEX swaps blocked if either tokenIn or tokenOut is flagged in the registry
  - **Transaction guard**: `sendNative()` and `writeContract()` refuse to interact with flagged addresses
  - All guards are optional — if registry is unreachable or unconfigured, everything works as before

### Fixed
- **Intent Parameter Extraction** — Scammer intent handlers now extract addresses directly from input as fallback when vector intent detector returns empty parameters (vector detector skips AI parameter extraction for `_system` plugin intents)

## [2.14.15] - 2026-03-02

### Changed
- **Memory System: AI Relevance Filtering** — Replaced keyword/URL/path extraction (`analyzeGeneralKnowledge`) with AI-based relevance filter (`aiAnalyzeForMemory`)
  - Uses the active AI provider (e.g., HuggingFace Qwen) via `providerManager.generateResponse()` — no hardcoded model
  - AI decides if a message contains personal facts, preferences, or instructions worth remembering permanently
  - Pre-filters skip short messages, `/` commands, URL-only messages, and obvious command verbs before making AI calls
  - Stores AI-determined summary as memory content with `ai_` prefixed categories for tracking
  - Failures never break conversation flow (try/catch with `logger.debug`)

### Fixed
- **Memory System: Regex Pattern Overfitting** — Removed 5 overly broad regex patterns from `analyzeAndLearn()` that were storing commands as "knowledge"
  - Removed: `instruction` (matched "please" + anything), `goal` (matched "need to" + anything), `routine` (matched "I usually" + anything), `method`, `project` (matched "building/creating" + anything)
  - Kept: `name`, `preference`, `work`, `location`, `fact` — these match explicit personal statements only
  - Cleaned up 46 junk memories from production DB (26 `resource_link` YouTube URLs, 20 `general_important` false positives)

## [2.14.14] - 2026-03-02

### Changed
- **Video Generation: ModelsLab Provider** — Replaced Replicate with ModelsLab as the default video generation provider
  - ModelsLab has no content moderation (Replicate silently modified prompts)
  - Pay-as-you-go: $0.20/video (Ultra), $0.08/video (Standard), no monthly fee
  - Same Wan models (2.1, 2.2) plus CogVideoX and WanX
  - Async submit + poll API pattern with adaptive polling intervals
  - Downloads video from output URLs with proxy_links fallback
  - API key stored encrypted in DB (same pattern as other providers)
  - Web UI: ModelsLab options (model, endpoint, resolution, frames, FPS)
  - OpenAI (Sora) available as fallback — warns user about content moderation when falling back
  - Replicate removed entirely from codebase

### Removed
- Replicate video generation provider and all associated code (client, API key loading, schema, UI)

## [2.14.13] - 2026-03-01

### Added
- **MessageBird MMS Support** — New `sendMMS` command in MessageBird plugin using the correct `/mms` endpoint
  - Accepts originator, recipient, message body, and mediaUrl
  - Uses retry logic consistent with existing sendSMS command
- **Transaction Status Smart Caching** — `/api/transactions/status/:txHash` now has:
  - Rate limiting (100 requests per 15 minutes) via express-rate-limit
  - Retry logic for transient blockchain RPC errors
  - Smart caching: only caches finalized statuses (confirmed/failed), never pending

### Changed
- `src/utils/database.js` — MongoDB reconnection now uses exponential backoff (1s base, 30s max) instead of fixed 5s intervals. Applies to initial connection retries, error recovery, and disconnect auto-reconnection
- `src/services/crypto/agentIdentityService.js` — ERC-8004 registration now only includes enabled plugins in capabilities list. Disabled plugins and those without API keys are no longer advertised

### Fixed
- ERC-8004 registration file included disabled plugins in capabilities — now correctly filters to only enabled plugins, matching what the External Services tab shows

### PR Review
- Reviewed and closed 9 AI-generated PRs (#1686–#1694)
  - #1686 (MqttDevice.js) — Dead code with no callers or integration path
  - #1687 (ContractABI.js) — Index matches no existing query pattern
  - #1688 (database.js) — Good idea (exponential backoff), implemented manually above
  - #1689 (systemReports.js) — Buggy CSV cache, hallucinated PR description
  - #1690 (transactions.js) — Good ideas (caching, rate limiting), but cached pending tx for 5min. Implemented correctly above
  - #1691 (donations.js) — Redundant caching (service already has it)
  - #1692 (ArbSignal.js) — 5min cache harmful for time-sensitive arb signals
  - #1693 (BugReport.js) — Would crash model on load (missing package import), destructive dedup logic
  - #1694 (messagebird.js) — Good idea (MMS), wrong endpoint. Implemented correctly above

## [2.14.12] - 2026-03-01

### Added
- **Telegram Streaming Responses** — AI query responses now stream in real-time using Telegram Bot API 9.5 `sendMessageDraft`
  - Text appears progressively as the AI generates it, replacing the static "Thinking..." placeholder
  - Streaming for AI queries only (general questions, changelog summaries) — plugin operations send results normally
  - Streaming support added to OpenAI, Anthropic, and HuggingFace providers via `generateStreamingResponse()`
  - HuggingFace streaming uses SSE parsing of the OpenAI-compatible chat completions endpoint
  - ProviderManager delegates to active provider with automatic fallback to non-streaming
  - TelegramDashboard sends draft updates throttled to 300ms with in-flight protection
  - Draft auto-clears when the final message is sent

### Changed
- `src/providers/openai.js` — New `generateStreamingResponse()` method using OpenAI async iterable streaming
- `src/providers/anthropic.js` — New `generateStreamingResponse()` method using Anthropic `client.messages.stream()`
- `src/providers/huggingface.js` — New `generateStreamingResponse()` method using SSE stream parsing
- `src/core/providerManager.js` — New `generateStreamingResponse()` with fallback to non-streaming providers
- `src/core/agent.js` — `handleNaturalQuery()`, `query` handler, and `getRecentChanges()` use streaming when `context.onStreamChunk` is available
- `src/interfaces/telegram/telegramDashboard.js` — `setupTextHandler()` sends `sendMessageDraft` calls with rate-limited draft updates

## [2.14.11] - 2026-02-28

### Added
- **Eufy Security Camera Plugin** (`src/api/plugins/eufy.js`) — Direct integration with Eufy cameras via `eufy-security-client` library (cloud + P2P)
  - 5 commands: `setup`, `devices`, `snapshot`, `alerts`, `status`
  - Lazy connection — credentials loaded at boot, connection deferred to first command
  - 2FA authentication flow handled inline via Telegram (code entry as chat message)
  - On-demand snapshots: cloud `pictureUrl` (fast) with P2P livestream + ffmpeg fallback
  - Motion and person detection alerts with configurable per-device throttle (default 60s)
  - Alert config persisted in PluginSettings (survives restarts)
  - Session persistence via `persistent.json` — re-auth only needed once
  - Fuzzy device lookup by name or exact serial number match
- **Generic plugin metadata forwarding** in `agent.js` — `result.metadata` from plugins now propagates through the NL pipeline, including through the AI interpretation step. Fixes `setOperation` for Shazam and enables it for Eufy 2FA
- **TelegramDashboard pending operation support** — Dashboard now handles `metadata.setOperation` from plugin responses, enabling inline 2FA code entry and other interactive flows

### Changed
- `package.json` — Added `eufy-security-client@^3.7.2` dependency

## [2.14.10] - 2026-02-28

### Changed
- **Video Generation Provider**: Replaced fal.ai with Replicate as the default video generation provider
  - fal.ai rejected creative prompts via input-side content moderation (422 errors even with safety checker disabled)
  - Replicate hosts Wan 2.5/2.2 T2V models with no content moderation and flat per-video pricing ($0.05-$0.10)
  - New `replicate` npm package replaces `@fal-ai/client`
  - Resolution mapped to Replicate size format (e.g., `720p` -> `1280*720`)
  - Updated schema, Web UI, settings endpoints, and frontend

### Fixed
- **Stealth Browser Crash**: `stealthBrowser.js` used top-level `import puppeteerExtra from 'puppeteer-extra'` which crashed the entire module (and anything importing it — accounts routes, scraper plugin) when the package wasn't installed. Now lazily loads at call time with automatic fallback to plain puppeteer
- **Wallet Service Library Loading**: `Promise.all` imported 6 crypto libraries; if any one was missing (bitcoinjs-lib, bip39, hdkey, siwe), the entire batch failed and `ethers` was never assigned despite being installed. Each library now loads independently
- **Missing Production Dependencies**: Installed `puppeteer-extra`, `puppeteer-extra-plugin-stealth`, `bitcoinjs-lib`, `bip39`, `hdkey`, `siwe` on production

## [2.14.9] - 2026-02-27

### Added
- **Critical Bug Report Notifications** — New critical bug reports (`severity: 'critical'`) now trigger an immediate agent notification with bug ID, title, file/line, pattern, and description excerpt via `retryOperation`-wrapped `agent.notify()`

## [2.14.8] - 2026-02-27

### Changed
- **Watchlist Composite Scoring** — Replaced momentum-only watchlist evaluation with a weighted composite score (0-100):
  - **Volatility (60%)**: stddev of 24h price returns + swing count (intervals with >2% moves) — rewards tokens with trading opportunities for grid trading
  - **Liquidity (25%)**: binary gate (no V3/V4 liquidity = score 0) + depth bonus from quote `amountOut`
  - **Momentum (15%)**: mild positive (0-30%) scores highest, >50% pump penalized, negative scales down — tiebreaker only
  - New `_computeWatchlistScore()` method on TokenTraderStrategy
- **Watchlist Fail-Count Tolerance** — Tokens are no longer removed on first failure; `_failCount` tracks consecutive failures per token (persists via MongoDB config serialization)
  - 3+ consecutive failures (no price data or no liquidity) AND not `system: true` → permanent removal
  - Successful data fetch resets `_failCount` to 0
  - Transient network/RPC errors don't increment fail count
  - System tokens (`system: true`) are never removed regardless of fail count
- **Enriched watchlistPriceFetcher** — Returns `{price, change24h, priceHistory, hasLiquidity, liquidityDepth, liquidityPaths}` instead of just `{price, change24h}`; returns data with `hasLiquidity: false` instead of `null` for no-liquidity tokens
- **Minimum Score Threshold** — Watchlist rotation requires score >= 15 to prevent rotating to low-quality candidates

## [2.14.7] - 2026-02-27

### Added
- **LP Market Maker Auto-Open** — When enabled with no active position, the market maker now automatically opens a V3 LP position during the heartbeat check, with a 10-minute cooldown between attempts and Telegram notification on success
- **Token Trader Watchlist Rotation** — During CIRCUIT_BREAKER or COOLDOWN states with no opportunity, evaluates watchlist tokens for rotation using combined price + 24h momentum scoring
  - `watchlistPriceFetcher` wrapper fetches current price and 24h price history for momentum assessment
  - If holding tokens worth >$1, triggers `pendingManualExit` sell first, then rotates next cycle
  - If holding dust (<$1) or no tokens, configures new token immediately via `configure()`
  - Liquidity verification: checks V3/V4 swap path (both stablecoin and native routes) before selecting candidate
  - Untradeable tokens automatically removed from watchlist
  - Active token excluded from watchlist evaluation to prevent self-removal
- **Watchlist Momentum Cap** — Rejects watchlist candidates up >50% in 24h (likely pump tops) to avoid buying into parabolic moves
- **Probe Position Sizing** — Watchlist rotations use 25% of reserve for the initial buy (probe position) instead of full allocation

### Changed
- **Token Trader `configure()`** — Accepts `_preserveBreaker: true` option to carry forward consecutive stop-loss count during watchlist rotations, preserving circuit breaker state across token switches
- **LP Market Maker state** — Added `lastOpenAttemptAt` field to DEFAULT_STATE for auto-open cooldown tracking

### Fixed
- **Untradeable token handling** — When a buy fails with forceV3/no swap path error and no tokens are held, the token is removed from watchlist, deconfigured, and the strategy halts cleanly instead of retrying indefinitely

## [2.14.6] - 2026-02-27

### Added
- **V3 LP Market Maker Service** — Autonomous concentrated liquidity market maker for the SKYNET/BNB V3 pool on PancakeSwap
  - Opens ±20% range positions around current price, auto-rebalances when out of range, collects fees on 1-hour intervals
  - Safety gates: 30-minute rebalance cooldown, 5/day circuit breaker, Telegram alerts on rebalance/trip/errors
  - Capital isolation from Dollar Maximizer and Token Trader strategies
  - State persisted in SystemSettings (survives restarts)
  - Integrated into CryptoStrategyAgent heartbeat as a tertiary service (runs after arbitrage)
  - V3 pool auto-creation via `createAndInitializePoolIfNecessary` with BigInt Newton's method sqrtPriceX96 from V2 reserves
  - BNB auto-wrapping to WBNB before providing liquidity
- **Market Maker API** — 7 new REST endpoints under `/api/crypto/lp/mm/`:
  - `GET /status` — Config + state snapshot
  - `POST /enable` — Enable with optional config overrides (rangePercent, feeTier, allocationBNB, allocationSKYNET)
  - `POST /disable` — Close position + disable
  - `POST /open` — Open new V3 concentrated liquidity position
  - `POST /close` — Remove all liquidity and deactivate
  - `POST /rebalance` — Manual rebalance (remove + re-add at current price)
  - `POST /collect` — Collect accumulated trading fees
- **Market Maker Web UI** — Dashboard card in crypto tab with live stats, config inputs, and action buttons

### Fixed
- **ethers.MaxUint128 undefined** — Replaced with `(2n ** 128n - 1n)` in V3 fee collection and liquidity removal (ethers v6 compat)
- **V3 addLiquidityV3 duplicate key error** — Changed from `new LPPosition()` to upsert pattern for pool re-entry
- **Residual sweep selling MM capital** — WBNB is now skipped by `sweepResidualTokens()` when LP market maker is enabled
- **V3 close/rebalance crash on zero-liquidity** — Graceful handling when position already has no liquidity (e.g., partial rebalance failure)

### Changed
- **LPPosition schema** — Expanded transactions type enum: `['add', 'remove']` → `['add', 'remove', 'collect', 'rebalance']`
- **lpManager ABI** — Added `createAndInitializePoolIfNecessary` to V3 position manager ABI

## [2.14.5] - 2026-02-26

### Added
- **On-Chain Staking Contract** — Synthetix-style `SkynetStaking.sol` deployed to BSC (`0x9205b5E16E3Ef7e6Dd51EE6334EA7f8D7Fec31d6`), funded with 20M SKYNET reward pool (7-day epochs, auto-renewed by scheduler). Verified via Sourcify perfect match.
- **Staking API** — New REST endpoints for staking operations:
  - `GET /api/staking/info` — Current user's stake position (staked amount, pending rewards, APY, wallet balance)
  - `GET /api/staking/stats` — Contract-wide stats (total staked, reward rate, epoch timing)
  - `POST /api/staking/stake` — Stake SKYNET tokens (auto-approves)
  - `POST /api/staking/unstake` — Unstake tokens (auto-claims pending rewards)
  - `POST /api/staking/claim` — Claim pending staking rewards
  - `POST /api/staking/fund` — Fund new reward epoch (owner only)
  - `GET /api/staking/history` — Staking transaction history
- **Staking Web UI** — Dashboard in crypto tab showing position, rewards, contract stats, and stake/unstake/claim actions
- **Staking NLP Intents** — 4 new intents for natural language staking control:
  - Intent 119 (`stakingStatus`): "check my staking status", "how much am I staking", "staking rewards"
  - Intent 120 (`stakingStake`): "stake 5000 SKYNET", "stake all my tokens"
  - Intent 121 (`stakingUnstake`): "unstake 1000 SKYNET", "withdraw my stake"
  - Intent 122 (`stakingClaim`): "claim my staking rewards", "collect staking yield"
- **Staking Scheduler Job** — Auto-renews reward epochs when period expires
- **`extractStakingAmount()` method** — Regex-based amount parser supporting numbers, "all"/"max", and null (prompts user for amount)

### Fixed
- **Crypto price "symbol is required"** — `extractSearchParams` for crypto now detects when no specific token is mentioned (e.g. "current price per token") and asks the user to specify, instead of passing an empty symbol to the plugin
- **Task creation validation error** — Improved parameter guard to detect when AI extraction yields no real params (only `fromAI` flag) for plugins requiring params (tasks, websearch). Now returns a clarification prompt instead of a cryptic validation error

### Changed
- **System prompt staking knowledge** — Updated from outdated scheduler-based distribution model to accurate on-chain Synthetix-style contract info with NLP action references

## [2.14.4] - 2026-02-25

### Fixed
- **Lifetime PnL tracking** — Token Trader PnL no longer resets when switching tokens. `configure()` now carries forward realized PnL and gas costs into `lifetimeRealizedPnL`/`lifetimeGasCostUsd` before resetting for the new token (config v7)
- **DM balance stale after TT trades** — Dollar Maximizer stablecoin position now refreshes immediately after Token Trader buy/sell via `_refreshDMPositionAfterTrade()`, instead of waiting for the next DM analysis cycle
- **Transaction type always "swap"** — `swapService.js` now uses the `STABLECOINS` constant to classify transactions as `buy` (stablecoin→token), `sell` (token→stablecoin), or `swap` (token↔token)
- **CryptoWallet schema rejected buy/sell types** — Added `buy` and `sell` to the Mongoose transaction type enum; the missing values were causing all trades to fail with validation errors
- **Dashboard PnL showed single-token only** — Web UI now uses `lifetimeRealized + unrealized` for the total P&L display, correctly reflecting all-time performance across token switches
- **Revenue P&L ignored held assets** — Revenue tracker now includes unrealized position value (token balance + stablecoin reserve) in net profit calculation, with separate `cashflowProfit` and `strategyPnL` fields
- **Revenue service skipped buy/sell transactions** — Sync filter updated from `type === 'swap'` only to also accept `buy` and `sell` types
- **Crypto page blank on expired JWT** — `loadCrypto()`, `apiGet()`, and `apiPost()` now detect 401/403 responses and redirect to login instead of showing a blank page

### Added
- **`GET /api/crypto/strategy/config`** — Returns the current strategy configuration (previously only POST existed for updates)
- **Lifetime PnL in Token Trader status** — `lifetimeRealized` and `lifetimeGasCost` fields added to `/api/crypto/strategy/token-trader/status` response

### Changed
- **Token Trader config v7** — Added `lifetimeRealizedPnL` and `lifetimeGasCostUsd` state fields with v6→v7 migration

## [2.14.3] - 2026-02-25

### Fixed
- **Critical: Emergency sell bypass** — Hourly emergency drop (-8%/hr) sell was blocked by the $1 net profit filter. New `emergency_partial_sell` action type bypasses profit check for capital preservation
- **Grid sell minimum too high** — Lowered grid sell minimum profit from $1.00 to $0.25 for grid trades, making SIDEWAYS grid trading viable for smaller positions
- **Whois plugin error noise** — Removed redundant `logger.error` from whois plugin init when API key is missing; apiManager already handles this gracefully by registering the plugin as disabled

### Added
- **PUMP regime wide trailing stop** — New 12% trailing stop in PUMP regime (activates when peak gain >= 10%) prevents giving back large unrealized gains during pump consolidation
- **25% scale-out level** — Added intermediate scale-out at +25% to close the gap between 20% and 30%. New levels: [10, 20, 25, 30, 40, 50] with rebalanced sizing
- **Dollar Maximizer idle capital easing** — Gradually tightens buy threshold after 7+ days holding stablecoins (linear ramp to 50% easing over 21 days) to deploy idle capital instead of waiting indefinitely
- **SKYNET service eligibility filtering** — Whitelisted 17 safe categories, removed financial data and privacy-sensitive services. Services from disabled plugins are excluded
- **SKYNET market pricing** — `GET /p2p/api/skynet/token-price` fetches live SKYNET price from PancakeSwap V2 LP reserves. `POST /p2p/api/skynet/services/market-prices` auto-prices services based on USD tiers
- **SKYNET UI confirmation prompts** — Save Settings, Reset, Enable All Free, Disable All, and Vote buttons now require confirmation before executing
- **SKYNET governance vote stacking** — Vote buttons stacked vertically for mobile-friendly layout
- **SKYNET live economy intent** — Intent 118 (`skynetEconomyLive`) fetches live data marketplace listings, arb signals, referral history, and compute jobs
- **Dynamic bounty/proposal context** — System prompt auto-refreshes current open bounties and active governance proposals every 5 minutes

### Changed
- **Token Trader config v6** — Scale-out sizing rebalanced: {10:10%, 20:10%, 25:15%, 30:15%, 40:20%, 50:30%}
- **SKYNET service count** — Reduced from 693 to ~36 eligible services (17 safe categories, enabled plugins only)

### New API Endpoints
- `GET /p2p/api/skynet/token-price` — Live SKYNET token price from LP reserves
- `POST /p2p/api/skynet/services/market-prices` — Set market-rate prices for all services

## [2.14.2] - 2026-02-25

### Added
- **SKYNET Token Utilities — 12 features implemented:**
  - **Data Marketplace** — P2P data listing/purchase with SKYNET payments (DataListing model, API routes)
  - **Concentrated Liquidity V3 LP** — PancakeSwap V3 NonfungiblePositionManager integration (mint, remove, collect fees, rebalance)
  - **On-chain Staking Service** — `skynetStakingService.js` for stake/unstake/claim with contract integration
  - **Automated Contract Audit** — Slither audit: 0 vulnerabilities, 5 informational findings
  - **Skynet Token Settings UI** — Web UI section for configuring SKYNET token address
  - **ERC-8004 Peer Verification** — On-chain verification of peer agent identity via BSC registry
  - **Staking Yield Distribution** — Weekly scheduled job distributing from 20M staking pool by peer participation score
  - **Knowledge Pack Pricing** — Optional SKYNET price on premium knowledge packs with payment-before-delivery flow
  - **Arbitrage Signal Sharing** — Auto-broadcast profitable arb signals to P2P peers from ArbitrageStrategy
  - **Compute Rental** — P2P compute job execution with timeout/memory limits and per-minute pricing
  - **Service Priority Queue** — SKYNET-tipped service requests get priority execution (sorted by tip amount)
  - **Referral Rewards** — Referral tracking and stats between peers (SkynetReferral model)

### New Models
- `DataListing` — P2P data marketplace listings
- `SkynetReferral` — Referral reward tracking
- `ArbSignal` — Arbitrage signal storage
- `ComputeJob` — P2P compute job execution tracking

### New Files
- `src/core/agentAccessor.js` — Lightweight global agent singleton accessor
- `src/services/crypto/skynetStakingService.js` — On-chain staking service
- `src/models/DataListing.js`, `SkynetReferral.js`, `ArbSignal.js`, `ComputeJob.js`

### New API Endpoints
- `GET /p2p/api/skynet/data-listings` — Data marketplace listings
- `POST /p2p/api/skynet/data-listings` — Create data listing
- `GET /p2p/api/skynet/arb-signals` — Recent arbitrage signals
- `GET /p2p/api/skynet/referrals` — Referral reward stats
- `GET /p2p/api/skynet/compute-jobs` — Compute job history
- `GET/POST /api/settings/skynet-token-address` — Token address settings

### New P2P Message Types
- `data_listing_post`, `data_purchase_request`, `data_purchase_response`
- `referral_reward`, `arb_signal`
- `compute_request`, `compute_response`, `compute_payment_required`
- `knowledge_pack_payment_required`

## [2.14.1] - 2026-02-25

### Added
- **SKYNET Agent Knowledge** — ALICE now has full knowledge of SKYNET token and Skynet P2P network in her system prompt
  - Answers "What is SKYNET?", "Do I need SKYNET tokens?", "How does the P2P network work?", etc. from built-in knowledge
  - 3 new NLP intents: `skynetInfo` (115), `skynetNetworkStatus` (116), `skynetTokenInfo` (117)
  - Intent 115: General SKYNET/Skynet questions → answered from enriched system prompt
  - Intent 116: Live Skynet network status → queries P2PPeer, SkynetServiceConfig, SkynetBounty, SkynetGovernance models
  - Intent 117: Live SKYNET token data → queries SkynetTokenLedger, SkynetPayment models with allocation breakdown

## [2.14.0] - 2026-02-24

### Added
- **SKYNET Token Economy — Full Implementation (Phases 1–5)**

#### Phase 1: Token Contract & Foundation
- **SKYNET BEP-20 token deployed to BSC** — 100M fixed supply, no tax, OpenZeppelin ERC20+Ownable. Contract: `0x8Ef0ecE5687417a8037F787b39417eB16972b04F`. 14 unit tests passing
- **SKYNET/BNB liquidity pool** — Initial PancakeSwap V2 pool with 50M SKYNET + 0.5 BNB. Pair: `0xF3dEF3534EEC3195e0C217938F710E6F2838694A`
- **SkynetTokenLedger model** — Internal accounting for minted vs bought tokens with trading guards
- **SKYNET permanent Token Trader watchlist** — System token with lock icon, cannot be removed

#### Phase 2: Skynet Paid Services
- **P2P service protocol** — 6 new message types: `service_catalog_request/response`, `service_request`, `service_result`, `service_error`, `payment_required`
- **SKYNET BEP-20 payment verification** — Transfer event log parsing, double-spend prevention (NodeCache + DB), 3-block confirmations, 5% amount tolerance
- **SkynetServiceConfig model** — Per-operation enable/disable, SKYNET pricing, rate limiting
- **SkynetServiceExecutor** — Full service execution pipeline: catalog → verify payment → execute plugin → sanitize → respond
- **Web UI Services tab** — Per-operation pricing toggles, bulk controls, revenue dashboard, payment history, service sync

#### Phase 3: Liquidity Management
- **V2 Liquidity methods** — `addLiquidity()`, `removeLiquidity()`, `getLPInfo()` in swapService
- **LPManager service** — Position tracking with LPPosition model, add/remove with auto-tracking, refresh, stats
- **LP API routes** — GET/POST positions, refresh, add/remove liquidity, LP info
- **Web UI LP section** — Liquidity positions card in crypto tab

#### Phase 4: Reputation Staking
- **Trust score system** — Composite 0-100 score: manual trust (30), ERC-8004 (20), SKYNET balance (20, log scale), longevity (15), activity (15)
- **On-chain balance verification** — SKYNET balance announced in capability exchange, verified via BSC RPC
- **Trust score UI** — Score badges on peer cards, SKYNET balance with verification indicator

#### Phase 5: Extended Economy
- **Bounty system** — SkynetBounty model, post/claim/complete workflow, broadcast to peers
- **Governance voting** — SkynetGovernance model, token-weighted proposals, for/against/abstain
- **Agent tipping** — `tip_received` message type with event emission
- **SkynetEconomy service** — Handles bounties, governance, tipping
- **Web UI Economy tab** — Bounties list, governance proposals with voting UI, economy stats

### Changed
- **P2P capability exchange** — Now includes wallet address, SKYNET token address, SKYNET balance, and ERC-8004 identity for reputation staking
- **P2PPeer model** — Added `skynetWallet`, `skynetTokenAddress`, `skynetCatalog`, `skynetBalance`, `skynetBalanceVerified`, `trustScore` fields
- **messageHandler.js** — Added 12 new message type handlers (6 service + 6 economy), ERC-8004 identity exchange
- **p2pService.js** — Added SkynetServiceExecutor and SkynetEconomy initialization, economy broadcast methods

### Enhanced
- **SKYNET in arbitrage scanner** — Added SKYNET token to default scan tokens for cross-DEX arbitrage on BSC
- **Token trader balance in wallet UI** — Balances section now shows the active token trader token (e.g., SIREN) with its current balance

### Fixed
- **BigInt serialization in LP info** — `getLPInfo()` returned raw BigInt that crashed `JSON.stringify()`. Now converts to string
- **responseSanitizer stack overflow** — `sanitizeValue()` infinite-looped on circular object references. Added WeakSet visited-set guard
- **Service sync found 0 services** — Sync used `plugin.getActions()` but apiManager stores `{instance, enabled}` wrappers. Fixed to use `plugin.instance.commands` for proper plugin discovery
- **ERC-8004 status stuck at "minted"** — Mint function now sets status to "active" instead of "minted". Existing DB entries migrated
- **ERC-8004 auto-link wallet** — `linkWallet()` is now automatically called after minting so the on-chain identity is linked to the wallet
- **ERC-8004 peer scaffolding wired** — P2PPeer `erc8004` field is now populated from capability exchange messages (was dead scaffolding)
- **Token watchlist lost on config migration** — `tokenWatchlist` was missing from `userSetFields` in TokenTraderStrategy, causing user-added tokens to be discarded during config version bumps
- **Test script wrong API paths** — Token trader and strategy endpoints were hitting wrong URL paths (missing `/strategy/` prefix)

## [2.13.8] - 2026-02-24

### Added
- **HuggingFace Qwen2.5-Coder-32B-Instruct model** — Added Qwen/Qwen2.5-Coder-32B-Instruct to the available HuggingFace chat models list. Specialized coding model accessible via the HuggingFace router with `:fastest` and `:cheapest` provider policy support
- **Twitter poll results** — New `fetchPollResults` command on Twitter plugin fetches poll choices, vote counts, total votes, and time remaining using correct FxTwitter API fields (`poll.choices[].label`, `poll.choices[].count`)
- **Custom transcoding profiles** — `/convert` endpoint now accepts `customProfile` JSON with `videoCodec`, `audioCodec`, `resolution`, `videoBitrate`, `audioBitrate`. Validates against codec allowlists and format patterns for security
- **PDF annotation endpoint** — New `POST /annotate` route on PDF toolkit draws highlights, comments, and shapes onto PDF pages using pdf-lib (merged from PR #1652)
- **Weatherstack forecast** — New `getWeatherForecast` command on Weatherstack plugin fetches multi-day forecasts via `/forecast` endpoint with `forecast_days` parameter (merged from PR #1653)
- **Vonage messageId in SMS/MMS responses** — `sendSms` and `sendMms` now return `messageId` from the Vonage API response for downstream tracking

### Changed
- **PR review batch** — Reviewed 17 AI-generated PRs (#1641–#1658). Merged 2 clean PRs, closed 12 with fundamental issues, reimplemented 3 features manually with correct code

## [2.13.7] - 2026-02-23

### Added
- **Token trader 40% scale-out level** — Added intermediate scale-out at +40% to close the dangerous 20% gap between 30% and 50% thresholds. Scale-out sizing rebalanced: `{10: 10%, 20: 15%, 30: 20%, 40: 20%, 50: 35%}`
- **Pump stall detection** — Time-based partial profit-taking: if token stays in PUMP regime for 6+ hours without hitting the next scale-out level, automatically sells 10% of position. Prevents indefinite holding during consolidation. Tracked via `pumpEnteredAt` and `lastPumpStallSell` state fields
- **Crypto diagnostic prompt docs** — Full diagnostic prompt at `docs/claude/CLAUDE_CRYPTO_DIAG.md` and quick reference at `docs/claude/CLAUDE_CRYPTO_QUICK.md` with current state, thresholds, API endpoints, log patterns, and deployment checklist

### Changed
- **PUMP trailing stop tightened** — Reduced `pumpTrailingStopPercent` from 6% to 4.5% below peak price in PUMP/MOON regimes. Protects more unrealized gains on small-cap tokens where 6% swings happen quickly
- **Token trader config version** — Bumped to v5 with automatic migration from v4 on restart. Migration applies new scale-out levels, trailing stop, and stall detection settings
- **Web UI menu ordering** — Moved "External Services" to correct alphabetical position (between Emails and Feature Requests)

### Fixed
- **all-activity.log rotation** — Reduced maxsize from 50MB to 30MB, increased maxFiles from 3 to 5, added `tailable: true` for reliable Winston file rotation. Fixes log stall observed on Feb 22 when file hit 50MB limit

## [2.13.6] - 2026-02-22

### Added
- **Daily status report overhaul** — Rewrote `generateWeeklyReport()` in scheduler with parallel data gathering. Fixed memory activity querying `$metadata.source` instead of `$source`, fixed scheduled job run counting to estimate actual runs from intervals, added AI usage stats (token counts, costs, model breakdown), crypto stats, media stats (Sonarr/Radarr), and self-improvement stats sections
- **yt-dlp video format routing** — `downloadAudio()` now detects video formats (mp4, mkv, webm, etc.) and redirects to `downloadMedia()` instead of normalizing to audio. Fixes issue where NLP routing to audio handler with `format: mp4` would produce an mp3
- **yt-dlp audio format validation** — Invalid audio formats are caught early with proper normalization instead of passing to yt-dlp
- **LAN download links for large files** — When video files exceed Telegram's 50MB limit, provides `http://localhost:3000/downloads/filename` link. Added `/downloads` static route to web interface
- **Telegram video size handling** — Pre-flight file size check before sending video, with document fallback for files between 50-2000MB
- **Agent stats compare command** — New `agentstats compare [days]` plugin command compares improvement stats between current and previous N-day periods using `ImprovementMetrics.getMetricsForRange()`
- **Market indicators historical tracking** — `MarketIndicators` now tracks historical data points with bounded storage (max 1000 per indicator), with `calculateMovingAverage()` and `calculateVolatility()` methods for trend analysis
- **NumbersAPI batch processing** — New `batch` command processes multiple fact requests in parallel via `Promise.all`
- **Scraping retry improvement** — Scraping endpoint now properly converts retryable failures into thrown errors so `retryOperation` actually retries. Added health check endpoint

### Changed
- **PR review batch** — Reviewed 12 AI-generated PRs (#1626–#1640). Merged 2 clean PRs, closed 8 with fundamental issues (non-existent methods, syntax errors, breaking exports, security risks, dead code). Reimplemented 2 features correctly from closed PRs

### Fixed
- **LAN download URL** — Fixed missing slash between `/downloads` and filename in Telegram download links
- **Scheduled job count** — `_parseIntervalToMs()` now checks human-readable format first before cron to avoid misclassifying intervals like "5 minutes" as cron expressions
- **Job success rate capping** — Success rate now capped at 100% to prevent >100% display from accumulated counts

## [2.13.5] - 2026-02-21

### Added
- **NOT operator for filtered log transport** — `FilteredFileTransport` now supports `NOT` logical operator in addition to `AND`/`OR`, allowing exclusion-based log filtering
- **\*Arr notification management** — `ArrBasePlugin` gains `getNotifications()`, `createNotification()`, and `deleteNotification()` methods with proper error handling and cache invalidation. Available to all \*arr plugins (Radarr, Sonarr, Lidarr, Readarr, Prowlarr)
- **Multi-format image generation** — External image generation endpoint now accepts `format` parameter (png, jpeg, webp, tiff) with early validation before generation. Uses sharp for format conversion. Default remains png
- **HealingEvent cooldown cache** — `isInCooldown()` now caches results via NodeCache to avoid repeated MongoDB queries during cooldown periods
- **Preference history tracking** — `UserPreference.setPreferences()` now saves snapshots to `UserPreferenceHistory` collection before updates. New `getPreferenceHistory()` method for audit trail
- **FeatureRequest error logging** — 5 static query methods now log errors via logger before re-throwing
- **ScanProgressCache retry resilience** — MongoDB operations wrapped in `retryOperation()` for transient failure recovery

### Changed
- **PR review batch** — Reviewed 22 AI-generated PRs (#1604–#1625). Merged 4 safe PRs, closed 15 with fundamental issues (wrong imports, dead code, broken APIs, rogue Express servers, async/sync bugs, fabricated endpoints). Salvaged and correctly implemented 3 features manually

## [2.13.4] - 2026-02-19

### Added
- **Batch typed data signature verification** — New `POST /api/signatures/verify-typed-data-batch` endpoint delegates to existing `signatureService.verifyTypedDataSignaturesBatch()` for verifying multiple EIP-712 signatures sequentially with retry logic
- **Account listing cache** — Account list queries cached for 5 minutes with proper invalidation on all write operations (register, bulk-register, manual add, status update, bulk status update, delete, credentials update, primary change). Sorted JSON cache keys ensure consistent lookups
- **Self-modification validation hardening** — 5 new blocking checks to prevent low-quality AI PRs:
  - Dead imports now block PR creation (previously just a warning, ignored 85% of the time)
  - New import paths verified against filesystem (prevents crash-on-load PRs)
  - Trivial changes detected (import-only PRs with no real code blocked)
  - Unreachable functions detected (new functions that are never exported or called)
  - Placeholder URLs blocked (e.g., `api.example.com`)
  - Trailing newline auto-fix (POSIX compliance)
  - retryOperation misuse warning for filesystem operations

### Changed
- **PR review batch** — Reviewed and closed 13 AI-generated PRs (#1591–#1603). Common issues: unused NodeCache imports, wrong import paths, dead code, description-implementation mismatch, breaking changes to sync callers. Salvaged and correctly implemented 3 features
- **Registry client cleanup** — Removed unused `isRetryableError` import from P2P registry client

## [2.13.3] - 2026-02-18

### Added
- **Batch document processing endpoint** — New `POST /api/external/documents/process/batch` endpoint processes up to 10 files in parallel using `safePromiseAll`, with proper `validateMagicBytesArray` middleware. Original single-file endpoint preserved
- **Scraping retry + caching** — External scraping endpoint now retries failed requests (3 attempts) and caches successful results for 10 minutes with composite cache keys (action + URL + selectors)
- **Identity verification circuit breaker** — External auth middleware now tracks consecutive failures and opens circuit after 5 failures, fast-failing for 30 seconds before allowing a test request (HALF_OPEN state). Prevents hammering blockchain providers during outages
- **Peer grouping** — P2P PeerManager groups peers by trust level and capabilities hash for efficient lookup. Properly removes peers from old groups when trust level or capabilities change
- **Market indicator batch fetch** — `MarketIndicators.getCachedValues()` fetches multiple cached indicators concurrently via `Promise.all`

### Changed
- **PR review batch** — Reviewed and closed 10 AI-generated PRs (#1581–#1590). Closed 5 with fundamental issues (fabricated API endpoints, non-existent dependencies, anti-patterns, breaking changes). Implemented 5 features manually with corrected code

## [2.13.2] - 2026-02-18

### Added
- **Grid trading adaptive spacing** — Grid spacing now dynamically adjusts based on real-time price volatility. Tracks rolling price history per symbol, calculates standard deviation of returns, and scales grid spacing from 0.5x (calm markets) to 2.5x (volatile markets) of the configured base. Grid stats now include current volatility multiplier per symbol
- **Sandbox language expansion** — Added C (gcc:14), C++ (gcc:14), TypeScript (tsx via node:20-alpine), Perl (perl:5.40-slim), and Kotlin (zenika/kotlin:1.9) to the code execution sandbox, bringing total supported languages to 14

### Changed
- **PR review batch** — Reviewed and closed 19 AI-generated PRs (#1559–#1580) with detailed comments. Common issues: wrong import paths, unused imports/instances, stub methods, broken validation logic, crash-on-load bugs. Salvaged adaptive grid spacing concept from PR #1577 and sandbox language expansion from PR #1578, implementing both manually with correct code

## [2.13.1] - 2026-02-16

### Changed
- **Skynet rename** — P2P Federation UI renamed to "Skynet" throughout the web interface, menu moved to alphabetical S section
- **Skynet enable/disable toggle** — Enable/disable Skynet from the web UI with confirmation dialog instead of requiring `.env` file changes. Backed by SystemSettings with dynamic service start/stop (no restart needed). Agent startup checks SystemSettings first, falls back to `P2P_ENABLED` env var

### Fixed
- **Skynet toggle on mobile** — Self-contained toggle switch that renders correctly on all screen sizes
- **Fingerprint display on mobile** — Horizontal scroll instead of character wrapping

## [2.13.0] - 2026-02-16

### Added
- **P2P Knowledge Packs** — Structured, signed packages of memories that agents can discover, evaluate, and import via the LANP federation protocol
  - KnowledgePack Mongoose model with full lifecycle tracking (draft/published/transferring/awaiting_approval/evaluating/approved/rejected/importing/imported/failed)
  - KnowledgePackSharing service mirroring the pluginSharing chunked transfer pattern (64KB chunks, SHA-256 per-chunk + full-content verification, Ed25519 manifest signing)
  - Content validation: type restriction (knowledge/learned/preference/fact only), size limits (500 memories, 10KB each, 5MB total), executable code scanning (eval, require, child_process, etc.)
  - AI safety evaluation: structured prompt checks for destructive instructions, data exfiltration, social engineering, embedded code, PII — with topic whitelist support
  - Import pipeline: iterates pack memories through `memoryManager.store()` for automatic embedding generation, deduplication, and vector indexing
  - Pack creation from existing memories with query filters (type, tags, category, min importance)
  - 7 new P2P message types for knowledge pack protocol
  - 10 new REST API endpoints under `/p2p/api/knowledge-packs` and `/p2p/api/peers/:fingerprint/knowledge-packs`
  - Web UI Knowledge subtab with Available, Pending Approval, My Packs, and Imported views
  - Create Pack modal with memory query filters (type, tags, importance)
  - Settings: auto-import toggle and topic whitelist (saved via SystemSettings)

## [2.12.1] - 2026-02-15

### Fixed
- **Email parameter extraction errors** — When AI parameter extraction failed (JSON parse error, contact not found), the error was silently swallowed and plugins executed with empty parameters, causing confusing validation errors like "Required field 'subject' is missing" instead of the actual error message. Now returns the real error to the user. (Fixes #1538, #1539)
- **Contact search fallback regex** — `extractFindContactParams()` fallback regex used a lazy quantifier that only captured the first word of multi-word names (e.g. "John" instead of "John Smith"). Fixed to greedy match.

## [2.12.0] - 2026-02-15

### Added
- **P2P Federation (LANP)** — End-to-end encrypted multi-instance networking via WebSocket relay at `registry.lanagent.net`
  - Ed25519 identity generation with SHA-256 fingerprint for authentication
  - X25519 ECDH key exchange + AES-256-GCM encryption for all peer messages
  - Trust On First Use (TOFU) peer verification with signing key mismatch detection
  - WebSocket registry client with exponential backoff reconnection (5s–60s)
  - Peer discovery, online/offline presence tracking, capabilities exchange
  - Chunked plugin sharing (64KB chunks) with per-chunk and full SHA-256 verification
  - Ed25519 manifest signing for plugin authenticity verification
  - Source code sanitization pipeline strips env vars, API keys, IPs, paths, passwords, credentials before sharing
  - Plugin approval workflow: auto-install from trusted peers, manual approval for untrusted
  - P2PPeer and P2PTransfer MongoDB models for peer tracking and transfer history
  - Web UI Federation page with Status, Peers, Transfers, Pending Approvals, and Settings subtabs
  - Settings page: enable/disable federation, registry URL, display name, auto-share and auto-install toggles
  - Mobile-responsive subtabs (icon-only on small screens) and fingerprint display
  - 13 REST API endpoints under `/p2p/api/`
  - Standalone registry server (`lanagent-registry/`) deployed to `registry.lanagent.net` with nginx + SSL + PM2
  - Federation is opt-in (`P2P_ENABLED=true`)

## [2.11.0] - 2026-02-14

### Added
- **Nano faucet automation** (thenanobutton.com) — Puppeteer-based browser automation with Xvfb virtual display, Turnstile captcha handling, auto-pocket after withdrawal. Currently disabled (Turnstile blocks automation).
  - New `nanoButtonFaucet.js` with screenshot diagnostics, cooldown management, detailed logging
  - API endpoints: `POST /api/faucets/claim/nano`, `GET /api/faucets/nano/status`
- **External service toggle confirmations** — toggle switches (replacing checkboxes) with confirmation modal before enabling/disabling services, matching the plugin page pattern
- **Token watchlist UI** — watchlist panel on crypto page for tracking rotation candidates

### Fixed
- **Nano RPC endpoints** — replaced dead mynano.ninja/proxy.nanos.cc with working rainstorm.city/api as primary; added 429 rate limit handling with exponential backoff
- **Nano representative address** — fixed invalid DEFAULT_REPRESENTATIVE that caused "Invalid representativeAddress" errors on receive
- **Transaction labels** — swaps now correctly categorized as `trade_sell`/`trade_buy` instead of misleading `defi_yield`/`service_payment`
- **Token symbol resolution** — fixed KNOWN_TOKEN_SYMBOLS map with correct contract addresses for FHE, SIREN, LINK
- **Revenue API 429 errors** — increased rate limit from 100 to 300 requests per 15 minutes
- **Refresh balances 401** — fixed missing auth header on `/api/crypto/refresh-balances` POST calls
- **Nano balance display** — capped decimal places to 6 to prevent mobile overflow from 30-digit raw values
- **Mobile CSS** — balance values properly constrained with max-width and text-overflow

## [2.10.99] - 2026-02-14

### Added
- **Nano (XNO) wallet support** — feeless, instant-settlement cryptocurrency with full send/receive/faucet integration
  - New `nanoService.js` with RPC failover (rpc.nano.to, proxy.nanos.cc), balance caching, Proof of Work delegation
  - 6 REST API endpoints: `/api/crypto/nano/balance`, `/account-info`, `/send`, `/receive`, `/receivable`, `/status`
  - Auto-receive monitor (5-minute interval) pockets incoming blocks automatically
  - Nano faucet integration (NanoDrop) with auto-pocket after claim
  - Web UI: Nano icon, XNO balance display, Pocket Receivable / Check Pending / Send XNO action buttons
  - NLP intents: "receive nano", "pocket nano", "claim nano faucet", plus XNO/NANO support in sendCrypto
  - Existing wallet migration: derives Nano address from encrypted mnemonic on first startup
  - `nanocurrency-web` dependency for BIP39-to-Nano key derivation, block signing, unit conversion

## [2.10.98] - 2026-02-13

### Added
- **Sandbox: PHP, Java, and Rust language support** — expanded code execution sandbox from 5 to 8 languages
  - PHP 8.3 (reads from stdin)
  - Java 17 via Eclipse Temurin (compiled to exec-enabled tmpfs)
  - Rust 1.84 (compiled to exec-enabled tmpfs)
  - Compiled languages get a separate `/build` tmpfs with exec permissions while `/tmp` stays `noexec` for security

### PR Review
- Reviewed 2 AI-generated PRs (#1494–#1495): closed both, manually implemented sandbox language expansion from #1495 with security fixes
  - **Closed #1494** (PositionIndicators.js): Fundamentally broken — wrong import path, unused import, dead feature (storeHistoricalData never called), math on wrong types (NaN), duplicates TechnicalIndicators.js
  - **Closed #1495** (sandbox.js): Good idea, bad implementation — Java/Rust fail due to noexec on /tmp, PHP stdin handling broken. Implemented manually with proper exec tmpfs separation

## [2.10.97] - 2026-02-13

### Added
- **Checkly plugin: create and delete checks** — merged PR #1492, added `create_check` and `delete_check` commands to the Checkly monitoring plugin with proper cache invalidation

### PR Review
- Reviewed 8 AI-generated PRs (#1486–#1493): merged 1 with fixes, closed 7 with explanatory comments
  - **Merged #1492** (checkly.js): Added create/delete check commands, fixed missing cache invalidation
  - **Closed #1486** (MqttDevice.js): Dead code, architectural conflict with existing event engine
  - **Closed #1487** (download.js): Wrong import path, broken retry logic on res.download()
  - **Closed #1488** (faucets.js): Added opossum circuit breaker when retryUtils already provides one
  - **Closed #1489** (embeddingService.js): Duplicated existing providerManager functionality
  - **Closed #1490** (prowlarr.js): Called nonexistent scheduleJob() method, would crash at runtime
  - **Closed #1491** (intentIndexer.js): Single unused import line, no functional change
  - **Closed #1493** (NetworkDevice.js): Dead code and division-by-zero bugs

## [2.10.96] - 2026-02-13

### Added
- **Telegram notifications for external gateway payments** — owner is notified in real-time via Telegram when external agents pay for services; includes service name, agent ID, amount, TX hash, and confirmations

### Fixed
- **External services admin dashboard dates** — fixed "Invalid Date" on all dates in the external services page; `.lean()` was returning raw BSON types that serialized as empty objects instead of ISO date strings

## [2.10.95] - 2026-02-13

### Added
- **DCA Strategy: Volatility-based buy interval adjustment** — dynamically adjusts buy intervals based on market volatility index; high volatility halves intervals, low volatility doubles them
- **Bug report history tracking** — status changes are now tracked in a `history` array on BugReport documents for audit trails
- **Validation result caching** — input validation results are cached with NodeCache (5-min TTL) to avoid redundant revalidation of repeated inputs
- **Account lifecycle management** — AutoAccount model now has `deactivateAccount()`, `reactivateAccount()`, and `archiveAccount()` methods
- **Strategy dependency management** — StrategyRegistry checks strategy dependencies before activation, preventing strategies from running without required dependencies

### Improved
- **Web scraper retry logic** — replaced manual retry loops with `retryOperation` utility, removed unused playwright import
- **SSH session timeout management** — sessions auto-terminate after configured max duration using `safeTimeout`
- **MCP server status updates** — `updateStatus()` now uses retryOperation for resilience against transient DB errors
- **External catalog performance** — added NodeCache caching (5-min TTL) and rate limiting (100 req/15min) to catalog route
- **Runtime error trend queries** — `getErrorTrends()` now cached with NodeCache and uses retryOperation for DB resilience
- **Gravatar profile caching** — `fetchGravatarProfile()` results cached with NodeCache (1-hour TTL) to reduce API calls
- **Image generation resilience** — external image generation endpoint now retries failed generation attempts

### PR Review
- Reviewed 24 AI-generated PRs: merged 8, manually implemented 4 with fixes, closed 12 with explanatory comments

## [2.10.94] - 2026-02-13

### Added
- **Agent self-awareness for external services** — ALICE now knows about her external gateway, all 8 services with pricing, payment flow, and admin capabilities in her system prompt
- **NLP intent: external service stats** (intent 114) — Users can ask "show external service stats", "how much revenue", "what payments have you received" and get full revenue, service list, recent payments
- **Updated about me and features list** with external service gateway section
- **Test scripts**: `scripts/verify-live.sh` (16-check live verification) and `scripts/test-self-purchase.sh` (full end-to-end payment flow test)
- **Self-purchase validated**: ALICE paid herself 0.002 BNB, executed Python sandbox code, verified replay protection and fake TX rejection all pass

## [2.10.93] - 2026-02-13

### Added
- **External Gateway: Code Execution Sandbox** (`POST /api/external/sandbox/execute`)
  - Execute Python, Node.js, Bash, Ruby, or Go code in isolated Docker containers
  - Full sandboxing: `--network none`, `--read-only`, 256MB RAM, 2 CPU cores, 64 PID limit, non-root user
  - Code piped via stdin (prevents shell injection), 64KB max, 30s timeout
  - Pre-pulled alpine images for instant cold starts
  - Pricing: 0.002 BNB per execution, rate limit 10/15min
- **External Gateway: PDF Toolkit** (5 endpoints under `/api/external/pdf/`)
  - Merge (`POST /merge`): combine 2-20 PDFs into one
  - Split (`POST /split`): extract page ranges (e.g. "1-5,8,10-12")
  - Compress (`POST /compress`): Ghostscript compression with screen/ebook/printer quality
  - Watermark (`POST /watermark`): overlay text on all pages with configurable opacity/position
  - Extract (`POST /extract`): text extraction with metadata (title, author, dates)
  - Uses pdf-lib for manipulation, pdf-parse for extraction, Ghostscript for compression
  - Pricing: 0.0005 BNB per operation, rate limit 20/15min
- Multi-file magic byte validation (`validateMagicBytesArray`) for PDF merge uploads
- VPS nginx whitelist updated with `/api/external/sandbox/` and `/api/external/pdf/` paths

### Dependencies
- Added `pdf-lib` ^1.17.1 (pure JS PDF manipulation)
- Installed `ghostscript` on production server

## [2.10.92] - 2026-02-13

### Added
- **ERC-8004 Phase 3 — External Service Gateway**
  - 6 paid services exposed to external AI agents via BNB on-chain payment: YouTube download (MP4/MP3), media transcoding, AI image generation, web scraping, document processing (OCR)
  - x402-style payment flow: 402 responses with payment instructions, on-chain BNB verification (3 confirmations, 5% tolerance, double-spend prevention)
  - ERC-8004 identity authentication: verify caller agents on-chain via `ownerOf()` on Identity Registry
  - JWT-signed download tokens with configurable expiry and download limits
  - Public service catalog at `GET /api/external/catalog` (no auth required)
  - Secure file upload pipeline: multer disk storage, random filenames, MIME whitelist, magic byte validation, VirusTotal hash scanning, auto-cleanup
  - Admin Web UI tab: service management (enable/disable, pricing), kill switch toggle, revenue stats, audit log
  - Registration file now includes enabled services with pricing and external endpoints
  - Response sanitizer: strips internal IPs, paths, hostnames, stack traces from all external responses
  - VPS reverse proxy: WireGuard tunnel, nginx + Let's Encrypt SSL, UFW firewall (only 22/80/443/51820)
  - Kill switch: emergency disable all external services

### Fixed
- Whois plugin now gracefully registers as disabled when API key is missing (instead of throwing error to log)

## [2.10.91] - 2026-02-12

### Added
- **ERC-8004 Phase 2 — NFT Display, Telegram, linkWallet**
  - Web UI: Full NFT card display when minted — 120px avatar with glow, "AgentIdentity (AGENT) #2930" title, BSC chain badge, metadata grid (owner, minted date, IPFS avatar, IPFS registration), BscScan NFT link, IPFS gateway links
  - Web UI: One-time staleness notification via `showNotification()` when capabilities have changed since last on-chain update
  - Web UI: "Link Wallet" button — calls `setAgentWallet()` on-chain via EIP-712 signed message
  - Web UI: All ERC-8004 buttons hardened with double-click guards, confirm dialogs mentioning gas costs, and loading spinners
  - Telegram: New `getAgentNFT` intent (#113) — "show me your NFT", "what is your agent ID", "ERC-8004 identity", etc.
  - Telegram: NFT handler returns avatar photo with caption (Agent ID, chain, BscScan link, IPFS links, staleness warning) or text if not minted
  - `POST /api/agent/erc8004/link-wallet` — Link wallet via EIP-712 `SetAgentWallet` typed data signing and on-chain `setAgentWallet()` call
  - Agent model: `linkedWallet` and `walletLinkedAt` fields added to `erc8004` subdocument
  - Identity status endpoint now returns `linkedWallet`, `walletLinkedAt`, and `nftUrl`

## [2.10.90] - 2026-02-12

### Fixed
- **ERC-8004 Minting** — Fixed critical bugs preventing on-chain minting:
  - Corrected BSC registry address from testnet (`0x8004A818...`) to mainnet (`0x8004A169...`) using official [erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) deployment
  - Fixed wallet address lookup (`chain` field instead of `network`) in transactionService
  - Fixed encrypted seed access (`encryptedSeed` field instead of `seed`) in transactionService
  - Aligned wallet signer creation with proven swapService approach (`Wallet.fromPhrase`)
  - Disambiguated `register()` call for overloaded ABI using `contract['register(string)']`
  - Added full ERC-8004 ABI (metadata, events, wallet management functions)
  - Added `Registered` event parsing for agentId extraction from mint receipt
  - Successfully minted Agent #2930 on BSC mainnet

## [2.10.89] - 2026-02-11

### Added
- **ERC-8004 Agent Identity** — On-chain identity NFT system for AI agents:
  - `GET /api/agent/erc8004/status` — Identity status, chain, agentId, staleness detection, gas estimate
  - `POST /api/agent/erc8004/registration` — Generate and preview registration file JSON
  - `POST /api/agent/erc8004/mint` — Upload avatar + registration to IPFS via Pinata, call `register()` on Identity Registry
  - `PUT /api/agent/erc8004/update` — Re-upload registration to IPFS, call `setAgentURI()` on-chain
  - `POST /api/agent/erc8004/pinata-key` — Save encrypted Pinata IPFS API keys
  - `GET /api/agent/erc8004/pinata-key` — Check Pinata key configuration status
  - Registration file includes agent name, version, avatar, 87 plugin capabilities with hashes, interface endpoints
  - Capabilities hash (SHA-256) enables staleness detection when plugins change
  - BSC and Ethereum registry addresses embedded; BSC default (~$0.01 gas)
  - Agent model extended with `erc8004` subdocument (status, chain, agentId, txHash, agentURI, IPFS CIDs)
  - Pinata keys hydrated from encrypted database on startup
  - Web UI: ERC-8004 card in Crypto tab with status badge, avatar, registration preview, Pinata key config, mint/update/explorer buttons
  - Web UI: Identity status row added to Overview tab Agent Information card
  - New service: `src/services/crypto/agentIdentityService.js`

## [2.10.88] - 2026-02-11

### Improved
- **FCM Plugin** — Added `retryOperation` with exponential backoff on all HTTP calls; `sendBulkMessages` now batches tokens in groups of 1000 (FCM limit) with `Promise.allSettled` for partial result reporting
- **jsonplaceholder Plugin** — Switched from `Map` to `NodeCache` with automatic TTL expiration; all axios calls wrapped with `retryOperation` and context strings for better retry logging; selective cache invalidation in `createPost` (only clears posts-related keys)

### Maintenance
- Reviewed and closed 10 AI-generated PRs (#1450–#1460) from self-modification service — common issues: unused imports, wrong import paths, fabricated API endpoints, stub methods, breaking async changes

## [2.10.87] - 2026-02-11

### Added
- **Gravatar OAuth2 Flow** — Browser-based WordPress.com OAuth authorization for Gravatar avatar uploads:
  - `GET /api/gravatar/oauth/authorize` — Start OAuth flow, returns authorize URL with CSRF state token
  - `GET /api/gravatar/oauth/callback` — Handles redirect from WordPress.com, exchanges code for access token
  - `GET /api/gravatar/oauth/status` — Check OAuth connection status (connected/not connected)
  - `POST /api/gravatar/oauth/disconnect` — Remove stored OAuth token
  - Token stored encrypted in MongoDB via PluginSettings, hydrated on startup
  - OAuth scope `auth gravatar-profile:manage` for avatar write access
  - Settings UI with Connect/Disconnect buttons and live connection status
  - Auto-crops non-square images to square via sharp before uploading to Gravatar
- **Avatar NLP Intents** — Three vectorized intents for natural language avatar management:
  - `setAvatar` — "set this as your avatar", "change your profile picture"
  - `syncAvatar` — "sync your avatar to gravatar", "upload your avatar to gravatar" (executes upload)
  - `getAvatar` — "show me your avatar", "what do you look like" (sends image file or URL)

### Changed
- `uploadAvatarToGravatar()` now prefers `GRAVATAR_OAUTH_TOKEN` over `GRAVATAR_API_KEY`
- Gravatar API key field relabeled as "read-only fallback" in Settings UI

## [2.10.86] - 2026-02-11

### Added
- **Agent Avatar System** — Per-instance avatar image with API, Web UI, and system prompt integration:
  - `GET /api/agent/avatar` — Serve avatar image (no auth, public, streamable)
  - `POST /api/agent/avatar` — Upload avatar via base64 JSON or update description only (auth required)
  - `GET /api/agent/identity` — Agent identity card (name, version, avatar, personality, plugins, interfaces)
  - Auto-detects avatar from `data/agent/` or copies from project root on startup
  - Avatar displayed in Overview page Agent Information card
  - Settings tab section for avatar management (preview, file upload, description input)
  - System prompt includes visual identity and appearance description so ALICE is self-aware
  - Agent model extended with `avatarPath` and `avatarDescription` fields
  - JSON body limit increased to 10MB for base64 image uploads

## [2.10.84] - 2026-02-11

### Added
- **Jellyfin plugin** — Full-featured Jellyfin media server management with 30 commands covering:
  - **System**: Server info, restart, shutdown, activity log, scheduled tasks
  - **Libraries**: List, scan/refresh libraries
  - **Media**: Browse, search, get details, latest additions, delete, refresh metadata
  - **TV Shows**: Seasons, episodes, next-up queue
  - **Users**: List, create, delete, password management
  - **Sessions**: Active streams, playback control (play/pause/stop/seek), send messages
  - **Playlists**: Create, list, add/remove items
  - **Plugins**: List installed and available packages
  - Vectorized intent system with 16 intents and natural language examples
  - Configurable via Settings tab (server URL + API key)
  - Cached API responses with retryOperation for resilience

## [2.10.83] - 2026-02-11

### Improved
- **FeatureRequest query caching** — Added NodeCache (5min TTL) and retryOperation to all static query methods (getByStatus, getByCategory, getByPriority, getUserSubmitted, getAutoGenerated)
- **SystemReport query caching** — Added NodeCache caching for getLatestReport and retryOperation wrapping for all static query methods
- **NetworkDevice compound indexes** — Added indexes on services.port+services.protocol and stats.uptimePercentage for faster query performance
- **GitHostingProvider retry mechanism** — Added performNetworkOperation helper with configurable retry logic for all subclass network operations
- **FilteredTransport dynamic log levels** — Added updateLogLevel method for runtime log level adjustment without restart; replaced console.error with logger.error
- **Account activity logging** — Added middleware to log all account API operations with method, URL, userId, and response status
- **FCM message priority** — Added priority parameter to sendMessage and sendBulkMessages with proper Android and APNs priority handling

### PR Review
- Reviewed 10 AI-generated PRs (#1439-#1448), implemented 7 features manually with fixes, closed 3 (videoGenerationService unused cache, SubAgent no-op timezone method, StatusCake wrong import paths)

## [2.10.82] - 2026-02-10

### Fixed
- **CRITICAL: Circuit breaker false tripping** — `calculateDynamicRetryParams()` defaulted to 5 retries with no history data (after PM2 restart), exceeding circuit breaker threshold of 5. Now returns caller defaults when no history, requires 3+ data points, and caps retries at 4
- **CRITICAL: *arr intent misclassification** — "what authors do I have in readarr" routed to `add_author` instead of `get_authors` because vector embeddings for same-plugin intents were too similar. Added post-match keyword disambiguation for all *arr plugins (list/search/add/delete)
- **Axios circular JSON errors** — *arr API errors crashed serialization due to circular references in axios error objects. `_apiRequest()` now extracts clean error messages (status code, server message, error code)

### Improved
- **Action-type semantic enrichment** — Intent embeddings now include operation-type keywords (e.g., "retrieve view list" vs "add create import") to improve vector separation between similar intents within the same plugin
- **Readarr intent examples** — Expanded `get_authors` and `delete_author` examples for better vector discrimination; improved `listAuthors` and `addAuthor` intent descriptions

## [2.10.81] - 2026-02-10

### Improved
- **TokenTrader progressive scale-out** — Sell more at higher gain levels: 10%→10%, 20%→15%, 30%→25%, 50%→35% (configurable per-level)
- **Regime-aware trailing stop** — Standard 8% → PUMP 6% → MOON>50% tight 5% (three tiers)
- **VWAP-based adaptive baseline** — DollarMaximizer uses 48-hour time-weighted average for baseline resets instead of raw current price
- **Regime confidence weighting** — Low-confidence regime detection (<80%) widens buy thresholds up to 1.5x to avoid whipsaw entries
- **Token trader status API** — Flattened convenience fields (currentPrice, tokenSymbol, tokenBalance, etc.) for easier diagnostic parsing
- **Strategy running state** — `isActive` field based on last successful execution timestamp (within 20 min) instead of stale `running` flag

### Fixed
- **CRITICAL: BaseStrategy importState version migration** — Config keys with null code defaults (tokenAddress, tokenNetwork, etc.) were discarded during CONFIG_VERSION bumps. Now preserves saved values when code default is null/undefined
- **CRITICAL: TokenTrader importState** — Explicitly re-imports user-set fields (tokenAddress, tokenNetwork, tokenSymbol, etc.) after super.importState to prevent version migration from clearing token configuration
- **CRITICAL: Residual sweep token protection** — Sweep now checks 3 sources for managed token addresses (in-memory registry, persisted MongoDB state, executor state) to prevent selling managed tokens during startup race conditions
- **Residual sweep log dedup** — `skipped_gas_exceeds_value` entries now have 24-hour cooldown to reduce repetitive logging

### Added
- **Token rotation watchlist** — `evaluateWatchlist()` method for post-COOLDOWN token rotation (watchlist configurable via API)

## [2.10.80] - 2026-02-10

### Added
- **Radarr plugin** — Full movie management: search, add, delete, calendar, queue, history, health, refresh, download search (12 commands, vectorized NLP intents)
- **Sonarr plugin** — Full TV series management: search, add, delete, episodes, calendar, queue, wanted/missing, history, health, refresh (14 commands, vectorized NLP intents)
- **Lidarr plugin** — Full music artist/album management: search, add, delete, albums, calendar, queue, wanted/missing, history, health, refresh (14 commands, vectorized NLP intents)
- **Readarr plugin** — Full book/author management: search, add, delete, books, calendar, queue, wanted/missing, history, health, refresh (14 commands, vectorized NLP intents)
- **Prowlarr plugin** — Indexer management and cross-indexer search: list/test indexers, search, connected apps, stats, health, app sync (8 commands, vectorized NLP intents)
- **ArrBasePlugin shared base class** — Common *arr API handling (X-Api-Key auth, retry logic, caching, health/queue/calendar/history/command/status endpoints, AI parameter extraction)

### Improved
- **Plugin Development Guide** — Updated with modern patterns: `commands[]` array, NodeCache, `retryOperation`, `PluginSettings`, AI parameter extraction, `initialized` flag

### Technical
- All 5 *arr plugins use shared `arr-base-helper.js` base class to avoid code duplication
- Credentials loaded via PluginSettings (DB) with env var fallback (RADARR_URL/API_KEY, SONARR_URL/API_KEY, etc.)
- Graceful degradation: plugins register as needing configuration when credentials missing
- 62+ vectorized NLP intent examples across all *arr plugins for natural language matching
- NodeCache used for API response caching with configurable TTL

## [2.10.79] - 2026-02-10

### Added
- **IPstack timezone endpoints** — `getTimezone` and `getOwnTimezone` commands for IP-based timezone lookup
- **Currencylayer fluctuation data** — `getCurrencyFluctuations` command for analyzing currency fluctuation over date ranges
- **Ollama streaming responses** — `streamresponse` command for real-time streaming from local Ollama models
- **Bitbucket git hosting** — Added Bitbucket as third git hosting provider option alongside GitHub and GitLab
- **Plan step priority** — Plan-execute agent now supports priority field on plan steps (defaults to 'medium')
- **JSON validation options** — `validateJsonSchema` now accepts options for custom error messages and severity levels
- **Mean reversion risk adjustment** — Dynamic risk parameters (trade size, stop loss, profit taking multipliers) based on volatility
- **EventRule 'not' condition** — Added 'not' logical operator for event rule conditions
- **Account bulk operations** — Bulk register, bulk status update endpoints for account management
- **Account retry resilience** — All account API operations now use retryOperation for transient failure handling

### Improved
- **MarketIndicators caching** — Replaced manual Map cache with NodeCache (auto-expiring TTL) and added retryOperation to fetchers
- **SelfDiagnostics caching** — System info (memory, disk) cached with NodeCache to reduce repeated system calls

### Technical
- Reviewed 24 AI-generated PRs (#1412-#1438): merged 6 clean PRs, manually implemented 5 features with fixes, closed 13 broken PRs
- PR #1412 merged: jsonUtils validation options (clean)
- PR #1425 merged: ipstack timezone endpoints (clean)
- PR #1433 merged: currencylayer fluctuations (clean)
- PR #1434 merged: ollama streaming (clean)
- PR #1435 merged: Bitbucket git hosting support (clean)
- PR #1437 merged: planExecuteAgent priority field (clean)
- PR #1414 closed: risk adjustment implemented manually (removed unused retryOperation import)
- PR #1417 closed: 'not' condition implemented manually (removed stub evaluateConditions method)
- PR #1418 closed: retry + bulk endpoints implemented manually (removed unused NodeCache import)
- PR #1419 closed: NodeCache + retry implemented manually (fixed wrong import path ../utils/ → ../../../utils/)
- PR #1438 closed: caching implemented manually (removed unused retryOperation import)
- PR #1413 closed: unused NodeCache import, no functional change
- PR #1415 closed: fake translation API endpoint
- PR #1416 closed: breaking async change to parse(), nonsensical retry on deterministic parsing
- PR #1420 closed: imports non-existent notificationService
- PR #1421 closed: calls non-existent sentiment.analyze() on OpenAI client
- PR #1422 closed: breaking API change + non-existent getTransactionStatuses method
- PR #1423 closed: calls non-existent whoisjson.history() method
- PR #1424 closed: wrong import path, breaks winston transport callback pattern
- PR #1429 closed: hardcoded WebSocket port 8080, bad architecture
- PR #1430 closed: uses 'this' in module-level function (undefined)
- PR #1431 closed: breaking generateToken return type change
- PR #1432 closed: breaking async encrypt/decrypt change
- PR #1436 closed: unused NodeCache import, no functional change

## [2.10.78] - 2026-02-08

### Added
- **Lyrics plugin** — New plugin for song lyrics lookup using free APIs (LRCLIB primary, lyrics.ovh fallback)
  - `get` command: fetch lyrics by artist + title
  - `search` command: search for lyrics by query string
  - `synced` command: get time-synced LRC lyrics for karaoke/timed display
  - Results cached for 1 hour, no API key required
  - Lyrics stored in conversation memory for follow-up questions about the song
- **yt-dlp update command** — `update` and `version` commands added to the ytdlp plugin
- **yt-dlp VPN/proxy support** — Downloads can route through ExpressVPN or a custom proxy to bypass geo-blocks

### Fixed
- **yt-dlp SABR streaming failure** — Updated yt-dlp binary from 2025.12.08 to 2026.02.04, fixing YouTube SABR streaming issue
- **yt-dlp "update" misrouting** — "Update yt-dlp" was being misrouted to transcribe/download since no update command existed

## [2.10.77] - 2026-02-08

### Added
- **Fixer getFluctuation** — New command calculates percentage change between two historical dates using existing `getHistoricalRates()` method
- **Email multi-language verification** — Italian, Portuguese, and Dutch verification patterns for email confirmation detection
- **UPS severity channel mapping** — Configurable notification channels per severity level (low→email, medium→email+telegram, high→telegram+webhook) with `getNotificationChannels()` method
- **Accounts date filtering** — `startDate` and `endDate` query parameters on `GET /api/accounts` for filtering accounts by creation date

### Improved
- **ImprovementMetrics performance** — Added `.lean()` to `Improvement.find()` queries, returning plain objects instead of Mongoose documents

### Technical
- Reviewed 10 AI-generated PRs (#1401-#1410): merged 2 clean PRs (#1406 emailService, #1407 fixer), closed 8, manually implemented 3 features with correct code
- PR #1401 closed: unused NodeCache import in mcpClient.js
- PR #1402 closed: cache without invalidation in NetworkDevice.js
- PR #1403 closed: wrong sorting implementation — reimplemented date filtering correctly
- PR #1404 closed: removed .toObject() which prevents NodeCache bug — reimplemented .lean() only
- PR #1405 closed: broke options.messages API in gab.js
- PR #1408 closed: called non-existent TaskScheduler.scheduleJob() in currencylayer.js
- PR #1409 closed: wrong severity levels + unused imports — reimplemented channel mapping correctly
- PR #1410 closed: async getHistory() broke 3+ callers in operationLogger.js

## [2.10.76] - 2026-02-08

### Added
- **V4 swap support for BSC** — Full PancakeSwap Infinity (V4) quoting and execution on BSC via CLQuoter + Universal Router, with V3 fallback on V4 failure
- **Arbitrage token management API** — GET/POST/DELETE endpoints for configuring arbitrage scanner tokens via Web UI or API
- **Intra-V3 fee-tier arbitrage** — Scans all V3 fee tier combinations (100/500/2500/10000 bps) for same-protocol price discrepancies
- **Volatility-triggered fast scanning** — Price moves >3% dispatch `crypto:high_volatility` event, reducing scan delays from 3s to 1.5s between tokens
- **Configurable arb scan tokens** — 6 default tokens (ETH, BTCB, CAKE, XVS, UNI, DOGE), custom tokens addable via Web UI, token trader token auto-included
- **Arb token Web UI panel** — Token management panel below token trader with color-coded badges (gray=default, blue=tokenTrader, green=custom)

### Fixed
- **Stale config override** — MongoDB-persisted strategy config no longer overwrites code defaults; `_configVersion` mechanism ensures newer code defaults take precedence
- **Arb scanner getting no quotes** — V2+V3+V4 running in parallel exceeded BSC RPC rate limits; V4 now runs sequentially after V2+V3

### Technical
- BaseStrategy.importState() uses _configVersion to decide code vs persisted config priority
- PancakeSwap Infinity CLQuoter uses different PoolKey struct than Uniswap V4 (poolManager field, bytes32 parameters)
- Universal Router execute() with command bytes for V4_CL_SWAP_EXACT_IN_SINGLE (0x10)
- getV3QuotesByFeeTier() returns per-fee-tier quotes for intra-V3 arb scanning
- ArbitrageStrategy scans 9+ cross-protocol combos per token (v2/v3/v4 buy×sell) plus intra-V3 fee tier combos

## [2.10.75] - 2026-02-08

### Added
- **Cross-DEX arbitrage strategy** — Scans LINK, ETH, BTCB for round-trip price discrepancies across V2/V3 protocols, auto-executes profitable arb trades with stuck-position recovery
- **Arbitrage strategy export/import** — Full state persistence via BaseStrategy pattern (totalArbPnL, recentOpportunities, stuckPosition)

### Technical
- ArbitrageStrategy extends BaseStrategy with 15s per-quote timeout and 45s global scan timeout
- Runs every heartbeat after primary + secondary strategies complete
- Circular import avoided by passing token_trader config from CryptoStrategyAgent

## [2.10.74] - 2026-02-08

### Added
- **Chainlink oracle token price feeds** — Token price lookups now use Chainlink oracles (LINK/USD, ETH/USD, BTC/USD on BSC) as primary source, with DEX stablecoin quotes as secondary
- **Cross-source price validation** — Detects >5% discrepancy between Chainlink oracle and DEX prices, logs potential arbitrage opportunities
- **Adaptive grid thresholds** — Token trader grid buy/sell triggers auto-adjust based on recent price volatility instead of fixed ±2%

### Fixed
- **Price monitor wrong token prices** — Replaced stale PancakeSwap V3 WBNB quoter (showed $15 for $9 LINK) with Chainlink oracle reads + DEX stablecoin fallback
- **Token trader grid never triggering** — Fixed by adaptive thresholds that tighten to match actual volatility (e.g., ±0.5-1% for low-vol tokens)

## [2.10.73] - 2026-02-08

### Added
- **Vonage scheduleMessage** — Schedule SMS/MMS to be sent at a future time with ISO 8601 `sendAt` parameter
- **Trello moveCard** — Move cards between lists using Trello API `PUT /cards/{id}` with `idList` update
- **PriceIndicators 30d/90d** — New `price_change_30d` and `price_change_90d` crypto strategy indicators
- **MqttHistory caching** — NodeCache for time series and statistics queries, retryOperation for write operations
- **IPstack NodeCache** — Upgraded from Map to NodeCache with TTL-based caching for geolocation lookups
- **VectorIntentDetector shared retry** — Replaced local retryOperation with shared `retryUtils.retryOperation`

### Fixed
- **Goliath alert spam** — Suppressed repeated identical warning-level Telegram alerts; only NEW or CRITICAL alerts trigger notifications
- **APT update alerts removed** — Pending apt updates no longer trigger warning alerts (informational only)

### Technical
- Reviewed 10 AI-generated PRs: merged 2 clean PRs (#1394, #1399), closed 8, manually implemented 4 features with correct code
- PR #1391 closed: non-existent `TaskScheduler.scheduleJob()` — reimplemented using setTimeout
- PR #1392 closed: unused `rateLimit` import, wrong `operationName` option — reimplemented with correct `retryUtils` API
- PR #1393 closed: passed `currency` param to service methods that don't support it (fake feature)
- PR #1395 closed: called non-existent `whoisjson.getHistoricalWhois()` API method
- PR #1396 closed: wrong import path `../utils/logger.js` — reimplemented indicators without bad import
- PR #1397 closed: multiple bugs (string as array index, broke existing API contract)
- PR #1398 closed: wrong import paths, sync→async breaking change on pure functions
- PR #1400 closed: unused `rateLimit` import — reimplemented Map→NodeCache upgrade

## [2.10.72] - 2026-02-08

### Added
- **Integromat cloneScenario** — New `cloneScenario` command that duplicates an existing Make scenario with a new ID, optionally applying modifications before creation
- **CloudWatch Anomaly Detection** — New `detectanomalies` command that sets up anomaly detection models and retrieves anomaly scores for EC2 metrics
- **Slack Block Kit** — New `sendFormattedMessage` command for sending rich formatted messages using Slack's Block Kit API
- **FCM Scheduled Messages** — New `scheduleMessage` command for Firebase Cloud Messaging, schedules notifications to be sent at a future time using Agenda
- **Project Bulk Remove Tasks** — New `removeTasks()` method on Project model for efficient bulk task removal using Set-based filtering
- **IndicatorProvider Batch Processing** — `getValues()` now batch-checks cache upfront with `mget()`, only evaluating uncached indicators
- **MCP Tool Retry** — MCP tool execution wrapped in `retryOperation` with 3 retries and exponential backoff for transient failures

### Technical
- Reviewed 9 AI-generated PRs: merged 5 clean PRs, closed 3 (broken/useless), manually implemented 3 features with correct code
- PR #1383 closed: added unused NodeCache + express-rate-limit to Anthropic provider, retryUtils already has adaptive retry
- PR #1385 closed: used non-existent `createQueue` from `async-queue`, added unrelated caching to logger
- PR #1384 closed: wrong import path `../utils/retryUtils.js` — reimplemented with correct path `../../utils/retryUtils.js`
- PR #1386 closed: used non-existent `TaskScheduler.scheduleJob()` — reimplemented using Agenda pattern from Integromat plugin
- PR #1382 merged: removed unused `GetAnomalyDetectorsCommand` and `GetMetricDataCommandInput` imports
- `src/api/plugins/integromatnowmake.js` — `cloneScenario()` using existing `getScenario()` + `createScenario()`
- `src/api/plugins/amazoncloudwatch.js` — `detectAnomalies()` with `PutAnomalyDetectorCommand` + `GetMetricDataCommand`
- `src/api/plugins/slack.js` — `sendFormattedMessage()` with Block Kit blocks array
- `src/api/plugins/firebasecloudmessagingfcm.js` — `scheduleMessage()` using `this.scheduler.agenda.schedule()` with Agenda job definition
- `src/models/Project.js` — `removeTasks()` bulk method with Set-based filtering and cache invalidation
- `src/services/crypto/indicators/IndicatorProvider.js` — `getValues()` uses `cache.mget()` for batch cache lookups
- `src/services/mcp/mcpClient.js` — `executeTool()` wrapped in `retryOperation()` with context logging

## [2.10.71] - 2026-02-07

### Fixed
- **Token Trader Exit Button** — Manual exit via Web UI now works correctly. Previously, the exit endpoint created an exit decision but then called `executeTokenTrader()` which ran a fresh analysis that returned `hold` in SIDEWAYS regime, silently discarding the exit. Now uses a `pendingManualExit` flag that bypasses the analysis pipeline and sells immediately
- **Manual Exit V2 Fallback** — Manual exits no longer force V3-only routing. Some tokens lack V3 pools for sell paths; manual exits now allow V2 fallback since the user explicitly requested the sell
- **ServerMaintenanceAgent 9/9 Services** — Monitored services count was stuck at 9 instead of 10 after adding transmission. Root cause: `monitoredServices.apps` config is persisted in MongoDB on first init and never refreshed. Added startup sync that compares persisted app count with code defaults and updates MongoDB when they differ

### Added
- **Telegram Reply Context** — When replying to a previous message in Telegram (using the reply feature), the bot now reads the replied-to message and includes it as context for NLP processing. Prepends `[Replying to ALICE's message: "..."]` or the user's name for non-bot messages

### Technical
- `src/services/crypto/strategies/TokenTraderStrategy.js` — `createExitDecision()` sets `this.state.pendingManualExit = true`
- `src/services/subagents/CryptoStrategyAgent.js` — `executeTokenTrader()` checks `pendingManualExit` flag, bypasses analysis, creates sell decision directly; manual exits set `forceV3: false`
- `src/interfaces/telegram/telegram.js` — extracts `reply_to_message` text/caption before NLP processing
- `src/services/subagents/ServerMaintenanceAgent.js` — `initialize()` syncs `monitoredServices.apps` from `getDefaultConfig()` when count differs from persisted config

## [2.10.70] - 2026-02-07

### Added
- **Transmission Monitoring** — Added `transmission-daemon` to ServerMaintenanceAgent monitored services on goliath (port 9091). Includes crash detection, manual-stop awareness, and version tracking like all other monitored services
- **VPN Pre-Check for Restart** — New `requiresVpn` flag on service config. Before restarting a VPN-dependent service (transmission), verifies expressvpn daemon is active AND connected. Refuses restart if VPN is down to prevent unprotected torrent traffic

### Technical
- `src/services/subagents/ServerMaintenanceAgent.js` — added transmission to `monitoredServices.apps` with `requiresVpn: true`, added VPN connection check in `restartApp()` before restarting VPN-dependent services

## [2.10.69] - 2026-02-07

### Added
- **`/clearall` Telegram Command** — Synonym for `/newchat`, both clear conversation context and start a fresh session
- **Dynamic About Info** — `getAboutMe()` now uses dynamic values for version (from `package.json`) and plugin count (from `apiManager`) instead of stale hardcoded values (`2.8.45` and `24+`)

### Fixed
- Stale fallback version in `getAboutMe()` — was hardcoded `2.8.45`, now uses `this.version` read from `package.json`
- Stale plugin count in `getAboutMe()` — was hardcoded `24+`, now dynamically reports actual count (currently 84)

### Technical
- `src/interfaces/telegram/telegram.js` — `/newchat` handler now accepts `['newchat', 'clearall']` array, added `/clearall` to help text
- `src/core/agent.js` — `getAboutMe()` uses `this.version` and `this.apiManager.getPluginList().length`

## [2.10.68] - 2026-02-07

### Added
- **Journal Caching & Pagination** — `searchContent()` and `findRecent()` now use NodeCache (5-min TTL) with retry logic and `skip` parameter for pagination support
- **Indicator Provider Retry Logic** — Trading indicator execution now wrapped in `retryOperation` with 3 retries for resilience against transient failures
- **Slack Interactive Buttons** — New `addInteractiveButton` action for sending messages with interactive button attachments via the Slack API
- **AutoAccount Activity Analytics** — New schema fields (`loginFrequency`, `averageSessionDuration`, `featureUsage` Map) with `updateActivityAnalytics()` and `trackFeatureUsage()` methods using retry-safe saves
- **Anthropic Provider Retry Improvements** — Enhanced retry configuration with exponential backoff (factor 2), 3 retries (up from 2), `isRetryableError` classifier, and warning-level logging on retry attempts for both `generateResponse` and `analyzeImage`

### Technical
- Reviewed 8 AI-generated PRs: closed 3 (dead code/no-ops), manually implemented 5 features with correct code
- PR #1372 (Journal.js): Fixed broken cache pattern (`cache.set()` returns `true` not value)
- PR #1373 (database.js): Closed — `adjustPoolSize()` always returns 10 since `currentLoad` is never set
- PR #1374 (CryptoStrategy.js): Closed — all added functions are dead code, `isRetryableError` not imported, `logger.critical` doesn't exist
- PR #1375 (IndicatorProvider.js): Fixed wrong import path (`../utils/retryUtils.js` → `../../../utils/retryUtils.js`)
- PR #1376 (GridTradingStrategy.js): Closed — assumes OHLC candle data that doesn't exist in market data pipeline
- PR #1377 (slack.js): Clean implementation, adopted as-is
- PR #1378 (AutoAccount.js): Fixed unused cache import, added missing `loginFrequency` increment
- PR #1379 (anthropic.js): Fixed `shouldRetry` → `customErrorClassifier`, removed unused NodeCache

## [2.10.67] - 2026-02-07

### Added
- **PR Review Triage** — Reviewed all 30 AI-generated PRs: merged 10, closed 13 (with detailed comments), and manually implemented 7 features with correct code from closed PRs
- **Plugin Enhancements (merged PRs)** — Asana setPriority/setDueDate, SignalWire message analytics, NASA launch schedule, Google Cloud Functions updateFunction, Firebase/CryptoWallet transaction categories & tags
- **Core Improvements (merged PRs)** — ContractABI metadata queries with caching, ProviderStatsArchive performance analytics, MCP tool versioning & rollback, MCP SSE connection retry, outputSchemas permissionsMap refactor
- **BaseStrategy Dynamic Risk Assessment** — Liquidity-based slippage tolerance adjustment (>1M liquidity: 1%, >500K: 2%, default: 3%)
- **Batch Transaction Confirmations** — `waitForTransactions()` using `Promise.allSettled` for safe parallel confirmation without incorrectly marking successful transactions as failed
- **Browser Pool for Web Scraper** — Reuses Puppeteer browser instances (pool of up to 5) instead of launching/closing per scrape
- **SSH Session Report Improvements** — `peakUsageTimes` and `errorTrends` added to `generateSessionReport()`
- **Bulk Gravatar Profiles** — `fetchBulkGravatarProfiles()` for batch profile lookups using `safePromiseAll`
- **GitHostingSettings Error Logging** — `getOrCreate()` and `getActiveProviderConfig()` now log errors before re-throwing

### Technical
- 10 AI-generated PRs merged directly: #1340, #1341, #1344, #1349, #1355, #1356, #1360, #1364, #1367, #1371
- 13 PRs closed with comments (security issues: #1357 eval(), #1369 new Function(); broken: #1342, #1343, #1345, #1346, #1350, #1353, #1354, #1358, #1359, #1365, #1370)
- 7 features manually implemented from closed PRs with correct imports, no unused code
- `src/services/crypto/strategies/BaseStrategy.js` — added `dynamicRiskAssessment()`
- `src/services/crypto/transactionService.js` — added `waitForTransactions()` with `Promise.allSettled`
- `src/services/webScraper.js` — added `getBrowserInstance()`, `releaseBrowserInstance()`, browser pool
- `src/models/SSHConnection.js` — enhanced `generateSessionReport()` with peak usage and error trends
- `src/utils/gravatarHelper.js` — added `fetchBulkGravatarProfiles()` with correct import path
- `src/models/GitHostingSettings.js` — added logger import and try/catch to static methods

## [2.10.66] - 2026-02-06

### Added
- **Gas Cost Tracking for Token Trader** — Swap gas costs (in native token) are now captured from transaction receipts and tracked in PnL. `swapService` returns `gasCostNative`, which is converted to USD and passed to `recordBuy()`/`recordSell()`. PnL now deducts gas: `pnl = stablecoinReceived - costBasis - gasCostUsd`. Total gas cost visible in `token-trader/status` API under `pnl.totalGasCost`
- **Pre-Trade Gas Profitability Gate** — Before executing buys or sells, estimates gas cost in USD using live `feeData.gasPrice * 250000` and native token price. Buys require net value >= $1 after gas. Sells require net profit >= $1 after gas. Emergency sells (DUMP, stop-loss, full exit) bypass the gate for capital preservation
- **Token Trader "Update Config" Button** — New green "Update Config" button in Web UI patches `capitalAllocationPercent`, `dumpThreshold`, and `tokenTaxPercent` via `POST /api/crypto/strategy/config/token_trader` without resetting any state, PnL, or regime data
- **Confirmation Dialogs on All Dangerous Crypto Buttons** — Network mode toggle (testnet/mainnet), strategy switch, strategy threshold save, and Configure & Enter all now require explicit confirmation before executing. Existing confirmations on Exit Position and Send Transaction preserved
- **Token Trader Settings Sync from Server** — Web UI input fields (Capital %, Stop-Loss %, Tax %) now populate from actual server config via `settings` field in `token-trader/status` API response, instead of showing hardcoded defaults

### Technical
- `src/services/crypto/swapService.js` — captures `gasUsed * effectiveGasPrice` from tx receipt, returns `gasCostNative` in swap result
- `src/services/crypto/strategies/TokenTraderStrategy.js` — added `totalGasCostUsd` to state, `gasCostUsd` parameter to `recordBuy()`/`recordSell()`, `settings` object in `getTokenTraderStatus()`, `totalGasCostUsd` reset in `configure()`
- `src/services/subagents/CryptoStrategyAgent.js` — pre-trade gas estimation using `provider.getFeeData()`, $1 minimum net value/profit gates, emergency sell bypass, actual gas cost passthrough to record methods
- `src/interfaces/web/public/app.js` — `confirm()` guards on `toggleNetworkMode()`, `switchStrategy()`, `updateStrategyConfig()`, `configureTokenTrader()`, new `updateTokenTraderConfig()` function, settings field population in `refreshTokenTraderStatus()`
- `src/interfaces/web/public/index.html` — "Update Config" button added to token trader section

## [2.10.65] - 2026-02-06

### Added
- **ServerMaintenanceAgent** — New sub-agent for monitoring and maintaining the goliath home server (TARGET_SERVER). Runs hourly via `maintenance:heartbeat` Agenda job. Connects via SSH plugin to perform disk, memory, CPU, service, Docker, NTP, temperature, and uptime checks. Safe operations (journal vacuum, apt autoclean, tmp cleanup) run automatically; dangerous operations (apt upgrade, service restart, reboot, docker prune) require user approval. Alerts via Telegram only when issues are found
- **Monitored Application Services** — Tracks 9 services on goliath: calibre, jellyfin, radarr, sonarr, lidarr, readarr, prowlarr, expressvpn, vsftpd. Auto-restarts crashed services but never restarts manually stopped ones. Detects crash vs manual stop via `systemctl show -p Result`. Records baseline on first run. Tracks versions via dpkg and *arr local API endpoints
- **Smart Disk Thresholds** — Media drives (HDD1-6, MediaLibrary*) are expected near-full and evaluated by free space (alert below 20GB) instead of percentage. NASMedia and other non-media drives use standard 80%/95% thresholds. Eliminates false critical alerts on 99%-full media drives with 40-50GB free
- **Security Drive Auto-Cleanup** — When `/media/Security` exceeds 85% usage, automatically runs the existing `clear.sh` script to clear security camera footage from Sentry directories, preventing FTP recording failures
- **FTP Service Monitoring** — vsftpd added to monitored services for security camera FTP recording continuity

### Technical
- New file: `src/services/subagents/ServerMaintenanceAgent.js` — extends BaseAgentHandler, SSH plugin integration, Promise.allSettled parallel checks, per-drive threshold logic, process-based monitoring for calibre (broken systemd unit), *arr API version detection via config.xml API keys
- `src/services/subagents/index.js` — added ServerMaintenanceAgent export
- `src/core/agent.js` — registered `maintenance` domain handler
- `src/services/scheduler.js` — added `maintenance-heartbeat` job definition and 60-minute schedule

## [2.10.64] - 2026-02-06

### Fixed
- **Strategy Condition Operator Overwrite** — CRITICAL: `evaluateSingleCondition()` used consecutive `if` statements causing later operators to overwrite earlier matches. Fixed with `else if` chain so first matching operator wins
- **40+ Indicators Unreachable** — IndicatorProvider (RSI, MACD, Bollinger, market indicators, etc.) was never wired into RuleBasedStrategy. Added as fallback in `getIndicatorValue()` making all 50+ indicators available to custom rules
- **ReDoS Vulnerability** — Regex condition matching accepted arbitrary user input patterns. Added 100-char pattern limit and 1000-char test string limit
- **Health Status Permanently Degraded** — `consecutiveErrors` counter incremented on errors but never reset on success. Now resets after successful rule evaluation
- **Cooldown Hours Overwriting Minutes** — Rule cooldown with both hours and minutes only used the last value. Fixed to accumulate both (e.g., 1h 30m = 90 min)
- **MACD Signal Line Always Zero** — `calculateMACD()` returned `signal: 0` instead of computing proper 9-period EMA of MACD values
- **Strategy Sanitization No-Op** — `sanitizeConfig()`/`sanitizeState()` only removed `_id`/`__v`. Now recursively strips keys matching sensitive patterns (apiKey, secret, password, privateKey, token, mnemonic)
- **validateBundle Infinite Recursion** — Bundle items with a `strategies` array would trigger infinite loop between `validateStrategy()` and `validateBundle()`. Added depth parameter to prevent re-entry
- **Custom Indicator Circular References** — Lookup-type custom indicators could recurse infinitely. Added visited-set cycle detection
- **disable_rule Permanently Mutates Config** — Error handler wrote `rule.enabled = false` directly to config (survived export). Replaced with runtime-only `disabledRules` Set
- **US Market Hours Ignoring DST** — Hardcoded UTC hours didn't account for EDT/EST transitions. Now uses `Intl.DateTimeFormat` with `America/New_York` timezone
- **Moon Phase Float Tolerance** — Last phase `max: 1` could miss values at `1.0000000001` due to floating point. Changed to `max: 1.0001` matching MoonIndicators.js
- **Slugify Empty String** — Strategy names with only special characters produced empty slugs. Added fallback: `strategy_<timestamp>`
- **Source Version Hardcoded** — Exporter fallback was hardcoded to `2.10.60`. Now reads version from package.json at module load
- **errorRateLast24h Discarded** — Health endpoint computed error rate but didn't include it in response. Now returned in health object
- **generateChecksum Including Undefined State** — Checksum included `data.state` (always undefined at root level). Fixed to only hash metadata, strategy, and strategies fields
- **week_of_year Timezone Bug** — Used local timezone `Date()` constructor instead of `Date.UTC()` for year start

### Technical
- RuleBasedStrategy: imported IndicatorProvider singleton, else-if condition chain, circular reference Set, runtime disabledRules, consecutiveErrors reset, cooldown accumulation, regex limits, moon float buffer, comparison/formula custom indicators
- strategyExporter: recursive sensitive key sanitization, depth-guarded validation, slugify fallback, dynamic version from package.json, fixed checksum scope
- TechnicalIndicators: proper MACD signal line via historical MACD EMA
- TimeIndicators: DST-aware US market hours via Intl API, UTC-correct week_of_year

## [2.10.63] - 2026-02-06

### Fixed
- **SubAgent Stuck State Recovery** — Agents stuck in "running" status (from crashes/hangs) are now automatically recovered to "idle" on startup. Added 10-minute session timeout via Promise.race to prevent future hangs, with force-reset fallback if `endSession()` fails
- **Dead Token Auto-Sell Cascade** — Tokens with no DEX liquidity (e.g. NAUT, STINGRAY) no longer cascade through 9 sell percentages (100% → 0.01%) wasting 2+ minutes per heartbeat. New `isNoPathError` detection bails immediately after first "No viable swap path" failure. Tokens with 3+ consecutive failures are permanently skipped
- **Git Plugin `manageRemote` Crash** — Implemented missing `manageRemote()` method in GitPlugin (list, get-url, add, remove, set-url actions). Previously caused `this.manageRemote is not a function` crash when NLP routed git remote commands
- **Music Plugin NLP Misrouting** — Added keyword guard to `generateSong()` that rejects prompts without music-related words, preventing non-music requests from being incorrectly handled by the music plugin
- **Network Monitoring Settings Not Persisting** — Network plugin config (enabled toggle, interval, subnets, etc.) was silently lost on restart because it saved to `Agent.serviceConfigs.network` which has no Mongoose schema entry (strict mode strips unknown keys). Migrated to `PluginSettings.getCached/setCached` — the standard pattern used by 20+ plugins

### Technical
- SubAgentOrchestrator: stale session recovery on initialize(), Promise.race timeout in executeAgent(), force-reset fallback in error handler
- CryptoStrategyAgent: `isNoPathError` helper, early bail in stablecoin sell and native fallback sell, failCount >= 3 permanent skip in handleDeposits()
- GitPlugin: full manageRemote() implementation with 5 sub-actions
- MusicPlugin: musicKeywords regex guard before song generation
- NetworkPlugin: replaced broken Agent.serviceConfigs pattern with PluginSettings for config and scan data persistence

## [2.10.62] - 2026-02-05

### Added
- **Token Trader State Restore Endpoint** — New `POST /api/crypto/strategy/token-trader/restore-state` endpoint to recover token trader position data after accidental configuration resets
- **Web UI Strategy Export/Import Buttons** — Added config vs full backup options for strategy export in the crypto page UI (Export Config, Full Backup, All Configs, All Full)

### Fixed
- **cryptoManager Export Functions** — Fixed `cryptoManager.exportAllStrategies is not a function` error by adding proper Object.assign to attach export/import functions to window.cryptoManager in both DOM-ready code paths
- **Token Trader State Recovery** — Added ability to restore position, P&L, tracking, and regime data when token trader is accidentally reconfigured

### Technical
- Restructured app.js cryptoManager initialization to ensure export functions are available regardless of DOM ready state
- Added restore-state endpoint that accepts position, pnl, tracking, and regime data to recover from accidental resets

## [2.10.61] - 2026-02-05

### Added
- **Strategy Import/Export System** — Universal strategy format (`.strategy.json`) for sharing and backing up crypto trading strategies
- **Rule-Based Strategy Engine** — Create custom strategies with declarative JSON rules using 50+ built-in indicators
- **Indicator Provider System** — Six categories of indicators: price, time, moon phase, technical (RSI/MACD/Bollinger), market, and position
- **Telegram Strategy Import** — Upload `.strategy.json` files directly to Telegram bot with preview and merge/replace options
- **Simulation Mode** — Test custom strategies without executing real trades; all actions logged but not executed

### New API Endpoints
- `GET /api/crypto/strategy/capabilities` — Get platform capabilities and available indicators
- `GET /api/crypto/strategy/export/:name` — Export a single strategy to USF format
- `GET /api/crypto/strategy/export-all` — Export all strategies as a bundle
- `POST /api/crypto/strategy/validate` — Validate a strategy file without importing
- `POST /api/crypto/strategy/import` — Import a strategy from USF format

### Documentation
- New guide: `docs/guides/CUSTOM-STRATEGIES.md` — Complete reference for creating custom strategies

## [2.10.60] - 2026-02-05

### Added
- **Network API rate limiting** — All network monitoring endpoints now have rate limiting (100 requests per 15 minutes) via express-rate-limit
- **Network API retry logic** — API calls wrapped with retryOperation for improved reliability against transient failures
- **Network alerts caching** — NodeCache (5 min TTL) for alerts endpoint reduces database load
- **BaseStrategy trade retry** — New `executeTradeWithRetry()` method in BaseStrategy provides reusable retry wrapper for trade execution across all strategies
- **MCP tool registration retry** — Tool registration in mcpToolRegistry now wrapped with retryOperation (3 retries) for improved resilience

### PR Review
- Reviewed 16 AI-generated PRs (#1324-1339)
- Merged 1 PR (#1328 - network.js rate limiting and retry logic)
- Manually implemented 2 features from closed PRs with corrected import paths
- Closed 13 PRs due to: wrong import paths, unused code, non-existent dependencies (Redis, sentiment analysis), broken implementations, or architectural mismatches

## [2.10.59] - 2026-02-03

### Fixed
- **Residual sweep retry limit** — Tokens that fail all slippage levels (100% down to 0.01%) now track a `failCount`; after 3 full failed cycles the token is permanently skipped until the 7-day auto-cleanup. Prevents 16+ error spam per heartbeat for illiquid tokens (e.g. STINGRAY)
- **DiscoveredFeature node-cache crash** — Added missing `.lean()` to `findImplementable` query; node-cache deep-clone was crashing on raw mongoose documents (`Cannot read '_defaultToObjectOptions'`)
- **Network trading controls** — Removed Polygon and Base toggles from Web UI; only Ethereum and BSC are configured in the strategy. Cleaned up `minNetworkValueUsd` config accordingly
- **Git repo divergent branches** — Reset endpoint (`POST /api/system/reset-repo`) now uses `git fetch + reset --hard` instead of `git pull`. Self-modification pull fallback added: if `git pull` fails, falls back to `fetch + reset --hard origin/main`

### Reviewed
- **PRs #1308-1316** — Reviewed 9 AI-generated PRs: all were either already implemented in previous releases (caching/retry for revenue.js, contracts.js, Google Cloud Functions plugin) or empty/duplicate. All closed with comments.

## [2.10.58] - 2026-02-03

### Added
- **V3 preference for all swaps** — Dollar maximizer swaps now use `preferV3: true`, selecting V3 even if V2 is up to 2% better output. Falls back to V2 only if V3 has no liquidity or V2 is significantly better
- **Uniswap V4 quoting foundation** — V4 PoolManager quoter added for Ethereum; 3-way V4 > V3 > V2 quote comparison selects best protocol. V4 execution stubbed (falls back to V3/V2 for actual swaps)
- **Gas profitability check** — Dollar maximizer estimates gas cost before executing sells; skips if expected profit < 2x gas cost. Stop-loss sells bypass this check (capital preservation)
- **Low-balance network auto-skip** — Networks with total wallet value (native + stablecoin) below minimum threshold are auto-skipped (ETH: $50, BNB: $5, MATIC: $2, Base: $5)
- **Per-network trading toggle** — Disable/enable trading on individual networks (Ethereum, BSC, Polygon, Base) via Web UI or API. Settings persist in MongoDB across restarts
- **Network settings API** — `GET/POST /api/crypto/settings/disabled-networks` endpoints for managing disabled networks

### Fixed
- **Dollar maximizer swap options** — All dollar maximizer swaps now pass `preferV3`, `gasCheck`, and `expectedOutputUsd` options (previously passed no options, defaulting to V2 for major pairs)

## [2.10.57] - 2026-02-03

### Fixed
- **Token Trader V3 enforcement hardening** — After catastrophic V2 routing loss on FHE, added multiple safety layers:
  - `forceV3: true` on all token_trader swaps; if V3 quote fails, swap is aborted entirely (no V2 fallback)
  - Output sanity check tightened from 50% to 70% threshold — aborts swap if best quote < 70% of expected USD value
  - `expectedOutputUsd` always set via spot-price fallback when getQuote fails, ensuring sanity check is never skipped
  - Sanity check now logs protocol version (V2/V3) and percentage for diagnostics
- **DUMP regime graduated sell** — Hourly volatility spike (-8%/hr) now sells 50% instead of 100%; only hard stop-loss (-15% from entry) triggers full liquidation. Prevents panic-dumping user-supplied tokens on temporary dips
- **DUMP trigger logging** — Regime change log now includes which trigger fired (hourly emergency vs absolute stop-loss) with exact threshold values

## [2.10.56] - 2026-02-03

### Added
- **GitHostingProvider Webhook Management** - Abstract methods for `createWebhook`, `listWebhooks`, `deleteWebhook` on git hosting providers
- **Project Advanced Search** - `advancedSearch()` static method on Project model supports filtering by tags, status, and priority via MongoDB aggregation
- **Dynamic Schema Validation** - `adjustSchema()` and `validateData()` functions in outputSchemas for runtime-contextual schema modification and validation
- **Asana Task Dependencies** - `adddependency` and `removedependency` commands using correct Asana API endpoints (`addDependencies`/`removeDependencies`)
- **UserPreference Version Tracking** - `version` field with auto-increment on each preference update

### Improved
- **ImprovementMetrics Batch Queries** - Sequential daily/cumulative queries parallelized with `Promise.all`
- **Faucet Multi-Network Claims** - Network and per-faucet claim processing parallelized with `Promise.all` for faster batch claims
- **MongoDB Connection Pooling** - Added `maxPoolSize: 10` to mongoose connection options for concurrent operation support

### PR Review
- Reviewed 12 AI-generated PRs (1296-1307): implemented 8 features (with corrections where needed), closed 4 with fundamentally broken implementations
- Closed PRs: vectorIntentRoutes (non-existent methods), anthropic.js (unused code/aggressive retries), whois history (non-existent API), StrategyRegistry backtesting (non-existent strategy.evaluate())

## [2.10.55] - 2026-02-02

### Added
- **Token Trader Config Version Migration** - `importState()` override detects config version mismatch on restart and applies updated code-level defaults; prevents saved MongoDB config from overriding safety-critical threshold changes
- **Post-Dump Re-entry Cooldown** - Token trader waits 2 hours after a stop-loss sell before re-entering the market, preventing immediate buy-back into a still-dumping token
- **Plugin Execution Timeout** - apiManager wraps plugin execution in `Promise.race` with configurable per-plugin timeout (default 30s)
- **Phone Number Format Conversion** - numverify plugin `convertPhoneNumberFormat` command converts between E.164, national, and international formats via libphonenumber-js
- **Batch IP Geolocation** - ipgeolocation plugin `batch_lookup_ip` command looks up multiple IPs in one call with per-IP caching
- **ModelCache Usage Analytics** - `trackUsage()` and `getUsageAnalytics()` methods on ModelCache for request count, average response time, and error rate tracking

### Fixed
- **Token Trader DCA-to-stoploss gap** - DCA depth limit moved from -15% to -10%, creating a 5% buffer before the -15% stop-loss (was only 1% gap, causing buy-then-immediately-sell losses)
- **Saved config overriding code fixes on restart** - `BaseStrategy.importState()` spread saved config over constructor defaults, silently reverting deployed threshold changes; fixed with config version migration in `TokenTraderStrategy`
- **Mediastack error responses** - `fetchNews` now checks `error.response` for structured API error messages with status codes
- **NASA Mars Rover sequential fetches** - Refactored to `Promise.all` for parallel sol fetching with individual caching
- **UserPreference console.error** - Replaced with structured `logger.error` using existing logger import
- **DiagnosticReport aggregate retries** - Wrapped `this.aggregate()` in `retryOperation()` with 3 retries
- **Freshping HTTP retry** - All 5 axios calls wrapped with `retryOperation()` (import path corrected from PR)
- **GitHostingSettings field validation** - Added Mongoose validators for github/gitlab token, owner, repo, projectId fields
- **Checkly cache upgrade** - Replaced `Map` with `NodeCache` (stdTTL 300s) for automatic expiration

### Dependencies
- Added `libphonenumber-js` ^1.11.0

## [2.10.54] - 2026-02-02

### Added
- **DEX Price Monitor for Token Trader** - Price monitor now quotes tracked tokens via V3 Quoter contract every 5 minutes, dispatches `crypto:significant_move` on >1% moves
- **Residual Token Sweep** - Heartbeat sweeps wallet for non-primary stablecoins (BUSD), reflection tokens, and other residual ERC20 balances, auto-selling up to 2 per cycle
- **Non-Primary Stablecoin Auto-Sell** - Deposit handler now sells non-primary stablecoins (e.g., BUSD when primary is USDT) instead of just logging them

### Fixed
- **Heartbeat interval reduced** - Changed from 30 minutes to 10 minutes for 3x faster strategy reaction
- **Retry-on-revert never fired** - `hardCeiling` was equal to `currentSlippage` so `_incrementSlippage` always exceeded it; ceiling now has 2% headroom above starting slippage
- **Transient revert retry** - First retry now uses same slippage (revert may be block timing, not slippage), subsequent retries increment
- **V3 swap gas estimation failures** - Added `gasLimit: 500000n` to V3 swap `txOverrides` to prevent `estimateGas()` edge cases on complex multi-hop paths
- **Deposit dedup blocked reflection tokens** - Successfully sold tokens (`auto_sell_attempted`) can now be re-processed when new balance appears; only scam/dust remain permanently blocked

## [2.10.53] - 2026-02-02

### Added
- **Deposit Detection & Auto-Sell** - Automatic detection and sale of incoming token deposits
  - Deep scan now awaited before deposit detection (fixes race condition where `knownTokens` was always empty on restart)
  - Chunked auto-sell with progressive size reduction: 100%, 50%, 25%, 10%, 5%, 1%, 0.5%, 0.1%, 0.01%
  - Rate-limit-aware sell execution with backoff delays (3s between attempts, 15s on rate limit, 5s between tokens)
  - 24-hour cooldown for failed sells prevents retry spam
  - `POST /api/crypto/tokens/sell-safe` endpoint for manual token dump trigger
  - Diagnostic logging in `detectNewDeposits` for event/known/merged token counts

### Fixed
- **Deep scan race condition** - `runDeepScanAll()` was fire-and-forget, so deposit detection ran against empty `knownTokens` map on every app restart, finding 0 deposits
- **Auto-sell slippage too low for tax tokens** - Default slippage increased to 99% and effective tax to 50% for unknown/airdrop tokens with hidden transfer fees (50-99%)
- **Dedup key included token amount** - Changed from `network:address:amount` to `network:address` so tokens aren't retried every heartbeat when balance fluctuates
- **Pool error boundary at minimum sell step** - Changed from `pct > 0.01` to index-based `hasMoreSteps` check so the last sell percentage isn't silently skipped

## [2.10.52] - 2026-02-01

### Added
- **Token Scanner Auto-Discovery** - Token scanner now auto-starts and reliably detects all wallet tokens
  - Auto-initializes on first crypto heartbeat with periodic scanning enabled
  - 3-stage deep scan pipeline: RPC event scan → Block explorer API → Balance probe
  - Balance probe checks whitelisted, popular, and strategy-managed token addresses via direct `balanceOf()` RPC calls
  - Pulls managed token addresses from strategy registry (token_trader) automatically
  - Supports `POST /api/crypto/tokens/scan` with `{"deep": true}` for full historical scan
  - Includes safety analysis: honeypot simulation, scam name detection, dust flagging
  - Scanner status endpoint now reports deep scan progress and periodic scan state

### Fixed
- **Token scanner showed 0 detected tokens** - Public BSC RPCs silently drop large `getLogs` queries; balance probe approach bypasses this limitation entirely
- **HuggingFace music provider URL** - Updated from deprecated router.huggingface.co to api-inference.huggingface.co
- **Music generation poll logging** - Upgraded from debug to info level for production visibility

## [2.10.51] - 2026-02-01

### Added
- **Crypto Trading NL Intents** - Natural language commands now route to the crypto trading system
  - `cryptoTradingStatus` — "how is my crypto trading doing", "trading bot status", "market regime"
  - `cryptoPositions` — "what are my crypto positions", "what is the strategy holding"
  - `cryptoTradeHistory` — "show my recent trades", "trading journal"
  - `swapCrypto` — "swap ETH for USDT", "buy ETH", "sell BNB" (parses intent, routes to strategy)
  - 4 new intents in aiIntentDetector (IDs 103-106) with vector embeddings auto-indexed on startup
  - 4 new regex fallback patterns in intentDetector for offline matching
  - Handler methods in agent.js fetch live data from CryptoStrategyAgent via SubAgent orchestrator
- **DevEnv Project Versioning** - Git-based version history and rollback for development projects
  - `listProjectVersions` — returns commit history (hash, subject, author, date) with configurable limit
  - `rollbackProjectVersion` — restores project files to a specific commit, auto-commits working changes before rollback
  - API endpoints: `GET /api/projects/:id/versions`, `POST /api/projects/:id/rollback`

### PR Review Batch 8 (#1274-#1278)
- Reviewed 5 AI-generated PRs
- Implemented 1 feature manually (project versioning from PR #1276, reimplemented with working backend methods)
- Closed 4 PRs: model auto-switching with non-existent API (#1274), empty lazy loading (#1275), schema-only stub (#1277), duplicate retry logic (#1278)

## [2.10.50] - 2026-02-01

### Added
- **Market Regime Detection** - DollarMaximizer strategy now detects market regimes (strong_downtrend, downtrend, sideways, uptrend, strong_uptrend)
  - Composite score from price slope (40%), trend strength (30%), and RSI (30%)
  - Buy thresholds dynamically widen in downtrends (2.5x in strong_downtrend, 1.75x in downtrend) and tighten in uptrends (0.85x, 0.7x)
  - 72-hour rolling price history for trend analysis, persisted across restarts
  - Stop-loss and sell thresholds remain fixed regardless of regime
  - Agent-computed indicators (SMA, EMA, RSI, trendStrength) now piped through to dedicated strategy executors
- **V3 Tax Token Quoting** - V3 quotes no longer skipped for fee-on-transfer tokens, allowing V3 to compete on all swaps
- **V3 Tax Re-Estimation** - When V2/V3 price divergence exceeds 20%, V3 round-trip used for tax estimation instead of illiquid V2 pool

### Fixed
- **Position Reconciliation** - `nativeAmount` now always synced to actual wallet balance on every heartbeat
  - Previously hardcoded to 0 when switching to stablecoin position
  - Stablecoin mismatch fix now includes native balance in spread
  - Catch-all sync added after all reconciliation branches
- **Unmanaged Native Detection** - New reconciliation branch detects native tokens above gas reserve when position says stablecoin
  - Triggers when native exceeds 2x gas reserve and excess value > $5 USD
  - Switches position to native so stop-loss and take-profit apply
- **Dead Code Removal** - Removed unused `scheduleCryptoAgent()` and `cancelCryptoAgent()` from scheduler
- **CryptoStrategyAgent Cleanup** - Removed unused `indicatorCache`, `decisionJournal`, no-op `loadPriceHistory()`, redundant dynamic imports in `getStablecoinBalances()`

## [2.10.49] - 2026-02-01

### Added
- **Music Batch Generation** - `generateBatch()` method on Suno, Mubert, and Soundverse providers for concurrent track generation using `safePromiseAll`
- **StatusCake Scheduled Tests** - New `scheduleTest` command using Agenda-based TaskScheduler for cron-scheduled uptime monitoring
- **Language-Aware Text Splitter** - `LanguageAwareSplitter` class with language-specific tokenization (EN, ES, FR, DE, JA, ZH) for improved RAG chunking
- **Aviationstack Response Caching** - NodeCache (5-min TTL) on airline and airport info lookups to reduce redundant API calls
- **Image Generation Concurrency** - PQueue-based concurrency limiter (max 5 parallel) with retry and exponential backoff for image generation
- **MCP Transport Error Categorization** - `categorizeError()` classifies MCP errors as ServerError/ClientError/NetworkError with actionable messages
- **MCP SSE Retry** - Automatic retry with 3 attempts for SSE transport message sending
- **Improvement Model Resilience** - `handleError()` with retry + context logging, `healthCheck()` static for diagnostics
- **SSH Session Analytics** - `generateSessionReport()` computes session metrics (count, duration, error rate, usage patterns by day)

### PR Review Batch 7 (#1258-#1273)
- Reviewed 16 AI-generated PRs
- Implemented 8 features manually with corrected imports and patterns
- Closed 8 PRs (broken imports, incomplete changes, destructive template edits, missing dependencies)

## [2.10.48] - 2026-01-31

### Added
- **PancakeSwap V3 / Uniswap V3 Swap Support** - V3 quoting and swapping alongside V2
  - V3 Quoter contracts for BSC and Ethereum with all fee tiers (100, 500, 2500, 10000)
  - `_getV3Quote()` tries single-hop and multi-hop paths, picks best output
  - `_executeV3Swap()` handles single-hop (`exactInputSingle`) and multi-hop (`exactInput`)
  - Native output unwrapping via `multicall` with `unwrapWETH9`
  - Tax tokens forced to V2 (V3 lacks fee-on-transfer support)
  - `getQuote()` and `swap()` compare V2 vs V3 and pick whichever gives better output
- **V3 Multi-Hop Routing** - Route through liquid intermediate pools (e.g., USDT→WBNB→FHE)
  - All fee tiers tried for native-wrapped multi-hop (4x4 = 16 combinations)
  - Top 2 fee tiers per leg for stablecoin multi-hop (limits RPC calls to ~32)
- **Price Impact Guard** - Pre-swap price impact check in token trader executor
  - MAX_PRICE_IMPACT_PCT = 10% threshold for both buys and sells
  - Compares effective trade price vs spot price (1-unit DEX quote)
  - Aborts trade if impact exceeds limit, prevents catastrophic losses in thin pools
- **Token Trader Strategy** - New strategy for speculative token trading
- **HuggingFace Music Provider** - Framework for MusicGen integration (pending HF inference support)
- **Crypto Strategy UI** - Web dashboard for strategy management and monitoring

### Fixed
- **Music Plugin Credential Loading** - `basePlugin.js loadCredentials()` now queries correct MongoDB fields
  - Was reading `settings.credentials` instead of `settingsValue` with `settingsKey: 'credentials'`
  - Affected all plugins storing credentials via the web UI
- **Music Provider Error Serialization** - API errors no longer show `[object Object]`
  - Properly extracts error string from nested response objects
- **AIML API Endpoint** - Updated from deprecated Suno endpoint to current `/v2/generate/audio`
  - Tries `stable-audio` (cheapest) then `minimax/music-2.0` as fallback
- **GeneratedSong Model** - Added `huggingface` to provider enum

## [2.10.47] - 2026-01-31

### Added
- **Faucet Multi-Network Batch Claims** - `POST /api/faucets/claim/multi` endpoint for batch claiming across networks
  - Accepts `{ networks: [...] }` body, max 5 networks per request
  - Uses existing `claimFromApiFaucet()` for each automated faucet per network
  - Checks cooldown via `canClaim()` before attempting claims
  - Invalidates caches after successful claims
  - Rate-limited via existing `claimLimiter`

### Improved
- **DiagnosticReport Health Trend Caching** - NodeCache (5-min TTL) on `getHealthTrend` aggregation
  - Avoids redundant MongoDB aggregation queries for repeated calls
  - Cache key includes `days` parameter for proper cache separation

### Crypto Trading Fixes
- **Stop-Loss Ping-Pong Prevention** - 1-hour cooldown after stop-loss sell prevents immediate buy-back
- **Multi-Network Trading** - Execute trades on all networks per trigger, not just the first decision
- **Received Amount Display** - Fixed USDC showing as 0 (was using 18 decimals instead of 6)
- **Swap Deadline** - 2-hour deadline for ETH mainnet (was 20 min, caused EXPIRED errors during congestion)
- **TX Confirmation Wait** - Waits for on-chain confirmation before marking position (prevents false position updates)
- **Telegram Notification Formatting** - Underscore escape for Markdown, proper decimal display for amounts

### PR Review (PRs #1253-#1257)
- 5 PRs reviewed, 0 merged as-is, 2 reimplemented manually, 3 closed
- Reimplemented: #1254 (DiagnosticReport.js health trend caching), #1255 (faucets.js multi-network claims)
- Closed: #1253 (imageGenerationService.js broken imports, no-op feature), #1256 (NetworkDevice.js broken logic, duplicates pollDevices), #1257 (UpsConfig.js dead code, never called)

## [2.10.46] - 2026-01-31

### Added
- **Diagnostics Scheduled Execution** - On-demand scheduled diagnostics via plugin commands
  - `schedule` command - Schedule automatic diagnostics at specified intervals using Agenda
  - `view-schedule` command - View all scheduled diagnostic jobs
  - `cancel-schedule` command - Cancel all scheduled diagnostic jobs
  - Natural language intents: "schedule diagnostics", "view scheduled diagnostics", "cancel scheduled diagnostics"

### Improved
- **DevEnv API Resilience** - All 20 devenv endpoints wrapped with `retryOperation` (3 retries with exponential backoff)
- **DevEnv Structured Logging** - Replaced all `console.error` with structured `logger.error` across devenv.js
- **DevEnv Metrics Caching** - NodeCache (10-min TTL) for project metrics endpoint to reduce load
- **Video Generation Retry** - `retryOperation` wrapper on video generation provider calls for transient failure recovery

### PR Review (PRs #1243-#1252)
- 10 PRs reviewed, 0 merged as-is, 3 reimplemented manually, 7 closed
- Reimplemented: #1243 (devenv.js retry + logger + caching), #1247 (diagnostics scheduled execution), #1251 (video generation retry)
- Closed: #1244 (StrategyRegistry async Map.set nonsensical), #1245 (ContractEvent placeholder code), #1246 (commandParser breaking async + lost capture groups), #1248 (pluginUIManager Node.js logger in browser code), #1249 (selfHealing unattached WebSocket server), #1250 (encryption key length mismatch), #1252 (SSH stub connection pool)

## [2.10.45] - 2026-01-30

### Added
- **DeviceGroup Bulk Operations** - Transactional bulk CRUD for MQTT device groups
  - `bulkCreate` - Create multiple device groups in a single transaction
  - `bulkUpdate` - Update multiple device groups atomically
  - `bulkDelete` - Delete multiple device groups by ID with transaction rollback on failure
- **Twitter Thread Download** - Download full Twitter/X threads
  - `downloadThread` command fetches all tweets in a thread starting from a given URL
  - Follows conversation chain via FxTwitter API
  - Dynamic intent registration for natural language ("download this thread")
- **MCPToken Usage Threshold Notifications** - Proactive token usage alerts
  - `checkUsageThreshold()` instance method on MCPToken model
  - Logs warning when token usage exceeds threshold (default 1000)
  - Called automatically on each token usage increment
- **HuggingFace Custom Model Selection** - Use any Hugging Face model
  - `customModel` parameter on textClassification, textGeneration, questionAnswering
  - `listModels` command to browse available models from HuggingFace API
  - Custom model overrides default model when specified
- **NASA Batch Mars Rover Sols** - Fetch photos from multiple sols in one call
  - `marsRoverPhotos` now accepts an array of sols for batch fetching
  - Results aggregated across all requested sols
  - `retryOperation` added to all NASA API calls (APOD, Mars Rover, NEO, Earth, EPIC, ADS)

### Improved
- **Firewall Retry Logic** - All UFW commands wrapped with `retryOperation` (3 retries)
- **Firewall Logger Migration** - Replaced all `console.error` with structured `logger.error`
- **Project Task Caching** - Module-level NodeCache (5-min TTL) for Project.js task queries
- **OutputParser Lazy Schema Compilation** - Ajv schema compiled on first parse instead of constructor

### PR Review (PRs #1232-#1242)
- 11 PRs reviewed, 5 merged, 3 reimplemented manually, 3 closed
- Merged: #1233 (DeviceGroup bulk ops), #1237 (Twitter threads), #1239 (MCPToken thresholds), #1241 (HuggingFace models), #1242 (Firewall retry + logger)
- Reimplemented: #1232 (Project.js task caching), #1236 (OutputParser lazy compile), #1238 (NASA batch sols + retry)
- Closed: #1234 (non-functional outputSchemas versioning), #1235 (wrong Vonage scheduler API), #1240 (DiagnosticReport standalone WebSocket on hardcoded port)

## [2.10.44] - 2026-01-30

### Fixed
- **Crypto Strategy Never Trading** - Fixed 3 bugs preventing dollar_maximizer from ever executing trades
  - **Price key mismatch**: scheduler.js `cryptoPriceState` didn't store `symbol`, causing heartbeat to pass network names ("ethereum") instead of token symbols ("ETH") as price keys. Strategy looked up `ETH/USD` but found `ethereum/USD` → "No price data" → always hold.
  - **Transform fallback**: All 5 strategy executors used `priceData.symbol` without checking if it matched the network name. Added fallback to `networks[network].symbol`.
  - **Baseline state never persisted**: `executeDollarMaximizer` hold/sell/buy paths never saved `priceBaselines` or `positions` back to agent state via `updateState()`. Every run reset baseline to current price → 0% change → always hold.
- **Strategy execution logging**: Added detailed logging for DollarMaximizer analysis (prices, baselines, changes, opportunities, decisions) and market data gathering (wallet balances per network)

## [2.10.43] - 2026-01-30

### Added
- **SignalWire Template Messaging** - Predefined message templates with variable substitution
  - `sendtemplatemessage` command sends messages using templates with `{{variable}}` placeholders
  - `managetemplates` command for full CRUD + list operations on templates
  - Template variable substitution preserves unmatched variables
- **BaseProvider Simulation Mode** - Test provider responses without real API calls
  - Enable with `simulationMode: true` in provider config
  - Returns mock responses for generateResponse, generateEmbedding, transcribeAudio, generateSpeech, analyzeImage
  - All simulation calls logged with `[Simulation]` prefix
- **Momentum Strategy Dynamic MA Periods** - Volatility-based moving average adjustment
  - `calculateVolatility()` measures market volatility as average absolute price change
  - `adjustMAPeriods()` scales MA periods by volatility factor (0.5x-2x range)
  - Higher volatility = longer MA periods (smoother), lower volatility = shorter (more responsive)
  - Preserves per-asset trendStrength configuration
- **ReActAgent Context-Aware Error Logging** - Enhanced diagnostics for reasoning pipeline
  - Error handlers now include agent state, query, iteration count, and action parameters
  - Thinking errors include query and history length for debugging

### PR Review (PRs #1224-#1231)
- 8 PRs reviewed, 4 features reimplemented manually, 4 closed
- Reimplemented: #1224 (reactAgent.js error logging), #1225 (BaseProvider simulation), #1228 (MomentumStrategy dynamic MA), #1230 (SignalWire templates)
- Closed: #1226 (unnecessary Redis dependency), #1227 (breaking async validation change), #1229 (naive NLP with new dependency), #1231 (bad mongoose document caching)

## [2.10.42] - 2026-01-29

### Added
- **Event-Driven Crypto Strategy Execution** - Replaces blind 60-minute timer
  - `SubAgentOrchestrator.dispatchEvent()` routes domain events to agents via `schedule.eventTriggers`
  - Chainlink price monitor (5-min Agenda job) reads ETH/USD and BNB/USD on-chain feeds
  - Dispatches `crypto:significant_move` event on >1% price moves
  - Crypto heartbeat (30-min Agenda job) for time-based strategies in flat markets
  - Pre-fetched Chainlink prices passed through event data to avoid redundant reads
  - CryptoStrategyAgent subscribes to events instead of running on a blind timer

### Changed
- `GeneratedSong` model compound index expanded to include `createdAt: -1` for query optimization

### PR Review (PRs #1211-#1223)
- All 13 PRs closed (fatal issues in every PR)
- Salvaged: GeneratedSong compound index optimization from PR #1221
- Common issues: fabricated API endpoints, broken imports, nonexistent dependencies, SyntaxErrors

## [2.10.41] - 2026-01-29

### Added
- **CloudWatch Alarm Management** - Real AWS SDK v3 integration replacing mock data
  - `createalarm` - Create CloudWatch alarms with configurable thresholds
  - `deletealarm` - Delete CloudWatch alarms by name
  - `describealarms` - Describe and inspect alarm details
  - Replaced mock data responses with real AWS SDK v3 `@aws-sdk/client-cloudwatch` calls
  - Existing getmetrics, putmetricdata, listmetrics now use real SDK calls

- **Vonage 2FA OTP** - Two-factor authentication via SMS
  - `send2fa` command sends numeric OTP to phone numbers
  - Secure implementation: OTP only sent to phone, never returned in API response
  - Cryptographically secure numeric OTP generation via `crypto.randomInt`

- **SSH Connection Tagging** - Tag-based organization for SSH connections
  - Tags field added to SSHConnection model
  - Tag filtering support in GET /ssh/api/connections via query parameter
  - Tags passthrough in create/update SSH connection routes

- **SSH Session Tracking** - Session logging for SSH connections
  - `sessionLogs` array tracks start/end times, duration, errors
  - `startSession`, `endSession`, `logSessionError` instance methods
  - Tags index for efficient tag-based lookups

- **MCP Token Usage Analytics** - Track token access patterns
  - Peak usage times tracking by hour
  - Most accessed tools tracking
  - `trackUsageAnalytics` instance method for per-token tracking
  - `aggregateUsageAnalytics` static for cross-token aggregation

- **Vector Search Enhancements** - Improved reliability and filtering
  - Retry logic on intent indexing, embedding generation, and vector search
  - Filter parameter passthrough to vector store search endpoint
  - Health check endpoint at `/api/vector-intent/health`

- **Email Signature Templates** - Role/department-based template selection
  - Templates auto-selected based on user role (manager, developer, intern)
  - Department-based templates (sales, engineering, hr)
  - Falls back to default style parameter

### Improved
- **BaseProvider Resilience** - TokenUsage persistence wrapped with retry logic
- **FeatureRequest Indexing** - Optimized composite index on category + submittedAt

### PR Review Session
- Reviewed 13 PRs (#1198-#1210)
- Merged: 1 (#1199 - email signature templates)
- Closed with features reimplemented: 8 (#1200, #1202, #1203, #1204, #1205, #1207, #1208, #1209)
- Closed as broken: 4 (#1198, #1201, #1206, #1210)

## [2.10.40] - 2026-01-28

### Added
- **YouTube Video Transcription** - Get transcripts from YouTube videos
  - Subtitle extraction via yt-dlp (fast, free path using existing captions)
  - Audio transcription fallback via Whisper STT for videos without subtitles
  - VTT and SRT subtitle parsing with deduplication and HTML tag removal
  - Chunked audio transcription for long videos (20-min chunks, respects 25MB Whisper limit)
  - Intent 167 for NLP detection ("transcribe this video", "what does this video say")

## [2.10.39] - 2026-01-28

### Added
- **Journal Mode** - Captain's log style personal journaling via Telegram
  - Enter/exit journal mode via `/journal` command or NL ("enter journal mode")
  - Records all text and voice input while in journal mode
  - AI-generated title, summary, tags, and mood analysis on session close
  - Memory extraction from journal entries (preferences, goals, facts)
  - Search journals by keyword or date range
  - View and summarize past journal sessions
  - Voice message transcription support while journaling
  - New Journal Mongoose model with embedded entries schema

## [2.10.38] - 2026-01-28

### Added
- **Twitter/X Plugin** - Download and display tweets with text, images, and videos
  - Download photos and videos from Twitter/X posts via URL
  - Extract text and metadata without downloading media
  - Uses FxTwitter API (no authentication required, no broken npm packages)
  - Video size check (50MB Telegram limit) with direct link fallback
  - Auto-cleanup of temp files older than 1 hour
  - Dynamic intent registration via plugin commands array

## [2.10.37] - 2026-01-28

### Added
- **Digest Plugin - Web Search & Scheduled Briefings**
  - Scheduled digests with cron-based delivery via Agenda
  - Executive briefing format for Telegram messages
  - Smart message splitting for long content (4000 char limit)
  - New `deliveryMethod` parameter for research action
  - New actions: `scheduleDigest`, `getSchedules`, `removeSchedule`, `runScheduledDigest`
  - Preferred sources guide research via prompt directive
  - No link previews in Telegram messages (`disable_web_page_preview`)

- **OpenAI Web Search Support**
  - Added web search via OpenAI Responses API with `web_search_preview` tool
  - Digest plugin now uses selected provider's web search (OpenAI or Anthropic)

- **Guest Message Retry Logic** (PR #1192 idea)
  - Added retry logic to `processGuestMessage` in multiUserSupport.js
  - Improves resilience for transient AI provider errors

- **Command Parser Confidence Threshold** (PR #1193 idea)
  - Commands with confidence below 0.7 now require approval
  - Reduces false positive command executions

- **Mediastack API Throttling** (PR #1195 idea)
  - Native request throttling (~3 req/sec) without external dependencies
  - Prevents rate limit issues with mediastack API

### Fixed
- **DiscoveredFeature NodeCache Error**
  - Added `.lean()` to queries to fix `_defaultToObjectOptions` cloning error
  - NodeCache can now properly cache query results

### Changed
- **Digest Plugin Research**
  - Uses selected provider with web search (no forced Anthropic switch)
  - Improved prompts requesting article URLs

### Closed (Not Merged)
- **PR #1194 gab.js batch processing**: Removes critical init code, broken batching logic
- **PR #1196 MomentumStrategy adaptive MA**: Flawed ATR calculation, backwards logic
- **PR #1197 anthropic.js multilingual**: Imports non-existent file, Claude already multilingual

## [2.10.36] - 2026-01-27

### Added
- **Task Reminder Retry Logic** (PR #1172)
  - Added retry mechanism for task reminder notifications using retryUtils
  - Improves resilience when notification channels are temporarily unavailable

- **Device Alias Caching & Performance** (PR #1177)
  - Added NodeCache for caching device alias queries (5-minute TTL)
  - Uses `.lean()` for Mongoose queries to reduce memory overhead
  - Proper cache invalidation on create/update/delete operations
  - Added retry logic for database operations

- **HealingEvent Retry Logic** (PR #1176)
  - Added retry mechanism for HealingEvent.fail() save operations
  - Improves database operation resilience

- **UpsEvent Improvements** (PR #1180)
  - Added retry logic for UpsEvent save operations
  - Added basic `correlateEvents()` method for event pattern analysis

### Closed (Not Merged)
- **PR #1173 accounts.js pagination**: Service doesn't support pagination params
- **PR #1174 gravatarHelper.js async**: Retry logic on sync hash operations unnecessary
- **PR #1175 validation.js async**: Breaking change - callers use sync API
- **PR #1178 GitHostingProvider webhooks**: Just stubs with no implementation
- **PR #1179 faucetService.js auto-claim**: Speculative API endpoints

## [2.10.35] - 2026-01-26

### Added
- **Crypto Strategy Baseline Staleness Auto-Reset**
  - New `checkAndResetStaleBaselines()` method in CryptoStrategyAgent
  - Automatically resets baselines when they become stale (default: 5 days old AND 2%+ below)
  - Prevents agent from being stuck waiting for prices to recover to old highs
  - Logs resets with reason and previous baseline for audit trail
  - Configurable via `baselineStaleDays` and `baselineStaleThreshold` config options

- **VolatilityAdjustedStrategy State Persistence**
  - Strategy registry state is now persisted after each agent run
  - Baseline staleness detection config added to strategy
  - Added `getBaselineStalenessInfo()` method for visibility
  - Added `manualBaselineReset()` for manual intervention

### Fixed
- **Crypto Agent Not Trading**
  - Root cause: Baselines were 5-7 days old with prices 5-9% below
  - Agent was waiting for prices to rise to old levels before selling
  - Now automatically resets stale baselines to current prices
  - Example: ETH baseline reset from $3,214 → $2,920 (was 9.34% below)
  - Example: BNB baseline reset from $924 → $876 (was 5.24% below)

## [2.10.34] - 2026-01-26

### Added
- **Provider Priority Adjustment**
  - New `adjustProviderPriority()` method in ProviderManager
  - Dynamically reorders fallback providers based on performance metrics
  - Sorts by combined response time and error rate

- **Scan Progress Cache Optimization**
  - Batch delete for cache key invalidation (more efficient than iteration)

### Fixed
- **Git Issue Creation from Natural Language**
  - Fixed git.createIssue not receiving `message` field for natural language processing
  - Now correctly passes original user input to createIssueFromNaturalLanguage
  - Issue creation via API ("create a github issue for: X") now works correctly

- **Email Duplicate Processing**
  - Fixed emails being processed twice per check cycle
  - Added deduplication by messageId before concatenating IMAP and database emails

- **Self-Modification Duplicate PRs**
  - Fixed race condition where both Agenda scheduler and internal idle check interval
    could trigger `checkForImprovements()` simultaneously, causing two PRs within minutes
  - Disabled internal idle check interval since Agenda already handles scheduling
  - Now only Agenda's `self-mod-scan` job triggers capability upgrades (hourly)

### PR Review Session (Major)
- Reviewed 17 AI-generated PRs (#1154-#1170)
- **2 merged:**
  - #1154 (scanProgressCache.js) - Batch delete for cache key optimization
  - #1158 (providerManager.js) - Provider priority adjustment based on metrics
- **15 closed due to issues:**
  - #1155 (donationService.js) - Wrong import path for retryUtils
  - #1156 (NativeMaximizerStrategy.js) - Wrong import path, unused code
  - #1157 (DCAStrategy.js) - Wrong import paths for logger and retryUtils
  - #1159 (transactionService.js) - Breaking change: queued transactions instead of immediate
  - #1160 (MeanReversionStrategy.js) - Dead code: functions defined but never called
  - #1161 (vectorIntentRoutes.js) - Good retry logic but unused cache import
  - #1162 (gab.js) - Unused NodeCache, removed helpful comments
  - #1163 (mcpClient.js) - Wrong import path for retryUtils
  - #1164 (zapier.js) - Uses non-existent TaskScheduler.schedule method
  - #1165 (emailSignatureHelper.js) - Unused NodeCache import
  - #1166 (GridTradingStrategy.js) - HTTP handler in strategy class, removed docs
  - #1167 (CryptoStrategy.js) - All code unused (dead imports and functions)
  - #1168 (DiagnosticReport.js) - Unused NodeCache and retryOperation imports
  - #1169 (firewall.js) - Uses non-existent TaskScheduler.schedule method
  - #1170 (mcpTransport.js) - Unused imports, removes comments

### Common Issues in AI-Generated PRs
- Wrong import paths (e.g., '../utils/' instead of '../../utils/')
- Adding imports/declarations that are never used
- Removing helpful documentation comments
- Breaking existing functionality with "optimizations"
- Defining functions that are never called

## [2.10.33] - 2026-01-26

### Added
- **MqttBroker Dynamic Subscription Management**
  - New `addSubscription()` method to add subscriptions at runtime
  - New `removeSubscription()` method to remove subscriptions by topic
  - New `updateSubscription()` method to modify existing subscriptions
  - All methods persist changes to database automatically

### Fixed
- **Settings Page Token Thresholds Button**
  - Added `getTokenThresholds` and `setTokenThresholds` to monitoring plugin action enum
  - Fixed app.js API call to pass thresholds directly instead of wrapped in data object
  - Token threshold save button now works correctly

### PR Review Session
- Reviewed 3 AI-generated PRs (#1150-#1152)
- 0 merged directly, 1 implemented manually:
  - #1151 (MqttBroker.js) - Dynamic subscription management (implemented without unused import)
- 2 closed due to issues:
  - #1150 (NativeMaximizerStrategy.js) - Wrong import paths, unnecessary async conversion
  - #1152 (mcpClient.js) - Wrong import path, redundant caching over already-cached methods

## [2.10.32] - 2026-01-25

### Added
- **DiscoveredFeature Caching**
  - Added NodeCache caching to static methods (findByRepository, findImplementable, searchForExamples)
  - 10-minute TTL for cached query results
  - Reduces database load for frequently-accessed feature discovery queries

### PR Review Session
- Reviewed 4 AI-generated PRs (#1146-#1149)
- 1 merged:
  - #1146 (DiscoveredFeature.js) - Query result caching
- 3 closed due to issues:
  - #1147 (database.js) - Uses deprecated `poolSize` option (should be `maxPoolSize`)
  - #1148 (webScraper.js) - Removes important VPN rotation retry behavior
  - #1149 (filteredTransport.js) - Breaks winston transport, adds uninstalled dependency

## [2.10.31] - 2026-01-25

### Added
- **ABI Manager Retry Logic**
  - Added retryOperation wrapper to database operations in ABIManager
  - Uses isRetryableError for intelligent retry decisions
  - Improves resilience for contract ABI storage and retrieval

- **Resource Manager Analytics**
  - New `analyzeResourceUsage()` method for taking usage snapshots
  - New `generateResourceUsageReport()` method for time-based reports
  - Tracks resource usage patterns over time

- **API Key Usage Reports**
  - New `generateUsageReport()` method in apiKeyService
  - Aggregates usage statistics with date filtering
  - Calculates average usage per day and per key

- **Bulk Device Alias Parallelization**
  - Changed bulk alias import from sequential to parallel (Promise.all)
  - Improves performance for large alias imports

### Fixed
- **Mongoose Validation Error in Memory Storage**
  - Fixed object content being passed to storeConversation without stringification
  - Now properly converts response.content objects to JSON strings
  - Prevents "type Object at path content" validation errors

### PR Review Session
- Reviewed 6 AI-generated PRs (#1140-#1145)
- 2 merged:
  - #1142 (resourceManager.js) - Usage analytics methods
  - #1144 (abiManager.js) - Retry logic for database operations
- 4 closed due to issues:
  - #1140 (filteredTransport.js) - Breaks winston transport contract
  - #1141 (DeviceAlias.js) - Uses non-existent scheduler method
  - #1143 (apiKeyService.js) - Unused imports (implemented idea manually)
  - #1145 (deviceAliasRoutes.js) - Unused import (implemented idea manually)

## [2.10.30] - 2026-01-25

### Added
- **Batch Signature Signing** (`/api/signatures/sign-batch`)
  - New endpoint for signing multiple messages in parallel
  - Uses Promise.all for efficient batch processing
  - Accepts array of messages, returns array of signatures

- **ThingSpeak Data Transformation** (`transformAndSendData`)
  - New plugin action for transforming data before sending to ThingSpeak
  - Supports scaling transformations
  - Validates transformed data before API submission

- **NewRelic Error Logs** (`getErrorLogs`)
  - New plugin action to fetch error logs for specific applications
  - Returns detailed error information from NewRelic API

- **Markdown Table Formatting** (`formatTable`)
  - New utility function for formatting 2D arrays as Markdown tables
  - Auto-calculates column widths for proper alignment
  - Added to markdown utility module

- **Memory Vector Store Batch Processing**
  - Batch insertion for memory embeddings (50 records default)
  - Configurable batch size and timeout via environment variables
  - Uses NodeCache for improved performance
  - Retry logic with `retryOperation` for database writes

- **Self-Modification Lock Retry Logic**
  - Added retryOperation wrapper to all file operations
  - Improves resilience for lock file reads/writes
  - Prevents transient filesystem errors from breaking locks

### PR Review Session
- Reviewed 18 AI-generated PRs (#1122-#1139)
- 6 merged:
  - #1128 (memoryVectorStore.js) - Batch processing for vector store
  - #1129 (newrelic.js) - getErrorLogs function
  - #1133 (thingspeak.js) - transformAndSendData function
  - #1134 (markdown.js) - formatTable utility
  - #1135 (selfModLock.js) - Retry logic for file operations
  - #1136 (signatures.js) - Batch signing endpoint
- 12 closed due to issues:
  - #1122 (accounts.js) - Imports non-existent accountActivityLogger service
  - #1123 (BluetoothDevice.js) - Truncated file, removed exports
  - #1124 (zapier.js) - Uses non-existent TaskScheduler.scheduleJob()
  - #1125 (apiManager.js) - Wrong import path, broken version check
  - #1126 (NativeMaximizerStrategy.js) - Wrong import path, unused imports
  - #1127 (GridTradingStrategy.js) - Wrong import path, removes documentation
  - #1130 (faucetService.js) - Breaking API change (array to object)
  - #1131 (numverify.js) - Unused rateLimit import
  - #1132 (donationService.js) - Wrong import path
  - #1137 (whois.js) - Uses non-existent API method
  - #1138 (mcpClient.js) - Wrong import path, redundant caching
  - #1139 (projectContext.js) - Broken code (this in module function)

## [2.10.29] - 2026-01-24

### Added
- **Transaction Service Retry Logic**
  - Added retry mechanism for contract function calls with exponential backoff
  - Added retry mechanism for native token transfers (ETH, BNB, MATIC)
  - Improves resilience against transient network errors
  - Uses existing `retryOperation` utility from retryUtils.js

### Fixed
- **Crypto Strategy Agent Scheduling**
  - Fixed Agenda job not persisting after app restart
  - Agent now properly schedules and runs every 60 minutes
  - Verified market data gathering and signal analysis working correctly

- **AI Intent Detection for YouTube Audio Downloads**
  - Added new intent 166 (downloadAudio) for downloading audio/MP3 from URLs
  - Fixed issue where YouTube MP3 requests were incorrectly routed to ffmpeg.extract
  - Updated intents 64-66 with clearer descriptions to differentiate URL downloads from local file operations
  - Updated Decision Guide for proper intent routing

- **Conversation Context for Multi-Step Tasks**
  - PluginChainProcessor now receives conversation history for context-aware task analysis
  - AI can now understand follow-up requests like "try again", "send me the file", etc.
  - References to previous messages (URLs, filenames) are now properly resolved

- **Downloaded File Auto-Delivery**
  - Added handler for files already on disk (e.g., ytdlp downloads)
  - Files are now auto-sent via Telegram based on extension (audio/video/photo/document)
  - Clarified prompt: "send me" via Telegram = single download step (no email needed)

### PR Review Session
- Reviewed 7 AI-generated PRs (#1115-#1121)
- 1 implemented correctly:
  - #1115 (transactionService.js) - Transaction retry logic (fixed wrong import path)
- 6 closed due to issues:
  - #1116 (MomentumStrategy.js) - Unused imports, unnecessary complexity
  - #1117 (MqttState.js) - Security vulnerability (eval via new Function)
  - #1118 (numverify.js) - Would break cleanup method (Map vs NodeCache API)
  - #1119 (MCPToken.js) - Broken validation logic for bcrypt comparison
  - #1120 (BluetoothDevice.js) - Catastrophically broken (truncated file)
  - #1121 (operationLogger.js) - Hardcoded WebSocket port, no error handling

## [2.10.27] - 2026-01-23

### Fixed
- **Crypto Strategy Agent Budget System**
  - Increased daily API call budget from 50 to 500 for SubAgent
  - Increased daily token budget from 25,000 to 250,000
  - Fixed in-memory budget check not reflecting database updates
  - `generateResponse()` now refreshes agentDoc from database before checking budget
  - Prevents "Daily API call budget exceeded" errors after direct DB updates

### Added
- **CLAUDE.md Project Instructions**
  - Comprehensive development instructions for Claude Code
  - Production server credentials and deployment procedures
  - PM2 management, debugging commands, and documentation guidelines
  - Persists across Claude Code sessions

### Infrastructure
- **Crypto Strategy Price History Seeding**
  - Used existing `/api/crypto/strategy/seed-history` endpoint
  - Seeded 24 hours of CoinGecko price data for ETH and BNB
  - Strategy now operational with volatility calculations
  - Verified low volatility regime detection (2-3%) with tightened thresholds

## [2.10.26] - 2026-01-23

### Added
- **MCPServer Dynamic Configuration** (PR #1094)
  - `watchConfigFile()` method for watching config file changes
  - `updateServerConfigurations()` to apply changes without restart
  - Zero-downtime configuration updates for MCP servers
- **Mediastack Response Caching** (from PR #1093 idea)
  - NodeCache integration with 5-minute TTL
  - Reduces API calls for frequently accessed news queries
  - `getCachedData()` helper method for caching pattern
- **MeanReversionStrategy Volatility Adjustment** (from PR #1092 idea)
  - Dynamic MA period adjustment based on market volatility
  - Per-pair volatility tracking and MA period management
  - New config options: volatilityThreshold, maxMAPeriodHours, minMAPeriodHours
  - `updateVolatility()` and `adjustMAPeriod()` methods
  - Enhanced stats include volatility and per-pair MA period
- **BluetoothDevice Query Caching** (from PR #1095 idea)
  - Caching for `getPairedDevices()` and `getConnectedDevices()`
  - Automatic cache invalidation on device changes
  - `retryOperation` wrapper for database operations
  - `invalidateCache()` static method
- **EventRule Query Caching** (from PR #1096 idea)
  - Caching for `findMatchingRules()` with cache invalidation hooks
  - Post-save and post-delete hooks for automatic cache invalidation
  - Retry logic for database queries

### PR Review Session
- Reviewed 6 AI-generated PRs (#1092-#1097)
- 1 merged:
  - #1094 (MCPServer.js) - Dynamic configuration updates
- 5 closed with features re-implemented correctly:
  - #1092 (MeanReversionStrategy.js) - Fixed per-pair MA period tracking (was global)
  - #1093 (mediastack.js) - Removed unused rateLimit import
  - #1095 (BluetoothDevice.js) - Added missing cache invalidation
  - #1096 (EventRule.js) - Added missing cache invalidation hooks
  - #1097 (projectContext.js) - Closed: requires new `natural` dependency, functionality already exists

## [2.10.25] - 2026-01-23

### Added
- **Plugin Settings Versioning** (PR #1089)
  - Version field tracks settings changes
  - History array stores all previous states
  - `rollbackToVersion()` allows reverting to any previous version
  - `getHistory()` returns complete audit trail
- **Adaptive Circuit Breaker** (PR #1090)
  - `adjustParameters()` method dynamically adjusts failure threshold and recovery timeout
  - Parameters adjusted based on historical failure rate (>70%, >40%, default)
  - Uses existing retryHistoryCache for tracking
- **WebLoader Retry Logic** (from PR #1091 idea)
  - WebLoader now retries failed requests with exponential backoff
  - 3 retries with 1s minimum timeout
  - Improves resilience for transient network errors

### PR Review Session
- Reviewed 3 AI-generated PRs (#1089-#1091)
- 2 merged:
  - #1089 (PluginSettings.js) - Settings versioning and history
  - #1090 (retryUtils.js) - Adaptive circuit breaker
- 1 closed with fix re-implemented:
  - #1091 (documentLoader.js) - Wrong import path, fixed and implemented correctly

## [2.10.24] - 2026-01-22

### Added
- **System Reports Rate Limiting** (PR #1085)
  - Added express-rate-limit to system reports API
  - 100 requests per 15 minutes per IP
- **Agent Tool Usage Statistics** (PR #1086)
  - BaseAgentHandler now tracks tool usage frequency and success rates
  - `prioritizeTools()` method to sort tools by success rate
  - Helps optimize agent tool selection
- **MQTT Device Status History** (PR #1088)
  - MqttDevice model now tracks status history
  - `addStatusHistory()` method to record status changes
  - `getStatusHistory()` method to retrieve recent status entries
  - Added index for efficient status history queries

### PR Review Session
- Reviewed 8 AI-generated PRs (#1081-#1088)
- 3 merged:
  - #1085 (systemReports.js) - Rate limiting for system reports API
  - #1086 (BaseAgentHandler.js) - Tool usage statistics
  - #1088 (MqttDevice.js) - Status history tracking
- 5 closed due to implementation issues:
  - #1081 (SystemReport.js) - Unused import added
  - #1082 (intentIndexer.js) - Version field not meaningfully used
  - #1083 (errorHandlers.js) - Uses non-existent logger.alert, unused imports
  - #1084 (hardhat.js) - Calls non-existent service methods
  - #1087 (vonage.js) - Duplicates existing verify functionality

## [2.10.23] - 2026-01-22

### Added
- **Mediastack Date Filtering** - News queries now support date filtering
  - `date` parameter for specific date (YYYY-MM-DD format)
  - `dateFrom` and `dateTo` parameters for date ranges
  - Works with `getLatestNews`, `searchNews`, and `getNewsByCategory`
  - Proper API parameter handling (single `date` param with range format)

### PR Review Session
- Reviewed 7 AI-generated PRs (#1074-#1080)
- All closed due to implementation issues:
  - #1074 (apiKeyService.js) - References non-existent `usageLogs` field in model
  - #1075 (_ai_template.js) - Removes critical documentation, adds unused imports
  - #1076 (MCP index.js) - Wrong import path, breaks simple re-export pattern
  - #1077 (mediastack.js) - Good idea but buggy implementation (duplicate `date` params)
  - #1078 (PRReview.js) - Incomplete: function added but never integrated
  - #1079 (GridTradingStrategy.js) - Wrong import path, cache never used
  - #1080 (validation.js) - Breaking change: async would break sync callers
- Date filtering feature from #1077 re-implemented correctly

## [2.10.22] - 2026-01-21

### Fixed
- **Network Mode Persistence** - walletService now loads network mode from CryptoStrategy config on startup
  - Previously defaulted to testnet instead of loading saved value
  - Network mode now persists correctly across PM2 restarts
- **Strategy Selector Persistence** - WebUI strategy dropdown now loads from server on page load
  - Fixed timing issue where cryptoManager wasn't defined when loadCrypto ran
  - Added direct API fetch with auth headers to load active strategy
- **PM2 jlist JSON Parsing** - selfDiagnosticsEnhanced and prReviewer now handle non-JSON PM2 output prefix
  - PM2 sometimes outputs messages like ">>>> In-memory PM2..." before JSON
  - Now extracts JSON array by finding `[` character before parsing

### Added
- **Transaction History Network Filter** - WebUI filter to show mainnet-only, testnet-only, or all transactions
  - Dropdown filter in transaction history section
  - Helps users focus on real transactions vs test transactions

### PR Review Session
- Reviewed 3 AI-generated PRs (#1071-#1073)
- All closed due to implementation issues:
  - #1071 (NetworkScanResult.js) - Wrong import path, unused cache, no functional benefit
  - #1072 (logger.js) - Unused imports, no integration point
  - #1073 (SystemReport.js) - Nonsensical ML implementation (training on 3 points with dummy labels), D3 misuse server-side

## [2.10.15] - 2026-01-20

### Added
- **Polygon Network Support**
  - Added Polygon (MATIC) to active mainnet networks
  - Added Amoy testnet for Polygon testing
  - MATIC native token with USDC stablecoin pairing
  - Network-specific thresholds (5%/-4% for MATIC)

- **4 New Trading Strategies**
  - Grid Trading: Profit from price oscillations with grid-based orders
  - Mean Reversion: Buy below moving average, sell above
  - Volatility-Adjusted: Dynamic thresholds based on ATR volatility
  - Momentum: Trend following using RSI indicators

- **Token Scanner Service**
  - Automatic detection of incoming token transfers
  - Honeypot detection via DEX sell simulation
  - Scam token identification (name patterns, dust attacks)
  - Whitelist for verified tokens (USDC, USDT, DAI, WETH, WBNB, WMATIC)
  - Blacklist for known scam tokens
  - 9 new API endpoints for token scanning and safety checks

- **Position Management API**
  - `POST /api/crypto/strategy/position` - Update position state
  - `GET /api/crypto/strategy/positions` - Get all positions
  - Allows syncing positions after manual/external trades

### Fixed
- Empty wallet handling now returns 0 trade amount instead of negative
- BSC stablecoin corrected from BUSD to USDT (BUSD deprecated)
- Price pair now dynamically uses token symbol (BNB/USD, MATIC/USD)

## [2.10.14] - 2026-01-19

### Added
- **Volatility-Based Risk Management** (BaseStrategy.js)
  - `calculateVolatility()` - Calculate market volatility using historical price data
  - `adjustRiskParameters()` - Dynamically adjust maxTradePercentage based on volatility
  - Lower volatility = higher trade percentage, higher volatility = more cautious

- **Sinch Scheduled Communications**
  - `schedule_sms` - Schedule SMS messages for future delivery using Agenda
  - `schedule_voice_call` - Schedule voice calls for future time
  - `list_scheduled` - View all pending scheduled SMS and calls
  - `cancel_scheduled` - Cancel scheduled items by job ID
  - Uses Agenda scheduler for reliable job execution

- **Email Service Improvements** (PR #1039)
  - Lazy loading check to prevent redundant re-initialization
  - Retry logic for email operations (search, send, markAsRead, delete)

- **IPstack IP Range Queries** (PR #1038)
  - Support for batch IP geolocation queries with `ipRange` parameter
  - Sequential processing to respect API rate limits

### PR Review Session #5
- Reviewed 9 AI-generated PRs (#1037-#1045)
- 2 merged: #1038, #1039
- 5 closed with issues re-implemented correctly:
  - #1045 (BaseStrategy.js) - Wrong logger import path, feature re-implemented
  - #1044 (sinch.js) - Wrong scheduler usage, feature re-implemented correctly
  - #1043 (thingspeak.js) - Feature already exists, wrong express-rate-limit usage
  - #1042 (index.js) - Breaks existing exports, non-functional ConfigurationManager
  - #1041 (projectContext.js) - Uses `this` in module function (undefined)
- 2 closed as problematic:
  - #1040 (transactionService.js) - CRITICAL: Would send all funds to first recipient
  - #1037 (selfDiagnostics.js) - Unused imports, stub function with no functionality

## [2.10.13] - 2026-01-19

### Added
- **Self-Healing/Auto-Remediation Service** - Automatic detection and remediation of runtime issues
  - New `src/services/selfHealingService.js` - Core auto-remediation service
  - New `src/models/HealingEvent.js` - Database model for tracking healing actions
  - New `src/api/plugins/selfHealing.js` - API plugin for control and monitoring
  - Uses Agenda scheduler for reliable job execution (not setInterval)
  - New dedicated "Self-Healing" page in Web UI with full controls
  - Added to "Last Activities" in Background Tasks page

### Self-Healing Features
- **Memory Cleanup** - Automatic garbage collection and cache clearing when memory exceeds threshold (90%)
- **Disk Cleanup** - Log rotation and temp file cleanup when disk usage is high (90%)
- **Database Reconnection** - Automatic MongoDB reconnection on connection loss
- **Cache Cleanup** - Periodic cache clearing (every 30 minutes)
- **Log Rotation** - Automatic rotation of oversized log files (>100MB)

### Safety Features
- **Disabled by default** - Requires explicit enable via API
- **Dry-run mode** - Enabled by default, logs actions without executing
- **Per-action cooldowns** - Prevents action loops (5-60 minute cooldowns)
- **Rate limiting** - Max 10 actions per hour globally, per-action limits
- **Full audit trail** - All actions logged to database with system state

### API Endpoints (selfHealing plugin)
- `status` - Get service status, system state, and statistics
- `enable/disable` - Control service state
- `setDryRun` - Toggle dry-run mode
- `trigger` - Manually trigger healing actions (memory_cleanup, disk_cleanup, cache_clear, db_reconnect, log_rotation)
- `events` - View healing event history
- `stats` - Get healing statistics for time period
- `config` - View/update configuration
- `runCheck` - Manually trigger health check
- `systemState` - Get current system state (memory, disk, CPU, uptime)
- `cleanup` - Remove old healing events from database

## [2.10.12] - 2026-01-19

### Added
- **JSONPlaceholder Plugin - CRUD Completion** (PR #1035)
  - `updatePost` command - Update existing posts by ID
  - `deletePost` command - Delete posts by ID
  - Both commands include proper validation and error handling
  - Cache invalidation on updates/deletes

### PR Review Session #4
- Reviewed 3 AI-generated PRs (#1034-#1036)
- 1 merged, 2 closed:
  - #1034 (abiManager.js) - Closed: incorrect express-rate-limit usage for outgoing calls
  - #1035 (jsonplaceholder.js) - Merged: valid CRUD completion
  - #1036 (vectorIntentRoutes.js) - Closed: unused NodeCache code

## [2.10.11] - 2026-01-19

### Fixed
- **Ethereum RPC Endpoint** - Updated from unreliable `eth.llamarpc.com` to `ethereum-rpc.publicnode.com`
  - Fixes "no response" errors when checking ETH balances on mainnet
  - Crypto strategy agent can now reliably check Ethereum balances

### PR Review Session #3
- Reviewed 7 AI-generated PRs (#1027-#1033)
- All closed due to implementation issues:
  - #1027 (MqttState.js) - Incomplete transformation feature, removes documentation
  - #1028 (logger.js) - Non-functional service log levels, unused imports
  - #1029 (emailSignatureHelper.js) - Async/sync bug with QRCode.toDataURL()
  - #1030 (transactions.js) - Risk of duplicate transactions with retry logic
  - #1031 (diagnostics.js) - Calls non-existent scheduler.scheduleJob() method
  - #1032 (EventRule.js) - Incomplete condition evaluation, wrong location
  - #1033 (_ai_template.js) - Removes critical template docs, API mismatch

## [2.10.10] - 2026-01-19

### Added
- **Git Hosting Abstraction Layer** - Support for both GitHub and GitLab
  - New `src/services/gitHosting/` module with provider abstraction
  - `GitHostingProvider` - Abstract base class defining the interface
  - `GitHubProvider` - GitHub implementation using REST API and `gh` CLI
  - `GitLabProvider` - GitLab API v4 implementation (gitlab.com and self-hosted)
  - Factory pattern for provider selection based on settings
  - Graceful fallback to `gh` CLI when provider fails

- **GitHostingSettings Model** - MongoDB schema for git hosting configuration
  - Provider selection (github/gitlab)
  - Per-provider credentials and settings
  - Default merge/PR settings (target branch, labels, merge method)
  - Feature flags for auto-PR creation and issue management

### Changed
- **Self-Modification Service** - Now uses git hosting abstraction
  - `checkForExistingPRs()` uses provider API with fallback
  - `createPullRequest()` uses provider for PR creation
  - `createUpgradePullRequest()` supports both GitHub and GitLab

- **PR Reviewer Plugin** - Updated to use git hosting abstraction
  - `reviewPRs()` lists MRs/PRs via provider
  - `reviewSinglePR()` gets PR details via provider
  - `mergePR()`, `rejectPR()`, `implementPR()` all use provider
  - Full fallback to `gh` CLI for backwards compatibility

### Environment Variables
- `GIT_HOSTING_PROVIDER` - Set to 'github' or 'gitlab' (default: github)
- `GITHUB_TOKEN` - GitHub Personal Access Token
- `GITLAB_TOKEN` - GitLab Personal Access Token
- `GITLAB_URL` - GitLab instance URL (default: https://gitlab.com)
- `GITLAB_PROJECT_ID` - GitLab project ID (owner/repo or numeric)

## [2.10.9] - 2026-01-18

### Added
- **NetworkDevice Model** - Persistent storage for discovered network devices
  - Devices now survive server restarts (stored in MongoDB)
  - Tracks: IP, MAC, hostname, vendor, deviceType, OS, services, ports
  - Stores discovery timestamps (dateDiscovered, lastSeen, lastOnline)
  - User customization: name, category, tags, notes
  - Monitoring preferences: alertOnOffline, alertOnOnline, wolEnabled
  - Status history for uptime tracking

- **Device Polling** - Periodic availability checks via ping/ARP
  - Polls monitored devices between full scans
  - Alerts when devices go online/offline (configurable per device)
  - ARP fallback for devices that don't respond to ping

### Fixed
- **Crypto Network Mode** - WebUI toggle now updates all 3 storage locations
  - walletService, cryptostrategies collection, and subagents collection

## [2.10.8] - 2026-01-18

### Fixed
- **Telegram Markdown** - Removed unnecessary dash escaping in `escapeMarkdown()` utility

### Improved
- **UPS Monitoring (NUT)** - Verified and tested on production server
  - APC Back-UPS XS 1500M successfully connected via USB
  - NUT configured with udev rules for USB permissions
  - Auto-detection and configuration working correctly
  - Polling, notifications, and MQTT publishing operational

## [2.10.7] - 2026-01-18

### Added
- **HuggingFace Plugin** - NLP models API integration
  - `textClassification` - Classify text into predefined categories
  - `textGeneration` - Generate text based on prompts
  - `questionAnswering` - Answer questions based on context

- **MessageBird Plugin** - Global communication API
  - `sendSMS` - Send SMS messages with originator ID
  - `getBalance` - Check account balance

- **Google Cloud Functions Plugin** - Serverless cloud automation
  - `listFunctions` - List all functions in a project
  - `getFunction` - Get details of a specific function
  - `deployFunction` - Deploy new cloud functions

### Improved
- **Revenue API** - Added caching, rate limiting, and retry logic
  - Response caching for summary endpoints (5-minute TTL)
  - Rate limiting (100 requests per 15 minutes)
  - Retry logic for all service calls

- **Contracts API** - Added caching, rate limiting, and retry logic
  - Response caching for network info, token info, balances (5-minute TTL)
  - Rate limiting (100 requests per 15 minutes)
  - Retry logic for contract reads

- **DiscoveredFeature Model** - Added retry logic for database operations
  - All static methods now use retryOperation for resilience
  - Proper error logging before re-throwing

- **CalendarEvent Model** - Timezone conversion for attendees
  - New timezone field for attendees
  - `convertTimesForAttendee()` method for automatic time zone conversion

### PR Review Sessions
- First session: Reviewed 13 PRs - Merged #999, #1002 - Manually implemented 3 plugins
- Second session: Reviewed 4 PRs - Merged #1009, #1011 - Closed 2 with explanations

## [2.10.6] - 2026-01-18

### Added
- **Checkly Plugin** - Browser and API monitoring service integration
  - `get_checks` - Retrieve all monitoring checks
  - `get_check_details` - Get details of a specific check by ID
  - Bearer token authentication with retry operations

- **Sinch Plugin** - SMS, voice, and verification APIs
  - `send_sms` - Send SMS messages to phone numbers
  - `make_voice_call` - Initiate voice calls
  - `verify_number` - Phone number verification service

- **Calendar MongoDB Storage** - Local calendar event storage
  - CalendarEvent model for MongoDB persistence
  - Intent definitions for vector-based calendar detection
  - Support for both local MongoDB storage and optional CalDAV sync

- **MqttState Batch Updates** - High-throughput MQTT state management
  - `batchUpdateStates()` for efficient bulk state updates
  - Optimized for IoT scenarios with many concurrent updates

### Changed
- **Email System Migration** - Full support for custom SMTP/IMAP servers
  - All code now checks `EMAIL_USER` before falling back to `GMAIL_USER`
  - Calendar, email, and web interface properly use custom mail server
  - accountRegistrationService uses `EMAIL_USER` for account generation

### Improved
- **ThingSpeak Plugin** - Added retry mechanism for all API calls
- **ApiKeys Plugin** - Added pagination (`page`, `pageSize`) and caching for list operations
- **PR Review Session** - Reviewed 5 PRs, merged Sinch plugin, implemented features from rejected PRs

## [2.10.5] - 2026-01-17

### Added
- **Multi-Provider Email Support**: Email plugin now supports multiple providers beyond Gmail
  - Outlook/Hotmail: Full SMTP/IMAP support via office365.com servers
  - Fastmail: Premium email with reliable automation support
  - Custom/Self-Hosted: Configure any SMTP/IMAP server (docker-mailserver, Mailcow, etc.)
  - New environment variables: `EMAIL_PROVIDER`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_SMTP_HOST`, `EMAIL_IMAP_HOST`
  - Backward compatible: Legacy `GMAIL_USER`/`GMAIL_APP_PASS` still work

- **Gravatar API Integration**: Email contacts are now enriched with Gravatar profile data
  - Automatic profile fetching when new contacts are stored
  - Pulls display name, avatar URL, job title, company, location, bio
  - Imports verified social accounts (Twitter, GitHub, LinkedIn, etc.)
  - Graceful fallback if no API key or Gravatar unavailable
  - Optional `GRAVATAR_API_KEY` env var for enhanced data access

### Changed
- **Self-Hosted Email Active**: Agent now uses alice@lanagent.net via docker-mailserver on DigitalOcean
  - Let's Encrypt TLS certificates
  - DKIM, SPF, and DMARC configured for deliverability
  - Domain: lanagent.net, Server: mail.lanagent.net

## [2.10.4] - 2026-01-17

### Fixed
- **Self-Modification PR Creation**: Scheduler now calls `checkForImprovements()` instead of just `analyzeCodebase()`, ensuring improvements are actually implemented and PRs are created
- **Duplicate Feature Suggestions**: Capability scanner now checks both open AND merged PRs (last 50) to avoid suggesting features that have already been implemented
- **Token Usage Alerts**: Monitoring plugin now only alerts on the active AI provider instead of all registered providers, preventing false alerts for unused providers
- **Alert Cooldown Persistence**: Token usage alert cooldowns are now persisted to database, surviving server restarts (2-hour cooldown works correctly)
- **Sub-Agent Orchestrator WebUI**: Fixed button handlers and methods in both `accountManager` definitions to ensure proper functionality regardless of DOM load timing

### Improved
- **Capability Scanner Prompt**: Enhanced prompt instructs AI to assume common features (health checks, logging, caching) already exist in mature codebases, reducing duplicate suggestions
- **Token Monitoring Efficiency**: Only queries token usage for the currently active provider rather than all three providers

## [2.10.3] - 2026-01-16

### Added
- **Multi-Strategy Trading System** - Pluggable trading strategy architecture
  - Strategy Registry for managing multiple trading strategies
  - BaseStrategy abstract class for consistent strategy interface
  - NativeMaximizerStrategy: Buy low, sell high with per-asset thresholds
  - DCAStrategy: Dollar Cost Averaging with configurable intervals
  - Network-mode-aware price baselines (testnet/mainnet separation)
  - Per-asset thresholds: ETH 3%/-2.5%, BNB 4%/-3%, MATIC 5%/-4%

- **Strategy Evolution System** - Self-modification for trading strategies
  - Performance metrics tracking: win rate, Sharpe ratio, max drawdown
  - Automated issue detection: poor performance, low execution rate, excessive drawdown
  - Recommendation generation for threshold adjustments and strategy switches
  - Integration with self-modification system via FeatureRequest creation
  - Configurable analysis thresholds with cooldown periods

- **Strategy Management API Endpoints**
  - `GET /api/crypto/strategy/list` - List all available strategies
  - `GET /api/crypto/strategy/active` - Get current active strategy
  - `POST /api/crypto/strategy/switch` - Switch active strategy
  - `GET /api/crypto/strategy/performance` - Compare strategy performance
  - `POST /api/crypto/strategy/config/:name` - Update strategy configuration

- **Strategy Evolution API Endpoints**
  - `GET /api/crypto/strategy/evolution/analyze` - Run performance analysis
  - `GET /api/crypto/strategy/evolution/status` - Get evolution system status
  - `POST /api/crypto/strategy/evolution/apply` - Apply recommended improvements
  - `POST /api/crypto/strategy/evolution/feature-request` - Create feature request
  - `GET /api/crypto/strategy/evolution/evaluate` - Evaluate pending improvements

### Fixed
- **Mainnet Balance Accuracy**: Added direct mainnet balance fetching that bypasses network mode
- **Price Baseline Bug**: Baselines now keyed by `networkMode:network:pair` to separate testnet/mainnet state

### Improved
- Strategy Web UI with dropdown selector and real-time stats display
- Crypto sub-agent now supports ETH and BNB mainnet trading simultaneously

## [2.10.2] - 2026-01-16

### Added
- **Fixer Plugin**: NodeCache caching for frequently requested exchange rates with retry logic
- **MqttHistory Model**: Batch processing with `recordMessagesBatch()` for efficient bulk MQTT message storage
- **MqttHistory Model**: Advanced query filtering with `advancedQuery()` supporting payload content, QoS, and retained flag filtering
- **DevelopmentPlan Model**: Advanced filtering with `filterItems()` static method for querying development items
- **Currencylayer Plugin**: Exchange rate trends with `getRateTrends()` for historical rate analysis over time periods
- **EmbeddingService**: Parallel batch processing using Promise.all for improved embedding generation performance

### Improved
- Code cleanup: Removed unused imports from fixer.js, MqttHistory.js, and embeddingService.js

### PRs Merged
- #957: Caching for Fixer plugin exchange rates
- #958: Batch processing for MQTT messages
- #961: Advanced filtering for DevelopmentPlan model
- #962: Rate trends for Currencylayer plugin
- #963: Parallel batch processing for EmbeddingService

## [2.10.1] - 2026-01-16

### Fixed
- **Memory Manager**: Prevent object storage errors when web-scraped content or complex objects are passed to conversation storage. Large objects are now summarized to prevent database bloat.
- **Agent Response Storage**: Ensure response content is always converted to string before storing in memory, preventing Mongoose validation errors.
- **Git Plugin Issue Creation**: Fix `getRecentConversations` call to use correct parameter signature and update field name references to match actual return format.

### Added
- **Aviationstack Plugin**: New `getHistoricalFlightData` command for retrieving historical flight data by flight number and date range
- **Slack Plugin**: New `replyInThread` command for replying to specific messages in threads
- **Asana Plugin**: New `getProjectDetails` and `updateProjectDetails` commands for project management
- **IPGeolocation Plugin**: New `historical_ip_lookup` command for querying IP geolocation history over date ranges
- **AutoAccount Model**: MFA support with `enableMFA`, `disableMFA`, and `generateBackupCodes` methods
- **ContractEvent Model**: Query caching with `fetchEventsWithCache` for improved database performance
- **ProviderStatsArchive Model**: Error categorization tracking with detailed error type classification

### Improved
- Enhanced memory deduplication handles non-string content gracefully
- Better error handling in plugin execution chain

## [2.10.0] - 2026-01-15

### Added
- **Sub-Agent Orchestrator** - Autonomous agent system for domain-specific tasks
  - Central management for domain, project, and task agents
  - Lifecycle management: create, run, stop, pause, resume, delete
  - Scheduling with hourly, daily, or custom patterns (e.g., "30m", "2h")
  - Approval workflow for high-impact actions requiring human decision
  - Cost tracking with budget management and API call monitoring
  - Learning system that improves from past execution results
  - Event-driven architecture with WebSocket support

- **CryptoStrategyAgent** - Built-in domain agent for autonomous trading
  - CoinGecko API integration for live market prices (free, no API key required)
  - Technical indicators: RSI calculation, price change analysis
  - Multiple strategies: Native Maximizer, DCA, Mean Reversion, Momentum, Arbitrage Scanner
  - Automatic trade execution via DEX swaps (Uniswap, PancakeSwap)
  - Network support: Testnet (Sepolia, BSC-Testnet) and Mainnet (Ethereum, BSC)
  - LLM-powered decision making with confidence thresholds
  - Trade journal for tracking AI reasoning and outcomes

- **Sub-Agents Plugin** - Natural language interface for agent management
  - Commands: listAgents, createAgent, getAgent, updateAgent, deleteAgent
  - Control: runAgent, stopAgent, pauseAgent, resumeAgent
  - Insights: getHistory, getLearnings, getStatus
  - Natural language: "list my sub-agents", "run the crypto agent", "show agent history"

- **Sub-Agents Database Model** - MongoDB schema for agent persistence
  - Agent types: domain, project, task
  - State management with session tracking
  - History logging with automatic cleanup
  - Approval queue for pending decisions
  - Learning storage for continuous improvement

- **Sub-Agents Web UI** - Full management interface
  - Dashboard with agent status overview
  - Create/edit agent modals with domain config
  - Run/stop/pause controls with real-time status
  - History viewer with execution details
  - WebSocket integration for live updates

- **Sub-Agents REST API** - Complete CRUD and control endpoints
  - `/api/subagents/status` - Orchestrator status
  - `/api/subagents/agents` - List, create agents
  - `/api/subagents/agents/:id` - Get, update, delete agent
  - `/api/subagents/agents/:id/run|stop|pause|resume` - Agent control
  - `/api/subagents/agents/:id/history|learnings` - Agent insights
  - `/api/subagents/agents/:id/approve/:approvalId` - Approval workflow

### Fixed
- CoinGecko integration replaces stale Chainlink testnet oracle data
- Wallet balance fetching uses correct walletService chain-to-network mapping
- Swap function calls use correct signature: `swap(tokenIn, tokenOut, amountIn, slippage, network)`

## [2.9.0] - 2026-01-15

### Added
- **MCP Plugin** - Model Context Protocol support for AI tool integration
  - Full MCP client implementation for connecting to external MCP servers
  - Support for both stdio (local process) and SSE (HTTP/SSE) transports
  - Automatic tool discovery from connected MCP servers
  - Tool registry with intent system integration (format: `mcp_servername_toolname`)
  - Authentication support (none, apiKey, bearer, basic) with encrypted credentials
  - Auto-connect capability for servers on startup
  - Framework stub for future MCP server mode (expose plugins as MCP tools)

- **MCP Database Models**
  - `MCPServer` - Server configuration storage with encrypted credentials
  - `MCPToken` - Access token management for server mode

- **MCP Web UI** - Full management interface at `/mcp`
  - Dashboard showing connection status and tool counts
  - Server management (add, edit, connect, disconnect, delete)
  - Tool browser with search and execute capabilities
  - Token management for server mode authentication
  - Real-time status updates

- **MCP Plugin Commands**
  - `listServers` - List configured MCP servers
  - `addServer` - Add a new MCP server connection
  - `removeServer` - Remove an MCP server
  - `connect` / `disconnect` - Manage server connections
  - `discoverTools` - Discover tools from connected servers
  - `executeTool` - Execute a tool on an MCP server
  - `syncIntents` - Sync MCP tools with intent system

### Dependencies
- Added `@modelcontextprotocol/sdk` ^1.0.0

## [2.8.84] - 2026-01-15

### Added
- **New API Plugins** - Three new service integrations
  - `mediastack.js` - Real-time news API (getLatestNews, searchNews, getNewsByCategory)
  - `currencylayer.js` - Currency exchange rates (getLiveRates, getHistoricalRates, convertCurrency)
  - `aviationstack.js` - Flight status and aviation data (getFlightStatus, getAirlineInfo, getAirportInfo)

- **ContractEvent Batch Save** - Efficient bulk operations
  - New `batchSaveWithRetry` static method
  - Uses insertMany with ordered:false for performance
  - Includes retry logic for transient failures

### Improved
- **PluginDevelopment Indexes** - Query optimization
  - Added compound index `{status: 1, completedAt: -1}`
  - Removed unused formatCodeBlock import

### PR Review Summary
- Reviewed 10 auto-generated PRs (#930-#939) from self-modification service
- Closed all PRs due to various issues (broken tests, fabricated APIs, return type bugs)
- Manually implemented valid functionality from 5 PRs:
  - 3 new API plugins (mediastack, currencylayer, aviationstack)
  - PluginDevelopment compound index
  - ContractEvent batch save capability

## [2.8.83] - 2026-01-15

### Added
- **RuntimeError Categorization** - Automatic error classification
  - New `category` field in RuntimeError schema
  - `categorizeError` method finds similar historical errors
  - Assigns most common category from matching patterns
  - Falls back to 'uncategorized' when no history exists

- **SSH Command Execution Logging** - Better visibility for debugging
  - Logs command execution time in milliseconds
  - Logs command failures with error details
  - Logs execution exceptions

### Improved
- **Project Context Resilience** - Added retry logic
  - Plugin execute calls now use `retryOperation` wrapper
  - Projects plugin and Git plugin calls retry on transient failures

- **Markdown Escape Performance** - Regex consolidation
  - `escapeMarkdown`: Single regex instead of 17 separate replace calls
  - `escapeMarkdownLite`: Single regex instead of 5 replace calls
  - Significant performance improvement for high-frequency escaping

### PR Review Summary
- Reviewed 5 auto-generated PRs from self-modification service
- Merged 2 PRs with safe, functional improvements (#926, #928)
- Manually implemented good parts from 2 PRs (retry logic, regex optimization)
- Closed 3 PRs due to broken implementations (NLP logic, cache collision, deprecated APIs)

## [2.8.82] - 2026-01-15

### Added
- **CryptoWallet Batch Transactions** - Add multiple transactions at once
  - New `batchTransactions` method on wallet model
  - Input validation and retry logic for reliability

- **MQTT History Advanced Query** - Enhanced filtering capabilities
  - New `advancedQuery` static method for complex queries
  - Filter by topic, brokerId, deviceId, QoS level, retained flag
  - Case-insensitive payload content search
  - Configurable time range and result limits

### Fixed
- **SSH Interface Escape Sequences** - Critical bug fix
  - Fixed double-escaped `\r\n` sequences that broke terminal display
  - SSH sessions now display properly with correct newlines

### Improved
- **SSH Interface Command Queue** - Sequential command processing
  - Commands now processed in order to prevent race conditions
  - Added processing flag to track queue state

- **SSH Interface Caching** - NodeCache for frequently accessed data
  - Agent status, system metrics, and tasks now cached (5 min TTL)
  - Reduces redundant API calls during SSH sessions

- **ABI Manager Caching** - Upgraded to NodeCache with TTL
  - Replaced simple Map cache with NodeCache (5 min TTL)
  - Automatic cache expiration prevents stale data
  - Updated cache API methods (del, flushAll)

### PR Review Summary
- Reviewed 14 auto-generated PRs from self-modification service
- Merged 3 PRs with safe, functional improvements
- Manually implemented good parts from 1 PR (NodeCache for abiManager)
- Closed 10 PRs due to non-functional implementations (fabricated APIs, wrong imports, etc.)

## [2.8.81] - 2026-01-15

### Added
- **LangChain-Inspired Features** - Four powerful AI/ML capabilities

- **RAG (Retrieval-Augmented Generation)** - Complete knowledge management system
  - Document loaders: PDF, Text, Web, Markdown, JSON, CSV
  - Smart text splitters: Character, Recursive, Token, Code-aware, Sentence
  - Retrieval strategies: Similarity, MMR, Hybrid, Contextual Compression, Multi-query
  - Knowledge plugin for natural language document management
  - Natural language: "ingest document", "query knowledge base", "search for..."

- **Ollama Provider** - Local LLM support for privacy and cost savings
  - Chat model support (mistral, llama2, codellama, qwen, etc.)
  - Embedding model support (nomic-embed-text, mxbai-embed-large)
  - Vision model support (llava, bakllava)
  - Zero-cost inference with local models
  - Seamless integration with existing provider system

- **Structured Output Parsing** - JSON schema validation with Ajv
  - Pre-defined schemas for intents, chains, and plugin parameters
  - Automatic format instructions for LLM prompts
  - Validation error handling with retry capability

- **Agent Reasoning Patterns** - Advanced problem-solving capabilities
  - ReAct (Reasoning + Acting): Interleaved thinking/acting loop
  - Plan-and-Execute: Upfront planning with replanning on errors
  - ThoughtStore: Persist reasoning traces to MongoDB
  - Configurable via Agent model (mode, maxIterations, showThoughts)

### Files Added
- `src/services/outputParser.js` - Structured output parsing with JSON schemas
- `src/services/outputSchemas.js` - Pre-defined schemas for common operations
- `src/providers/ollama.js` - Ollama local LLM provider
- `src/services/rag/documentLoader.js` - Document loaders (PDF, Text, Web, etc.)
- `src/services/rag/textSplitter.js` - Text splitters (Recursive, Semantic, Code)
- `src/services/rag/retriever.js` - Retrieval strategies (Similarity, MMR, Hybrid)
- `src/services/rag/ragChain.js` - RAG orchestration and query handling
- `src/services/rag/index.js` - RAG module exports
- `src/api/plugins/knowledge.js` - Knowledge base plugin (v1.0.0)
- `src/services/reasoning/reactAgent.js` - ReAct reasoning pattern
- `src/services/reasoning/planExecuteAgent.js` - Plan-and-Execute pattern
- `src/services/reasoning/thoughtStore.js` - Reasoning trace persistence
- `src/services/reasoning/index.js` - Reasoning module exports

### Modified
- `src/core/providerManager.js` - Added Ollama registration
- `src/core/agent.js` - Integrated reasoning agents
- `src/core/aiIntentDetector.js` - Uses structured output parsing
- `src/core/pluginChainProcessor.js` - Uses structured output parsing
- `src/core/memoryManager.js` - Added RAG integration methods
- `src/models/Agent.js` - Added Ollama and reasoning config schemas
- `example.env` - Added Ollama environment variables

### Dependencies
- Added `ajv` (^8.12.0) for JSON schema validation
- Added `ajv-formats` (^2.1.1) for format validation

## [2.8.80] - 2026-01-15

### Added
- **UPS Monitoring** - Monitor APC/NUT-compatible UPS devices
  - Background polling service via NUT `upsc` command
  - Power event detection (on_battery, low_battery, battery_critical, power_restored)
  - Configurable thresholds: low battery (30%), critical (10%), shutdown (5%)
  - Auto-shutdown capability (disabled by default for safety)
  - Event history with severity tracking and acknowledgment
  - MQTT integration for IoT automation triggers
  - Natural language: "what's my UPS status?", "how much battery left?"
  - Web UI dashboard with real-time status and event history

- **Bluetooth Control** - Manage Bluetooth devices via bluetoothctl
  - Scan for nearby devices with signal strength (RSSI)
  - Pair/unpair, connect/disconnect, trust/untrust operations
  - Device tracking with MAC address, type, and connection history
  - Alias support for friendly device names
  - Auto-connect configuration per device
  - Natural language: "scan for bluetooth", "connect to my headphones"
  - Web UI with device list and action buttons (mobile-responsive)

- **Wake-on-LAN** - Network plugin enhancement
  - Wake devices by MAC address or device alias
  - UDP magic packet broadcast on ports 7 and 9
  - Integrated with existing network device inventory
  - Natural language: "wake up my desktop"

### Models Added
- `UpsEvent.js` - Power event history and tracking
- `UpsConfig.js` - UPS monitoring configuration
- `BluetoothDevice.js` - Bluetooth device tracking

### API Endpoints
- `GET /api/plugins/ups/status` - Current UPS status
- `GET /api/plugins/ups/list` - List configured UPS devices
- `GET /api/plugins/ups/history` - Power event history
- `GET/POST /api/plugins/ups/config` - UPS configuration
- `POST /api/plugins/ups/acknowledge/:id` - Acknowledge event
- `POST /api/plugins/bluetooth/scan` - Scan for devices
- `GET /api/plugins/bluetooth/devices` - All known devices
- `GET /api/plugins/bluetooth/paired` - Paired devices
- `GET /api/plugins/bluetooth/connected` - Connected devices
- `POST /api/plugins/bluetooth/pair/:mac` - Pair device
- `POST /api/plugins/bluetooth/connect/:mac` - Connect device
- `POST /api/plugins/bluetooth/disconnect/:mac` - Disconnect device
- `POST /api/plugins/network/wol` - Wake-on-LAN

### Fixed
- Mobile CSS layout for Bluetooth device buttons (stack on narrow screens)
- Mobile CSS layout for Crypto page input fields and buttons
- MongoDB upsert conflict in BluetoothDevice.upsertFromScan

## [2.8.79] - 2026-01-15

### Added
- **MQTT & Event Engine** - Full IoT/home automation capability
  - Built-in Aedes MQTT broker (TCP port 1883, WebSocket port 9883)
  - Home Assistant MQTT Discovery protocol support
  - Auto-discovers Tasmota, Zigbee2MQTT, ESPHome devices
  - Event Engine for rule-based automation (NO AI in hot path)
  - MongoDB models: MqttBroker, MqttDevice, MqttState, MqttHistory, EventRule
  - Time-series message history with TTL auto-cleanup
  - Natural language control: "turn on the living room light", "what's the temperature"

- **MQTT Web UI** - New tab in dashboard
  - Brokers management (internal + external connections)
  - Device discovery and state monitoring
  - Automation rules creation and management
  - Live topic viewer
  - Manual publish interface
  - Mobile-responsive stacked tabs

- **MQTT Plugin** - Natural language interface for IoT
  - Device listing and state queries
  - Turn on/off and set commands
  - Rule management via conversation
  - Broker status checks

### API Endpoints
- `GET /mqtt/api/status` - Service and Event Engine status
- `GET /mqtt/api/brokers` - List all brokers
- `POST /mqtt/api/brokers` - Create/update broker
- `DELETE /mqtt/api/brokers/:id` - Delete broker
- `POST /mqtt/api/brokers/:id/toggle` - Enable/disable broker
- `GET /mqtt/api/devices` - List discovered devices
- `POST /mqtt/api/devices/:id/command` - Send device command
- `GET /mqtt/api/states` - Get topic states
- `POST /mqtt/api/publish` - Publish MQTT message
- `GET /mqtt/api/rules` - List automation rules
- `POST /mqtt/api/rules` - Create automation rule
- `POST /mqtt/api/rules/:id/trigger` - Manually trigger rule
- `GET /mqtt/api/history` - Message history with aggregation

### Fixed
- ipstack plugin now loads in "needs configuration" state instead of failing
- Plugin settings modal transparent background (CSS variable fix)
- MQTT service initialization blocked by metrics updater errors

## [2.8.78] - 2026-01-14

### Added
- **Image Generation** - AI-powered image creation via natural language
  - OpenAI support: GPT-Image-1, GPT-Image-1.5, DALL-E 3, DALL-E 2
  - HuggingFace support: FLUX.1 Schnell/Dev, Stable Diffusion 3 Medium, SDXL 1.0
  - Configurable settings in Web UI AI Providers page
  - Intent detection: "generate an image of...", "create a picture of...", "draw me..."
  - Per-image cost tracking with provider-specific pricing

- **Video Generation** - AI-powered video creation via natural language
  - OpenAI support: Sora 2 with async job polling
  - HuggingFace support: Wan 2.1 T2V 14B
  - Configurable duration, quality, and resolution settings
  - Intent detection: "generate a video of...", "create a video showing..."
  - Per-second cost tracking for video generation

- **Media Generation Cost Tracking** - Full integration with analytics
  - New `requestType` values: 'image' and 'video' in TokenUsage model
  - `directCost` support in BaseProvider for non-token-based pricing
  - Statistics sections in Web UI showing total count and monthly costs
  - Costs appear in Model Usage chart and provider total costs

- **Crypto Strategy Agenda Integration** - Moved to proper job scheduler
  - Crypto strategy now runs as Agenda job instead of setInterval
  - Visible in Background Tasks page alongside other scheduled jobs
  - Respects enabled/disabled state and emergency stop flag
  - Hourly execution schedule (configurable via service)

### API Endpoints
- `GET /api/media/settings` - Get image and video generation settings
- `POST /api/media/image/settings` - Update image generation settings
- `POST /api/media/video/settings` - Update video generation settings
- `POST /api/media/image/generate` - Generate image directly via API
- `POST /api/media/video/generate` - Generate video directly via API
- `GET /api/media/image/stats` - Get image generation statistics and costs
- `GET /api/media/video/stats` - Get video generation statistics and costs

### Removed
- Tax reporting features from Crypto page (will be separate plugin if needed)
  - Removed Tax Year card from revenue section
  - Removed Tax Reports section with year selector
  - Removed generateTaxReport, generateFullTaxReport, viewTaxSummary functions
  - Removed associated CSS styles

### Fixed
- OpenAI image generation: gpt-image-* models don't support response_format parameter
- Image URLs are now fetched and converted to buffers for consistent handling

### PR Reviews
- Merged PR #876 (freshping.js updateCheck) - clean implementation of update command
- Closed PR #877 (DiscoveredFeature.js) - misplaced rate limiter, caching without invalidation

## [2.8.77] - 2026-01-14

### Added
- **Native Token Maximizer Strategy** - Autonomous trading to maximize ETH and tBNB balances
  - Focused on BSC testnet (tBNB) and Sepolia (ETH) networks only
  - Price baseline tracking with 24-hour automatic reset
  - Sell to stablecoin when native token price rises 5%+ from baseline
  - Buy back native token when price drops 3%+ after selling
  - Position tracking per network (inStablecoin, entryPrice, stablecoinAmount)
  - Detailed network analysis in status response showing price changes and opportunities

### Enhanced
- Strategy status now shows positions, price baselines, and per-network analysis
- Improved state persistence - new properties merge correctly with saved config
- Better logging showing price changes and hold/trade decisions per network

## [2.8.76] - 2026-01-14

### Added
- **Crypto Strategy Service** - Autonomous trading strategy with hourly analysis loop
  - Gathers market data from Chainlink oracles (ETH, BTC, BNB prices)
  - Analyzes portfolio state across all testnets/mainnets
  - AI-powered market analysis and trading decisions
  - Configurable strategies: DCA, rebalancing
  - Risk management: max trade %, daily loss limits, emergency stop
  - Decision journal tracks all reasoning and market snapshots
  - Network mode toggle (testnet/mainnet) syncs all chains
  - Auto-execute or propose-only modes

- **DEX Swap Service** - Token swapping via decentralized exchanges
  - Supports Uniswap V2, PancakeSwap, QuickSwap, SushiSwap
  - Networks: Ethereum, Polygon, BSC, Base (mainnet + testnets)
  - Get quotes before executing swaps
  - Slippage tolerance configuration
  - Automatic token approvals
  - Transaction tracking and confirmation

### API Endpoints
- `GET /api/crypto/strategy/status` - Get strategy service status
- `POST /api/crypto/strategy/enable` - Enable strategy service
- `POST /api/crypto/strategy/disable` - Disable strategy service
- `POST /api/crypto/strategy/config` - Update strategy configuration
- `POST /api/crypto/strategy/trigger` - Trigger manual strategy run
- `POST /api/crypto/strategy/network-mode` - Set testnet/mainnet mode
- `POST /api/crypto/strategy/emergency-stop` - Emergency kill switch
- `GET /api/crypto/strategy/journal` - View decision history
- `POST /api/crypto/swap/quote` - Get swap quote
- `POST /api/crypto/swap/execute` - Execute token swap
- `GET /api/crypto/swap/networks` - List supported networks
- `GET /api/crypto/swap/pending` - View pending swaps

### Fixed
- Wallet balance checking now uses actual blockchain queries
- CryptoWallet model supports swap, contract_write, approval transaction types

## [2.8.75] - 2026-01-14

### Added
- **NASA ADS Search** - Search NASA's Astrophysics Data System for research papers
  - New `adsSearch` command in NASA plugin (v1.3.0)
  - Search by keywords or author names
  - Returns title, author, and abstract for top 10 results
  - Results cached for 1 hour like other NASA endpoints
  - Requires `ADS_API_KEY` environment variable

### PR Review Session
- Reviewed 6 AI-generated PRs (#870-#875)
- Merged PR #875 (NASA ADS Search) - well-implemented feature following existing patterns
- Closed PR #870 (walletService.js) - unnecessary caching, libraries already cached
- Closed PR #871 (crypto.js) - called non-existent methods, wrong data assumptions
- Closed PR #872 (ContractABI.js) - missing imports, but manually implemented network enum
- Closed PR #873 (vectorStore.js) - breaking changes, removed existing methods
- Closed PR #874 (BaseProvider.js) - unused imports, flawed model selection logic

### Enhanced
- **ContractABI Networks** - Added support for additional blockchain networks
  - base-sepolia, avalanche, fantom, arbitrum now supported
  - Implemented from closed PR #872

## [2.8.74] - 2026-01-13

### Added
- **Voice Interaction Persistence** - Wake word listening state now persists across restarts
  - New `voiceInteractionEnabled` field in Agent model voice settings
  - Toggle in Web UI Voice settings page controls wake word listening
  - State saved to MongoDB when starting/stopping via API or Web UI
  - Auto-starts on server restart if previously enabled
  - Falls back to VOICE_AUTOSTART env var if no persisted state

- **Voice Interaction API Endpoints**
  - `GET /api/voice/interaction/status` - Get current listening status
  - `POST /api/voice/interaction/start` - Start wake word listening (persists)
  - `POST /api/voice/interaction/stop` - Stop wake word listening (persists)

### Improved
- **Memory Extraction** - Now requires complete sentences for storage
  - AI prompt explicitly rejects fragments like "X is" or "the password is"
  - Uses recent conversation context to help complete fragmented voice input
  - Returns clarification request if input seems incomplete
  - Validates extracted info is at least 10 characters and not a fragment

- **Voice Sentence Continuation** - Handles split voice commands gracefully
  - Added `pendingTranscription` buffer for incomplete sentences
  - New `isIncompleteSentence()` detects fragments ending in "is", "that", "the", etc.
  - Waits up to 8 seconds for sentence continuation before processing
  - Combines fragments automatically when continuation arrives

- **Audio Device Detection** - More reliable device selection
  - Always re-detects devices on start (handles USB device renumbering)
  - Prioritizes eMeet > USB > built-in devices
  - Logs selected device clearly for debugging

### Fixed
- **Vector Store Schema** - Fixed case sensitivity issue in LanceDB queries
  - Changed `userId = 'x'` to `"userId" = 'x'` in WHERE clauses
  - Resolves "No field named userid" error on memory search

## [2.8.73] - 2026-01-13

### Added
- **Custom Wake Word Training System** - Train personalized wake word models via Telegram
  - New `WakeWordTrainingService` for collecting voice samples and training models
  - `/train_wakeword` - Start training collection process
  - `/cancel_training` - Cancel ongoing training session
  - `/training_status` - Check current training progress
  - Collects 25 positive samples (saying the wake word) + 15 negative samples (other phrases)
  - Real voice samples from user for better accuracy than synthetic TTS
  - Automatic model deployment and voice interaction restart after training
  - Telegram notifications for training progress and completion
  - Models saved locally with backup support

### API Endpoints
- `GET /api/voice/wake-word/status` - Get wake word training status
- `POST /api/voice/wake-word/start` - Start training collection (WebUI)
- `POST /api/voice/wake-word/cancel` - Cancel ongoing training
- `GET /api/voice/wake-word/model-info` - Get info about trained models

### Technical Details
- OpenWakeWord integration for local wake word detection
- ONNX model export for inference
- Audio augmentation (speed, pitch, reverb, noise) for training diversity
- OGG to WAV conversion via ffmpeg for Telegram voice messages
- Two-stage detection: local wake word → then cloud Whisper API (privacy/efficiency)

## [2.8.72] - 2026-01-13

### Added
- **Memory Analytics** - New aggregation capabilities for memory system
  - `aggregateMemoriesByUser()` - Group memories by user with statistics
  - Returns average importance, total access count, and memory count per user
  - Supports optional match criteria for filtering

- **Task Dependency Resolution** - Advanced dependency management for tasks
  - `resolveDependencies()` - Topological sort for task execution order
  - Detects circular dependencies and throws descriptive errors
  - Returns ordered list of task IDs that must complete before current task

- **Anthropic API Retry Logic** - Improved resilience for Claude API calls
  - `generateResponse()` now wrapped with retry operation (2 retries, 1s min timeout)
  - `analyzeImage()` also wrapped with retry logic
  - Handles transient network failures gracefully

- **TokenUsage User Metrics** - User-specific usage tracking with caching
  - `getUserMetrics()` - Get aggregated metrics per user
  - Returns total tokens, total cost, average response time, total requests
  - Results cached for 10 minutes to improve performance
  - New compound index on userId + createdAt for efficient queries

### PR Review Session
- Reviewed 17 AI-generated PRs (#853-#869)
- Merged 1 PR (#856 - TokenUsage user metrics)
- Closed 16 PRs due to issues:
  - Unused imports (common: NodeCache, retryOperation, rateLimit imported but not used)
  - Non-existent methods called (signatureService.addNetworkSupport, scheduler.scheduleTask)
  - Breaking changes without migration (sync→async, schema changes)
  - Incomplete implementations (caches never populated, fake system metrics)
  - Wrong import paths (../utils instead of ../../utils)
- Implemented 3 features from closed PRs with fixes:
  - Memory aggregation from PR #855
  - Task dependency resolution from PR #861
  - Anthropic retry logic from PR #859

## [2.8.71] - 2026-01-12

### Added
- **Voice Plugin Methods** - Added missing voice plugin actions
  - `configureTelegramVoice` - Configure Telegram-specific voice settings
  - `createVoiceProfile` - Create custom voice profiles
  - `listVoiceProfiles` - List all available voice profiles

### Fixed
- **Telegram Voice Messages** - Fixed voice messages not being processed
  - Authorization middleware now sets `ctx.isAuthorized` for master users
  - Voice handler was checking wrong authorization flag

- **Graceful Voice Transcription Handling**
  - Voice messages < 1 second now return friendly message instead of error
  - Empty transcriptions (no speech detected) handled gracefully
  - Transcription errors show user-friendly messages

- **Web UI Voice Input (Android Brave)**
  - Added secure context detection - shows clear "HTTPS required" message
  - Brave browser detection with automatic MediaRecorder fallback
  - Improved MIME type detection for cross-browser audio recording

- **TokenUsage Enum Error** - Changed `requestType: 'transcription'` to `'audio'`
  - Fixes "transcription is not a valid enum value" errors in OpenAI/HuggingFace providers

- **TTS JSON Response Issue** - Voice responses no longer try to speak JSON
  - Skips TTS for responses starting with `{` or `[`
  - Skips TTS for responses over 5000 characters

### Notes
- HuggingFace Kokoro TTS speed/voice parameters not supported via Inference API
  - Speed setting stored but not applied (Inference API limitation)
  - For speed control, use OpenAI TTS provider instead

## [2.8.70] - 2026-01-12

### Added
- **AI Provider Stats Archiving** - Monthly usage tracking without data loss
  - New `ProviderStatsArchive` model stores monthly snapshots with provider/model breakdowns
  - Archive & Reset button in web UI with confirmation dialog
  - Historical period selector dropdown to view past months' stats
  - Automatic monthly archive on 1st of each month at midnight
  - Monthly usage report sent via Telegram with totals

### API Endpoints
- `POST /api/ai/metrics/archive` - Archive current stats (with optional clear)
- `GET /api/ai/metrics/history` - Get all archived monthly stats
- `GET /api/ai/metrics/history/:year/:month` - Get specific month's archive
- `DELETE /api/ai/metrics` - Clear current stats (requires force=true)

### Fixed
- Memory vector store now only indexes knowledge/learned memory types
  - Previously indexed all 10,682 memories including conversation history
  - Now correctly indexes only ~47 curated knowledge memories
  - Conversation history is temporal and excluded from semantic search index

## [2.8.69] - 2026-01-12

### Added
- **Memory Management Web UI** - Complete web interface for memory system administration
  - Clear all memories button with confirmation dialog (requires "DELETE ALL MEMORIES" phrase)
  - Rebuild vector index button with progress feedback
  - Deduplication toggle and threshold slider (0-100% similarity)
  - Vector store stats display showing indexed memory count and status
  - Real-time settings synchronization

### API Endpoints
- `POST /api/memory/clear-all` - Clear all memories (MongoDB and vector store)
- `POST /api/memory/rebuild-index` - Rebuild LanceDB vector index from MongoDB memories
- `POST /api/memory/settings` - Now supports deduplicationEnabled and deduplicationThreshold

### PR Review Session
- Reviewed 3 AI-generated PRs (#843, #844, #845)
- Merged all 3 PRs with quality improvements:
  - #843: DeviceAlias batch resolution with retry operations and proper logging
  - #844: BaseProvider dynamic alert threshold updates with event emission
  - #845: Signature API caching, batch verification, compression, and rate limiting

## [2.8.68] - 2026-01-12

### Added
- **Vector Similarity Search for Memories** - Complete overhaul of memory system
  - New `MemoryVectorStore` service using LanceDB for efficient k-nearest neighbor search
  - Proper semantic search in `memoryManager.recall()` with similarity scores
  - Automatic index rebuilding from existing memories on startup
  - Filter support by type, userId, category in vector searches

- **Semantic Deduplication** - Prevents redundant memory storage
  - Checks similarity before storing new memories (configurable threshold, default 85%)
  - Returns existing memory and updates access count instead of creating duplicates
  - Significantly reduces storage and embedding costs over time

### Fixed
- **Memory System Issues**
  - Removed incorrect 2dsphere index (was for geospatial data, not vectors)
  - `Memory.findSimilar()` was a stub that ignored embeddings - now properly documented
  - Added `getMemoriesWithEmbeddings()` method for index rebuild operations
  - Embeddings now excluded from default queries to save bandwidth (`select: false`)

### Enhanced
- **Memory Statistics** - Vector store stats included in `getMemoryStats()` output
- **Memory Cleanup** - `clearConversationHistory()` now removes from both MongoDB and LanceDB
- **Memory Settings** - Deduplication threshold configurable via settings

## [2.8.67] - 2026-01-12

### Added
- **Dynamic Retry Parameters** - retryUtils now adapts based on historical success/failure rates
  - Tracks success/failure history for each operation context
  - Dynamically adjusts retry count, backoff factor, and timeouts based on past performance
  - Operations with lower success rates get more retries and longer timeouts

- **FCM Bulk Messaging** - Send Firebase Cloud Messaging notifications to multiple devices
  - `sendBulkMessages` action sends notifications to an array of registration tokens
  - Proper parameter validation for bulk operations

- **Email Batch Processing** - Process multiple emails efficiently
  - `batchProcessEmails` static method for bulk email status updates
  - Caching for conversation queries with 10-minute TTL
  - Retry operations on all database queries

- **CryptoWallet Caching** - Improved wallet lookup performance
  - Added caching for `findOrCreate` operations
  - New `healthCheck` static method for wallet status

- **Faucets Caching** - Cached responses for faucet data
  - 10-minute cache for faucet lists and network-specific data

- **CloudWatch Retry Operations** - More resilient AWS CloudWatch calls
  - All CloudWatch API calls now use retry operations with 3 attempts

- **Integromatnowmake Version Control** - Scenario versioning capabilities
  - `listScenarioVersions` - List all versions of a scenario with caching
  - `rollbackScenario` - Rollback to a previous version of a scenario

- **System Reports Caching** - Performance improvements
  - Cached trends endpoint with 5-minute TTL
  - Retry operations for report queries

- **Database Health Check** - New diagnostic function
  - `databaseHealthCheck()` returns detailed connection status
  - Includes state, reconnect attempts, and timestamp

### PR Review Session (Batch)
- Reviewed 12 AI-generated PRs (#831-#842)
- Merged 6 PRs with high-quality implementations:
  - #836: Dynamic retry parameters in retryUtils.js
  - #840: FCM bulk messaging
  - #841: CloudWatch retry operations
  - #832: Email batch processing and caching
  - #833: CryptoWallet caching and health check
  - #834: Faucets caching
- Closed 6 PRs due to issues (detailed feedback provided):
  - #831: Date mutation bug, unused imports, silent error swallowing
  - #835: Broken loadClass usage causing runtime errors
  - #837: Imports non-existent vectorSearch.js file
  - #838: Wrong import path (../ instead of ../../)
  - #839: Wrong import path, unused rateLimit import
  - #842: Wrong import path, unused cache, deprecated poolSize option
- Implemented useful features from closed PRs with correct code

## [2.8.66] - 2026-01-11

### Added
- **CloudWatch Anomaly Detector** - New AWS CloudWatch monitoring capabilities
  - `createAnomalyDetector` - Create anomaly detectors for specific metrics
  - `describeAnomalyDetectors` - List and describe existing anomaly detectors
  - Supports namespace, metric name, dimensions, and stat configuration

### PR Review Session (Part 4)
- Reviewed 6 AI-generated PRs (#825-#830)
- Merged PR #828 (cloudwatch.js) - well-structured anomaly detector feature
- Closed 5 PRs due to issues:
  - #825: async log() dangerous for Winston, unused imports
  - #826: wrong import paths, non-existent MFA API
  - #827: unused imports, buggy advancedSearch implementation
  - #829: unused rateLimit import
  - #830: fake NLP implementation, overwrites useful data

## [2.8.65] - 2026-01-11

### Added
- **Fixer API Plugin** - Foreign exchange rates and currency conversion
  - `getLatestRates` - Fetch current exchange rates for all supported currencies
  - `getHistoricalRates` - Fetch historical rates for a specific date
  - `convertCurrency` - Convert amounts between currencies
  - Credential system integration with `FIXER_API_KEY` environment variable

- **Telegram Markdown Fix**
  - Removed unnecessary period escaping from markdown utility
  - Text now displays `filename.js` instead of `filename\.js`

### PR Review Session (Part 3)
- Reviewed 3 AI-generated PRs (#822, #823, #824)
- Merged PR #822 (Fixer plugin) - well-structured currency exchange plugin
- Closed PR #823 (BugReport.js) - placeholder categorization code
- Closed PR #824 (index.js) - would break app, calls non-existent methods
- Plugin count now at 57 modular plugins

## [2.8.64] - 2026-01-11

### Added
- **Hardhat Multi-Network Deployment**
  - Deploy contracts to multiple networks in parallel
  - Supports both `network` (string) and `networks` (array) parameters
  - Backward compatible - existing single-network calls work unchanged
  - Automatic retry (3 attempts) with exponential backoff per network
  - Individual success/failure tracking for each network deployment

- **Hardhat Health Check Endpoint**
  - `GET /api/hardhat/health` - Service status endpoint
  - Returns service name, status, and timestamp

- **Plugin Development Guide Improvements**
  - Added test template (`tests/plugins/_ai_test_template.js`)
  - Added `testTemplate` section documenting test requirements
  - Added `commonMistakes` section with anti-patterns to avoid:
    - Placeholder action names in tests
    - Wrong import paths from plugins directory
    - Non-existent function imports
    - Stub implementations

### Fixed
- **Plugin Test Files**
  - Fixed ipstack.test.js - now uses actual actions (getLocation, getOwnLocation)
  - Fixed weatherstack.test.js - now uses actual actions (getCurrentWeather, etc.)
  - Fixed numverify.test.js - now uses actual actions (validatePhoneNumber, etc.)

### PR Review Session (Part 2)
- Reviewed 2 additional AI-generated PRs (#820, #821)
- Closed both due to issues (unused imports, incorrect API usage)
- Implemented useful features from PR #820 properly with backward compatibility

## [2.8.63] - 2026-01-11

### Added
- **3 New API Plugins**
  - IPstack plugin - IP geolocation and lookup (getLocation, getOwnLocation)
  - Weatherstack plugin - Weather information API (getCurrentWeather, getWeatherDescription, getTemperature)
  - Numverify plugin - Phone number validation and carrier lookup (validatePhoneNumber, getCarrierInfo)

- **Multi-Language Email Verification**
  - Spanish verification patterns (código de verificación, tu código es)
  - French verification patterns (code de vérification, votre code est)
  - German verification patterns (bestätigungscode, ihr code ist)
  - Link detection patterns for international verification URLs

### Enhanced
- **Retry Utilities**
  - Custom error classification support via `customErrorClassifier` option
  - Smarter default retry behavior using `isRetryableError()` classification
  - Only transient errors (network, 5xx, 429, MongoDB) are retried by default
  - Backwards compatible - callers can override with custom classifier

### PR Review Session
- Reviewed 14 AI-generated PRs
- Merged 5 PRs with useful functionality
- Closed 9 PRs with implementation issues (stub code, wrong imports, non-existent methods)
- Plugin count now at 56 modular plugins

## [2.8.62] - 2026-01-10

### Added
- **Feature Request Auto-Approve Toggle**
  - New toggle in Feature Requests tab to auto-approve all incoming requests
  - When enabled, bulk-approves all existing pending requests
  - Setting persists across restarts (stored in MongoDB SystemSettings)
  - Works for manual submissions, code analysis improvements, and GitHub discoveries
  - API endpoints: GET/PUT `/api/feature-requests/settings/auto-approve`

### Enhanced
- **Feature Request UI Improvements**
  - Auto-discovered requests now properly show "Auto" tag based on `submittedBy` field
  - URLs in descriptions are now clickable links (linkifyUrls helper)
  - Fixed overflow issues for long titles and URLs on mobile
  - Added word-break CSS for proper text wrapping in request cards

### Fixed
- **Feature Request Display**
  - Fixed auto-discovered tag detection (now checks `submittedBy` and `autoGenerated` fields)
  - Fixed link overflow in feature request cards with `word-break: break-all`
  - Request cards now have `overflow: hidden` and `max-width: 100%`

## [2.8.61] - 2026-01-09

### Added
- **Smart Rate Limiting System**
  - IP-based rate limiting for unauthenticated requests (100 per 15 minutes default)
  - Automatic proxy/load balancer detection via X-Forwarded-For headers
  - API key authenticated requests bypass IP rate limiting (use their own limits)
  - Health check endpoint `/api/device-aliases/health` exempt from rate limiting
  - Configurable via `DEVICE_ALIAS_RATE_LIMIT` environment variable
  - Rate limit headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`)
  - 429 responses include `retryAfter` timestamp for client retry logic

### Fixed
- **PR Review Process**
  - Reviewed and closed 2 AI-generated PRs with incomplete implementations
  - Replaced PR #775's naive rate limiting with proper implementation
  - Documented issues with PR #776's incomplete 2FA implementation

## [2.8.60] - 2026-01-09

### Added
- **Govee Plugin Temperature Control**
  - Natural language temperature commands ("set to 7k", "cold white", "warm white")
  - Support for kelvin values (7k, 5000k, 6500 kelvin)
  - Temperature descriptions mapped to appropriate kelvin values
  - Automatic detection of temperature vs color in setColor method
  - "Bright white" now correctly maps to cold white (6500K)

### Fixed
- **Govee Plugin Natural Language Control**
  - Fixed AI parameter extraction to capture full device names (e.g., "master toilet light" instead of just "light")
  - Enhanced brightness control to accept both "brightness" and "level" parameters
  - Added support for percentage strings ("100%", "50 percent") in brightness commands
  - Fixed color parsing to handle compound colors like "bright white", "warm white", "dark blue"
  - Improved vector intent matching for better command recognition
  - Fixed schedule creation to show device names instead of MAC addresses

### Enhanced
- **Govee Plugin Color Support**
  - Added compound color parsing (bright/dark/light/warm/cool modifiers)
  - Improved color name matching for complex commands
  - Added more natural language examples for vector intent training

### Technical Improvements
- **AI Intent Detection**
  - Updated agent.js prompt to better extract full device names from natural language
  - Enhanced parseColorName in govee-enhancements.js for compound colors
  - Fixed setBrightness method to handle multiple parameter formats
  - Added automatic intent indexing when plugins are enabled

## [2.8.60] - 2026-01-08

### Added
- **Govee Plugin Enhancements**
  - UI modal controls for color, brightness, temperature, and scene selection
  - Group management system with MongoDB integration for device grouping
    - Create/delete groups through UI
    - Visual group tags with device counts
    - Group control modal with power, brightness, color, and theme options
  - Bulk operations support for controlling multiple devices at once
  - Theme system with predefined themes (relax, energize, romance, party, movie, sleep, focus, nature)
  - "Surprise me" random theme selection
  - Percentage-based brightness control from natural language
  - Enhanced intent patterns for better NLP understanding
  - New commands: group, theme, bulk, backup, restore
  - API routes for group management (/api/govee/groups, /api/govee/bulk)
  - Backup and restore functionality for device settings and schedules
    - Export device configurations to JSON file
    - Restore settings from backup with device matching
    - Optional Agenda-based schedule backup/restore
    - Advanced features UI with backup/restore buttons
  - Device capabilities viewer showing all available features per device
  - Support for additional device types from API v2:
    - Air purifiers, heaters, humidifiers, dehumidifiers
    - Thermometers, sensors
    - Smart plugs/sockets
    - Ice makers, aroma diffusers
  - New commands based on API documentation:
    - toggle: Control nightlight, oscillation, air deflector
    - segment: Control individual light strip segments
    - mode: Set work modes for appliances (gear, fan, auto)
  - **Schedule Management System**
    - MongoDB-backed scheduling with Agenda job scheduler
    - Web UI for creating, viewing, and managing schedules
    - Flexible scheduling options: once, daily, weekdays, weekends, custom days
    - Support for all device actions: power, brightness, color, scene
    - Enable/disable toggles for temporary schedule suspension
    - API routes for schedule CRUD operations (/api/govee/schedules)
    - Natural language schedule creation through AI integration
    - Visual schedule status with next run time display

- **Plugin Development Service Improvements**
  - Updated AI template to include vector intent system documentation
  - Added helper file guidelines for complex plugins
  - Enhanced command structure requirements (examples array for NLP)
  - Fixed undefined examplePlugin reference in code generation

### Fixed
- **Govee Plugin UI**
  - Non-power buttons (color, brightness, temperature, scenes) now functional with modal controls
  - Template literal escaping issues in UI generation

### Technical Improvements
- **Govee Plugin Architecture**
  - Created govee-enhancements.js module for additional functionality
  - Added DeviceGroup MongoDB model for persistent group storage
  - Implemented bulk device resolution with room-based and pattern matching
  - Added percentage parsing from natural language (10%, "fifty percent", "dim", "bright", etc.)

- **Plugin Development Templates**
  - Enhanced _ai_template.js with vector intent documentation
  - Updated _ai_template_guide.json with helper file patterns
  - Added MongoDB model usage guidelines
  - Improved command examples structure for better vector matching

## [2.8.59] - 2026-01-07

### Added
- **Vector Intent Detection System**
  - OpenAI embedding-based intent matching for lightning-fast command recognition
  - AI-powered parameter extraction from natural language
  - 0.4 similarity threshold for accurate intent detection
  - Vector store integration with LanceDB for efficient similarity search
  - Automatic intent indexing with 370+ intents
  - Fallback to traditional AI detection when no vector match found
  - **Automatic plugin intent management**: Intents are automatically indexed when plugins are loaded/enabled and removed when disabled/unloaded

- **Device Alias Management**
  - MongoDB-backed custom device naming system
  - Case-insensitive alias matching for user convenience
  - REST API endpoints for alias CRUD operations
  - Bulk import capability for multiple aliases
  - Plugin-specific alias support (currently Govee)
  - Usage tracking for popular aliases

- **Enhanced Email AI**
  - Automatic web search integration for current information
  - Keywords trigger search: latest, current, news, weather, stock, etc.
  - Formal business email composition with multi-paragraph structure
  - Increased token limit from 800 to 1500 for comprehensive emails
  - Optional enableWebSearch and searchQuery parameters
  - Web search results included in AI context for accuracy

### Technical Improvements
- **JWT Loading Fix**
  - Implemented lazy loading pattern to prevent PM2 restart loops
  - Added caching for JWT secret after first successful retrieval
  - Fixed module initialization order issues with ES6 imports
  - Proper error messaging for missing environment variables

- **Plugin Toggle Fix**
  - Fixed plugin toggle endpoint that was always disabling plugins
  - Now properly toggles between enabled/disabled states
  - Maintains plugin state persistence in database

- **Vector Intent Caching**
  - Added node-cache integration for intent detection results
  - 10-minute TTL with automatic expiration handling
  - Retry logic with exponential backoff for API resilience
  - Cache statistics tracking for performance monitoring
  - Reduces API costs and improves response times

### API Additions
- `POST /api/vector-intent/index` - Index all intents for vector search
- `GET /api/vector-intent/stats` - Get vector detection statistics
- `GET /api/device-aliases` - List all device aliases
- `POST /api/device-aliases` - Create/update device alias
- `DELETE /api/device-aliases/:alias` - Delete specific alias
- `POST /api/device-aliases/bulk` - Bulk import aliases

## [2.8.58] - 2026-01-07

### Fixed
- **AI Intent Detection System**
  - Removed hardcoded plugin intents that should be dynamically generated
  - Fixed overlap between static and dynamic intent IDs (dynamic now start at 1000)
  - Removed duplicate intent ID 999
  - Removed hardcoded chainlink plugin intents (83, 84)
  - Removed hardcoded thingsboard intent (51)

### Added
- **Plugin-Specific Logging**
  - Added createPluginLogger() function for individual plugin log files
  - Plugin logs now stored in logs/plugins/ directory
  - Each plugin gets its own log file for better debugging

### Enhanced
- **Govee Plugin NLP**
  - Implemented two-step AI intent detection for better accuracy
  - Added comprehensive examples to all Govee commands
  - Fixed AI passing command objects instead of strings
  - Fixed command parser treating "turn off" as plugin disable
  - Added defensive code to handle various action parameter types

### Technical Improvements
- **Plugin Development Service**
  - Fixed multiple syntax errors in pluginDevelopment.js
  - Added plugin validation to prevent placeholder PRs
  - Fixed template literal escaping in nested contexts

## [2.8.57] - 2026-01-06

### Fixed
- **Govee Plugin UI Issues**
  - Fixed menu item appearing in wrong alphabetical section (now properly in G section)
  - Fixed AI Control toggle not persisting across page reloads
  - Fixed device status showing "Loading status..." indefinitely
  - Fixed power control buttons returning 400 errors
  - Fixed device status colors (green=on, red=off, grey=offline)
  
### Enhanced
- **Govee Plugin AI Integration**
  - Added getAICapabilities method for dynamic device discovery
  - Added resolveDeviceName method for natural language device control
  - Updated all intent handlers to accept device names instead of IDs
  - Support for "all" keyword to control multiple devices at once
  - Partial name matching (e.g., "kitchen" matches "Kitchen Light")
  - Case-insensitive device name resolution
  
### Technical Improvements
- Implemented proper PluginSettings persistence for AI control toggle
- Fixed URL encoding issues with device IDs containing colons
- Added comprehensive logging for debugging Govee API responses
- Improved error handling with user-friendly messages

## [2.8.56] - 2026-01-06

### Added
- **Govee Smart Home Plugin** with standardized UI system
  - Device discovery and status monitoring
  - Control capabilities (power, brightness, color)
  - Standardized UI generation for web interface
  - Real-time state synchronization
  - Support for lights, switches, and other Govee devices

### Development
- Working on unified plugin UI system for consistent web interface across all smart home plugins

## [2.8.54] - 2026-01-06

### Added
- **ThingSpeak Bulk Operations** - Enhanced IoT platform integration
  - Rate-limited bulk data sending (configurable for free/paid accounts)
  - Parallel bulk channel reading with concurrency control (max 5 concurrent)
  - Progress callbacks for long-running operations
  - Input validation and sanitization for security
  - Graceful error handling with detailed reporting
  - Maximum 100 items per bulk operation
  
- **ModelCache Versioning System** - Advanced AI model tracking
  - Automatic version history tracking with timestamps
  - Configurable retention policies (maxVersions: 10, retentionDays: 30)
  - Version comparison functionality to see changes
  - Rollback/restore capabilities to any previous version
  - Deep cloning to prevent reference issues
  - Automatic cleanup of old versions based on policies
  - Skip version creation when models unchanged

### Fixed
- **PR Reviewer Git Path Issues** - Fixed git commands execution
  - Added GIT_REPO_PATH configuration for proper repository location
  - Created execInRepo helper for all git/GitHub CLI commands
  - Resolved "not a git repository" errors in production
  
### Development
- Rejected PR #744 (ScanProgress WebSocket) due to missing dependencies and poor architecture
- Successfully implemented features from rejected ALICE PRs #738 and #740

## [2.8.56] - 2026-01-05

### Added
- **Autonomous PR Review System** - AI-powered pull request review and deployment
  - PRReviewerPlugin with configurable AI model (defaults to Claude 3.5 Opus)
  - Smart review actions: automatically merge, reject, or reimplement PRs
  - Safe production deployment with health monitoring and automatic rollback
  - Detailed PR comments with comprehensive AI analysis
  - Reimplementation feature creates better PRs when ideas are good but code is poor
  - Configurable schedule (twice daily, default: disabled for safety)
  - Full web UI integration with statistics tracking
  - Nightly AI model list updates at 2 AM
  - MongoDB persistence for settings and review history
  - Support for all AI providers with model-specific configuration

### Changed
- Added PR Review page to web dashboard (alphabetically sorted between Plugins and Projects)
- Updated self-improvement services count from 4 to 5
- Enhanced deployment safety with automatic health checks and rollback

### Fixed
- Telegram notification issue for GitHub issue creation
  - Fixed incorrect reference to `this.agent.telegramInterface`
  - Added `sendTelegramNotifications` setting to bug detector
  - Added UI toggle in Bug Fixing page that persists across restarts

## [2.8.55] - 2026-01-04

### Added
- **StatusCake Plugin** - Professional uptime monitoring integration
  - Create, list, update, and delete uptime tests
  - Get detailed test metrics and performance data
  - Bearer token authentication with API v1
  - Full CRUD operations for monitoring management

- **Freshping Plugin** - Website and API uptime monitoring
  - Create and manage monitoring checks
  - Real-time status monitoring for endpoints
  - Basic Auth with API key and subdomain
  - Support for check frequency configuration

- **SignalWire Plugin** - Communication APIs integration
  - Send SMS messages via SignalWire network
  - Retrieve message history
  - Twilio-compatible LAML API format
  - Basic Auth with project credentials

- **Report Export Feature** - Export system reports in multiple formats
  - JSON export with download headers
  - CSV export with proper formatting and escaping
  - Filter by date range (startDate/endDate)
  - Filter by report type
  - Available at /api/system/reports/export

- **Asana Plugin Enhancement** - Added task assignment functionality
  - New `assigntask` command to assign tasks to users
  - Uses PUT /tasks/{id} endpoint with assignee field
  - Proper parameter validation for taskId and assignee

### Changed
- Updated plugin count to 52 total plugins
- Added environment variables for new plugins to .env.example:
  - STATUSCAKE_API_KEY
  - FRESHPING_API_KEY and FRESHPING_SUBDOMAIN
  - SIGNALWIRE_API_TOKEN, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_SPACE_URL

### Fixed
- Implemented features from AI-generated PRs correctly:
  - Fixed validation patterns in plugin implementations
  - Corrected authentication methods (Bearer vs Basic Auth)
  - Used proper API endpoints per documentation

## [2.8.54] - 2026-01-03

### Added
- **AWS CloudWatch Plugin** - Monitor AWS services and send custom metrics
  - Get metrics from EC2, RDS, and other AWS services
  - Send custom application metrics to CloudWatch
  - List available metrics in any namespace
  - Full AWS SDK integration

- **Vonage Plugin** - APIs for SMS, voice, and phone verifications
  - Send SMS messages globally
  - Voice call capabilities
  - Phone number verification
  - Nexmo API integration

- **Runtime Error Scanner** - Automated log monitoring and error detection service
  - Continuous monitoring of all system logs every minute
  - Smart position tracking to avoid duplicate error detection
  - Persistent state via MongoDB - positions survive restarts
  - Automatic severity classification (critical/high/medium/low)
  - GitHub issue creation for critical errors (rate-limited to 5/hour)
  - Pattern matching for 14+ error types
  - Context extraction for better debugging
  - Performance optimized - skips large files, reads only new content

### Fixed
- **Error Scanner Position Persistence** - Fixed MongoDB save issues
  - Added required schema fields (severity, occurrences) to scan position documents
  - Enhanced logging throughout save/load process for debugging
  - Scan positions now properly persist and load on startup
  - Fixed database connection to use correct 'lanagent' database

## [2.8.53] - 2026-01-03

### Added
- **Bug Detection Enhancement** - Improved deduplication with error scanner
  - Unified deduplication logic between runtime errors and static bugs
  - Shared GitHub issue creation with duplicate prevention
  - Enhanced error statistics tracking

## [2.8.52] - 2026-01-03

### Added (Currently Disabled)
- **9 New API Integration Plugins** - Added but need proper implementation
  - **WhoisPlugin** - Domain WHOIS lookups (needs verification)
  - **ImageUpscalerPlugin** - AI-powered image upscaling (needs verification)
  - **LinkedInPlugin** - DISABLED - Needs proper API documentation
  - **JSearchPlugin** - DISABLED - Needs proper API documentation
  - **AmazonDataPlugin** - DISABLED - Needs proper API documentation
  - **NinjaScraperPlugin** - DISABLED - Needs proper API documentation
  - **QuotesPlugin** - DISABLED - Needs proper API documentation
  - **FlightDataPlugin** - DISABLED - Needs proper API documentation
  - **HotelsPlugin** - DISABLED - Needs proper API documentation

### Known Issues
- **7 Plugins Disabled** - Implemented without reading API documentation
  - These plugins will return an error message until properly reimplemented
  - See src/api/plugins/DISABLED_PLUGINS.md for details
  - Need to read actual RapidAPI documentation and reimplement

## [2.8.53] - 2026-01-03 - 9 New Integration Plugins (7 Currently Disabled)

### Added
- **Domain Intelligence**: WhoisPlugin for domain lookups and availability checking
  - WHOIS Lookups: Complete domain registration information
  - Availability Check: Instant domain availability verification
  - NPM Package: Uses @whoisjson/whoisjson for reliable data
- **AI Image Enhancement**: ImageUpscalerPlugin for photo improvements
  - Multiple Scales: 2x, 4x, and 8x upscaling options
  - Quality Enhancement: AI-powered image improvement
  - Batch Processing: Handle multiple images efficiently
- **Professional Networking**: LinkedInPlugin for company and profile data
  - Company Search: Find companies by domain
  - Profile Scraping: Extract professional profiles
  - Detailed Information: Skills, experience, education
- **Job Market Intelligence**: JSearchPlugin for employment opportunities
  - Job Search: Find positions across platforms
  - Salary Estimates: Get compensation data by location
  - Detailed Listings: Full job descriptions and requirements
- **E-commerce Data**: AmazonDataPlugin for product research
  - Product Search: Real-time Amazon inventory
  - Review Analysis: Customer feedback and ratings
  - Price Tracking: Monitor deals and offers
- **Advanced Scraping**: NinjaScraperPlugin for complex web data
  - JavaScript Rendering: Handle dynamic content
  - Screenshots: Capture webpage visuals
  - Data Extraction: Structured data from any site
- **Inspirational Content**: QuotesPlugin for motivational quotes
  - Multiple Sources: Authors, categories, keywords
  - Random Quotes: Daily inspiration
  - Search Function: Find specific themes
- **Travel Intelligence**: FlightDataPlugin for aviation information
  - Flight Search: Compare routes and prices
  - Live Status: Real-time flight tracking
  - Airport Data: Comprehensive airport information
- **Accommodation Search**: HotelsPlugin for lodging options
  - Location Search: Find hotels by destination
  - Reviews: Guest ratings and feedback
  - Nearby Options: GPS-based hotel discovery

### Important Note
- **⚠️ IMPORTANT**: 7 of these plugins (LinkedIn, JSearch, Amazon Data, Ninja Scraper, Quotes, Flight Data, Hotels) are currently DISABLED as they were implemented without reading the actual API documentation. They will return an error until properly reimplemented. Only WhoisPlugin and ImageUpscalerPlugin may work as they had some documentation/examples provided.

## [2.8.51] - 2026-01-03

### Added
- **AI Provider Monitoring** - Real-time performance alerting for providers
  - Configurable alert thresholds for response time (default 1000ms)
  - Error rate monitoring with alerts (default 10% threshold)
  - Alert events emitted for downstream monitoring systems
  - Clean integration with existing metrics tracking

- **NASA Plugin Caching** - Improved performance for space data requests
  - 1-hour cache for APOD, Mars Rover, NEO, and Earth imagery endpoints
  - Reduces API calls to NASA services
  - node-cache dependency added for efficient in-memory caching
  - Version bumped to 1.1.0

### Fixed
- **AI-Generated PR Review** - Reviewed and processed 6 automated PRs
  - Merged valuable enhancements (provider monitoring, NASA caching)
  - Closed problematic PRs with missing dependencies or non-existent APIs
  - Added detailed feedback for all PR decisions

## [2.8.50] - 2026-01-03

### Fixed
- **Enhanced Diagnostics System** - Resolved all critical issues and false positives
  - Fixed memory status endpoint to use correct memoryManager methods (getMemoryStats, getRecentConversations, getSettings)
  - Fixed Telegram interface detection - now shows as operational if bot has valid token
  - Fixed service registration - all services now properly added to services Map
  - Fixed agent startup crashes by checking for start/stop method existence
  - Fixed API key usage tracking - agent's diagnostic key usage properly incremented
  - Added duplicate run prevention - minimum 1 minute between diagnostic runs
  - Added duplicate notification prevention - minimum 5 minutes between critical alerts
  - Enhanced warning logging with full details in diagnostics.log

- **Task Scheduler** - Fixed null reference error in report time calculation
  - Fixed "Cannot read properties of null (reading 'split')" in calculateNextReportTime
  - Added null checks and default values for missing report settings
  - Report time defaults to '09:00' when not configured
  - Frequency defaults to 7 days when not configured

### Enhanced  
- **System Health Monitoring** - More reliable and accurate diagnostics
  - Telegram bot no longer shows false positive warnings
  - Services properly tracked and managed through lifecycle
  - Detailed warning information logged for troubleshooting
  - API endpoint tests correctly track key usage
  - System consistently reports "All systems operational"

## [2.8.49] - 2026-01-02

### Added
- **Enhanced Diagnostics System** with comprehensive health monitoring
  - New `diagnostics` plugin for system health checks and API endpoint testing
  - Runs automatically every 6 hours via Agenda task scheduler
  - Tests system resources, database connectivity, API endpoints, interfaces, and services
  - Auto-generates secure API key for self-testing
  - 10-minute startup delay prevents false alerts during initialization
  - Dedicated `diagnostics.log` file for tracking health history
  - Critical issue alerts sent via Telegram notifications
  - MongoDB storage for diagnostic reports and trend analysis

- **Dynamic Logs UI** for improved log management
  - New `/api/logs/available` endpoint returns all available log files
  - Logs page automatically displays all non-archived logs
  - Log files grouped by category (Application/PM2) with file sizes
  - No more manual updates needed when adding new log files

- **Background Tasks Integration**
  - System diagnostics now visible on Background Tasks page
  - Added "System Diagnostics" to Last Activities section
  - Tracks last run time alongside other scheduled jobs

### Enhanced
- **Task Scheduler** with better error handling
  - Added validation for null report settings to prevent startup crashes
  - Default values applied when settings are missing
  - More robust job scheduling

- **Logger System** with new filtered transport
  - Added diagnostics log filter for health monitoring messages
  - Improved service-based log routing

### Fixed
- Scheduler crash when report settings time is null
- Enhanced diagnostics methods were outside class definition
- Web interface startup issues due to syntax errors

## [2.8.48] - 2026-01-02

### Added
- **AI-Powered Conversation Enhancement** for more natural agent interactions
  - Context-aware query intent that includes conversation history
  - AI interpretation of technical command outputs for conversational responses
  - Smart response selection between raw data and interpreted results
  - System setting `ai_interpret_outputs` to control interpretation behavior
  - New methods: `interpretCommandOutput` and `shouldInterpretOutput`

### Enhanced
- **Memory System** improvements
  - Full plugin execution results stored instead of 200-character truncations
  - Better context preservation for AI queries
  - Operation summaries added for new plugins
  - Changelog reader provides more detailed summaries

- **Bug Detection** with improved deduplication
  - Added fingerprint field to BugReport model with unique constraint
  - Database-level duplicate prevention using fingerprints
  - Enhanced `isDuplicateBug` method to check DB before local cache
  - All async operations properly awaited
  - Status change notifications via agent.notify()
  - Mongoose middleware for automatic status tracking

- **Agent Interaction** improvements
  - Rewrote `recallInformation` method for conversational responses
  - Technical outputs interpreted through AI for better UX
  - Natural language responses instead of raw data dumps
  - Context-aware conversation handling

### Fixed
- Query intent handler missing conversation context
- Plugin results being truncated in memory storage
- Bug detector async/await issues in duplicate checking
- Robotic responses when recalling information

## [2.8.46] - 2026-01-02

### Added
- Four new API plugin integrations
  - **Amazon CloudWatch**: AWS monitoring with metrics, logs, and alarms
    - Get metrics from EC2 instances and other AWS services
    - Put custom metrics for application monitoring
    - List available metrics by namespace
    - Mock implementation ready for AWS SDK integration
  - **New Relic**: Application performance monitoring
    - List applications with performance data
    - Get detailed application metrics (apdex, response time)
    - Monitor alert policies and incidents
    - Track transactions and throughput
    - Retrieve historical metric data
  - **Trello**: Project management integration
    - Create and manage boards with customizable lists
    - Full CRUD operations for cards
    - List management (create, get lists from boards)
    - Update card details including name and description
    - OAuth-based authentication support
  - **Microsoft Graph**: Microsoft 365 services integration
    - Access Outlook emails with folder support
    - Send emails through Outlook
    - Create and list calendar events with attendees
    - OneDrive file listing and upload
    - User profile information access
    - Support for all Microsoft 365 services
- Bug scan status indicator feature for real-time monitoring
  - New `getScanProgress` action in bugDetector plugin
  - Returns active scan progress with file count, percentage, and current file
  - Shows estimated time remaining for active scans
  - Displays last scan information when no scan is active
  - Web UI integration for visual progress tracking
  - Real-time updates during incremental scans

### Enhanced
- Plugin development service to use dynamic intent detection
  - Removed static aiIntentDetector.js file updates
  - Plugins now register intents through their commands array at runtime
  - Cleaner pull requests without unnecessary intent file changes
  - Better scalability for adding multiple plugins
  - Updated commit messages to reflect dynamic approach
- Bug detection plugin with improved progress tracking capabilities
- Better user feedback during long-running scans
- More transparent scan operations with detailed status information

### Fixed
- Plugin development service no longer modifies static intent files
- Removed aiIntentDetector.js from automated git commits in plugin PRs

## [2.8.45] - 2026-01-01

### Added
- Chainlink oracle integration plugin with decentralized price feeds
  - Real-time price data from 50+ Chainlink oracles across crypto/forex pairs
  - Multi-network support: Ethereum, Polygon, BSC, Base (mainnet + testnet)
  - Historical price data queries by round ID
  - Price comparison between Chainlink and CoinGecko sources
  - LINK token balance checking and faucet information
  - Automatic testnet/mainnet mode based on agent configuration
  - 5-second caching for efficient repeated queries
- MongoDB migration for plugin data storage
  - Created Mongoose schemas for development and projects plugins
  - Automatic migration from old JSON flat files to MongoDB
  - Comprehensive plugin database usage guide (PLUGIN_DATABASE_GUIDE.md)
  - Plugin development template updated to guide MongoDB usage
- Enhanced plugin system with dynamic discovery
  - All plugins now expose their available commands
  - Web API includes plugin commands in responses
  - Agent dynamically discovers all enabled plugins

### Fixed
- Development and projects plugins using flat file storage instead of MongoDB
- Task model import error (changed from default to named export)
- Plugin development template now emphasizes MongoDB over flat files
- Git lock mechanism for web interface redeployment
  - Added missing methods to selfModLock.js (isLocked(), getLockInfo())
  - Fixed deploymentTimeout scope error
  - Added process death detection to prevent stale locks
- Wallet service integration in Chainlink plugin (direct import instead of agent.services)
- Plugin command discovery in web API responses

### Changed
- All plugin data storage now uses MongoDB for consistency and performance
- Improved query performance with proper database indexes
- Updated API documentation with clearer API key usage examples
- Added Amoy (Polygon testnet) network support to contractService

## [2.8.44] - 2026-01-01

### Added
- Crypto Web UI network mode toggle for switching between testnet and mainnet
  - Prominent visual toggle with clear labeling
  - Persistent network mode preference across sessions
  - Dynamic network selector updates based on mode
  - Visual warning when in mainnet mode
- Self-modification upgrade order toggle in Web UI
  - Control whether core services or plugins are upgraded first
  - Settings persist to MongoDB configuration
  - Visual toggle in self-modification settings page

### Changed
- Updated Polygon Mumbai testnet to Amoy testnet (chainId: 80002)
  - All Mumbai references replaced with Amoy
  - Updated faucet service with new Amoy endpoints
  - Updated testnet token addresses for Amoy
- Moved Accounts menu item to appear directly under Overview in sidebar

### Fixed
- Memory model validation error by adding missing enum types (operation, summary, pattern)
- Faucet service JSON parsing error with proper error handling
- Plugin development API documentation parsing with JSON extraction fallback
- Missing qrcode dependency added to package.json
- PM2 environment variable loading issue causing JWT_SECRET errors after restart
- Database fragmentation by consolidating all databases into single 'lanagent' database

## [2.8.43] - 2025-12-31

### Added
- API Key Usage Alerts functionality
  - Set custom usage thresholds for API keys
  - Email notifications when keys exceed usage limits
  - Alert configuration via apikeys plugin `setAlert` action
  - Automatic periodic monitoring with 24-hour cooldown between alerts
  - Alert settings stored persistently in database
- Personalized News Recommendations 
  - User preference management for news categories
  - Persistent storage of preferences in database
  - Multi-user support with userId parameter
  - New actions: `setPreferences`, `getPreferences`, `getPersonalizedNews`
  - Mixed feed from all preferred categories
  - Category validation to ensure only valid categories are saved

### Changed
- News Plugin updated to version 1.1.0 with personalization features
- DeviceInfo Plugin optimized with parallel queries and caching
  - All device detection functions now run in parallel using Promise.all
  - Added 5-minute cache for device queries to reduce repeated operations
  - Significant performance improvement for device listing operations
- ApiKey model now includes alertConfig field for usage monitoring

### Fixed
- Bug in apiKeyService where it referenced `apiKey.usage` instead of `apiKey.usageCount`
- Self-modification daily improvement count not incrementing when PRs were created
- Plugin development stalling due to multiple stuck in_progress plugins
- Plugin development Telegram notifications not being sent
- Lock safety mechanism added to prevent service lockouts on crashes
- Stale plugin cleanup mechanism added for plugins stuck in_progress over 2 hours
- Plugin development generating error messages instead of actual plugin code
  - Fixed by using direct AI provider calls instead of processNaturalLanguage
  - This bypasses intent detection that was triggering feature consideration workflow
- Plugin development timeout protection enhanced
  - Added 15-minute timeout per individual plugin development
  - Added 30-minute timeout for entire plugin development session
  - Ensures graceful continuation to next plugin on failures
  - Detailed step-by-step logging with elapsed time tracking
  - Emergency cleanup mechanism to force release locks on timeout

## [2.8.40] - 2025-12-31

### Added
- API Key Management System for external application authentication
  - Dual authentication support (JWT tokens + API keys)
  - Web UI management interface with create, revoke, suspend, and delete operations
  - Agent plugin (`apikeys`) for programmatic key management
  - Usage tracking with request count and last used timestamp
  - Configurable per-key rate limiting (default 100 requests/minute)
  - Mobile-optimized UI with proper text wrapping and clipboard support
  - Secure key storage with SHA-256 hashing (keys never stored in plain text)
  - Key format: `la_` prefix + 40 character random string
  - REST API endpoints for full CRUD operations on API keys
  - Support for both X-API-Key header and Authorization: ApiKey formats

### Changed
- Authentication middleware updated to support both JWT and API key authentication
- Web interface now includes "API Keys" tab for key management
- Package version updated to 2.8.40

### Fixed
- Mobile display issue where API keys showed vertically (one character per line)
- Copy to clipboard functionality on mobile devices using fallback method
- Proper word-wrapping for long API keys in mobile view

## [2.8.39] - 2025-12-30

### Added
- CoinGecko Plugin for comprehensive cryptocurrency market data
  - Real-time prices with market cap and 24h changes
  - Detailed coin information including ATH/ATL
  - Trending cryptocurrencies tracking
  - Global crypto market statistics
- News API Plugin for world news and headlines integration
  - Top headlines by category and country
  - Article search with advanced filtering
  - Access to thousands of news sources worldwide
  - Categories: business, technology, health, science, sports, entertainment
- Alpha Vantage Plugin for stock market and financial data
  - Real-time stock quotes and market data
  - Historical daily stock data
  - Company overviews and fundamentals
  - Foreign exchange currency rates
  - Cryptocurrency exchange rates
- Scraper Plugin Enhancement with 1-hour caching
  - Smart caching prevents re-scraping same URLs within 1 hour
  - Cached PDF generation for resource optimization
  - Optional bypassCache parameter for fresh data
  - Automatic cleanup of expired cache entries

### Changed
- Package version updated to 2.8.39
- IoT Device Detection added to deviceInfo plugin v1.1.0
- Performance optimization in development plugin with debounced saves

## [2.8.38] - 2025-12-30

### Added
- Centralized GitHub Discovery Service for efficient feature discovery
  - New scheduled job that runs twice daily (9 AM and 9 PM)
  - Stores discovered features with code snippets and implementation examples
  - Reduces GitHub API calls by centralizing searches
  - Automatic cleanup of stored code snippets after successful implementation
  - Web UI integration showing GitHub discovery status in background tasks
  - Analyzes 25+ known AI agent projects including AutoGPT, MetaGPT, LangChain
  - Smart feature extraction from READMEs, commits, and repository structures
  - Confidence-based prioritization (high/medium/low)
- Enhanced self-modification service to use stored GitHub references
  - Now queries database instead of making direct GitHub API calls
  - Includes GitHub code examples in upgrade prompts for better implementation
  - Cleans up stored references after successful implementation
- Enhanced plugin development service to use stored GitHub data
  - Queries database for plugin ideas instead of direct GitHub searches
  - Removes stored code snippets after successful plugin creation
  - Updates feature request status to 'completed' when plugins are created
- GitHub reference storage for all discovery types
  - Commit features now include full GitHub references
  - Structure-based discoveries include file paths and context
  - Code search results include matched snippets

### Changed
- Self-modification service now uses async `createUpgradePrompt()` to include GitHub references
- Plugin development service replaced `searchGitHubForPlugins()` with `getStoredGitHubPluginIdeas()`
- Both services now include cleanup mechanisms to reduce database disk usage
- Package version updated to 2.8.38
- GitHub discovery trigger script improved to store top 5 features regardless of confidence

### Fixed
- Resource optimization through reduced GitHub API calls
- Database disk usage through automatic cleanup of implemented features
- GitHub discovery storage now properly saves all feature types with references
- Fixed category validation error (changed from invalid "enhancement" to "core")
- Scheduler job now correctly stores discovered features in MongoDB

## [2.8.37] - 2025-12-30

### Added
- Comprehensive Telegram media support for all response types
  - Images/Photos with captions via replyWithPhoto
  - Videos with duration, dimensions, and streaming support
  - Animations/GIFs via replyWithAnimation
  - Audio files with metadata (title, performer, duration)
  - Voice messages with duration
  - Documents with proper filename handling
  - Location sharing via GPS coordinates
  - Media groups for photo/video albums
- Automatic buffer-to-file conversion for media handling
- Temporary file management with 60-second auto-cleanup
- Memory-safe storage for media responses in conversation history
- System status reports now stored in database for historical tracking
- New SystemReport model for persisting report data with structured content
- API endpoints for retrieving historical reports (`GET /api/system/reports`)
- Performance trends tracking across reports
- Report cleanup endpoint to manage old reports  
- Dynamic report frequency support (daily/weekly/monthly/custom)

### Fixed
- AI intent detection for PDF generation - added specific decision guide
- Parameter passing mismatch (parameters vs params) between intent detector and agent
- Plugin chain processor incorrectly treating "send me PDF" as multi-step task
- Memory validation error when storing document/media responses
- Natural language PDF generation from Telegram now works correctly
- Agent uptime now shows correct value instead of 0 days
- Most active interface now displays properly instead of "null"
- System restart count tracked from agent stats
- Average response time calculated from actual TokenUsage data
- Report generation handles missing/undefined values gracefully
- Report title reflects actual frequency (Daily/Weekly/Monthly Status Report)

### Changed
- Enhanced processNaturalLanguage to handle various media response types
- Improved single vs multi-step task detection for Telegram requests
- Updated plugin chain processor with explicit scraper action names
- Package version updated to 2.8.37

## [2.8.36] - 2025-12-29

### Added
- Comprehensive self-diagnostics system with MongoDB persistence
  - SelfDiagnosticsService for system health monitoring
  - DiagnosticReport model for storing test results and history
  - `/diagnostics` Telegram command with interactive button interface
  - REST API endpoints: /api/diagnostics/run, /latest, /history, /trend, /config
  - /api/health endpoint for quick health checks
  - Scheduled automatic diagnostics capability
  - Health trend tracking and issue detection

### Fixed
- PDF generation in scraper plugin now returns Buffer format for Telegram compatibility
- Tasks plugin metadata undefined error when task.metadata doesn't exist
- AIIntentDetector method name corrected from detectIntent to detect
- Telegram bot timeout increased via TELEGRAM_LAUNCH_TIMEOUT environment variable
- Removed corrupted openaigpt3.js plugin file

### Changed
- Package version updated to 2.8.36
- Enhanced error handling in tasks plugin for metadata operations

## [2.8.35] - 2025-12-29

### Added
- Complete device group management for ThingsBoard plugin
  - createDeviceGroup: Create new device groups with name and description
  - updateDeviceGroup: Update group details
  - deleteDeviceGroup: Delete device groups
  - getDeviceGroups: List all device groups
  - addDevicesToGroup: Batch add devices to groups
  - removeDevicesFromGroup: Batch remove devices from groups
  - getDeviceGroupDevices: List all devices in a specific group

### Fixed
- Self-modification service now filters to only allowed AI-driven capability upgrade types
- Fixed "Only AI-driven capability upgrades are supported" error by adding type filtering
- Self-modification service successfully creates PRs after fix (e.g., PR #482)

### Changed
- Plugin count in README updated from 28+ to 29+
- Self-modification service now filters improvements before selection

## [2.8.34] - 2025-12-29

### Added
- Consistent status display for all autonomous self-improvement services
  - Self-Modification: Added Currently Running status and Next Session timing
  - Plugin Development: Added Currently Running status and Next Session timing
  - Auto Improvements: New status grid with Last Analysis, Analysis Running, Next Analysis, and Pending Count
- Database query for accurate plugin development count (shows all plugins, not just last 50)
- Arduino Nano support with Blink and Analog Read templates
- Raspberry Pi Pico support with Blink, Temperature, and PWM templates
- Enhanced USB VID/PID mapping for better microcontroller detection
- RP2040 core automatic installation for Raspberry Pi Pico
- Scraper plugin bulk processing capability for multiple URLs
- ThingsBoard IoT platform integration plugin with full device management
- Future plugin considerations section in feature-progress.json (Azure IoT, AWS IoT)

### Changed
- Plugin Development getStatus() method now async to query MongoDB
- All API endpoints updated to await async getStatus() calls
- Microcontroller plugin version bumped to 1.1.0
- Microcontroller plugin description updated to include Raspberry Pi Pico
- Plugin count in README updated from 21+ to 28+

### Fixed
- Plugin development total count showing only last 50 items instead of all plugins
- Fixed GitHub issues API returning pull requests in bug count
- Fixed Telegram notifications for plugin development (isRunning instead of isConnected)
- Fixed self-modification branch name issue that was causing PR failures
- Web UI to allow maximum 10 plugins per day instead of 5

## [2.8.33] - 2025-12-29

### Added
- Multiple voice presets for ResembleAI Chatterbox model
  - Soft preset: Softer, less masculine voice using lower CFG values
  - Expressive preset: More emotional and varied speech
  - Neutral preset: Balanced, professional voice
- Automatic parameter adjustment for Chatterbox voices (cfg and exaggeration)
- Dedicated plugin-development.log file for plugin development service
- Plugin development service logger with proper service metadata
- Plugin development log viewer in web UI

### Changed
- Improved Chatterbox voice descriptions to better indicate voice characteristics
- Enhanced HuggingFace TTS to support model-specific parameters

### Fixed
- Plugin development logs incorrectly appearing in bug-detection.log
- Added exclusion filter to prevent plugin development logs in bug detection
- Set proper service metadata for plugin development logging
- OpenWeatherMap plugin development conflicts with existing branch
- Cleaned up failed plugin development attempts

## [2.8.32] - 2025-12-29

### Added
- Voice provider field to Agent schema for persistence across restarts
- Provider-specific model validation for OpenAI and HuggingFace
- HuggingFace models (hexgrad/Kokoro-82M, ResembleAI/chatterbox) to availableModels list

### Changed
- Enhanced voice settings validation to check models based on provider
- Updated Agent model schema to include provider enum field

### Fixed
- Voice provider selection not persisting after restart
- Model validation incorrectly rejecting HuggingFace models
- Complete voice settings now properly saved and restored

## [2.8.31] - 2025-12-29

### Added
- Complete Kokoro-82M voice library with all 13 high-quality voices rated C or higher
- American Female voices: Heart (A), Bella (A-), Nicole (B-), Aoede (C+), Kore (C+), Sarah (C+)
- American Male voices: Fenrir (C+), Michael (C+), Puck (C+)
- British Female voices: Emma (B-), Isabella (C)  
- British Male voices: Fable (C), George (C)
- Voice quality grade ratings in descriptions for informed selection

### Changed
- Improved voice category organization with separate sections for accent and gender
- Enhanced CSS spacing to prevent test button overlap with voice descriptions
- Added bottom margin to voice descriptions for better button placement

### Fixed
- Test button overlapping voice description text on both desktop and mobile
- Voice card layout spacing issues in mobile view

## [2.8.30] - 2025-12-29

### Added
- Enhanced HuggingFace TTS support with multiple models
- ResembleAI Chatterbox model support alongside Kokoro-82M
- Voice category separators in web UI for better organization
- Mobile-optimized voice selection with single-column layout
- Proper voice descriptions for Kokoro voices (AF/AM/BF/BM)

### Changed
- Updated @huggingface/inference package from v2.8.1 to v4.13.5
- Migrated from HfInference to InferenceClient for latest API compatibility
- Improved mobile UI spacing and typography for voice cards
- Enhanced voice grid layout with provider-specific categories
- Fixed web interface to properly pass provider parameter to TTS service

### Fixed
- HuggingFace API endpoint migration to router.huggingface.co
- Variable scoping issues in HuggingFace error handling
- Voice provider parameter not being passed from web interface
- Mobile UI cramped spacing for voice selection

## [2.8.29] - 2025-12-29

### Added
- **HuggingFace TTS Support**: Multiple TTS providers with Kokoro-82M model
  - Added HuggingFace Inference API integration alongside OpenAI
  - Kokoro-82M model with 13 high-quality voices (American/British English)
  - Provider selection in web UI - choose OpenAI or HuggingFace
  - Voice profiles now support provider preferences
  - Free TTS alternative with quality voices (A/B/C ratings only)
  - Automatic fallback between HF_TOKEN and HUGGINGFACE_TOKEN env vars
  - Updated voice plugin to v1.3.0 with provider endpoints

## [2.8.28] - 2025-12-29

### Added
- **Voice Profile Management**: Save and switch between voice configurations
  - Create custom voice profiles with different TTS settings
  - Switch between profiles via API or commands
  - New endpoints: POST `/profile` and `/profile/switch`
  - Commands: `voice profile create/switch/update <name>`
  - PR #473 merged from ALICE self-modification service

- **Structured Data Extraction**: Enhanced scraper plugin with JSON-LD and Microdata
  - Extracts JSON-LD structured data from web pages
  - Parses HTML5 microdata (itemscope/itemprop)
  - Works with Schema.org structured content
  - Supports both Cheerio and Puppeteer extraction methods
  - Added jsonld dependency for advanced processing
  - PR #474 merged from ALICE self-modification service

## [2.8.27] - 2025-12-29

### Added  
- **SendGrid Email Tracking and Analytics**: Comprehensive email tracking features
  - Added `trackOpens` and `trackClicks` parameters to sendEmail (default: true)
  - Implemented click tracking for all links in emails
  - Added open tracking with pixel substitution
  - New `getStats` command for email analytics with date ranges
  - Calculates open rates, click rates, and bounce rates
  - Provides daily statistics breakdown
  - Replaces incomplete PR #471 with full implementation

### Fixed
- **Closed Non-viable PRs**: 
  - PR #472 (Voice pitch/volume) - OpenAI TTS doesn't support these features
  - PR #471 (Email analytics) - Replaced with complete tracking implementation

## [2.8.26] - 2025-12-29

### Added
- **SendGrid Dynamic Templates Support**: New command for personalized emails
  - Added `sendDynamicEmail` command to use SendGrid dynamic templates
  - Pass custom dynamic data to populate email templates
  - Full error handling for API key and sender verification issues
  - PR #469 merged from ALICE self-modification service

- **Voice Language API Endpoint**: List supported TTS languages via API
  - New GET `/languages` endpoint in voice plugin
  - Returns 32 supported languages with codes and native names
  - Added `getSupportedLanguages()` method to TTS service
  - PR #470 merged from ALICE self-modification service

## [2.8.25] - 2025-12-29

### Added
- **Voice Plugin Language Support**: TTS now supports language selection
  - Added optional language parameter to voice test command
  - Default language set to 'en' with full backward compatibility
  - Updated command syntax: `voice test <voice> [text] [language]`
  - Plugin version bumped to 1.1.0
  - PR #468 merged from ALICE self-modification service

- **SendGrid Retry Logic**: Automatic retry mechanism for transient errors
  - Implemented exponential backoff strategy (1s → 2s → 4s)
  - Retries on 5xx errors and 429 rate limits only
  - Maximum 3 retry attempts with intelligent error detection
  - All API endpoints wrapped with retry functionality
  - PR #467 merged from ALICE self-modification service

## [2.8.24] - 2025-12-29

### Fixed
- **Notification Settings Persistence**: Weekly report settings now persist across agent restarts
  - Added `restoreReportSettings()` method to TaskScheduler
  - Settings are loaded from MongoDB on scheduler initialization
  - Report jobs are automatically rescheduled with saved preferences
  - Fixes issue where notification frequency/time was reset after restarts

## [2.8.18] - 2025-12-28

### Added
- **Complete Email Scheduling System**: Schedule one-time and recurring emails
  - ✅ **One-Time Scheduling**: "Send email to John tomorrow at 9am"
  - ✅ **Recurring Emails**: "Send daily report to team at 9am" with flexible patterns
  - ✅ **Natural Language Support**: Full AI intent detection for scheduled emails
  - ✅ **Contact Lookup**: Works with names or email addresses
  - ✅ **Management Actions**: List and cancel scheduled/recurring emails
  - ✅ **Cron & Interval Support**: Use "daily", "5 minutes", or "0 9 * * 1" patterns

- **Enhanced Development Plugin**: Tag-based organization system
  - ✅ **Feature & Edit Tagging**: Organize development items with custom tags
  - ✅ **Tag Management**: List all tags with usage counts
  - ✅ **Tag Filtering**: Filter features/edits by tags
  - ✅ **Tag Validation**: Ensures proper tag names (alphanumeric + hyphens/underscores)

- **Monitoring Plugin Enhancement**: Dynamic threshold configuration
  - ✅ **Runtime Configuration**: Update CPU, memory, disk, temperature thresholds
  - ✅ **Plugin Actions**: getThresholds and updateThresholds for management
  - ✅ **Validation**: Ensures warning thresholds are less than critical

### Fixed
- **Background Tasks UI**: Last Activities section now scrolls horizontally instead of truncating text
  - ✅ **Custom Scrollbars**: Themed scrollbars matching UI design
  - ✅ **Mobile Responsive**: Maintains functionality on all screen sizes

- **Monitoring Plugin API**: Converted unsupported API endpoints to plugin actions
  - Removed incompatible registerEndpoint calls
  - Converted threshold management to plugin action pattern

### Changed
- **Closed PR #451**: Bot PR about recurring email scheduling (feature implemented directly)

## [2.8.17] - 2025-12-28

### Added
- **Professional Email Signatures**: Enhanced HTML signatures with embedded avatars
  - Avatar image embedded directly in email signature (80x80px circular)
  - Professional table-based layout for maximum compatibility
  - Adaptive signatures for master vs other recipients
  - Created `emailSignatureHelper.js` for advanced signature options
  - Support for modern, classic, and minimal signature styles
  - Documentation at `/docs/features/professional-email-signatures.md`

### Fixed
- **AI Email Composition**: Fixed duplicate signatures and name usage
  - Strengthened prompt to prevent AI from adding its own sign-off
  - Added post-processing to remove any AI-generated signatures
  - Strips patterns like "Warm regards, ALICE - my user's Personal Assistant"
  - Email body now ends cleanly with just the closing phrase
  - System signature is properly separated from email content
- **Master Name Lookup**: Dynamic database lookup for personalized signatures
  - Fixed import path for Memory model in aiIntentDetector.js
  - Signatures now use actual master name from contacts database
  - "Your Personal Assistant" when emailing master
  - "[Master's Name]'s Personal Assistant" when emailing others
- **Multi-Step Task Execution**: Fixed websearch plugin action formatting
  - AI now correctly uses action: "crypto" instead of "websearch.getCryptoPrice"
  - Added clearer instructions for plugin action names in pluginChainProcessor.js

## [2.8.16] - 2025-12-27

### Added
- **Email Avatar Support**: Gravatar integration for professional email appearance
  - Created `gravatarHelper.js` utility for avatar URL generation
  - Added avatar headers (X-Avatar-URL, X-Gravatar, X-Face-URL, Face-URL) to all emails
  - Automatic MD5 hashing of sender email for privacy
  - Robohash fallback when no Gravatar configured
  - Comprehensive documentation at `/docs/features/email-avatars.md`

### Fixed
- **VPN Auto-Connect Persistence**: Settings now persist across restarts
  - Added database persistence for VPN plugin configuration
  - Import PluginSettings model for saving/loading settings
  - Created loadPersistedSettings() method to restore on initialization
  - Created saveSettings() method to persist configuration changes
  - Updated setAutoConnect() to save settings after changes
  - Auto-connect preference now survives agent restarts

- **Contact Search Improvements**: Enhanced name matching capabilities
  - Fixed Fuse.js configuration by removing deprecated tokenize option
  - Added last name to searchable fields for better matching
  - Enabled exact match for both first and last names
  - Added debug logging for Whalley-specific searches
  - Increased search threshold for more flexible matching

## [2.8.14] - 2025-12-27

### Fixed
- **Contact Structure Validation**: Enhanced contact resolution robustness
  - Fixed const reassignment issue in bestMatch variable
  - Added validation for contact email existence before using
  - Enhanced debugging for contact structure issues
  - Filter out contacts without metadata from search results
  - Better error messages when contacts lack email addresses

## [2.8.13] - 2025-12-27

### Fixed
- **Contact Resolution Safety**: Fixed undefined property access in email suggestions
  - Added safe navigation for contact metadata access
  - Fixed "Cannot read properties of undefined (reading 'email')" error
  - Added fallback values for missing contact properties
  - Enhanced logging for contact resolution debugging
  - Improved error handling for malformed suggestion objects

## [2.8.12] - 2025-12-27

### Fixed
- **Multi-Step Email Tasks**: Fixed validation error for missing recipient
  - Updated plugin chain processor prompt to explicitly extract recipients from requests
  - Added safety check to ensure email steps always have 'to' parameter
  - Improved AI instructions with examples showing proper recipient extraction
  - Added default subject line when none provided
  - Better error messages when 'to' parameter is missing

## [2.8.11] - 2025-12-27

### Fixed
- **Contact Resolution Logic**: Improved partial name matching for email operations
  - Fixed contact manager to properly handle requireHighConfidence=false parameter
  - Now accepts medium confidence matches (60-85%) for multi-step tasks
  - Added support for low confidence matches (40-60%) when high confidence not required
  - Better error messages showing suggested matches when exact match not found
  - Resolves issue where "Whalley" and other partial names weren't being matched

## [2.8.10] - 2025-12-27

### Fixed
- **Email Contact Resolution**: Multi-step tasks with email operations
  - Added automatic contact name to email address resolution
  - Fixed "recipient address is not valid RFC 5321" errors
  - Both sendEmail and sendEmailWithAI now support contact names
  - Clear error messages when contact lookup fails
  - Seamless integration with contact manager for name resolution

## [2.8.9] - 2025-12-27

### Added
- **Email Batch Operations**: Complete bulk email management functionality
  - Checkbox selection for individual emails with visual feedback
  - "Select All" functionality for efficient bulk operations
  - Batch "Mark as Processed" operation via new API endpoint `/api/emails/batch-process`
  - Mobile-responsive batch controls with proper flex layout
  - Event delegation for dynamic checkbox handling

- **Automatic Memory Saving**: Operations now captured in memory system
  - Plugin operations automatically saved after execution
  - Operation summaries generated for human-readable memories
  - Importance calculation based on operation type
  - Respects memory manager's autoAddEnabled setting

- **System Prompt Enhancements**: Improved AI identity consistency
  - Added explicit "NEVER break character" instruction in BEHAVIOR_DIRECTIVE
  - Agent maintains consistent identity as configured name
  - Dynamic plugin listing remains functional

- **PR Deduplication**: Plugin Development service prevents duplicate PRs
  - Added `checkForExistingPRs()` function to check PR history
  - Lists similar open and closed PRs before attempting new PR
  - Prevents duplicate plugin development efforts

### Fixed
- **CPU Usage False Positives**: Process monitoring accuracy improvements
  - Filtered out ps aux, ps -, top, htop commands from high CPU alerts
  - Resolved meaningless 100% CPU usage reports for monitoring commands

- **VPN Interface Issues**: Enhanced ExpressVPN integration
  - Fixed crowded advanced buttons with proper flex wrapping
  - Reimplemented auto-connect as agent-level control
  - Added clear UI explanations for VPN management modes

- **IMAP Connection Stability**: Email service reliability improvements
  - Increased authentication timeout from 10 to 30 seconds
  - Added connection reuse with keepalive settings
  - Better cleanup and error handling

- **Telegram Bot Startup**: Improved launch reliability
  - Increased timeout from 30 to 60 seconds
  - Added better error logging for connection issues

- **ES Module Compatibility**: Fixed scraper plugin
  - Replaced CommonJS require with proper ES imports
  - Resolved "require is not defined" errors

- **Web UI Fixes**: Multiple interface improvements
  - Calendar grid alignment fixed with minmax CSS
  - Email selection count now updates properly with event delegation
  - Mobile layout for batch controls improved
  - Background Tasks "Last Activities" section now scrollable on mobile
  - Consolidated duplicate Logs pages into single interface

### Changed
- **Sidebar Organization**: Menu items now sorted alphabetically (Overview remains at top)
- **Telegram Notifications**: Self-modification service now has proper error handling
- **Character Consistency**: Complete overhaul of all prompts and communications
  - All email prompts now maintain agent character
  - Removed hardcoded "ALICE" references in favor of dynamic agent name
  - Eliminated Anthropic-specific references for provider independence
  - Added explicit "NEVER break character" instructions throughout

## [2.8.8] - 2025-12-26

### Added - Enhanced Logging System & Calendar Stabilization
- **Comprehensive Logging Overhaul**: Complete reorganization of application logging
  - Replaced all `console.log` calls with proper logger instances
  - Added `plugins.log` file for dedicated plugin activity tracking
  - Service-specific child loggers for better debugging
  - Updated Web UI log viewer with new log file options
  - Created comprehensive LOGGING.md documentation guide
  - Fixed production server boot issue from log rotation endpoint

- **Calendar Plugin Stabilization**: Resolved all major CalDAV integration issues
  - Fixed event parsing returning 0 events despite finding calendar objects
  - Corrected Web UI routing for event update/delete operations  
  - Resolved 412 Precondition Failed errors with wildcard etag strategy
  - Improved sync operations before modifications
  - Calendar now fully operational with Google Calendar CalDAV

### Fixed
- **Console Logging**: Replaced console.log usage in `devenv.js` and `bugDetector.js` with proper loggers
- **Production Boot Issue**: Fixed server startup failure from log rotation endpoint default value mismatch
- **Calendar Data Access**: Discovered and fixed nested data structure in DAV response objects

### Improved
- **Log Organization**: All services now have dedicated log files for focused debugging
- **Production Cleanup**: Removed deprecated log files (combined.log, error.log, pm2-*.log)
- **Error Tracking**: Better error isolation with service-specific logging
- **Dynamic Version Display**: Version now read from package.json instead of hardcoded
  - Web UI agent info page shows current version
  - System prompt includes accurate version number
  - SSH interface displays correct version
  - Single source of truth in package.json

## [2.8.7] - 2025-12-26

### Added - Dynamic System Prompt & Capability Verification
- **Dynamic System Prompt Generation**: Agent capability awareness that updates automatically
  - Plugin list dynamically generated from `apiManager.getPluginList()`
  - Shows only enabled plugins with actual descriptions
  - Plugin count updates automatically (no more hardcoded "22+ plugins")
  - Eliminates manual updates when adding/removing plugins
  - Accurate representation of current system capabilities

- **Comprehensive Capability Testing**: Suite to verify agent access to all features
  - Created `agent-capabilities-test.js` for programmatic verification
  - Added `natural-language-test.md` with test phrases for all capabilities
  - Verified AI intent detection as primary with regex fallback
  - Confirmed access to all 26+ plugins via natural language and API
  - Validated full Agenda scheduler access for task scheduling

- **Enhanced Scheduling Documentation**: Better agent awareness of scheduling capabilities
  - Added scheduling examples to system prompt: "remind me in 30 minutes"
  - Documented available Agenda methods: schedule(), every(), now(), cancel()
  - Created comprehensive SCHEDULING.md guide
  - Agent can now better understand and execute scheduling requests

### Improved
- **System Prompt Accuracy**: Always reflects actual system state
  - Dynamic intent count calculation (40+ base + plugin intents)
  - Real-time plugin status (enabled/disabled)
  - Automatic inclusion of new plugins
  - Better scheduling capability awareness

## [2.8.6] - 2025-12-26

### Added - Enhanced Logging System
- **Organized Logging Structure**: Complete overhaul of application logging
  - Created dedicated log files for each major service:
    - `self-modification.log` - Self-modification service operations
    - `bug-detection.log` - Bug detection and fixing activities
    - `api-web.log` - Web interface and API requests
    - `plugins.log` - All plugin loading and operations
    - `calendar-debug.log` - Calendar-specific debugging
  - Implemented service-specific child loggers for better tracking
  - Each plugin automatically gets its own logger with service name tagging
  - Added filtered file transports for organized log segregation

### Fixed - Calendar Plugin Operations
- **Event Parsing**: Fixed issue where calendar returned 0 events despite finding 4 objects
  - Discovered data was nested in `obj.data.props.calendarData`
  - Properly accessing iCal data from DAV response objects
- **Event Update/Delete**: Fixed Web UI routing and API issues
  - Moved event IDs from URL path to request body to fix routing errors
  - Corrected DAV API usage: `dav.deleteCalendarObject` instead of `this.client.deleteCalendarObject`
  - Implemented sync operations before modifications
- **412 Precondition Failed**: Resolved update conflicts with etag mismatches
  - Implemented fetch-first approach for current etag
  - Added wildcard etag (`*`) fallback for forcing updates
  - Proper error handling for CalDAV precondition failures

### Improved - Web Interface
- **Log Viewer Updates**: Enhanced log file selection and display
  - Updated log selector dropdown with new log file options
  - Changed "combined" to "all-activity" for clarity
  - Added new log types: plugins, calendar-debug
  - Fixed backend API mappings for all log types
  - Updated log rotation endpoint to use correct default
- **Production Cleanup**: Removed deprecated log files
  - Deleted: combined.log, error.log, pm2-*.log files
  - Cleaned up redundant logging to reduce disk usage

### Documentation
- **LOGGING.md**: Created comprehensive logging guide
  - Detailed explanation of log file organization
  - Service-specific debugging workflows
  - Log file purposes and best practices
  - Quick problem diagnosis commands
  - Performance considerations and rotation policies

## [2.8.5] - 2025-12-26

### Added - Calendar Integration & Plugin Development
- **CalDAV Calendar Plugin**: Complete calendar integration without OAuth complexity
  - Universal CalDAV support for Google Calendar, iCloud, Yahoo, Outlook
  - App-specific password authentication instead of OAuth
  - Full event management: create, list, search, update, delete events
  - Smart scheduling with availability checking and free slot finding
  - Natural language support: "What's on my calendar today?"
  - Multiple calendar account support with easy switching
  - Event reminders and attendee management
  - Recurrence pattern support for repeating events
  - Created comprehensive test suite for calendar functionality

- **Plugin Development Documentation**: Created 990-line comprehensive guide
  - Complete plugin architecture explanation with BasePlugin class
  - 13 detailed sections covering all aspects of plugin development
  - Real-world examples: Weather API and MongoDB database plugins
  - AI intent integration guide for natural language processing
  - Parameter validation schemas and error handling patterns
  - State management and persistence strategies
  - Testing guidelines with Jest examples
  - Security best practices: rate limiting, caching, input sanitization
  - Publishing and distribution instructions

### Fixed - Web UI Chart Visualization
- **AI Provider Charts**: Resolved multiple display and overflow issues
  - Fixed "Usage by Model" pie chart showing only top half
    - Increased container height to 400px
    - Set overflow: visible for proper legend display
    - Adjusted CSS to prevent SVG clipping
  - Fixed "Provider Comparison" chart being scrunched
    - Increased chart height from 250px to 350px
    - Improved margin spacing for better layout
    - Ensured proper scaling on all screen sizes
  - Fixed charts causing page-wide horizontal scroll
    - Changed overflow handling to contain scrolling within chart divs
    - Set minimum widths for charts to prevent compression
    - Updated grid layout: single column mobile, dual column desktop
  - Fixed "Daily Token Usage" chart being too compressed
    - Increased height to 350px with better margins
    - Added minimum width of 500px for readability

### Improved
- **Web UI Responsiveness**: Enhanced mobile and desktop layouts
  - Charts now properly scale and scroll within their containers
  - Improved grid system for better space utilization
  - Fixed overflow issues that broke page layout

## [2.8.4] - 2025-12-26

### Fixed - Web UI Plugin Improvements
- **Plugin Descriptions**: Added missing descriptions for all plugins in web interface
  - Added descriptions for: backupStrategy, bugDetector, devenv, documentIntelligence, samba, systemAdmin, virustotal, voice, vpn
  - All plugins now display meaningful descriptions instead of "No description available"
  - Improved user understanding of plugin functionality in the web dashboard
- **Mobile UI Enhancements**: Fixed plugin toggle and description overlap issues
  - Plugin toggle buttons no longer allow dot to escape slider bounds on mobile
  - Added flex-shrink: 0 to prevent toggle compression on small screens
  - Plugin descriptions no longer overlap with toggle controls
  - Enhanced responsive layout with proper wrapping and spacing
  - Improved word-wrapping for long plugin descriptions on mobile devices

## [2.8.3] - 2025-12-26

### Fixed
- **Background Service Persistence**:
  - Fixed MongoDB persistence for self-modification, plugin development, and bug fixing services
  - Fixed "Last run: Never" issue - services now properly save and display lastCheckTime
  - Fixed self-modification analysisOnly mode not persisting across restarts
  - Fixed async/await issue in plugin development service disable method

### Added
- **Manual Service Triggers**:
  - Added manual trigger API endpoint for self-modification service (`/api/selfmod/check`)
  - Added "Run Check Now" button to self-modification web UI
  - All three background services now have manual trigger capabilities

### Improved
- **Service State Management**:
  - All service configurations now properly persist to MongoDB
  - Service states (enabled/disabled, analysisOnly, lastCheckTime) survive restarts
  - Improved error handling and logging for service state changes

## [2.8.2] - 2025-12-25

### Fixed
- **Web UI Issues**:
  - Fixed auto-refresh not working in Brave browser by using setTimeout instead of setInterval
  - Fixed AI providers page button/checkbox spacing at the top
  - Fixed chart display issues (overflow and text color using CSS variables)
  - Fixed button crowding on firewall and settings pages with proper flex spacing
  - Fixed mobile contact phone number spacing with increased padding and line-height

### Added
- **Memory Management Features**:
  - Batch selection with "Select All" checkbox for memory items
  - Batch delete functionality for selected memories
  - Auto-add memory toggle to control automatic memory storage
  - Implemented AI intents 38 (remember this) and 39 (recall) for memory operations
  
- **Input Validation & Security**:
  - Created comprehensive validation utility (validation.js)
  - Added input sanitization to system and SSH plugins
  - Blocks dangerous commands (rm -rf /, dd to system drives, mkfs on system drives, fork bombs)
  - Path traversal protection and command injection prevention
  
- **System Control**:
  - Added LAN Agent restart functionality to web UI settings
  - Supports normal restart and restart with log reset
  - Shows countdown timer during restart process
  
- **Log Management**:
  - Added manual log rotation control to raw logs tab
  - "Rotate Logs" button for immediate log rotation
  - Visual indication of automatic rotation settings
  - Backend API endpoint for log rotation with timestamp preservation

### Enhanced
- **Plugin Chain Processing**:
  - Added coordination to prevent plugin conflicts
  - Implemented concurrent chain limits (max 3)
  - Added plugin-level locks to prevent race conditions
  - Active chain tracking for better debugging
  
- **Code Quality**:
  - Created JSON utilities (jsonUtils.js) for safe parsing/stringifying
  - Standardized promise patterns from .then().catch() to async/await
  - Updated JSDoc examples to use logger instead of console.log
  - Replaced remaining console.log usage with proper logger

## [2.8.1] - 2025-12-25

### Fixed - SSH/Samba Encryption & PM2 Environment Configuration
- **Encryption Key Persistence**: Fixed PM2 not loading ENCRYPTION_KEY from .env file
  - Created ecosystem.config.cjs for proper environment variable loading
  - Ensures consistent encryption key across server restarts
  - Prevents "All configured authentication methods failed" errors
- **Password Storage Architecture**: Restructured credential handling in SSH and Samba plugins
  - Store decrypted passwords in memory for immediate use
  - Only encrypt passwords when persisting to MongoDB
  - Properly decrypt passwords when loading from database
  - Fixed password double-encryption issues causing authentication failures
- **Production Deployment**: Updated PM2 configuration for reliable credential management
  - Added --env-file support to ensure .env variables are loaded
  - Fixed inconsistent encryption keys causing stored passwords to become unusable
  - Cleared corrupted credential data to allow fresh start with proper encryption

### Enhanced
- **Debug Logging**: Added comprehensive logging for password encryption/decryption flow
  - Track password handling through save, load, and connect operations
  - Better error messages for encryption-related failures
  - Improved troubleshooting for authentication issues

## [2.8.0] - 2025-12-25

### Added - Enhanced Security & Persistence
- **Secure Credential Storage**: Implemented enterprise-grade encryption for sensitive data
  - AES-256-GCM encryption for SSH passwords and private keys
  - PBKDF2 key derivation with 100,000 iterations and unique salt per credential
  - Secure encryption for all Samba mount passwords
  - Environment-based encryption key management via ENCRYPTION_KEY variable
  - Automatic secure key generation with logging when not configured
  - Created new encryption utility module at src/utils/encryption.js
- **Database Persistence**: SSH and Samba configurations now survive restarts
  - MongoDB integration for persistent storage replacing in-memory storage
  - Created SSHConnection and SambaMount Mongoose models
  - All SSH connections automatically loaded from database on startup
  - All Samba mount configurations restored from database on initialization
  - Automatic encryption/decryption of credentials during save/load operations
  - Real-time database synchronization on all configuration changes
- **Samba Guest Access**: Enhanced flexibility for network shares
  - Made username and password optional for guest/anonymous access
  - Automatic 'guest' mount option when no credentials provided
  - Updated Web UI with clear "(optional)" labels and helpful placeholders
  - Support for no auth, username only, or full credential authentication
  - Smart mount options building based on provided credentials

### Fixed
- SSH plugin now properly encrypts passwords and private keys before storage
- Samba plugin correctly handles optional authentication scenarios
- Web UI validation updated to allow empty username/password for guest access

## [2.7.3] - 2025-12-24

### Fixed - Web UI Critical Functions
- **Task Management**: Fixed Add Task button functionality
  - Resolved priority type mismatch (string vs number) between API and Task model
  - Added priority mapping from string labels to numeric values
  - Fixed missing title field in API request payload
  - Added success/error notifications for better user feedback
- **SSH Management**: Verified SSH connection dialog and all related functions working correctly
- **Network Scanner**: Fixed multiple issues preventing device detection
  - Corrected API paths from /network/api/* to /api/network/*
  - Fixed subnet detection (192.168.0.0/24 instead of hardcoded 192.168.1.0/24)
  - Added network configuration persistence to database
  - Fixed agent lookup to handle single instance correctly
  - Removed duplicate agent records causing configuration conflicts
- **Samba/CIFS Mount**: Fixed "checking" status stuck issue
  - Removed conflicting old router file causing module import errors
  - Migrated to generic plugin router for consistency
  - Fixed CIFS status display showing "Not Installed" correctly
- **Docker Plugin**: Fixed "Unknown Docker action" error
  - Updated command parsing to handle simple action names
  - Fixed AI intent detector to extract actions from "docker ps" style commands
- **Arduino CLI**: Fixed initialization failure
  - Added check for existing configuration before attempting to create new one
  - Prevents "Config file already exists" errors

## [2.7.2] - 2025-12-24

### Added - Plugin Development Service Jest Testing
- **Automated Test Generation**: Plugin development service now generates complete Jest test suites
  - AI-powered test code generation for all new plugins
  - Comprehensive test coverage including initialization, parameter validation, API mocking, and error handling
  - Fallback to well-structured test templates when AI generation fails
  - ES6 module support with proper import/export syntax
- **Optional Test Execution**: New test running capability with web UI control
  - Jest test execution after plugin creation (configurable via web UI)
  - Test results included in GitHub PR descriptions
  - Clear test status indicators (✅ passed, ⚠️ failed)
  - Non-blocking test failures - PRs still created with failure notes
- **Enhanced Test Reporting**: Improved error messages and diagnostics
  - Better parsing of test execution results
  - Clear error categorization (syntax errors, import errors, test failures)
  - Detailed failure information in PR descriptions
- **Web UI Integration**: New test configuration options
  - "Run Tests After Creation" toggle in plugin development settings
  - Test requirement persisted in database configuration
  - Visual feedback for test execution status

### Fixed - Plugin Development Service Issues
- **Test Code Extraction**: Fixed AI response parsing to extract actual test code instead of analysis text
- **Import Statement Fix**: Resolved ES module import errors in test execution
- **Response Validation**: Added checks to detect and handle non-code AI responses
- **Template Generation**: Improved fallback test templates with proper axios mocking

## [2.7.1]
### Bug Fixes
- Fixed issue #427: Security Vulnerabilities: ../lanagent-repo/ecosystem.config.js:9
 - 2025-12-23

### Fixed - Critical Bug Fixing Service Workflow Issue
- **Branch Management Fix**: Resolved bug fixing service not switching back to main branch after PR creation
  - Fixed issue where bug fixing service would stay on feature branch after successful PR submission
  - Subsequent bug fixes would fail due to attempting to create new branches from feature branches instead of main
  - Added proper checkout to main branch after PR creation (bugFixing.js:293)
  - Ensures clean workflow where each bug fix starts from the latest main branch
- **Multi-Bug Session Support**: Bug fixing sessions now properly process all bugs in queue instead of failing after first success
  - Eliminates git conflicts and branch naming issues in multi-bug fixing sessions
  - Ensures each bug fix gets its own clean feature branch derived from main

### Fixed - HuggingFace Token Usage Reporting Discrepancy
- **Cost Calculation Fix**: Resolved major discrepancy between API service (.17) and charts (.01) token usage reporting
  - Fixed model name mapping in HuggingFace cost calculation function
  - Added proper pricing rates for Qwen models and other HuggingFace model families (Qwen, meta-llama, deepseek-ai, etc.)
  - Updated default pricing rates from unrealistic low values (0.00005) to accurate market rates (0.0002)
  - Model "Qwen/Qwen3-Coder-480B-A35B-Instruct" now correctly uses Qwen pricing instead of falling back to minimal default rates
- **Accurate Metrics**: Web dashboard charts now display correct cost estimates matching API service calculations
  - Eliminated confusion between high API usage reports and low chart displays
  - Provides accurate cost tracking for HuggingFace usage across all supported models

## [2.7.0] - 2025-12-23

### Added - MongoDB Bug Fixing State Management
- **MongoDB State Persistence**: Complete replacement of flat file state management with MongoDB
  - ProcessedBug MongoDB model for reliable bug tracking across sessions
  - Detailed state information including fix results, PR URLs, branch names, and error messages  
  - Cross-session duplicate prevention with database-backed state persistence
  - Eliminated .bug-fixing-state.json files from git commits for clean repository history
- **Enhanced Bug Fixing Service**: Major improvements to bug resolution quality and reliability
  - Improved AI prompts for better code indentation and formatting
  - Automatic branch conflict resolution with existing branch cleanup
  - Fixed affected files list display in pull request descriptions
  - Better error handling and state tracking for failed/skipped bugs
  - Template variable replacement for proper agent name display
- **Git Commit Filtering**: Selective file addition to prevent state file pollution
  - Filters out .bug-fixing-state.json and other non-source files from commits
  - Maintains clean git history for pull requests
  - Only commits actual source code changes

### Enhanced
- **Bug Detection Title Cleanup**: Removed redundant text tags from GitHub issue titles
  - Eliminates [CRITICAL], [HIGH], [MEDIUM], [LOW] text prefixes from issue titles
  - Maintains proper GitHub label categorization for filtering and organization
  - Cleaner issue titles while preserving full categorization functionality
- **End-to-End Verification**: Complete bug fixing workflow tested and confirmed operational
  - GitHub API integration verified with live issue processing
  - MongoDB state management confirmed working with production data
  - Pull request creation and branch management fully functional

## [2.6.0] - 2025-12-23

### Added - Bug Detection Duplicate Prevention System
- **Comprehensive Duplicate Prevention**: Complete overhaul of bug detection to prevent duplicate GitHub issues
  - SHA-256 fingerprint generation based on file path, line number, and bug pattern for unique identification
  - Local duplicate state management with fingerprint tracking across daily scans
  - Path normalization to handle relative path variations (`./`, `../`, etc.) consistently
  - GitHub API integration for duplicate issue detection using GitHub Search API
  - Enhanced issue creation with dual-layer duplicate checking (local + GitHub)
- **GitHub API Search Integration**: New search functionality added to Git plugin
  - `searchGitHubIssues` action with comprehensive query support
  - Full GitHub Search API integration with proper authentication
  - Issue search with title, body, and metadata filtering
  - Results formatting with complete issue details
- **Robust State Management**: Enhanced bug detection state persistence
  - Fingerprint-based duplicate tracking with Set data structures for efficient operations
  - Local state file management with proper serialization/deserialization
  - Automatic cleanup of old fingerprints to prevent unlimited state growth
  - Cross-scan duplicate prevention to avoid re-processing same bugs
- **Enhanced Bug Processing**: All bug detection flows updated with duplicate prevention
  - Pattern matching, error handling, and input validation checks include fingerprints
  - AI provider agnostic processing maintains duplicate prevention across all providers
  - Real-time duplicate detection during scan execution
  - Comprehensive testing infrastructure with end-to-end validation

### Enhanced - Bug Detection System
- **Production Testing**: Complete end-to-end testing confirmed operational status
  - Successfully processed 1,575+ bugs with 0 duplicates created
  - GitHub issue creation for Critical/High/Medium severity bugs working perfectly
  - Daily automated scans at 2:00 AM with top 5 priority limit
  - Path normalization handles various file path formats consistently
- **AI Provider Compatibility**: Bug detection works with all AI providers
  - OpenAI, Anthropic, HuggingFace, and Gab support confirmed
  - Provider-agnostic duplicate prevention maintains consistency
  - Proper error handling for provider-specific API differences

### Technical Implementation
- **Crypto Integration**: Added ES6 crypto module import for fingerprint generation
- **Enhanced Git Plugin**: New GitHub API search functionality with comprehensive error handling
- **Testing Framework**: Created comprehensive test suite for duplicate prevention validation
- **Bug Pattern Enhancement**: Updated all 8 bug patterns to include fingerprint generation
- **Code Quality**: Clean ES6 module implementation with proper async/await patterns

## [2.5.9] - 2025-12-23

### Fixed - HuggingFace Provider Complete Overhaul
- **Direct API Integration**: Replaced broken @huggingface/inference library with direct REST API calls
  - Fixed "api-inference.huggingface.co is no longer supported" error that was causing all HuggingFace requests to fail
  - Implemented direct `fetch()` calls to `router.huggingface.co/v1/chat/completions` endpoint
  - Added proper error handling and response parsing for HuggingFace API responses
  - Eliminated dependency on unreliable third-party inference library
- **Model Enhancement**: Added support for Qwen/Qwen3-Coder-480B-A35B-Instruct with auto-select provider routing
  - Updated default chat model from meta-llama/Llama-3.2-1B-Instruct to Qwen/Qwen3-Coder-480B-A35B-Instruct
  - Configured model to use HuggingFace's auto-select provider routing for optimal performance
  - Added model to available models list for web UI selection
- **Usage Tracking Fix**: Properly implemented metrics collection and cost estimation
  - Fixed broken `updateMetrics()` calls that were preventing usage tracking
  - Added proper token counting for prompt_tokens, completion_tokens, and total_tokens
  - Implemented fallback token estimation when API doesn't provide usage data
  - Cost calculation now works correctly for HuggingFace requests
- **Production Verification**: Tested and confirmed working on production server
  - Deployed fix via deployment scripts and verified with live production logs
  - Confirmed successful API responses with ~2 second response times
  - Eliminated fallback to OpenAI - HuggingFace now works as primary provider
  - No more error logs related to HuggingFace API failures

### Enhanced - Weekly Report System
- **Comprehensive Activity Data**: Enhanced weekly reports with meaningful system insights
  - Replaced basic uptime/memory stats with detailed activity analysis
  - Added email statistics (received, sent, auto-replies, processing rate)
  - Added AI activity metrics (conversations, new memories, most active interface)
  - Added error tracking and maintenance summaries
  - Added performance metrics (peak memory, response times, job success rates)
- **Configurable Report Frequency**: Added web UI settings for report scheduling
  - Report frequency configurable from 1 day to X months via web interface
  - Default remains weekly but users can customize based on needs
  - Reports always cover events since the last report regardless of frequency
  - Added next report time display and real-time status updates

### Fixed - Web Interface Issues
- **Settings Tab Checkboxes**: Resolved broken checkbox visibility
  - Fixed overly broad CSS rule that was hiding ALL checkboxes
  - Made `display: none` rule specific to toggle switches only
  - Added proper styling for regular checkboxes with accent colors
  - All settings page checkboxes now visible and functional

## [2.5.8] - 2025-12-22

### Fixed - Reminder System Cleanup
- **Automatic Reminder Cleanup**: Implemented automated cleanup of completed reminder jobs
  - Added `cleanup-old-reminders` job that removes completed/failed reminder jobs older than 10 minutes
  - Fixed scheduled jobs list cluttered with old completed reminder jobs
  - Cleanup runs daily at 4 AM UTC and immediately on system startup
  - Successfully reduced scheduled jobs count by removing 6 old reminder jobs
- **Improved Job Management**: Enhanced reminder job lifecycle management
  - Reminder jobs are now properly removed after completion instead of remaining scheduled
  - Fixed issue where completed reminder jobs were still showing in scheduled jobs list
  - Better memory management by cleaning up obsolete background jobs

## [2.5.7] - 2025-12-21

### Added - Comprehensive Testing & Final Persistence Fixes
- **Complete End-to-End Testing**: Comprehensive validation of all autonomous services
  - **Self-Modification Service**: Verified real code analysis, improvement detection, and safety mechanisms
  - **Bug Fixing Service**: Confirmed GitHub API integration and real issue processing
  - **Plugin Development Service**: Validated web search integration and API discovery
  - All services confirmed working with real data, not placeholders
  - Created detailed testing log documenting all validation results
- **Network Security Settings Persistence**: Final settings persistence issue resolved
  - Added database persistence to NetworkPlugin with `loadConfig()` and `saveConfig()` methods
  - Settings now persist across service restarts: monitoring enabled/disabled, scan intervals, alert preferences
  - All web UI settings now have proper persistence across the entire application

### Fixed - Complete Settings Persistence
- **Network Plugin Configuration**: Network security monitoring settings now save to database
  - Updated `setConfig()` method to actually persist data instead of returning mock success
  - Added proper configuration loading on plugin initialization
  - Fixed all network configuration persistence issues identified in web UI audit

### Enhanced - Testing & Validation
- **Production Readiness**: All autonomous services validated working end-to-end with real data
- **Documentation**: Updated comprehensive testing results in TESTING_LOG.md
- **User Feedback Integration**: Added note about self-modification service skepticism for future validation

## [2.5.6] - 2025-12-21

### Fixed - Web UI Settings Persistence  
- **Auto-Refresh Setting Persistence**: Fixed auto-refresh checkbox to persist across browser sessions
- **Service Configuration Persistence**: Fixed multiple services that weren't saving settings to database
  - **Self-Modification Service**: Added `loadConfig()`, `saveConfig()`, and `initialize()` methods
  - **Bug Fixing Service**: Added `loadConfig()`, `saveConfig()`, and `initialize()` methods
- **Web UI Settings Audit**: Comprehensive audit completed across all web interface settings

## [2.5.5] - 2025-12-21

### Added - Voice Output Extension
- **Extended Voice Length Support**: Removed artificial character limitations for longer voice messages
  - Eliminated 1000-character limit in TelegramDashboard voice responses  
  - Added intelligent text chunking for messages exceeding OpenAI TTS API limits (>4096 characters)
  - Implemented smart sentence boundary splitting to preserve natural speech flow
  - Added seamless audio buffer concatenation for unified voice delivery
- **Enhanced TTS Service**: Comprehensive chunking system for unlimited message length
  - `generateSpeechChunked()` method with boundary-aware text splitting
  - `splitTextIntoChunks()` function respects sentence and paragraph boundaries
  - `concatenateAudioBuffers()` method for seamless MP3 audio joining
  - Cost tracking aggregated across all chunks for accurate usage analytics

### Fixed
- **Telegram Voice Issues**: Resolved variable reference errors in caption generation
  - Fixed `voiceText` undefined variable references in telegram.js and telegramDashboard.js
  - Updated all caption generation logic to use correct content variables
  - Ensured consistent voice processing across both Telegram interfaces
- **Performance Optimization**: Smart chunking only activates when necessary
  - No performance impact for messages under 4096 characters
  - Maintains backwards compatibility with existing voice functionality

### Enhanced
- **Voice User Experience**: Users now receive complete audio for responses of any practical length
  - Voice messages no longer cut off at approximately 2 minutes
  - Maintains natural speech flow through intelligent boundary detection
  - Maximizes OpenAI TTS API capabilities with cost-efficient processing

## [2.5.4] - 2025-12-21

### Added - Feature Request Management System
- **Feature Request Web UI**: Complete web interface for submitting and managing feature requests
  - Comprehensive form with title, description, category, priority, use case, and implementation fields
  - Support for core functions, plugin enhancements, new plugins, UI improvements, API changes
  - Related plugin selection with all 21+ active plugins listed
- **Database Integration**: Full CRUD operations with MongoDB persistence
  - FeatureRequest model with comprehensive schema and validation
  - Status tracking (submitted, analyzing, planned, in-progress, completed, rejected)
  - Priority levels (critical, high, medium, low) with color-coded badges
  - Voting system for community feedback
- **Self-Modification Integration**: Auto-generation of feature requests from code analysis
  - Automatic creation of feature requests from identified improvements
  - Integration with existing self-modification service workflow
  - Categorization of improvements (core, plugin, performance, security, other)
  - Plugin detection from file paths for targeted improvements

### Enhanced
- **API Endpoints**: Complete REST API for feature request management
  - GET /api/feature-requests (with filtering by category, priority, status)
  - POST /api/feature-requests (create new requests)
  - PUT /api/feature-requests/:id/status (update status)
  - DELETE /api/feature-requests/:id (remove requests)
  - POST /api/feature-requests/:id/vote (voting system)
  - POST /api/feature-requests/analyze (trigger analysis)
  - GET /api/feature-requests/stats (statistics and metrics)
- **Web Interface**: New "Feature Requests" tab with professional styling
  - Real-time filtering and sorting capabilities
  - Auto-generated vs user-submitted request separation
  - Approval/rejection workflow for auto-generated improvements
  - Mobile-responsive design with dark theme consistency

### Technical Implementation
- Database model with comprehensive indexing for efficient querying
- Integration with existing authentication and authorization system
- Event-driven architecture with proper error handling and logging
- Automatic duplicate detection and prevention
- Integration with upgrade planning system for seamless workflow
- Support for both manual user requests and automated system suggestions

## [2.5.3] - 2025-12-21

### Added - Phase 3 Code Quality & Documentation Improvements
- **JSDoc Documentation**: Added comprehensive documentation to all key system files
  - Application startup and configuration (`src/index.js`)
  - Authentication system (`src/interfaces/web/auth.js`)
  - Database utilities (`src/utils/database.js`)
  - API testing endpoints (`src/interfaces/web/testingRoutes.js`)
  - Plugin base class with all methods (`src/api/core/basePlugin.js`)
- **System Prompts**: Updated to include new capabilities (email compose/reply, task management, JSDoc documentation, plugin architecture)
- **Feature Progress**: Updated milestone to reflect Phase 3 completion and current system status

### Enhanced
- **Plugin Architecture**: BasePlugin class now includes comprehensive JSDoc documentation with examples
  - All methods documented with parameter types, return values, and usage examples
  - Event emission documentation for config and state changes
  - Detailed validation schema documentation with examples
- **Developer Experience**: Improved code maintainability with detailed function documentation
- **Code Quality**: Standardized documentation format across all core system components

### Technical Improvements
- Enhanced BasePlugin validation system with comprehensive parameter schema documentation
- Added detailed authentication flow documentation with JWT examples
- Documented database connection patterns and error handling approaches
- Comprehensive API testing infrastructure documentation with endpoint examples
- Updated UPGRADE_PLAN.md to reflect completion of Phase 3 medium priority improvements

## [2.5.2] - 2025-12-21

### Fixed - Critical System Optimization & Bug Fixes
- **Job Scheduler**: Fixed critical counting logic issue where completed jobs showed as 0 (scheduler.js:645)
  - Enhanced job categorization for running, scheduled, completed, and failed states
  - Improved timestamp-based status determination logic
- **Network Security Monitoring**: Complete web interface functionality restoration
  - Added device discovery and tracking with real-time status monitoring
  - Enhanced network plugin with lastScanDevices tracking and proper API methods
  - Fixed loading issues on Network Security page with proper data structures
- **Samba/CIFS Management**: Complete mount management system implementation
  - Added comprehensive mount configuration storage and lifecycle management
  - Implemented createMount, updateMount, deleteMount, testMount, mountAll, unmountAll methods
  - Fixed "CIFS Utils: Checking..." loading issue with proper status reporting
- **Bug Detection System**: Verified and enhanced automated bug detection and fixing
  - Confirmed comprehensive bug detection with 8+ pattern types
  - Validated GitHub integration and automated issue creation workflow
  - Enhanced bug fixing service with AI-powered analysis and PR creation

### Enhanced
- **System Prompts**: Updated to reflect all 21+ active plugins and current capabilities
  - Added Network Security, VPN, Firewall, SSH, Samba/CIFS, Bug Detection, Dev Environment
  - Enhanced special features section with new security and automation capabilities
- **Plugin Settings Management**: Added comprehensive settings system to Network plugin
  - Implemented getSettings() and updateSettings() with validation
  - Added configurable scan intervals, monitoring options, and alert preferences

### Technical Improvements
- Enhanced VPN plugin with proper method aliases for web interface compatibility
- Fixed all web interface loading states (Network Security, Samba pages now fully functional)
- Improved job status API with accurate categorization based on job attributes
- Added device tracking to Network plugin with mount point status synchronization
- Enhanced Samba plugin with configuration persistence and actual mount status checking

## [2.5.1] - 2025-12-21

### Fixed - Bug Fixes & Plugin Improvements
- **Firewall Management**: Fixed rule parsing to exclude invalid entries (New profiles, Skip messages)
- **VPN Plugin**: Added missing getCommands() method for proper API integration
- **Development Environment**: Complete API plugin implementation with project lifecycle management
  - Project creation from templates (React, Node.js, Python/Flask)
  - Development server management with port allocation
  - Environment variables management and testing automation
  - Git integration with repository initialization and commit tracking
  - Template system with pre-configured project scaffolding

### Technical Improvements
- Enhanced firewall status parsing with better filtering logic
- Fixed VPN plugin method binding and execution flow
- Added comprehensive development environment automation capabilities
- Improved error handling across all web interface components

## [2.5.0] - 2025-12-21

### Added - Web UI Management Suite
- **VPN Management Web Interface**: Complete ExpressVPN control through web dashboard
  - Real-time VPN status monitoring with visual indicators
  - Location selection and smart connect functionality
  - Connection testing and public IP display
  - Auto-connect configuration management
- **Firewall Rule Management**: Complete UFW integration with web interface
  - Enable/disable firewall with safety confirmations
  - Add/delete allow/deny rules through web UI
  - Quick preset configurations (Web, SSH, Mail, DNS, FTP, Gaming)
  - Live rules display with color-coded actions
  - Logging level configuration and management
- **Enhanced Dashboard Auto-Refresh**: 30-second auto-refresh with visual countdown
  - Animated countdown timer with pulse animation
  - Tab-specific refresh logic for VPN and firewall tabs
  - Performance-optimized data fetching and UI updates

### Technical Improvements
- New API routes in `/src/interfaces/web/vpn.js` and `/src/interfaces/web/firewall.js`
- Enhanced JavaScript functionality in `app.js` with 200+ new lines
- Responsive CSS styling with mobile-friendly design
- Comprehensive error handling and user feedback systems
- Auto-refresh integration for real-time updates

## [2.4.3] - 2025-12-20

### Added - Voice Integration & Plugin Chaining
- **Voice & TTS Integration**: Professional voice response system
  - Complete system overhaul with fixed audio serving and ES modules
  - Web interface with functional voice testing and mobile-responsive UI
  - Telegram integration with text + voice messages
  - Two-tier control system for voice responses
  - OpenAI Text-to-Speech with 13+ voice options
  - Smart cost tracking and multiple TTS models
- **Plugin Chaining System**: Multi-step task execution
  - AI-powered task analysis for sequential plugin operations
  - Support for up to 5 sequential steps with data passing
  - Examples: Download and convert workflows

### Fixed - Voice System Overhaul
- **Major Issues Resolved:**
  - Fixed audio file serving in web interface (ES modules import conflict)
  - Resolved TTS service provider manager errors
  - Fixed web interface port conflicts (changed default from 80 to 3000)
  - **Critical Fix**: Added voice functionality to TelegramDashboard (messages were routed here instead of main TelegramInterface)
- **Voice Features Enhanced:**
  - ✅ **Web Interface Voice Testing**: All voice test buttons now working, audio players functional
  - ✅ **Telegram Voice Responses**: Both text + voice messages sent when enabled
  - ✅ **Voice Settings Control**: Two-tier settings (master enable + Telegram-specific)
  - ✅ **Smart Voice Captions**: Contextual captions like "🎤 ALICE - Greeting" instead of generic "Voice response"
- **Technical Improvements:**
  - Fixed `require` vs `import` conflicts in ES modules
  - Corrected provider manager API calls (`getProvider` → `providers.get`)
  - Added comprehensive voice debugging and error handling
  - Implemented voice cost tracking and usage statistics
- Resolved ES modules conflicts and audio serving issues
- Enhanced error handling for production reliability
- Improved voice system stability and performance

## [2.4.2] - 2025-12-19

### Added - Self-Modification & Bug Detection
- **Enhanced Self-Modification Testing**: Comprehensive validation system
  - Multi-stage validation with syntax, import, and runtime checks
  - Automated rollback on validation failures
  - Safe deployment with backup creation
- **Improved Git Plugin**: Enhanced repository management
  - Better error handling and status reporting
  - Improved commit message generation
- **Background Job Consolidation**: All background jobs now use Agenda scheduler
  - Unified job management and monitoring
  - Better reliability and error tracking

### Fixed
- Email signature formatting issues
- Bug detector default configuration
- UI improvements for better user experience
- Scheduled jobs visibility and management

## [2.4.1] - 2025-12-18

### Added - Development Tools & Automation
- **Plugin Development Service**: Automated plugin discovery and implementation
- **Bug Fixing Service**: Automatic GitHub issue resolution with PR fixes  
- **Enhanced Self-Modification**: Improved code quality analysis and enhancement
- **Advanced Task Management**: Better due date handling and reminder system
- **Email Template System**: Automated backup reports and system alerts

### Technical Improvements
- Enhanced AI provider management and hot-swapping
- Improved plugin architecture and loading system
- Better error handling and logging throughout the system
- Enhanced web interface performance and responsiveness

## [2.4.0] - 2025-12-17

### Added - Production Stability & Advanced Features
- **Production Monitoring**: Comprehensive system health monitoring
- **Advanced Plugin System**: 17 modular plugins with automatic expansion
- **Enhanced Memory Management**: MongoDB-backed conversation history
- **Improved Web Interface**: Better navigation and real-time updates
- **Security Enhancements**: User authorization and command approval systems

### Fixed
- Stability improvements across all core systems
- Enhanced error handling and recovery mechanisms
- Performance optimizations for large-scale deployments

## [2.3.0] - 2025-12-15

### Added - Core System Foundation
- **Multi-AI Provider Support**: OpenAI, Anthropic, Gab, HuggingFace integration
- **Advanced Telegram Interface**: Large message handling and multimedia support
- **Email Integration**: Full Gmail support with background checking
- **Task Management System**: Create, track, and manage tasks with reminders
- **Git Integration**: Repository management with natural language commands
- **Web Interface**: Comprehensive dashboard for system management

### Technical Foundation
- Node.js-based architecture with ES modules
- MongoDB integration for persistent storage
- Express.js web framework with WebSocket support
- Comprehensive plugin system architecture
- Security framework with authentication and authorization

## [2.2.0] - 2024-12-18

### Added - Code Self-Examination & Web Dashboard Enhancements
- **Code Self-Examination Features**
  - Four new AI intents (25-28) for code analysis and improvements
  - Intent 25: Examine Own Code - analyze and explain codebase
  - Intent 26: Suggest Improvements - generate enhancement suggestions
  - Intent 27: List Planned Improvements - show upgrade queue
  - Intent 28: Consider Feature Implementation - evaluate feasibility
  - Integration with self-modification service
  - Secure file searches with 3-file analysis limit

- **Web Dashboard Fixes**
  - Fixed missing sidebar menu with proper display and layout
  - Resolved sidebar layout problems with fixed 250px width
  - Fixed main content width using full available space
  - Added green connection status indicator with proper styling
  - Removed dark mode toggle (dark mode now mandatory)
  - Fixed WebSocket authentication using correct `verifyToken`
  - Added mobile-responsive hamburger menu with overlay

### Technical Improvements
- New agent methods: `examineCode()`, `suggestImprovements()`, `listPlannedImprovements()`, `considerFeature()`
- Enhanced parameter extraction for code topics and feature suggestions
- Fixed ES modules conflicts and authentication issues
- Improved mobile-first responsive design

## [2.1.0] - 2024-12-19

### Added - Media Processing & Project Management
- **Media Processing Capabilities**
  - FFmpeg plugin for comprehensive video/audio processing
    - Convert between formats (MP4, AVI, MKV, MP3, WAV, etc.)
    - Compress media with quality presets
    - Extract audio/video/frames from media files
    - Trim and concatenate videos
    - Generate thumbnails and animated GIFs
    - Add watermarks to videos
  - YT-DLP plugin for media downloading
    - Download from YouTube and 1000+ supported sites
    - Search videos and list available formats
    - Download entire playlists with progress tracking
    - Audio-only downloads with metadata embedding
    - Thumbnail extraction
  - Installation script for media tools deployment

- **Projects Management System**
  - Full CRUD operations for project tracking
  - Integration with task management system
  - Web UI with comprehensive project dashboard
  - Status tracking (planning, active, on-hold, completed)
  - Project types and metadata support
  - Persistent storage in MongoDB

- **Raw Logs Viewer**
  - View PM2 stdout/stderr logs in web interface
  - Search and filter functionality with real-time updates
  - File size and path information display
  - Graceful handling of large log files

### Fixed
- Telegram responses showing [object] for system/network commands
  - Proper extraction and formatting of plugin response objects
  - Better handling of success/error states
  - Improved formatting for complex API responses

### Changed
- Updated system prompt to include media processing capabilities
- Enhanced plugin response formatting in agent.js

## [2.0.5] - 2025-12-19

### Added
- **Contact Management**: Add and manage email contacts without sending emails - "add contact john@example.com"
- **Claude Web Search**: Anthropic provider now supports real-time web search using Claude's native web_search tool
- **Email Management Tab**: Web dashboard now shows all sent/received emails with processing status
- **AI Usage Tracking**: Fixed metrics collection for Anthropic and HuggingFace providers
- **Model Selection UI**: All AI providers now have model selectors with latest options and pricing
- **Provider Comparison Chart**: Overall AI usage visualization comparing all providers
- **Email Auto-Reply System**: MongoDB persistence for all emails with web UI management

### Fixed
- **Provider Switching**: Fixed issue where AI provider switching wasn't persisting correctly
- **Model Persistence**: Selected AI models now properly save and persist across restarts

### Enhanced
- **Web Scraping**: Full webpage analysis with Puppeteer/Cheerio, screenshots, PDF generation
- **Image Recognition**: AI-powered image analysis using OpenAI Vision API
- **URL Detection**: Automatic URL extraction and content analysis from messages
- **CPU Temperature Monitoring**: Real-time temperature tracking with alerts (displays °C/°F)
- **Analysis-Only Mode**: Self-modification can now analyze without making changes
- **Operation Logging**: Comprehensive audit trail for all plugin actions and commands
- **Enhanced Log Filtering**: Web dashboard logs now filterable by type
- **Telegram Web Link**: Quick access to web dashboard from Telegram bot

## [2.0.4] - 2025-12-18

### Updated
- **Web Dashboard**: Fully functional at http://localhost:3000 with complete agent info, memory, and upgrade planning
- **Telegram Bot**: Enhanced dashboard with correct token, all commands working
- **Core Agent**: Running stable (ALICE) with all plugins loaded
- **All Interfaces**: Web (80), Telegram, SSH (2222) all operational
- **Real-time Monitoring**: CPU (0%), Memory (5%), Disk (3%), system uptime (19h+)
- **MongoDB**: Connected and operational
- **AI Providers**: 5 providers loaded and functional
- **Authentication**: Web login working, WebSocket real-time updates active

### Status
- ✅ FULLY OPERATIONAL (100% Complete)

## [2.0.0] - 2024-12-18

### Added - Foundation & Task Management
- **Web Dashboard UI Improvements**
  - Fixed logout button positioning - now stacks properly below connection status
  - Added green pulsing connection indicator for visual feedback
  - Implemented collapsible hamburger menu with mobile-responsive sidebar
  - Added overlay for mobile menu interaction

- **Comprehensive Task Management**
  - Task system with priorities and due dates
  - Recurring tasks with customizable patterns
  - Background reminder processor with MongoDB persistence
  - Task dependencies and progress tracking

- **Software Management System**
  - Multi-package manager support (apt, snap, npm, pip, cargo, gem)
  - Install/uninstall/update operations with progress tracking
  - Compile from source capability
  - Special installation routines for complex software

### Fixed
- Web dashboard responsive layout issues
- Mobile navigation experience improvements
- UI element positioning and overflow problems

### Changed
- Dark mode is now mandatory (removed toggle option)
- Improved mobile-first responsive design approach

---

## Legend
- **Added**: New features
- **Fixed**: Bug fixes
- **Changed**: Changes in existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Security**: Security-related changes