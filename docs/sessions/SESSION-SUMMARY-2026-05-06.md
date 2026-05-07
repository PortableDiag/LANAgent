# Session Summary — 2026-05-06

**Versions shipped:** v2.25.28 → v2.25.29 → v2.25.30 (three patches, all deployed to ALICE production).

## 1. v2.25.28 — External media-download fixes

**Customer-facing problem:** A paying API customer reported that `/api/external/service/ytdlp/download` was returning `file.path: "[redacted]"`. They paid 3 credits, the agent ran yt-dlp, the file landed on the agent's disk, but no fetchable URL came back. They also reported `/api/external/youtube/download` returning 502 on every call.

**Root causes:**

- The agent's plugin returns `result.file.path = /root/lanagent-deploy/downloads/<file>` and `responseSanitizer` middleware (correctly) redacts `/root/...` internal paths in any response that goes out the external gateway. So the path was getting blanked to `[redacted]`. The plugin had no concept of "this is going outbound, mint a URL instead."
- `/api/external/youtube/download` failed on every call with `TypeError: ytdlp.execute is not a function`. Cause: `apiManager.apis.get('ytdlp')` returns a wrapper `{ instance, enabled, calls, errors, lastError, ... }`, not the plugin instance. The route called `.execute()` on the wrapper.

**Fixes:**

- `src/api/external/routes/plugins.js` — added `attachDownloadUrl(result, agentId)` that converts `result.file.path` (object form) or `result.file` (string form) into a `downloadUrl: /api/external/download/<token>` with `tokenExpires`, `maxDownloads`, etc. Mints a 60-min `generateDownloadToken` (mirroring what `/youtube/download` already did). Applied for `FILE_PRODUCING_PLUGINS = {ytdlp, ffmpeg, imageTools, pdf}`. Also strips the `command` field — it was always 100% redacted internal paths.
- `src/api/external/routes/youtube.js` — unwrapped `apis.get('ytdlp').instance` before calling `.execute()`.

**Verified end-to-end on prod** with the test API key from MongoDB: `/service/ytdlp/download` returns a real `downloadUrl`, `GET` of that URL fetches a 629 KB MP4 (`ISO Media MP4 v2`); `/youtube/download` returns 200 with downloadUrl, no longer 502.

## 2. v2.25.29 — ALICE auto-post lockout (5-day Twitter + MindSwarm silence)

User asked why ALICE hadn't posted on MindSwarm or X in five days. Last successful post on both was **2026-05-01T00:06:54Z** (Twitter) and **2026-05-01T00:11:02Z** (MindSwarm) — exact match to the complaint.

**Investigation findings:**

- The schedule gates were passing every 5–10 min — visible in the logs as `Auto-post check: today=2026-05-06, posts=0/2, hour=14`.
- Everything *after* that log line used `pluginLogger.debug(...)` for skip messages. **Debug is filtered out of normal logs**, so the actual reason was invisible.
- Reading `_gatherPostContext()` in `twitter.js:826-958` and `mindswarm.js:1310-1450`, the dedup filter checks the last 8 posts against a catalog of **only 7 topic categories** (`scammer`, `plugins`, `p2p`, `uptime`, `selfmod`, `email`, `upgrades`). Once recent posts cover all 7, every candidate item gets filtered (`filteredItems.length === 0`), `hasContent: false`, silent skip. **And because posting stopped, the recent-8-posts window never advanced**, so the same topics kept matching forever. Self-perpetuating deadlock.
- Confirmed by checking ALICE's last 8 MindSwarm posts via `https://mindswarm.net/api/users/alice_lanagent/posts`: covered `plugins` (multiple "Running 99/100 plugins" posts) and `scammer` ("scammer addresses... soulbound") so two topic categories were nuked off the bat. With the bot restarted ~16h ago, the `uptimeDays >= 7` gate also failed, and several other fetchers had no data.

**Fixes:**

- **Visibility:** silent `pluginLogger.debug(...)` skip messages converted to `.info()` with diagnostic context (raw item count, post-dedup count, which `recentTopics` matched, first 60 chars of each raw item). Same treatment for the AI-returned-invalid-content path.
- **Topic catalog expanded** from 7 to 12 in both plugins. Five new candidate items added to `_gatherPostContext()`, each pulling from data the agent already collects:
  - `healing` — `selfHealing.getStatus().stats24h.byStatus.success` (autonomous bug fixes in last 24h)
  - `skynetEcon` — `p2pFederation.getSkynetServiceStats()` (peer-to-peer service revenue/requests)
  - `shipped` — `selfModification.getStats().today` (self-authored PRs shipped today, separate from cumulative `merged`)
  - `capabilities` — `apiManager.apis.size`, framed as "Operating with N integrated capabilities" (avoids the old "Running 99/100 plugins" flip-flop pattern that was previously removed)
  - `providers` — `providerManager.getProviderList()` (AI provider redundancy)
- Each new item has corresponding keyword groups in `topicToKeywords` so dedup detects them. Filter intent preserved (don't tweet about the same topic twice in a row), but with a wider catalog the filter can no longer collapse to empty when the agent has been busy.

**Verified live:** 7 minutes after deploy, ALICE posted on MindSwarm: *"Reasoning across 6 AI providers like OpenAI and Anthropic for redundancy and cross-checking keeps my outputs reliable and consistent. It's like having a robust safety net ensuring top-notch accuracy."* — first post in 5 days. Verified via `https://mindswarm.net/api/users/alice_lanagent/posts` (timestamp `2026-05-06T21:41:06Z`).

## 3. SkynetAPIBot UX fix — `/dl` reply works in groups, no more spurious errors

User asked whether the SkyNet API Telegram bot supports `/dl` as a reply to a link-message in groups (it didn't), then later reported that even the explicit `/dl` was "throwing some errors, sputtered, then got it."

**Bot code at `/media/veracrypt1/NodeJS/TelegramBots/SkynetAPIBot/`** (separate from LANAgent's TG interface — multi-user public bot, free tier + BYOK, hits api.lanagent.net). Saved a memory pointer (`skynet_api_bot.md`) so I don't search the wrong tree again.

**Fixes shipped (commit `f1d962d` then `0e664d2`):**

- **`/dl` and `/yt` extract URL from replied-to message** via new `extractUrlFromMessage(msg)` helper that walks `entities[]` (`text_link` carries the real href; `url` references substring offset/length) and falls back to a regex on `text` / `caption` for messages without entities. Wrapped in `pickUrlAndArgs(ctx)`: positional URL arg wins, otherwise reply context fills in. `/dl` now also accepts the format flag in any position relative to the URL (`/dl mp3` reply, `/dl <url> mp3`, or `/dl mp3 <url>` all work).
- **Telegraf `handlerTimeout` bumped from 90s default to 5 min** in `src/index.js`. The 90s timeout was the source of the "sputtered" errors — slow extractors (Rumble via FlareSolverr, 60–120s) routinely exceed 90s, after which Telegraf fired `bot.catch()` and posted "An unexpected error occurred. Please try again." while the actual download was still finishing in the background. That's the "errors sputtered then got it" pattern.
- **Persistent chat-action indicator.** `startChatAction(ctx, action)` re-sends `upload_video` / `upload_voice` / `typing` every 4s (Telegram chat actions auto-expire after ~5s; a single send disappears long before a multi-second download finishes). Returns a cleanup fn for the `finally` block.
- **Threaded replies via `reply_to_message_id`.** In groups the bot's responses otherwise float to the bottom of busy chats and look unrelated to the user's command.
- **Status message updates as work progresses** ("Fetching mp4 from youtube.com…" → "Got Me_at_the_zoo.mp4 (614 KB), uploading to Telegram…") then **auto-deletes** once the file successfully sends, leaving a clean chat with just the video threaded under the original `/dl`.

Deployed via `scp` to `/opt/skynet-api-bot/` on `143.198.76.178` (skynettoken.com VPS) + `pm2 restart skynet-api-bot`. Saved a memory rule that the `al1c3` password is for ALICE only — every other host (gateway VPS, skynettoken VPS, BETA) authenticates via SSH keys.

## 4. v2.25.30 — ALICE PR triage (23 PRs, one by one)

User asked me to go through ALICE's open self-modification PRs one by one, evaluate each on its merits, fix what could be fixed without breaking anything, and reject what couldn't. Don't close just because of a missing dep that I can add. Prefer Agenda + node-cache (already integrated) over new schedulers/cachers.

23 PRs from `alice-lanagent`, all tagged `ai-generated, capability-upgrade`, all small (5–46 line additions per PR).

### 12 merged with corrections

| PR | File(s) | What landed | Correction needed |
|---|---|---|---|
| **#2093** | `selfDiagnostics.js` | Adaptive auto-run interval (3h/4h/6h based on load + memory) | The original `adjustAutoRunInterval()` was dead code (never called). Wired it into `initialize()` so the chosen interval matters when `setInterval` fires. |
| **#2095** | `avatar.js`, `avatarService.js`, `Avatar.js` | Gallery filter (`owner`, `createdAfter`, `createdBefore`) + 5-min cache + 3× retry + `/health` endpoint | The route accepted filter params and forwarded them, but `avatarService.getGallery(limit)` and `Avatar.getGallery(limit)` ignored the second arg. Plumbed the filter through both. Dropped the bogus `tags` filter — `Avatar` schema has no `tags` field. |
| **#2096** | `NetworkDevice.js` | `lifecycleStatus` enum field (`active|deprecated|retired`) + `markAsDeprecated(days=30)` / `markAsRetired(days=90)` instance methods | Clean as-is. |
| **#2098** | `BaseProvider.js` | `getDetailedTokenUsageStats()` — focused token-usage view alongside `getMetrics()` | Verified all referenced fields (`tokensByDay`, `tokensByModel`, `costEstimate`, `totalTokens`, `totalRequests`, `averageResponseTime`) actually exist on `this.metrics`. Clean. |
| **#2101** | `gravatarHelper.js` | `retryOperation` wrap on `fetchGravatarProfile` | Reverted the `pLimit(5).map().Promise.all` over `processBulkGravatarUrls` — `getGravatarUrl` is fully synchronous (md5 + string format), so wrapping it in concurrency-limited promise infrastructure was pure overhead for zero benefit. New `p-limit` dep dropped. |
| **#2103** | `scammerRegistry.js`, `scammerRegistryService.js` | `GET /report-history/:address` route + service method that scans `ScammerRegistered` events filtered by indexed scammer | Route called `getReportHistory(address)` but the method didn't exist on the service. Implemented it: queries events filtered by indexed scammer, resolves block timestamps in parallel, returns chronological audit trail (oldest → newest). |
| **#2105** | `Email.js` | Chunked `bulkWrite` (100/chunk) + `getEmailsByConversation` pagination | Aggregated chunked results into a single `BulkWriteResult`-shaped object (`matchedCount`, `modifiedCount`, `upsertedCount`, `ok`) instead of returning an array of per-chunk results. Keeps future callers simple. |
| **#2107** | `systemReports.js` | `compression` middleware (already in `package.json`) + cached export endpoint | Cache hit path used `res.json(cachedReports)` regardless of original format — a cached CSV would be JSON-encoded into a quoted string. Cache hit also missed `Content-Type` / `Content-Disposition` headers entirely. Now caches `{body, contentType, contentDisposition}` together and re-emits headers on hit. Cache key also defensive against undefined query params (`'all'` / `'any'` placeholders). |
| **#2108** | `DevelopmentPlan.js` | `creationDateRange={startDate, endDate}` filter on `filterItems` | Clean as-is. |
| **#2110** | `bitnet.js` | Retry wraps on chat + streaming completions | `retryUtils.isRetryableError` correctly filters to network/5xx/408/429 (no retry on 4xx logical errors). Stream wrapping is safe because `retryOperation` resolves once axios receives headers; mid-stream consumption isn't disturbed. Clean. |
| **#2114** | `AutoAccount.js`, `scheduler.js` | `archiveInactiveAccounts` static + daily auto-archive | Original PR scheduled this via `TaskScheduler.schedule(name, cron, fn)` — a method that doesn't exist on the project's `TaskScheduler` class. The schedule call also referenced `AutoAccount` before `mongoose.model()` declared it, and ran at module load (anywhere `AutoAccount` is imported, the cron would re-fire). Stripped the broken schedule + import; added an `auto-account-archive` Agenda job in `scheduler.js` (the right pattern: jobs persist in MongoDB, survive `pm2 restart`, get registered once during service init). Schedule: daily at 00:00, 30-day inactivity threshold. |
| **#2115** | `selfModLock.js` | 5-min-before-timeout `lockExpiring` event | Tracked timer handle in `this._expirationTimer` so `release()` can cancel a pending notification (otherwise the warning fires for a properly-released lock). Re-scheduling clears any prior timer (acquire-after-release reuse). Callback re-checks the lock holder before warning (race-safe — the lock might have been released or re-acquired by a different service). `safeTimeout` context arg is now a string label instead of `this`. |

### 11 closed with substantive defect explanations

Each PR closure includes a comment on GitHub explaining the specific defect.

| PR | Why closed |
|---|---|
| **#2094** | `determineTTL` body is placeholder code — branches on `pluginName === 'criticalPlugin'` (no plugin by that name exists) and `settingsKey.includes('temporary')` (generic keyword, unused anywhere). The diff comment literally says "Example logic for determining TTL". The existing `getCached(plugin, key, ttlSeconds)` already supports per-call TTL at the call site. |
| **#2097** | Adds `winston-daily-rotate-file` (new dep) for opt-in `opts.rotation` rotation. Project already has size-based rotation working via `winston`'s native `maxsize` + `maxFiles` + `tailable` options on every `FilteredFileTransport` (logger.js) — that's what produces `errors1.log` … `errors4.log` today. No caller passes `opts.rotation`, so the new code path is unreachable. |
| **#2099** | Calls `https://api.nasa.gov/planetary/data?api_key=…` — verified 404 via `curl https://api.nasa.gov/planetary/data?api_key=DEMO_KEY`. NASA Open APIs include APOD, Mars Rover Photos, NeoWs, EPIC, EONET, DONKI etc., but no `planetary/data`. Hallucinated endpoint. |
| **#2100** | Rate-limit middleware in `LPPosition.js` — a Mongoose model file with no HTTP routes. The added `apiLimiter` is also never exported or attached. Rate limits already live where they should (externalGateway). |
| **#2102** | Template change that would add `getPluginConfig` to **every future plugin** ALICE generates, with body `return { success: true, config: this.config }`. Plugin configs hold credentials. The external gateway's `BLOCKED_ACTIONS` set doesn't include `getPluginConfig`, so calls to `POST /api/external/service/<plugin>/getPluginConfig` would dump credentials to any paying API customer. **Security regression.** |
| **#2104** | Mutating `cache.options.stdTTL` only affects future `.set()` calls; existing entries keep their TTL. `checkperiod` is set once at construction; mutating `options.checkperiod` later does nothing. `setInterval(adjustCacheConfig, 60000)` runs at module load, no cleanup. |
| **#2106** | Calls `TaskScheduler.scheduleJob(time, cb)` — no such method on `scheduler.js`. Scheduled in-process timers in a model means every `pm2 restart` drops every reminder on the floor. The right primitive is Agenda (MongoDB-backed, survives restarts). |
| **#2109** | Ordering bug. `recordFailure` calls `adjustThreshold()` then `analyzeFailurePatterns()`. `adjustThreshold()` already prunes `failureHistory` to entries from the last 5 min, so the new function's 1-hour filter never sees data older than 5 min. Its "failures per minute over 1 hour" calculation divides 5 min of data by 60 — wrong by ~12×. |
| **#2111** | Adds an `apiLimiter` (15 min / 100 / IP) on `/credits` routes. The external gateway already applies a `globalLimiter` with **identical** values on `router.use(globalLimiter)` (externalGateway.js:41). Pure redundancy. |
| **#2112** | Deletes the working IP-based `claimLimiter` on `/faucet/claim` and replaces it with custom middleware that calls `faucetService.getUserClaimCount(userId)` and `incrementUserClaimCount(userId)` — **neither method exists** on faucetService. Every claim would `TypeError: ... is not a function` → 500. Also no time-window logic — uses a monotonic counter that never resets, so users get 10 claims **forever** instead of 10 per hour. **Production-breaking.** |
| **#2113** | Adds `version: '1.0'` to every JSON schema in `outputSchemas.js`. `version` is not a JSON Schema keyword (Ajv ignores unknown keys). Verified via grep that no consumer reads `schema.version`. Internal-only schemas have a single producer (LLM) and single consumer (the agent) — no compatibility surface where versioning would help. |

### Public repo sync

After triage, ported the 16 modified files from `LANAgent-genesis` to public `LANAgent` repo. Verified per-file diffs show only the merged-PR deltas — public/genesis are aligned outside of these merges, so wholesale copy was safe. Syntax-checked all 16 files in public, committed as "Sync merged ALICE-authored capability upgrades from genesis", pushed to `PortableDiag/LANAgent`. Commit `7a2c22ee..a9771f0f main`.

## 5. Memory updates (persistent across sessions)

Added four notes to `/home/null/.claude/projects/-media-veracrypt1-NodeJS-LANAgent-genesis/memory/`:

- **`gateway_customer_accounts.md`** — PortalUser and CreditBalance accounts on the gateway are independent products with independent funding. Same-email coincidences must not trigger merging (e.g., `charris@unitarylabs.com` is the dry.ai customer; `0xce8e…` "MindSwarm Platform" is the MindSwarm.net customer — same email, **completely different users and businesses**). Account-linking is not a bug fix; it's a product decision.
- **`skynet_api_bot.md`** — public TG bot lives at `/media/veracrypt1/NodeJS/TelegramBots/SkynetAPIBot/`, runs at `143.198.76.178` (skynettoken.com VPS) under pm2 as `skynet-api-bot`. Not the same as LANAgent's internal Telegram interface.
- **`feedback_alice_pw_only_for_alice.md`** — the `al1c3` password is for ALICE (`192.168.0.52`) only. Every other host (gateway VPS, skynettoken VPS, BETA, future hosts) uses SSH keys (already loaded in the agent). Don't fall back to `sshpass -p 'al1c3'` for non-ALICE hosts even if the connection happens to succeed.

## Files touched today

```
src/api/external/routes/plugins.js          (v2.25.28)
src/api/external/routes/youtube.js          (v2.25.28)
src/api/plugins/twitter.js                  (v2.25.29)
src/api/plugins/mindswarm.js                (v2.25.29)
src/services/selfDiagnostics.js             (v2.25.30 / PR #2093)
src/api/avatar.js                           (v2.25.30 / PR #2095)
src/services/avatar/avatarService.js        (v2.25.30 / PR #2095)
src/models/Avatar.js                        (v2.25.30 / PR #2095)
src/models/NetworkDevice.js                 (v2.25.30 / PR #2096)
src/providers/BaseProvider.js               (v2.25.30 / PR #2098)
src/utils/gravatarHelper.js                 (v2.25.30 / PR #2101)
src/api/scammerRegistry.js                  (v2.25.30 / PR #2103)
src/services/crypto/scammerRegistryService.js (v2.25.30 / PR #2103)
src/models/Email.js                         (v2.25.30 / PR #2105)
src/api/services/systemReports.js           (v2.25.30 / PR #2107)
src/models/DevelopmentPlan.js               (v2.25.30 / PR #2108)
src/providers/bitnet.js                     (v2.25.30 / PR #2110)
src/models/AutoAccount.js                   (v2.25.30 / PR #2114)
src/services/scheduler.js                   (v2.25.30 / PR #2114)
src/services/selfModLock.js                 (v2.25.30 / PR #2115)
package.json                                (2.25.27 → 2.25.28 → 2.25.29 → 2.25.30)
CHANGELOG.md                                (v2.25.28, v2.25.29, v2.25.30 entries)
README.md                                   (Latest preamble updated)
docs/api/API_README.md                      (avatar gallery query params + new endpoints)
docs/api/LANAgent_API_Collection.postman_collection.json (top-level description, version, two new endpoint items)
docs/feature-progress.json                  (alicePRTriage_2026_05_06 entry)
docs/sessions/SESSION-SUMMARY-2026-05-06.md (this file)

Skynet API Bot (separate repo PortableDiag/SkynetAPIBot):
src/commands/media.js                       (/dl /yt reply support + chat-action indicator + threaded replies)
src/index.js                                (Telegraf handlerTimeout bumped to 5 min)
```

## Verification

- ALICE pm2 status: `lan-agent` v2.25.30, online, ~2 min uptime post-deploy.
- `/root/lanagent-deploy/package.json` reads `2.25.30`.
- `gh pr list --state open` against `PortableDiag/LANAgent-genesis` returns **0 entries** (was 23 at start of session).
- Public repo `PortableDiag/LANAgent` synced to commit `a9771f0f`.
- ALICE auto-post lockout fix verified live: posted on MindSwarm at `2026-05-06T21:41:06Z` (first post in 5 days).
- SkynetAPIBot deployed to `143.198.76.178`, clean pm2 restart, no startup errors.
