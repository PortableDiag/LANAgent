# Session Summary — 2026-05-03

## Scope

1. **Audit gateway service prices** — operator recalled "we charged like 5 for the harder scrapes" and asked to verify and update.
2. **Build Scraper Subscriptions on the public gateway** — three monthly tiers ($10/$25/$50) alongside existing one-time credit packages. Stripe-backed, additive, fall back to credit pool when bucket exhausted.
3. **Extend the existing Launch Special promotion to subscriptions** — first-month-only Stripe coupon. Existing 50% bonus-credits behaviour unchanged for one-time purchases.
4. **Add VPN auto-rotation to the agent's paid-scrape path** — the operator was concerned the production IP would get flagged scraping at volume; build hop-on-block recovery using the existing ExpressVPN plugin.
5. Update all documentation, deploy to production, commit and push.

## v2.25.12 — Paid-scrape and gateway upgrades

### 1. Pricing audit + portal corrections

Audited three layers:
- **Agent canonical** (`src/api/external/routes/catalog.js`, `routes/plugins.js`) — accurate.
- **Gateway `/catalog` endpoint** (`/opt/api-gateway/index.mjs`) — accurate, mirrored agent.
- **Portal landing page** (`/opt/api-gateway/portal.mjs`) — wrong; service cards advertised the cheaper plugin-route prices instead of the dedicated-route prices.

| Card | Was | Real cost |
|------|-----|-----------|
| Web Scraping | 2 cr | tier-priced 1/2/3/5 (basic/stealth/full/render) |
| YouTube | 3 cr | `/youtube/download` 10 cr, `/youtube/audio` 8 cr (the 3 cr was the cheaper `plugin-ytdlp` route) |
| Media Processing | 5 cr | `/transcode` 20 cr (the 5 cr was the `plugin-ffmpeg` route) |

**Fixed in `portal.mjs`:**
- Web Scraping card now shows "1–5 cr" with the tier breakdown
- YouTube split into Video (MP4) 10 cr + Audio (MP3) 8 cr cards, both pointing at dedicated routes
- Media Processing renamed to "Media Transcoding" and labelled 20 cr
- Removed redundant **Advanced Scraper** card (functionally overlapped with tier-priced Web Scraping; underlying `/service/scraper/scrape` plugin endpoint still works for backwards compatibility, just hidden from marketing)
- Added three discrete demo cards for scraping: Basic 1 cr (HN target), Stealth 2 cr (Amazon), **Render 5 cr (DexScreener with `tier:"render", screenshot:true`)** — the render demo is the showpiece for the tier and proves it can handle JS-heavy SPAs

### 2. Scraper Subscriptions

Three monthly Stripe subscription tiers on `api.lanagent.net`, additive to existing one-time credits and BNB/SKYNET crypto purchases. Subscriptions cover only the `/scrape` and `/scrape/batch` routes; all 25 services still bill from the credit pool.

| Plan | Price | Basic / month | Render / month |
|------|-------|---------------|----------------|
| Scraper Starter | $10/mo | 100,000 | 2,500 |
| Scraper Pro | $25/mo | 500,000 | 15,000 |
| Scraper Business | $50/mo | 2,000,000 | 50,000 |

**Pricing rationale:** competitor ScraperAPI sells $49/mo for 100K basic credits. Our $10/mo Starter matches that volume at less than a quarter of the price; $50/mo Business gives 2M basic for the cost of their Hobby tier. Cost-to-serve is essentially zero on basic scrapes (cheerio fetches), so margins are healthy even on heavy-usage subscribers, and most subscribers won't hit the cap.

**Schema:** PortalUser extended with `scrapeSubscription { active, plan, stripeSubId, basicLimit, basicUsed, renderLimit, renderUsed, periodStart, periodEnd, cancelAtPeriodEnd }`.

**Atomic ops** — `consumeScrapeQuota(userId, bucket)` uses a single `findOneAndUpdate` with `$expr: { $lte: [{ $add: ["$used", 1] }, "$limit"] }` to enforce the limit at the DB level. No race conditions even under concurrent scrape calls. `refundScrapeQuota` decrements on agent failure.

**Tier mapping:**
- `basic` / `stealth` / `full` → basic counter (1 unit each)
- `render` → render counter (1 unit)

Two independent buckets means filling the basic bucket doesn't block render scrapes and vice-versa — verified end-to-end.

**Fallback to credits** — when a subscriber's bucket is exhausted, `/scrape` automatically falls back to the credit pool (per-URL on batch). Returns 402 only if BOTH the bucket is empty AND credits are insufficient. So subscribers never hard-fail as long as they have credits.

**New routes:**
```
GET  /portal/scrape-plans          (public)
GET  /portal/subscription          (auth required; current state + usage)
POST /portal/subscribe             (creates Checkout in subscription mode)
POST /portal/cancel-subscription   (sets cancel_at_period_end via Stripe API)
```

**Webhook lifecycle** — extended `portalWebhookHandler` for:
- `customer.subscription.created` / `customer.subscription.updated` — activate / refresh quota fields
- `customer.subscription.deleted` — deactivate
- `invoice.paid` (with `billing_reason: subscription_cycle`) — reset usage counters and update period dates

Existing Stripe webhook endpoint `we_1TFoB7DEB0q73v8zL1zFJj0p` updated via API to subscribe to all 5 events (was only listening to `checkout.session.completed`).

**Dashboard UI** — subscription block added to the existing dashboard view with plan name, two progress bars (basic + render), period end date, cancel button (or "Cancellation pending" when set). Falls back to "No active subscription. View plans to save on scraping." when not subscribed.

### 3. First-month promo coupon for subscriptions

Existing `Promotion` mechanism only applied to one-time credit purchases (added bonus credits). Extended to subscriptions:

- New `getOrCreateStripeCoupon(percentOff)` helper — idempotent, deterministic ID `lanagent_promo_${pct}pct_once`, `duration: 'once'`. First call creates the coupon on Stripe; subsequent calls retrieve it.
- `/portal/subscribe` checks `getActivePromotion()`; if active, attaches `discounts: [{ coupon: couponId }]` to the Checkout session.
- Active 50% Launch Special now reduces first month of subs from $10/$25/$50 to $5/$12.50/$25.
- Renewals revert to base price automatically (Stripe enforces `duration: 'once'`).
- Landing-page subscription cards get a "{N}% off first month" badge injected via the existing `/promotion`-fetching JS — looks up cards by new `data-sub-plan` attribute.
- After promo expires (May 11), no code changes needed — coupon no longer attached to new checkouts and badge no-ops.

**Verified:** subscription Checkout session for `scraper_pro` showed `amount_subtotal: 2500, amount_total: 1250, amount_discount: 1250, discounts: [{ coupon: 'lanagent_promo_50pct_once' }]`.

### 4. Defensive Stripe customer recovery

Bug surfaced during testing: a portal user had a stale `stripeCustomerId` from earlier test-mode work; live-key checkout failed with `"No such customer: cus_xxx; a similar object exists in test mode, but a live mode key was used"`.

Fix: `getOrCreateStripeCustomer(user)` validates the stored customer ID against Stripe before use. On `resource_missing`, creates a new customer and updates the user record. Used by both `/portal/checkout` (one-time credits) and `/portal/subscribe`.

**Verified:** planted `cus_doesnotexist_FAKE_TEST` on a test user, called `/portal/subscribe`, confirmed the helper detected the stale ID, created `cus_US0jdnuFWeijaC`, persisted it, and completed the subscribe.

### 5. VPN auto-rotation on block (the headline scraper feature)

**Audit:** ExpressVPN was already installed at `/opt/expressvpn` on production and connected to `usa-san-francisco` (LightwayUdp, Network Lock enabled), so all outbound — including scrapes — was already tunnelled. But the scraper code had **zero awareness** of the VPN: same SF exit for every scrape, no rotation on block. At volume, the SF IP would get flagged by anti-bot systems with no recovery.

**Built `executeScrapeWithVpnRotation` wrapper** in `src/api/external/routes/scraping.js`:

1. Run `executeScrape(req, params)` normally.
2. If `tier === 'basic'` OR result is success OR error doesn't look like a block → return.
3. Otherwise: get current VPN location, pick next from `VPN_ROTATION_POOL`, call `vpn.connect({ location })`, wait 2.5s for stabilization, invalidate the URL's scrape cache, retry.
4. Up to `MAX_VPN_ROTATIONS = 2` rotations per scrape.
5. On recovery, attach `vpnRotation: { location, rotations }` to the response.

**Block detection** (`isLikelyBlocked()`):
```js
/\b(403|406|429|503)\b|forbidden|blocked|cloudflare|just a moment|attention required|access denied|rate limit|too many requests|challenge/i
```

**Curated rotation pool** — 10 well-distributed exits, all reliable: `usnj` (US East), `usla` (US West), `usch` (US Central), `cato` (Toronto), `uklo` (London), `nlam` (Amsterdam), `defr` (Frankfurt), `frpa` (Paris), `jpto` (Tokyo), `sgma` (Singapore).

**Why basic is skipped** — cheerio fetches take <1s; a 3–5s VPN reconnect would dominate latency and degrade the basic-tier UX. Stealth/full/render already take 5–15s so an extra rotation cycle is acceptable.

**Test hook** — `_testBlock: 'once' | 'always'` in request body forces simulated blocks for E2E verification without needing a real blocked target. Forwarded by the gateway alongside `selectors`/`extractType`/`userAgent`.

**Test results** (production agent, real VPN):

| Test | Setup | Expected | Result |
|------|-------|----------|--------|
| 1 | `tier=basic`, `_testBlock=once` | Rotation skipped, scrape fails cleanly | ✓ VPN unchanged at SF |
| 2 | `tier=stealth`, no hook | Normal scrape succeeds | ✓ no rotation |
| 3 | `tier=stealth`, `_testBlock=once` | Block detected, rotate, recover on 2nd attempt | ✓ rotated `smart→usnj`, response has `vpnRotation: { location: 'usnj', rotations: 1 }` |
| 4 | `tier=stealth`, `_testBlock=always` | Block, rotate, still blocked, rotate, exhausted | ✓ rotated `smart→usnj→usla`, refunded credits |

Production logs from test 3:
```
[ExternalScrape] _testBlock=once: simulating initial block for rotation test
[ExternalScrape] Block detected on tier=stealth url=... — rotating VPN smart → usnj (attempt 1/2)
[ExternalScrape] Recovery via VPN usnj succeeded for ... after 1 rotation(s)
```

## Files changed

**Agent (LANAgent-genesis):**
- `package.json` — version → 2.25.12
- `src/api/external/routes/scraping.js` — VPN rotation logic
- `CHANGELOG.md`, `README.md`, `docs/api/API_README.md`, `docs/feature-progress.json`, `docs/api/LANAgent_API_Collection.postman_collection.json`

**Gateway (`/media/veracrypt3/Websites/LANAgent_Website/api-lanagent-net/`):**
- `portal.mjs` — `SCRAPE_SUB_PLANS`, `scrapeSubscription` schema field, atomic quota ops, 4 new routes, webhook lifecycle handlers, promo coupon helpers, defensive customer recovery, landing-page subscription cards + badges, dashboard subscription block
- `index.mjs` — `scrapeBucket()`, `trySubQuota()`/`refundSubQuota()`, `/scrape` and `/scrape/batch` routes try sub quota first then fall back to credits, response `billing` field, forwards `_testBlock` and other body fields to agent

## Deployment

Both already deployed and live during testing:
- Agent: `pm2 restart lan-agent` (PID 2885833, version 2.25.11 from package.json — bumped to 2.25.12 in this commit)
- Gateway: `pm2 restart api-gateway` (PID 943955)

End-of-day state: production is running v2.25.12 code, all tests pass, both prod boxes healthy.

---

## v2.25.13 — Email + Support layer (later same day)

A second focused block of work, all on the gateway side. Three pieces, each motivated by an operator observation while reviewing the v2.25.12 deploy.

### 1. Comparison doc updates

The earlier session produced a comparison write-up at `/media/veracrypt2/AICodeLogs/2026-05-03-lanagent-vs-scraperapi-comparison.md` — meant to give the operator something to show their boss explaining why the work scraper + ScraperAPI fallback was outperformed by LANAgent.

Two operator-driven revisions during this block:
- **Work scraper UA fix landed externally** — that section removed from the doc since it's no longer a gap. Headless mode noted as gated on a puppeteer upgrade (separate effort).
- **FlareSolverr clarification** — the operator was prepping to talk to the boss and asked whether FS would help the work scraper. Looked at the data honestly: **FS was not invoked in any of the 16/16 wins** (those were all decided at basic/stealth tier; FS is render-only). Updated the doc with an "Anticipated questions" section pre-empting the boss's likely "why didn't you add FS to the work scraper" question — three reasons (it's not what's failing, FS without rotation doesn't help, it's a Docker dep we don't run). Reordered priority: VPN/IP rotation is the real differentiator; FS is the long-tail tool.

### 2. Usage-threshold notification emails

**Trigger**: operator asked "when a customer has consumed 90 or 100% of their credits/allowance, do we email them like ScraperAPI does?" Audit found we did not. The agent's `ApiKey` model had a stub `alertConfig` with a `// TODO: integrate email service` comment. The gateway had no email infrastructure at all — not even password reset.

**Architecture decision**: thresholds are gateway-driven, not agent-driven. Multiple agents (ALICE, BETA, future forks) but one gateway that owns customer state and email. Putting the threshold logic anywhere else means duplicating customer state per agent or doing remote lookups on every debit.

**Build**:
- Provisioned `noreply@lanagent.net` mailbox on the mail server (docker-mailserver, 100MB quota). The mail-management API at port 9100 is firewall-blocked, so I created the mailbox directly via `docker compose exec mailserver setup email add` as root. Verified SMTP send works from the gateway VPS to `mail.lanagent.net:587`.
- New module `email.mjs` with `nodemailer` SMTP transport, polished HTML wrapper template (brand-color top stripe, monospace code blocks, two-column footer, preheader for inbox preview), and three threshold templates (80% warning, 90% urgent, 100% exhausted).
- PortalUser schema extended with `creditAlertBaseline` (snapshot of credits balance after most recent top-up — the "100% denominator" for credit alerts) and `notifications.{credits,subBasic,subRender}{80,90,100}` (per-threshold sent timestamps).
- Helpers in `portal.mjs`:
  - `pickUnsentThreshold(pct, sent80, sent90, sent100)` — returns highest unsent threshold (so a single big debit jumping 70%→100% sends the 100% mail, not three).
  - `claimNotification(userId, field)` — atomic `findOneAndUpdate` so concurrent debits can't double-send.
  - `checkSubThresholds(user, bucket)` and `checkCreditThresholds(user)` — fire-and-forget after consumption.
  - `resetSubNotifications(userId)` and `resetCreditNotifications(userId, newBaseline)` — wired into the Stripe webhook for `invoice.paid` (subscription_cycle) and `checkout.session.completed` (one-time top-up).
- Hooks in `index.mjs`: `trySubQuota` calls `checkSubThresholds` after `consumeScrapeQuota` succeeds; `debitCredits` for portal users calls `checkCreditThresholds` after debit. Both fire-and-forget so SMTP latency never enters the request path.

**Verified**: a node test script directly exercising the threshold helpers fired all 6 emails (sub × 3 + credits × 3) to portablediag@protonmail.com. 7th test confirmed idempotency — re-running with the flag already set does not resend.

**Subject + sender naming fix**: operator pointed out subjects saying "Your LANAgent credit balance is empty" read as the agent itself running out. Renamed sender to `LANAgent API <noreply@lanagent.net>` and updated all subject lines that referenced "LANAgent" generically to "LANAgent API".

### 3. Account-management email suite

Once the email transport existed, the natural follow-on was building all the missing user-facing email flows:

- **Password reset** — biggest gap. There was no `/portal/forgot-password` route at all; if a user forgot their portal password they were locked out, full stop. Built `POST /portal/forgot-password` (always returns 200 to avoid leaking which addresses are registered), `POST /portal/reset-password` (consumes token + sets new password), `GET /portal/reset?token=…` (HTML form linked from the email).
- **Email verification** — `emailVerified: false` was set on every account and never updated. Built `GET /portal/verify?token=…` (one-shot HTML page that flips the flag) and `POST /portal/resend-verification` (JWT-gated).
- **Welcome email** — fires on `/portal/signup` success with the user's API key + a copy-paste curl example.
- **API-key created / revoked notifications** — fires on `/portal/api-keys` POST/DELETE/regenerate with the key name, prefix, source IP, timestamp. Standard security hygiene; helps detect account takeover.
- **Subscription cancellation confirmation** — fires when `/portal/cancel-subscription` succeeds, with the period-end date. Stripe doesn't send anything for "scheduled cancel at period end."

**Token model** — new `PortalToken` collection with TTL index (Mongo auto-removes expired tokens). Tokens are SHA-256 hashed in DB; raw value only ever leaves in the email URL. Minting a fresh token invalidates prior unused tokens of the same purpose so stale links can't be replayed.

**Verified end-to-end**:
- Real signup fired Welcome + Confirm-email emails ✓
- `/portal/forgot-password` fired Reset-password email ✓
- Forged token through `/portal/verify` → DB flips `emailVerified=true`, token marked used, replay attempt rejected ✓
- Forged token through `/portal/reset-password` → password updated, login with new password works ✓
- API key create → notification email ✓
- API key delete → revocation email ✓
- Direct test of subscription cancellation template ✓

### 4. Support inbox (v1 + v2)

**Trigger**: footer of the threshold emails referenced `support@lanagent.net` but that mailbox didn't exist (sloppy on my part — I had the mailbox list and didn't reconcile). Operator pointed out it raises a bigger question: since LANAgent is AI-centered, support should be AI-handled with human escalation, not just human triage.

Decided to build incrementally rather than the full AI-handled system upfront.

**v1 — notification only**:
- Provisioned `support@lanagent.net` (500MB quota).
- New `support-poller` PM2 service on the gateway VPS (`/opt/api-gateway/support-poller.mjs`) using `imapflow` + `mailparser`.
- Polls IMAPS at `mail.lanagent.net:993` every 60s for `UNSEEN` messages.
- For each: skip filter (`Auto-Submitted` header, `Precedence: bulk/junk/list`, noreply-pattern senders), then Telegram-pings the operator with from/subject/body snippet.
- Marks `\Seen` so each ticket pings once.

**v2 — context-enriched notifications** (built same session):
- Added Mongo connection (read-only access to gateway DB).
- New `buildUserContext(fromAddress)` function: looks up the `From:` address in `PortalUser`, aggregates last 7 days of `RequestLog` (totals, failures, top failing routes, most recent failure with error + age), pulls last `PortalPayment`.
- Telegram message format now includes structured "Account / Quota / 7-day activity / Last failure / Last payment" block before the email body.
- Both matched-sender and unmatched-sender paths verified end-to-end (sent test emails from `alice@` to `support@` with different `From:` addresses).

**Roadmap doc**: `docs/proposals/ai-support-system.md` covers v3 (LLM-drafted replies with operator approval via Telegram inline keyboard), v4 (auto-send for trusted categories like account-status questions, hard rules that can never auto-send for money/security/legal/anger), v5 (proactive outreach on internal events — failed payments, sub exhaustion, repeat 402 bugs, geo-mismatch keys). Architecture split: gateway owns customer state, ALICE owns LLM. Recommended sequence in the doc: sit on v2 for at least 2 weeks before building v3 — real ticket volume will inform whether the LLM-draft investment is worth it.

## Files changed (v2.25.13)

**Gateway (`api-lanagent-net` repo, deployed to `/opt/api-gateway/`):**
- `email.mjs` (new) — SMTP transport + 9 transactional templates (3 threshold + 6 account-management).
- `portal.mjs` — schema additions (creditAlertBaseline, notifications, scrapeSubscription unchanged), threshold helpers, PortalToken model + mintToken/consumeToken, 5 new routes (forgot-password, reset-password, reset HTML, verify HTML, resend-verification), notification hooks in signup/api-keys/cancel-subscription.
- `index.mjs` — wired threshold checks into trySubQuota and debitCredits for portal users.
- `support-poller.mjs` (new) — IMAP poller with user-context enrichment.
- `ecosystem.config.cjs` — added support-poller PM2 entry, added MAIL_* + SUPPORT_* env vars, renamed MAIL_FROM sender to "LANAgent API".

**Mail server (`mail.lanagent.net`):**
- New mailbox `noreply@lanagent.net` (100MB) — sender for all transactional email.
- New mailbox `support@lanagent.net` (500MB) — inbound support tickets.

**Agent (`LANAgent-genesis`):**
- `package.json` — version → 2.25.13.
- `CHANGELOG.md`, `README.md`, `docs/api/API_README.md`, `docs/feature-progress.json`, `docs/api/LANAgent_API_Collection.postman_collection.json` — version stamps + changelog entry.
- `docs/proposals/ai-support-system.md` (new) — v3-v5 design doc.

## Deployment

Both services running on the gateway VPS via PM2:
- `api-gateway` — restarted with `--update-env` after new MAIL_* env vars added; running cleanly.
- `support-poller` — new PM2 process; connected to MongoDB + IMAPS; polling every 60s.

Mail server unchanged operationally (new mailboxes are config additions, no service restart needed).

End-of-day state: gateway running new code on commit-pending source; agent unchanged but version-stamped to v2.25.13 to mark the platform-level release; mail infrastructure has 2 new mailboxes and is sending + receiving cleanly. All test emails arrived in the operator's ProtonMail inbox.
