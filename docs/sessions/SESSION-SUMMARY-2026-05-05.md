# Session Summary — 2026-05-05

Gateway and BETA agent recovery: fixed silently-broken admin login, reconnected the gateway↔BETA pair, made BETA a real fallback in routing, and stood up backup tooling for BETA.

## Triggering symptom

Operator could not receive admin login emails for the gateway admin panel at `api.lanagent.net/admin/login`. SMTP submissions were not landing in their inbox — but mail.lanagent.net's logs showed no outbound attempts from the gateway around the request times.

## What was actually wrong

Three independent issues compounded:

### 1. Gateway admin login form silently dropped the email field

`/opt/api-gateway/index.mjs:621` registered `express.json()` only — no `express.urlencoded()` middleware. The login form at `/admin/login` posts `application/x-www-form-urlencoded` (default for HTML forms), so `req.body` came through as `{}`, `req.body?.email` was `undefined`, and the handler at `admin.mjs:264` fell into the "tarpit + log non-admin refusal" branch. The browser still received `?sent=1` because the response is intentionally identical regardless of whether the address matches (anti-enumeration).

Confirmation: live test of the same endpoint with `Content-Type: application/json` issued the magic link normally; with `application/x-www-form-urlencoded` it logged `[admin] magic link refused (non-admin) email= ip=…`.

**Fix:** add `app.use(express.urlencoded({ extended: true, limit: '1mb' }));` after the JSON parser. Verified post-fix: form-encoded POST with `email=portablediag@protonmail.com` → 302 → `[admin] magic link issued for …` → `[email] sent to=…`.

### 2. Gateway↔BETA paired with an API key that BETA had never seen

The gateway's `gatewayagents.BETA` record held `apiKey: lsk_af05eb64ef239196adbcf83658b2d511`, but BETA's `externalcreditbalances` collection was empty (0 docs). Result: every `GET /api/external/credits/balance` from the gateway returned 401, the `Agent BETA refresh failed: Request failed with status code 401` line spammed the error log, `successCount` stayed at 0, and BETA was never selected for traffic.

Audit log on BETA showed **6,917 calls to `/credits/balance` since 2026-04-11T18:03:22, all 401, none successful — ever**. The pair has been broken since the moment BETA came back up after the April 11 mongo ransomware incident.

The April 11 wipe destroyed `cryptowallets` (along with the original wallet's encrypted seed) and `externalcreditbalances`. BETA auto-generated a fresh wallet `0x40b03c8b9f3738397f66baa32db72f26619d3d07` 18 minutes later, but no one re-paired the gateway; the original API key just kept failing silently for 24 days. The pre-wipe wallet is unrecoverable (no off-host backup of the seed existed).

The "downstream update" tests on April 30 did not cause this — `scripts/deployment/deploy-beta.sh` does `docker system prune -f` (no `--volumes`); the named mongo volume `lanagent_mongodb_data` has been continuously preserved since April 11 17:58.

**Fix:** insert one `externalcreditbalances` doc on BETA pairing the existing wallet with the gateway's existing API key. After the insert: `/credits/balance` returns 200, the 401 spam stops, `lastSeen` updates each refresh cycle.

### 3. BETA had no credits and no agentId

After the auth fix BETA was reachable but had `credits: 0`, so it was filtered out of the funded pool by `pickBestAgent` and never picked for organic traffic. It also had `agentId: null`, so the direct-route endpoint `POST /agents/:agentId/:service` could not target it.

**Fix:** real on-chain bootstrap — the gateway's wallet swapped 0.0080 BNB → 268,770 SKYNET via PancakeSwap V2 then transferred 268,433 SKYNET (= $5 at $0.00001863 each) to BETA's recipient address. Tx `0xca0942a0d5f91d787d8cf3bcb69b0a5a1f48c1857d9854eaf27c73a6427b9ae7`. BETA's `/credits/purchase` endpoint verified the transfer and credited the gateway's account with 503 credits. `gatewayagents.BETA.credits` updated to 503, `agentId` set to 2931.

## Routing change — strict primary/fallback by reputation

The original `pickBestAgent` did weighted-random over funded agents using `Math.max(1, successCount - failCount)` as weight. With ALICE at rep=187 and BETA at rep=0, BETA still had ~0.5% selection probability — enough to cause occasional unexplained failures since BETA lacks several services ALICE provides (web-scraping with tiers, media-transcode, image-generation, etc., and no FlareSolverr for render tier).

Replaced with deterministic primary/fallback: among funded agents, prefer online ones (lastSeen < 10min), then sort by reputation descending and return the top. ALICE always wins when online and funded; BETA only sees traffic when ALICE is offline or out of credits.

Capability gating remains untouched at the DB query level (`getAvailableAgents` filters `services: service`), so render-tier scrapes can never route to BETA in the first place — there's no fallback for render tier if ALICE is down, which is correct (BETA can't actually serve them).

Verified by simulation across `plugin-websearch`, `plugin-news`, `plugin-scraper`, `youtube-download`: ALICE picked when both online; with ALICE simulated offline, BETA picks up.

## Backup tooling

Two layers, since the existing `/root/lanagent-backups/` directory on BETA was empty:

### Server-side cron on BETA
`/root/backup-beta.sh` — `mongodump --gzip --archive` of the BETA database to `/root/lanagent-backups/beta-YYYY-MM-DD.archive.gz`, 14-day retention. Cron `15 3 * * *`. First run produced a 9.0M archive.

Restore: `docker exec -i BETA-mongodb mongorestore --gzip --archive --drop < beta-YYYY-MM-DD.archive.gz`

### Local pull script in genesis repo
`scripts/deployment/backup-beta.sh` — runs from the dev machine and produces a single tar.gz at `/media/veracrypt1/NodeJS/_BackUps_/beta-backup-YYYY-MM-DDTHH-MM-SSZ.tar.gz` containing:
- `beta-mongo.archive.gz` — fresh mongodump (streamed over SSH, no remote temp file)
- `repo/` — `.env`, `docker-compose.yml`, `CLAUDE.local.md`, `ecosystem.config.cjs`, `package.json`, `data/`, `workspace/`, `quarantine/` (excludes `logs/` and `node_modules/`)
- `MANIFEST.txt` — git rev, container statuses, mongo db sizes, full wallet address listing for context

30-day local retention. First run produced a 14M archive. Re-run anytime; safe to invoke while BETA is live.

## Reset PM2 restart counter

`pm2 reset api-gateway` — was at 50 restarts, now 0. Process pid was preserved (no actual restart, just metadata reset). Two real restarts followed when applying the urlencoded fix and the routing change.

## What was investigated but not changed

- **April 11 ransomware** — already known and mitigated per `SESSION-SUMMARY-2026-04-11.md`; the bot wiped an exposed mongo on `0.0.0.0:27017`, the container was removed, and subsequent installs use docker-bridge-only mongo. Verified the current compose binds mongo to the bridge net only — no host port exposure today. Don't pay the ransom; those bots almost never have the data, they wipe-and-bluff.
- **Orphan volume `mongodb_data`** (310M, last write 2026-04-11T17:40) — contains the ransom note (`READ_ME_TO_RECOVER_YOUR_DATA` DB) and two crumbs in `beta` (1 runtime error + 2 audit logs); no recoverable wallet data. Left in place for forensics; can be removed with `docker volume rm mongodb_data` once we've confirmed nothing else needs it.
- **Render-tier fallback gap** — if ALICE goes down, render scrapes have no fallback because BETA lacks FlareSolverr. Adding it to BETA's compose is a separate piece of work; flagged as a known gap.
- **No restore drill** — backups are written but never round-tripped. Worth a one-time `mongorestore` against a throwaway container to confirm the archive actually restores.

## Files touched

### Gateway server (`137.184.2.62:/opt/api-gateway/`, untracked)
- `index.mjs` — added `express.urlencoded`; rewrote `pickBestAgent` for strict primary/fallback by reputation. Backup at `index.mjs.bak.20260505-180409`.

### BETA server (`164.92.79.184`)
- `/root/backup-beta.sh` — new, mongodump + retention.
- `crontab` — `15 3 * * * /root/backup-beta.sh`.

### Database changes (live)
- `BETA-mongodb.BETA.externalcreditbalances` — inserted gateway-paired doc.
- `scrape-gateway.gatewayagents.BETA` — `credits: 0 → 503`, `agentId: null → 2931`, `recipientAddress` populated by next refresh.

### On-chain
- `0xca0942a0d5f91d787d8cf3bcb69b0a5a1f48c1857d9854eaf27c73a6427b9ae7` — gateway → BETA, 268,433 SKYNET, $5.

### Genesis repo (this commit)
- `scripts/deployment/backup-beta.sh` — new, local pull script.
- `CHANGELOG.md`, `package.json`, `docs/feature-progress.json`, `docs/api/LANAgent_API_Collection.postman_collection.json` — version bump to 2.25.21 with this session's notes.
- `docs/sessions/SESSION-SUMMARY-2026-05-05.md` — this report.

## Late addition — admin dashboard responsive overhaul (v2.25.22)

After the v2.25.21 push, operator reported the Recent Payments table on `/admin` was crammed even on desktop and the top nav was unusable on mobile. Diagnosis:

1. **Recent Payments crammed:** the dashboard used `grid-3` (three equal columns) so the 4-column payments table had to fit in ~33% width. With long emails like `portablediag@protonmail.com` (28 chars), the numeric columns got squeezed into a sliver.
2. **Mobile top nav:** 9 nav links + flex-wrap meant the nav wrapped onto 2-3 lines, pushing the user/sign-out controls off the visible area.

### Fix (additive CSS, one button, one grid-class swap)

| Layer | Change |
|---|---|
| `SHARED_STYLE` | Added `.nav-toggle`, `.dash-grid`, `td.email-cell`, three media-query blocks (≤980px, ≤880px, ≤600px) |
| `layout()` HTML | Inserted `<button class="nav-toggle" onclick="toggle 'open' on sibling nav">☰</button>` between brand and topnav |
| `dashboardBody()` HTML | `<div class="grid grid-3">` → `<div class="dash-grid">` for the Payments/Agents/Tickets row |
| `renderPaymentsCompact()` JS | Email cell gains `email-cell` class + `title="<full email>"` tooltip |

Behavior at each breakpoint:

| Breakpoint | Topnav | Dash grid | Tables |
|---|---|---|---|
| Desktop (>980px) | Inline horizontal | 2fr / 1fr / 1fr (Payments wide) | normal |
| Tablet (881–980px) | Inline horizontal | Payments full-width row, Agents+Tickets share row | normal |
| Narrow (601–880px) | Hamburger drawer | as above | `overflow-x: auto` inside cards |
| Phone (≤600px) | Hamburger drawer | All three stacked | `overflow-x: auto`, smaller font |

### Files
- `/opt/api-gateway/admin.mjs` (gateway server, untracked) — backup at `admin.mjs.bak.20260505-183316`. Patched via a one-shot Python script (`/tmp/admin-patch.py`) since the file is too dense for line-edits and the changes touch four well-separated anchors.

### Verified
- `node --check` clean.
- PM2 restart clean.
- `/health` → 200 success.
- `/admin/login` HTML contains the new `nav-toggle` and `topbar` classes (6+ matches).
- Visual verification at narrow breakpoints requires browser inspection — not done remotely.

## Late addition #2 — admin dashboard mobile follow-up (v2.25.23)

After the v2.25.22 push, operator reported two more mobile bugs:

1. The Promotions page (`/admin/promotions`) scrolled horizontally on mobile — even the sticky header had to scroll right with the content.
2. The Scrapes page (`/admin/scrapes`) had Top Services and Top Agents charts side-by-side on phones.

### Diagnosis

Both used inline `grid-template-columns` declarations that completely override the responsive grid rules in `SHARED_STYLE`:

```html
<!-- promotionsBody -->
<div class="grid" style="grid-template-columns: 1fr 360px; gap:16px;">
<!-- scrapesBody -->
<div class="grid" style="grid-template-columns: 1fr 1fr; gap:14px; margin-top:14px;">
```

The `1fr 360px` form layout forced the page minimum-width = (table content) + 360px ≈ 600+ px, which exceeds any phone viewport. The `1fr 1fr` chart layout had no breakpoint at all so the two charts stayed side-by-side regardless of width.

The horizontal scroll was happening because the page content overflowed, not because the header was misbehaving. The header IS already sticky (`position: sticky; top: 0`); it just gets dragged right with everything else when the page is wider than the viewport.

### Fix

Added two new responsive grid classes to `SHARED_STYLE`:

```css
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 880px) { .grid-2 { grid-template-columns: 1fr; } }
.grid-aside { grid-template-columns: 1fr 360px; gap: 16px; }
@media (max-width: 880px) { .grid-aside { grid-template-columns: 1fr; gap: 14px; } }
```

Then swapped the two inline declarations:
- `promotionsBody`: `<div class="grid" style="grid-template-columns: 1fr 360px; gap:16px;">` → `<div class="grid grid-aside">`
- `scrapesBody`: `<div class="grid" style="grid-template-columns: 1fr 1fr; gap:14px; margin-top:14px;">` → `<div class="grid grid-2" style="margin-top:14px;">`

Audit of remaining `grid-template-columns` references confirms no other inline overrides exist; the rest are the named classes (`.grid-3`, `.grid-4`, `.grid-6`, `.kv`, `.dash-grid`, all already responsive) plus the new `.grid-2` / `.grid-aside`.

### Principle

"Always stack on mobile unless they're small." Multi-column layouts in `admin.mjs` should use one of the named responsive grid classes — never inline `grid-template-columns` — so the breakpoint is encoded with the layout intent and the page can't end up wider than the viewport.

## Verification

| Check | Result |
|---|---|
| Form-encoded POST to `/admin/auth/request` | 302 → `?sent=1`, magic link issued, email sent ✓ |
| Gateway → BETA `/credits/balance` with stored API key | 200 `{success:true,credits:503}` ✓ |
| `Agent BETA refresh failed: 401` log spam | stopped — no new lines for 90s+ post-fix ✓ |
| `pickBestAgent` simulation (both online) | ALICE for all services ✓ |
| `pickBestAgent` simulation (ALICE offline) | BETA picks up for services it supports ✓ |
| Capability gating for render tier | BETA absent from candidate list — correct ✓ |
| Server-side backup test run | 9.0M archive at `/root/lanagent-backups/beta-2026-05-05.archive.gz` ✓ |
| Local pull backup test run | 14M archive at `_BackUps_/beta-backup-2026-05-05T17-14-15Z.tar.gz` ✓ |
| Direct route `GET /agents/2931` | returns BETA's identity ✓ |

## Late addition #3 — admin dashboard per-page audit pass (v2.25.24)

After v2.25.23 went out, operator asked to "check the other admin pages for the same issue" — i.e. inline-style mobile-overflow class of bug. Walked every admin body that renders a multi-column or multi-input layout and looked for the same pattern: inline `grid-template-columns`, hardcoded `width:` on inputs, fixed-width tables.

### Findings

| Page | Layout primitive | Status |
|---|---|---|
| Dashboard | `dash-grid` + `grid-6` KPIs | already responsive (v2.25.22) |
| Users / Wallets | `grid-4` KPIs + single-col list | OK |
| User detail / Wallet detail | `grid-4` KPIs + `row-flex` admin actions | **fixed in this release** |
| Agents | single-col card | OK |
| Payments | `grid-3` KPIs + 7-col table | OK (table scrolls inside its card) |
| Subscriptions | 6-col table with embedded progress bars | OK (table scrolls inside its card) |
| Promotions | `grid-aside` | fixed in v2.25.23 |
| Tickets | wide table + `<dialog width=min(720px,90vw)>` with internal `row-flex` | OK (dialog viewport-bound, `row-flex` now wraps) |
| Scrapes | `grid-2` | fixed in v2.25.23 |
| Audit | single-col card + 6-col table | OK (table scrolls inside its card) |

### One offender — `row-flex` admin-actions card

User-detail and Wallet-detail pages have a "Grant credits" card that uses:

```html
<div class="row-flex">
  <label>Amount</label>
  <input type="number" style="width:160px;">
  <input type="text" placeholder="Note" style="flex:1;">
  <button>Grant</button>
</div>
```

`.row-flex` is `display: flex` with no wrap; the inline `width:160px` and `flex:1;` sit at higher specificity than any responsive override, so on phone widths the row spilled out of its card.

### Fix

Added a `@media (max-width: 880px)` rule that wraps the row, gives `<label>` its own line, and forces children to full-width:

```css
@media (max-width: 880px) {
  .row-flex { flex-wrap: wrap; gap: 8px; }
  .row-flex > label { flex-basis: 100%; }
  .row-flex > input,
  .row-flex > select,
  .row-flex > textarea { flex: 1 1 100% !important; width: auto !important; min-width: 0; }
}
```

The `!important` is the only override path since the troublesome widths are inline; rewriting the markup would have touched four templates and the Tickets dialog form. The CSS-only fix is contained to `SHARED_STYLE` and applies everywhere `.row-flex` is used, including the Tickets reply dialog.

### Outcome

No remaining inline `grid-template-columns` declarations anywhere in `admin.mjs`. Every multi-column layout now uses a named responsive grid class (`.grid-2`, `.grid-3`, `.grid-4`, `.grid-6`, `.grid-aside`, `.dash-grid`) or a now-wrapping flex container. Wide data tables stay inside their cards (which are themselves viewport-bound); they scroll within the card on narrow screens, which is the correct behavior for tabular data.

### Operating principle (carried forward)

The dashboard is fully audited as of this release. Future additions to `admin.mjs` should follow the rule: **no inline `grid-template-columns`, no hardcoded input `width:` on flex children — use a named class so the breakpoint is part of the layout primitive, not the consumer.**

---

# v2.25.25 — Render-tier price cut + work-scraper migration to LANAgent

Same-day, second session. Kicked off by a competitive review of our gateway scraping pricing, expanded into migrating the work scraper at `dry-scraperservice.dry.ai` off ScraperAPI, and ended with a render-tier price cut.

## Scope

1. **Pricing audit + competitive analysis.** Compare LANAgent's gateway scraping tier prices against ScraperAPI and ScrapeGraphAI. Confirm that the public site shows base prices with the Launch Special as a separate badge (not a teaser-then-renewal trap).
2. **Companion work-scraper migration.** Replace the work scraper's ScraperAPI fallback (`scrapeWithScraperApi`) with a LANAgent-backed implementation. Also migrate the `/raw-fetch` endpoint to the same shared helper. Single integration point.
3. **Render-tier price cut.** Drop render from 5cr ($0.05) to 3cr ($0.03) to match `full` — eliminate the per-call price gap, keep render semantically distinct.
4. **End-to-end verification** through the live work scraper at `dry-scraperservice.dry.ai`.

## 1. Pricing audit + competitive analysis

Worked through the 2026-05-03 LANAgent-vs-ScraperAPI comparison doc (`/media/veracrypt2/AICodeLogs/2026-05-03-lanagent-vs-scraperapi-comparison.md`). Refreshed it against current external pricing pulled live:

**ScraperAPI (May 2026)** — Hobby $49 (100K credits) / Startup $149 (1M) / Business $299 (3M) / Scaling $475 / Enterprise custom. Their "credits" are not requests — JS render = 10 credits, premium proxies = 10, ultra-premium + JS = 75 credits. So at Hobby tier, ultra-premium + JS = $0.0367/call.

**ScrapeGraphAI** — Free / Starter $17 (10K credits) / Growth $85 (100K) / Pro $425 (750K). Stealth modifier is **+5 credits flat**, so a stealth markdown scrape is 6 credits minimum. At Pro that's $0.0034/call; at Starter $0.0102.

**Apples-to-apples — real-browser scrapes/dollar:**

| Plan | Price | Real-browser scrapes/mo | $/stealth call |
|---|---:|---:|---:|
| **LANAgent Scraper Starter** | **$10** | **100K stealth + 2.5K render** | **$0.0001** |
| **LANAgent Scraper Pro** | **$25** | **500K stealth + 15K render** | **$0.00005** |
| **LANAgent Scraper Business** | **$50** | **2M stealth + 50K render** | **$0.000025** |
| ScraperAPI Hobby | $49 | 10K JS-render | $0.0049 |
| ScraperAPI Startup | $149 | 100K JS-render | $0.00149 |
| ScraperAPI Business | $299 | 300K JS-render | $0.000997 |
| ScrapeGraphAI Starter | $17 | 1,667 stealth | $0.0102 |
| ScrapeGraphAI Growth | $85 | 16,667 stealth | $0.0051 |
| ScrapeGraphAI Pro | $425 | 125K stealth | $0.0034 |

**LANAgent Pro ($25) is 6x cheaper than ScraperAPI Startup ($149) with 5x more capacity.** **LANAgent Business ($50) vs ScraperAPI Business ($299): 6x cheaper, 6.7x more capacity.** Against ScrapeGraphAI: their **Pro at $425/mo gives 125K stealth scrapes — fewer than our Starter at $10/mo (100K)**. **42x price spread for the same capacity.**

Confirmed via `GET /promotion` that the Launch Special (50% off first month, ends 2026-05-11) shows as a separate **"50% off first month"** badge on subscription cards rather than baked into the displayed base price. Prospects see real ongoing prices, not a teaser-and-renewal trap. Discount only materializes at Stripe Checkout via `lanagent_promo_50pct_once` coupon, applied to the first month only.

Surfaced two service-shaped gaps relative to ScrapeGraphAI:

- **Turnkey LLM extraction** — their `Extract` op: URL + schema → structured JSON in one call
- **Recursive crawl** — their `Crawl` op: start URL + depth/limit + optional per-page extract

Wrote a proposal at `docs/proposals/gateway-extract-and-crawl.md` for `/extract` and `/crawl` endpoints. Two-phase: `/extract` ships first (~1–2 days), `/crawl` second (~4–7 days). Both build on existing primitives — `webScraper`, Anthropic SDK, Agenda for async, MongoDB for state.

## 2. Work-scraper migration to LANAgent

The work scraper at `/media/veracrypt2/NodeJS/ScraperService/scraperservice.js` (deployed to `dry-scraperservice.dry.ai` / `45.76.17.222`, version 2.2.39) was using ScraperAPI ultra_premium as its fallback when puppeteer fails. The 2026-05-03 comparison doc found ScraperAPI fails 10/16 on real URLs; LANAgent succeeded on all 16. So: migrate.

### `scrapeWithScraperApi(url)` — main fallback path

**Replaced** the ScraperAPI ultra_premium axios call (lines 5054–5292 of the original) with a `callLANAgentScrape(url, tier)` helper that hits `https://api.lanagent.net/scrape`. Tier strategy is `full → render` escalation:

- First attempt: `tier: 'full'` (3cr) — real Chromium + stealth plugin + VPN auto-rotation + raw HTML
- On failure, escalate to `tier: 'render'` (3cr post-v2.25.25) — adds FlareSolverr for CF JS challenges

Function signature and return shape preserved so all 7 internal call sites (lines 1626, 1655, 1721, 4225, 4351, 4434, 6094 in the original) continued to work without modification. **Original 239-line ScraperAPI implementation preserved verbatim inside a `/* … */` reference block right under the new live function.** Easy rollback path.

Special-case post-processing preserved verbatim: IMDb title cleanup, Axios image override, 4chan header strip, Zillow custom extraction.

Counter increments (`scraperAPIFallbackAttempts/Successes/Fails`) and MongoDB `ScraperAPI` collection PASS/FAIL logging preserved so the `/scraperapi` and `/scraperapifails` admin pages keep working.

### `/raw-fetch` endpoint

Originally had its own self-contained ScraperAPI fallback (separate from `scrapeWithScraperApi` because the two endpoints have different return contracts — raw HTTP envelope `{success, source, status, contentType, html, message}` vs metadata `{title, description, image, html, text, metadata}`). Migrated to the same `callLANAgentScrape` helper for **single-source-of-truth fallback**. Tier mapping preserved the existing `options.ultraPremium` opt-in:

- `ultraPremium: true` → `tier: 'render'` (FlareSolverr)
- otherwise → `tier: 'full'`, escalating to `render` on failure

Original ScraperAPI block preserved as `/* */` reference immediately above the new code, matching the `scrapeWithScraperApi` pattern.

### Bug found and fixed during testing

First deploy of the migrated `scrapeWithScraperApi` returned `success: true` with empty title/description/text/html on every call. Root cause: my code read `scrapeResp.title` as top-level, but LANAgent's `/scrape` actually nests scraped fields under a `data` envelope:

```json
{
  "success": true, "tier": "full", "billing": "credits",
  "creditsCharged": 3, "creditsRemaining": 1947,
  "data": {
    "title": "...", "description": "...", "text": "...", "html": "...",
    "images": [{ "src": "...", "alt": "..." }],
    "links": [...], "ogImage": "https://...",
    "structuredData": [...], "microdata": {...}
  }
}
```

Fixed by reading `scrapeResp.data.*`, mapping `image` to `data.ogImage` (string URL) with fallback to `data.images[0].src` resolved against the page URL via `urlPackage.resolve()` (since `data.images[]` is an array of `{src, alt}` objects with potentially relative paths). Redeployed; verified end-to-end with three real URLs (HN, Reddit RSS, investing.com) that all returned populated fields.

### Live production hit logged

After the work-scraper redeploy, the first natural fallback in production fired against `https://www.foxnews.com/politics/rfk-jr-...`:

```
[orange]  Attempting fallback using ScraperAPI                    ← legacy log line (function name unchanged)
[reset]   [LANAGENT] PASS https://www.foxnews.com/politics/...    ← new log line, proves the migrated function ran
                          (tier=full, credits, charged=3)
[green]   Fallback ScraperAPI Success!                            ← caller-side post-success log
```

Counter `scraperAPIFallbackSuccesses` advanced. Charged 3 credits (from the work account's credit pool — they signed up separately as `charris@unitarylabs.com` and bought a credit package). No errors.

### ScraperAPI exhaustion side-discovery

While inspecting work-scraper logs, found that **ScraperAPI's monthly credit budget is exhausted** — every legacy `/raw-fetch` call (before the migration) had been silently failing with `"You have exhausted the API Credits available in this monthly cycle."` for an unknown number of days. Sibling services using `/raw-fetch` (RSS_Service, etc.) were getting silent failures. The migration fixes this incidentally — `/raw-fetch` now hits LANAgent which has working credit balance.

## 3. Render-tier price cut: 5cr → 3cr

User's instinct: **"5 cents a scrape wtf?"** — fair.

### Why the cut

- FlareSolverr cost-to-serve is well under $0.001/call (long-running Docker container, no per-call cost on top of fixed VPN/server overhead). The 5cr sticker was almost entirely margin.
- $0.05 read expensive next to:
  - ScraperAPI ultra_premium: $0.03+/call at the cheapest plan (plus $49/mo floor)
  - ScrapeGraphAI stealth-extract: $0.034/call on their $425/mo Pro plan
- Headline price story is now **"1¢ to 3¢ per scrape"** (was 1¢ to 5¢)
- Render stays semantically distinct from `full` (FlareSolverr-backed; handles real CF JS challenges) but aligned in price, so under a `full → render` escalation pattern the average per-fallback cost converges on $0.03 instead of $0.05
- 5cr slot now open for a future premium tier (residential proxies, 4G mobile IPs, etc.) without breaking the existing pricing ladder

### Changed

| File | Change |
|---|---|
| `src/api/external/routes/scraping.js` | `TIER_COSTS` `render: 5` → `render: 3` + comment + `/scrape` docstring |
| `src/api/external/routes/catalog.js` | `SERVICE_CREDIT_COSTS['web-scraping']` `render: 5` → `render: 3` |
| `docs/api/API_README.md` | Pricing tables (top-of-file plugin table + per-call credit table near line 1025) + new v2.25.25 section |
| `docs/api/LANAgent_API_Collection.postman_collection.json` | Version `2.25.24` → `2.25.25`, top-level description rewritten, `/scrape` endpoint description |
| `docs/feature-progress.json` | New `renderTierPriceCut_2026_05_05` entry, `lastUpdated` bumped, status preamble rewritten, `renderTierFlareSolverr2026_05_01.description` annotated |
| `CHANGELOG.md` | v2.25.25 entry |
| `package.json` | Version → `2.25.25` |
| `/opt/api-gateway/portal.mjs` (gateway VPS, untracked) | Render demo card label + service catalog price |
| `docs/proposals/gateway-extract-and-crawl.md` | `/extract` `/crawl` cost models updated for render=3cr |
| `/media/veracrypt2/AICodeLogs/2026-05-03-lanagent-vs-scraperapi-comparison.md` | Pricing addendum table + nuance lines |

### Unchanged

- Subscription bucket counts. Scraper Starter ($10/mo): 100K basic + 2.5K render. Pro ($25): 500K + 15K. Business ($50): 2M + 50K. Subscribers see no difference — render still draws from the smaller render-bucket regardless of credit-pool price.
- VPN auto-rotation behavior, FlareSolverr availability check, subscription tier-mapping, `_testBlock` E2E hook.

## 4. End-to-end verification

1. ✅ Genesis code change applied — `TIER_COSTS.render === 3` in both `scraping.js` and `catalog.js`
2. ✅ Deployed to production agent (192.168.0.52) via `deploy-quick.sh`; `pm2 restart lan-agent`
3. ✅ Updated gateway portal on VPS (137.184.2.62) — `/opt/api-gateway/portal.mjs` render card shows 3cr
4. ✅ Gateway PM2 restart clean
5. ✅ Direct `/scrape` POST with `tier: 'render'` against `api.lanagent.net` returned `creditsCharged: 3` and populated `data.html` (FlareSolverr path)
6. ✅ Triggered work-scraper fallback through `dry-scraperservice.dry.ai`; observed `[LANAGENT] PASS … (tier=render, charged=3)` in its pm2 log

## 5. Post-launch fixes (work-scraper v2.2.40 → v2.2.41)

After the migration was live and 13/13 fallbacks were succeeding cleanly, two more rounds of real-world testing surfaced edge-case bugs that needed follow-up. None of these were LANAgent gateway bugs — they were all on the work-scraper side — but they're recorded here because they were discovered while exercising the migrated path.

### Rumble symptom: `success:true` + bare-hostname title + `data:` image

Operator tried `https://rumble.com/v6yrxnk-...` and got back a "successful" scrape with title `"rumble.com"`, empty description/text, and an `image` that was a `data:image/...` URL — i.e. obviously broken content marked as success. First instinct was a LANAgent regression. **It wasn't.** Diagnosis:

- The work scraper runs its own Puppeteer first; LANAgent only fires as fallback when the local scrape fails or returns thin results.
- For Rumble, the local Puppeteer was *succeeding* in the sense that it loaded a page — but Cloudflare blocked the host at the network layer and Chrome rendered its own "This site can't be reached" / `ERR_CONNECTION_*` interstitial. Metascraper happily extracted the bare-hostname `<title>` from that interstitial and the data-URI Chrome error icon as `og:image`.
- The cache layer then stored that as a "completed" scrape, so subsequent hits short-circuited before even reaching the LANAgent fallback.

### Fix: `isChromeErrorPageResponse(result, requestedUrl)` detector

Added a small detector that flags a result as a Chrome error page if any of:

- The first 500 chars of `text` match `this site can'?t be reached | refused to connect | dns_probe | err_connection | err_name_not_resolved | net::err_`
- `title` equals the bare hostname (or `www.<host>`) AND `text` is missing or under 200 chars
- `image` is a `data:image…` URI AND `text` is under 500 chars

Wired in at three checkpoints:

1. **`doTheScrape` post-Metascraper** — if the local Puppeteer result trips the detector, treat as a local failure and fall through to the LANAgent fallback path
2. **`scrapeWithScraperApi` post-LANAgent (tier=full)** — if LANAgent's `full` response somehow trips the detector, escalate to `tier=render` (FlareSolverr) before returning
3. **`/scrape` cache-return path** — before serving a cached "completed" entry, run the detector; if it trips, invalidate the cache entry and re-scrape rather than serving the poisoned result

### Cache cleanup

One poisoned Rumble cache entry was already in the live `scrapes.scrapes` collection. Deleted manually:

```
mongosh scrapes --eval 'db.scrapes.deleteMany({url: "https://rumble.com/v6yrxnk-..."})'
```

The new defensive check at the cache-return path means future poisoned entries self-heal on the next request rather than requiring a manual purge.

### Caller-log rename: `"ScraperAPI"` → `"LANAgent"`

The function name `scrapeWithScraperApi(...)` is unchanged (would break call-site contract and tests), but the **operator-facing log strings** at all 6 caller sites still said `Attempting fallback using ScraperAPI` / `Fallback ScraperAPI Success!`. Renamed all 6 to read `Attempting fallback using LANAgent` / `Fallback LANAgent Success!`. Console logs now match what's actually running.

### Re-verification on Rumble

Cleared the cache, redeployed work-scraper, hit the same Rumble URL again:

- Local Puppeteer returned a Chrome error page → detector tripped → fell through to LANAgent
- LANAgent `tier=full` also returned thin content (Rumble actively blocks data-center IPs at the edge) → detector tripped → escalated to `tier=render`
- LANAgent `tier=render` (FlareSolverr) returned the real page: `"LIVE: Strategy (MSTR) Q1 2026 Earnings Call"` with populated description, text, and proper `ogImage`
- Charged 3cr (render). End-to-end clean.

### Work-scraper version bumps + commit

Three back-to-back work-scraper versions today:

| Version | Change |
|---|---|
| v2.2.39 | Migration: `scrapeWithScraperApi` and `/raw-fetch` route to LANAgent via `callLANAgentScrape(url, tier)` |
| v2.2.40 | Bugfix: read scraped fields from LANAgent's `data: {...}` envelope (`title`, `description`, `text`, `html`, `ogImage`, `images[{src,alt}]`); fixes `success:true` + empty fields |
| v2.2.41 | Add `isChromeErrorPageResponse` detector at 3 checkpoints; rename caller log strings to "LANAgent" |

Committed and pushed to `UnitaryLabs/scraperservice` as `0194c06` (commit author `charris <charris@unitarylabs.com>` via the work-repo's local git config; not the LANAgent dev identity).

### Side-discovery: ScraperAPI was already exhausted

While debugging Rumble, ran `tail` on the older log lines and found that ScraperAPI's monthly credit budget had been silently exhausted for an unknown number of days *before* the migration started. Every legacy `/raw-fetch` call was returning `"You have exhausted the API Credits available in this monthly cycle."` to its callers (RSS_Service and others). The migration fixes this incidentally — the new `/raw-fetch` path now routes through LANAgent's working credit balance — but it also means the work side has had partially-blind RSS ingestion for a while. Worth a separate post-mortem on the work side.

## Open follow-ups

- Track real `render`-tier usage over the next week. If the 16/16 pattern holds (no real CF JS challenges in the work scraper's traffic mix), render fires rarely and the 2cr-per-render savings won't show up much in the bill — but the headline price drop matters more than the realized savings.
- The work account (`charris@unitarylabs.com`) is on the credit pool, not a Scraper sub. After ~2 weeks of trial use, evaluate sub upgrade (Pro $25 covers 500K basic + 15K render; Business $50 covers 2M + 50K).
- ScraperAPI's exhaustion exposes a monitoring gap on the work side. `/raw-fetch` was silently failing for an unknown number of days. Worth adding an alert for `scraperAPIFallbackFails` rate spikes.
- `/extract` and `/crawl` proposal at `docs/proposals/gateway-extract-and-crawl.md` is ready for review whenever — closes the last UX gap vs ScrapeGraphAI.
- Launch Special (50% off first month) ends 2026-05-11. Decide whether to extend, replace, or let it lapse cleanly.
- Consider porting the `isChromeErrorPageResponse` detector pattern into LANAgent's own gateway scrape pipeline (`webScraper`) at `tier=full` — if a basic-tier or full-tier scrape ever lands on a CF-blocked host inside the gateway VPS, we'd hit the same Chrome-interstitial-as-success failure mode that the work scraper just patched. Cheap defensive check; mirrors the work-side fix.
