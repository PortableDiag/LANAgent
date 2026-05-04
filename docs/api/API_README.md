# LANAgent API Documentation

## Overview

LANAgent provides a comprehensive REST API for managing your home server, automating tasks, and integrating with AI services. The API follows a modular plugin-based architecture that makes it extensible and maintainable.

## Unified API Gateway (api.lanagent.net)

The LANAgent API gateway routes requests across available agents. 87+ paid services (16 plugins, 87+ commands, 13 dedicated routes), agent directory, Stripe + crypto payments. One URL for everything.

**Base URL:** `https://api.lanagent.net`

**Also available at:** `https://scrape.lanagent.net` (alias, same service)

### How It Works

### Two Ways to Get Credits

**Option A: Credit card (Stripe) — no crypto needed:**
1. Sign up at `api.lanagent.net` with email/password
2. Buy credit package ($5/$15/$50) via Stripe checkout
3. Get `gsk_*` API key automatically
4. Start calling services

**Option B: Crypto (BNB or SKYNET):**
1. Sign with BSC wallet → get JWT → generate `gsk_*` API key
2. Send BNB or SKYNET to gateway's `recipientAddress` (from `GET /credits/price`)
3. Submit tx hash to `POST /credits/purchase`
4. Start calling services

Both methods give you the same `gsk_*` API key and access the same services.

### Payment Flow (behind the scenes)

- **Clients** pay in credit card, BNB, or SKYNET
- **Agents** always receive SKYNET — the utility token
- **Gateway** auto-converts BNB→SKYNET via PancakeSwap when needed
- **Gateway margin:** 10%
- **Failed requests** are auto-refunded (credits returned)

---

### Services

| Service | Endpoint | Credits | Description |
|---------|----------|---------|-------------|
| Web Scrape (basic) | `POST /scrape` | 1 | Metadata, text, links |
| Web Scrape (stealth) | `POST /scrape` | 2 | Forces Puppeteer for difficult sites; auto-rotates VPN on block |
| Web Scrape (full) | `POST /scrape` | 3 | + raw HTML; auto-rotates VPN on block |
| Web Scrape (render) | `POST /scrape` | 5 | + HTML + screenshot, FlareSolverr-backed for Cloudflare-protected sites (Rumble, Bitchute, etc.); auto-rotates VPN on block |
| Batch Scrape | `POST /scrape/batch` | 1-5 each | Up to 100 URLs |
| YouTube Download | `POST /youtube/download` | 10 | MP4 video |
| YouTube Audio | `POST /youtube/audio` | 8 | MP3 audio |
| Media Transcode | `POST /transcode` | 20 | FFmpeg format conversion |
| AI Image Gen | `POST /image/generate` | 30 | Text-to-image |
| Document OCR | `POST /documents/process` | 10 | Text extraction |
| Code Sandbox | `POST /sandbox/execute` | 20 | Python/Node/Bash/Ruby/Go |
| PDF Merge | `POST /pdf/merge` | 5 | Merge PDFs |
| PDF Split | `POST /pdf/split` | 5 | Split PDF |
| PDF Compress | `POST /pdf/compress` | 5 | Compress PDF |
| PDF Text | `POST /pdf/text` | 5 | Extract text |
| Price Feed | `GET /price/:pair` | 1 | Chainlink oracle price (CoinGecko fallback — free) |
| Price Feeds List | `GET /price/feeds` | 1 | List available Chainlink feeds per network |
| Price Compare | `POST /price/compare` | 1 | Compare Chainlink vs CoinGecko |
| Price Info | `GET /price/:pair/info` | 1 | Feed metadata (contract, decimals, version) |
| Price History | `GET /price/:pair/history?roundId=...` | 1 | Historical price by Chainlink round ID |

All services accept `X-API-Key: gsk_your_key` header. Failed requests (target 4xx/5xx, timeout) are auto-refunded.

---

### Agent Directory

```
GET /agents
→ [{ "agentId": 2930, "name": "ALICE", "services": [...], "reliability": "98.5%", "online": true }]

GET /agents/2930
→ { "agent": { "agentId": 2930, "name": "ALICE", "services": [...], "endpoint": "..." } }

GET /agents/2930/catalog
→ { "services": { "web-scraping": { "creditCost": 1 }, ... } }

POST /agents/2930/scrape       ← route to specific agent
X-API-Key: gsk_your_key
{ "url": "https://example.com" }
```

ERC-8004 clients use `https://api.lanagent.net/agents/{agentId}` as the on-chain endpoint.

---

### Portal (Stripe — no crypto needed)

```
POST /portal/signup
{ "email": "you@example.com", "password": "8+ chars" }
→ { "token": "eyJ...", "apiKey": "gsk_abc123...", "credits": 0 }

POST /portal/login
{ "email": "you@example.com", "password": "..." }
→ { "token": "...", "credits": 400 }

POST /portal/checkout
Authorization: Bearer <token>
{ "package": "starter" }
→ { "checkoutUrl": "https://checkout.stripe.com/..." }

GET /portal/dashboard
Authorization: Bearer <token>
→ { "credits": 400, "apiKeys": [...], "recentPayments": [...] }

GET /portal/packages
→ { "packages": [
    { "id": "starter", "price": 500, "credits": 400, "priceDisplay": "$5.00" },
    { "id": "growth", "price": 1500, "credits": 1300, "priceDisplay": "$15.00" },
    { "id": "pro", "price": 5000, "credits": 4700, "priceDisplay": "$50.00" }
  ]}
```

---

### Scraper Subscriptions (v2.25.12+)

Monthly Stripe subscriptions for `/scrape` and `/scrape/batch` calls — flat-rate alternative to the per-call credit pool. Two independent quota buckets per plan: `basic` (covers `basic`/`stealth`/`full` tiers) and `render` (covers the `render` tier). Quotas reset on every renewal. Calls past the cap automatically fall back to the credit pool — never hard-fail as long as the user has either subscription quota or credits available.

| Plan | Price | Basic / month | Render / month |
|------|-------|---------------|----------------|
| Scraper Starter | $10/mo | 100,000 | 2,500 |
| Scraper Pro | $25/mo | 500,000 | 15,000 |
| Scraper Business | $50/mo | 2,000,000 | 50,000 |

```
GET /portal/scrape-plans                     ← public; lists all plans + quotas

POST /portal/subscribe                       ← auth required (gsk_* or JWT)
{ "plan": "scraper_pro" }
→ { "checkoutUrl": "https://checkout.stripe.com/...", "sessionId": "cs_live_..." }

GET /portal/subscription                     ← auth required
→ { "active": true, "plan": "scraper_pro", "planName": "Scraper Pro",
    "basicUsed": 1234, "basicLimit": 500000,
    "renderUsed": 17, "renderLimit": 15000,
    "periodEnd": "2026-06-03T...", "cancelAtPeriodEnd": false }

POST /portal/cancel-subscription             ← auth required; cancels at period end
→ { "success": true, "message": "Subscription will end at period end. You retain quota until then." }
```

Subscriptions cover **only** the scrape routes; all 25 other services (YouTube, transcoding, AI image gen, code sandbox, plugins, etc.) continue to bill from the credit pool. Subscriptions are additive — users can hold credits and a subscription simultaneously, and during an active sub the gateway uses subscription quota first, falling back to credits only when the bucket is exhausted.

`/scrape` response includes `billing: 'subscription' | 'credits'` so the client can tell which bucket paid for the call. When billed via subscription, `subBucket`, `subUsed`, and `subLimit` are surfaced; when billed via credits, `creditsCharged` and `creditsRemaining` are surfaced.

**Promo: first-month discount.** When a `Promotion` is active, subscription checkout attaches a Stripe coupon (`duration: 'once'`) for the matching discount percentage. Renewals revert to base price. Existing one-time credit packages already give bonus credits during promotions — same discount percent applies to the first month of any new sub.

---

### Crypto Auth + API Key

```
GET /auth/nonce?wallet=0x...
→ { "nonce": "scrape_gateway_auth_...", "expiresIn": 300 }

POST /auth/verify
{ "wallet": "0x...", "signature": "0x...", "nonce": "..." }
→ { "token": "eyJ...", "wallet": "0x...", "credits": 0 }

POST /auth/api-key
Authorization: Bearer <jwt>
{ "name": "my-app" }
→ { "apiKey": "gsk_abc123..." }
```

### Credits

```
GET /credits/price
→ {
    "recipientAddress": "0x3e05...",
    "creditValueUsd": 0.011,
    "pricePerCredit": { "bnb": "0.0000180..." },
    "availableAgents": 1,
    "acceptedCurrencies": ["BNB", "SKYNET"]
  }

POST /credits/purchase
X-API-Key: gsk_your_key
{ "txHash": "0x...", "currency": "BNB" }
→ { "credits": 500, "newBalance": 500 }

GET /credits/balance
X-API-Key: gsk_your_key
→ { "credits": 488, "totalPurchased": 500, "totalSpent": 12 }
```

### Promotions & Stats

```
GET /promotion
→ { "promotion": { "name": "Launch Special", "discountPercent": 50, "endsAt": "2026-05-11T..." } }
→ { "promotion": null }  ← no active promotion

GET /stats
→ { "version": "2.24.9", "agents": { "total": 2, "online": 2 },
    "services": { "total": 25, "plugins": 17 },
    "serviceCosts": { "anime": 1, "chainlink": 1, ... } }
```

Active promotions give bonus credits on all purchases (Stripe and crypto). Check `/promotion` to see if one is running.

### Catalog

```
GET /catalog
→ {
    "gateway": "api.lanagent.net",
    "services": { "web-scraping": { "credits": {...}, "endpoints": [...] }, ... },
    "agents": [{ "name": "ALICE", "agentId": 2930, "reliability": "98.5%", "online": true }],
    "agentDirectory": { "listAll": "GET /agents", "getAgent": "GET /agents/:agentId" }
  }
```

### Integration Example (Recommended)

Complete Node.js example — one-time setup, auto-purchase, and daily usage:

```javascript
import { ethers } from 'ethers';
import axios from 'axios';

const GW = 'https://api.lanagent.net';
const BSC_RPC = 'https://bsc-dataseed.binance.org';

// ============================================================
// STEP 1: ONE-TIME SETUP (run once, save wallet + API key)
// ============================================================

// Create a BSC wallet (store privateKey securely — encrypted DB, env var, etc.)
const wallet = ethers.Wallet.createRandom();
console.log('Wallet address:', wallet.address);
console.log('Private key (SAVE THIS SECURELY):', wallet.privateKey);
// Fund this address with BNB on BSC (any exchange withdrawal or wallet transfer)

// Authenticate with wallet signature
const { data: { nonce } } = await axios.get(`${GW}/auth/nonce?wallet=${wallet.address}`);
const signature = await wallet.signMessage(nonce);
const { data: { token } } = await axios.post(`${GW}/auth/verify`, {
  wallet: wallet.address, signature, nonce
});

// Generate API key (gsk_* prefix — save this, use for all future requests)
const { data: { apiKey } } = await axios.post(`${GW}/auth/api-key`,
  { name: 'my-app' },
  { headers: { Authorization: `Bearer ${token}` } }
);
console.log('API Key:', apiKey);  // gsk_abc123... — save this!
// After this point, you never need the JWT or wallet signature again.
// All requests use the gsk_* API key.

// ============================================================
// STEP 2: PURCHASE CREDITS (auto-purchase pattern)
// ============================================================

async function purchaseCredits(apiKey, wallet, amountBnb = '0.005') {
  // 1. Get current pricing and recipient address from the gateway
  const { data: priceInfo } = await axios.get(`${GW}/credits/price`);
  const recipientAddress = priceInfo.recipientAddress;  // Gateway's BSC wallet
  const pricePerCredit = parseFloat(priceInfo.pricePerCredit.bnb);
  console.log(`Recipient: ${recipientAddress}`);
  console.log(`Price: ${pricePerCredit} BNB/credit ($${priceInfo.creditValueUsd}/credit)`);

  // 2. Send BNB to the gateway's recipient address on BSC
  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const signer = wallet.connect(provider);
  const tx = await signer.sendTransaction({
    to: recipientAddress,
    value: ethers.parseEther(amountBnb)
  });
  console.log('Payment tx:', tx.hash);
  await tx.wait();  // Wait for confirmation

  // 3. Submit the tx hash to purchase credits
  const { data: purchase } = await axios.post(`${GW}/credits/purchase`,
    { txHash: tx.hash, currency: 'BNB' },
    { headers: { 'X-API-Key': apiKey } }
  );
  console.log(`Purchased ${purchase.credits} credits (balance: ${purchase.newBalance})`);
  return purchase;
}

// Buy credits (0.005 BNB ≈ 450 credits at current prices)
await purchaseCredits(apiKey, wallet, '0.005');

// ============================================================
// STEP 3: USE SERVICES (automated, no more wallet interaction)
// ============================================================

const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

// Single scrape
const { data: result } = await axios.post(`${GW}/scrape`,
  { url: 'https://en.wikipedia.org/wiki/Web_scraping', tier: 'basic' },
  { headers }
);
console.log(result.data.title);           // "Web scraping - Wikipedia"
console.log(result.creditsCharged);        // 1
console.log(result.creditsRemaining);      // 449
console.log(result.agent.name);            // "ALICE" (which agent handled it)

// Full scrape (includes raw HTML)
const { data: full } = await axios.post(`${GW}/scrape`,
  { url: 'https://news.ycombinator.com', tier: 'full' },
  { headers }
);
console.log(full.data.html.length);        // ~35000 chars of raw HTML

// Batch scrape (up to 100 URLs, failed ones refunded)
const { data: batch } = await axios.post(`${GW}/scrape/batch`,
  { urls: ['https://a.com', 'https://b.com', 'https://c.com'], tier: 'basic' },
  { headers }
);
console.log(`${batch.successful} ok, ${batch.failed} failed`);
console.log(`Charged: ${batch.creditsCharged}, Refunded: ${batch.creditsRefunded}`);

// YouTube download (10 credits)
const { data: yt } = await axios.post(`${GW}/youtube/download`,
  { url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' },
  { headers }
);

// AI image generation (30 credits)
const { data: img } = await axios.post(`${GW}/image/generate`,
  { prompt: 'A futuristic city at sunset', model: 'dall-e-3' },
  { headers }
);

// Code execution (20 credits)
const { data: code } = await axios.post(`${GW}/sandbox/execute`,
  { language: 'python', code: 'print("Hello from LANAgent!")' },
  { headers }
);

// Browse agents
const { data: agents } = await axios.get(`${GW}/agents`);
console.log(`${agents.agents.length} agents online`);

// ============================================================
// STEP 4: MONITOR AND AUTO-REPLENISH
// ============================================================

async function ensureCredits(apiKey, wallet, minCredits = 100) {
  const { data: bal } = await axios.get(`${GW}/credits/balance`,
    { headers: { 'X-API-Key': apiKey } }
  );
  if (bal.credits < minCredits) {
    console.log(`Low credits (${bal.credits}), purchasing more...`);
    await purchaseCredits(apiKey, wallet, '0.005');
  }
  return bal.credits;
}

// Call this before heavy batch operations or on a schedule
await ensureCredits(apiKey, wallet);
```

### Admin (agent operators)

Register your LANAgent instance on the gateway:

```
POST /admin/agents
X-Admin-Key: <admin-key>
{
  "url": "http://your-agent-ip:port",
  "name": "MyAgent",
  "apiKey": "lsk_your_key_on_your_agent",
  "agentId": 1234
}
```

The gateway calls `GET /api/external/catalog` on your agent and reads the `services` array to discover what you offer. It also fetches pricing and credit balance. **You must re-call this endpoint after adding new services** — the gateway does not auto-refresh the services list (only pricing refreshes every 5 minutes).

---

## Recent Updates (May 1, 2026)

### v2.25.12 — Scraper Subscriptions + VPN Rotation on Block

**Scraper Subscriptions** — three monthly Stripe tiers ($10/$25/$50) on the gateway portal, additive to the existing one-time credit packages. Two independent quota buckets per plan (basic + render). Tier mapping: `basic`/`stealth`/`full` → basic counter, `render` → render counter. Quotas reset on `invoice.paid` webhook (`subscription_cycle`). Falls back to credit pool when bucket exhausted. New routes: `GET /portal/scrape-plans`, `GET /portal/subscription`, `POST /portal/subscribe`, `POST /portal/cancel-subscription`. See **Scraper Subscriptions** section above.

**Promo coupon** — when an active `Promotion` document exists, `/portal/subscribe` attaches a Stripe coupon (`lanagent_promo_${pct}pct_once`, `duration: 'once'`) to the Checkout session. First-month discount only; renewals at full price. Idempotent via `getOrCreateStripeCoupon()`.

**Defensive Stripe customer recovery** — `getOrCreateStripeCustomer(user)` validates a stored `stripeCustomerId` against Stripe before use; recreates if missing (handles stale test-mode IDs after live-key switch, or dashboard deletions). Used by both `/portal/checkout` and `/portal/subscribe`.

**Paid-scrape: VPN auto-rotation on block** — `executeScrapeWithVpnRotation` wrapper in `src/api/external/routes/scraping.js` detects block-shaped failures (403/406/429/503/CF challenge/access-denied/rate-limit) on `stealth`/`full`/`render` tiers and rotates the agent's ExpressVPN exit through a curated 10-location pool, retrying up to `MAX_VPN_ROTATIONS = 2` times per scrape. Skipped on `tier='basic'`. Recovery surfaces `vpnRotation: { location, rotations }` in the response. Test hook `_testBlock: 'once' | 'always'` in request body simulates blocks for E2E verification.

### v2.25.10 — PR Review Pass + FlareSolverr Render Tier

**Render-tier scraping** (v2.25.7) — Cloudflare-protected sites (Rumble, Bitchute, etc.) no longer return 500 on the render tier. New `src/utils/flareSolverr.js` adds a 30-second-cached availability check + GET helper against a local FlareSolverr instance (`FLARESOLVERR_URL`, default `http://127.0.0.1:8191/v1`). The render tier now tries FlareSolverr first, falls back to cheerio→puppeteer, and escalates back to FS if puppeteer hits a managed challenge. Cookies + UA are passed through to puppeteer for screenshot capture so the rendered DOM matches the bypassed session.

**8 AI-generated PRs reviewed** (v2.25.10, #2057–#2064) — 4 implemented manually with corrections, 4 closed.

| Feature | Endpoint / Plugin |
|---------|-------------------|
| Shazam lyrics | `Shazam.getLyrics({ songId })` or `{ artist, title }` — resolves songId via `track_info`, queries lyrics.ovh, NodeCache-cached |
| LP MM scheduling | `POST /api/crypto/lp/mm/schedule` — Agenda-backed, ISO/natural-language/cron auto-detection (see LP MM section above) |
| P2P session counters | `sessionCount`, `reconnectionCount`, `averageSessionSeconds` now persisted on `P2PPeer` and exposed via `getActivityReport()` |
| Adaptive auth rate limit | `POST /api/external/*` — `express-rate-limit` driven by circuit breaker state (60/10/5 per min CLOSED/HALF_OPEN/OPEN, tunable via `EXTERNAL_AUTH_RATE_*`); keys by `X-Agent-Id` first |

### v2.25.6 — PR Review Pass: 26 PRs (5 merged, 11 implemented, 10 closed)

Reviewed AI-generated PRs #2031–#2056. Merged five directly. Eleven had good ideas but broken implementations — closed with rationale and reimplemented manually with corrections. Ten were closed as fundamentally broken or duplicative.

**New plugin actions:**

```bash
# Whois — schedule a domain expiration alert via Agenda (persisted)
curl -X POST http://localhost/api/plugin \
  -H "X-API-Key: $LANAGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "whois",
    "action": "setExpirationAlert",
    "domain": "example.com",
    "daysBefore": 30
  }'
# → { "success": true, "message": "Expiration alert scheduled for example.com at 2027-..." }

# Cancel any pending alerts for a domain
curl -X POST http://localhost/api/plugin \
  -H "X-API-Key: $LANAGENT_API_KEY" \
  -d '{ "plugin": "whois", "action": "cancelExpirationAlert", "domain": "example.com" }'
# → { "success": true, "cancelled": 1, "message": "Cancelled 1 alert(s) for example.com" }
```

**Calendar reminders — new `sms` and `push` types + recurring `customInterval`:**

```js
// Reminder schema (src/models/CalendarEvent.js)
reminders: [{
  type: 'notification' | 'email' | 'telegram' | 'sms' | 'push',
  minutesBefore: Number,        // default 15
  customInterval: Number,       // optional: minutes between recurring fires until event start
  target: String,               // optional override (phone for sms, FCM token for push)
  sent: Boolean,
  sentAt: Date,
  lastSentAt: Date              // tracks recurring fires
}]
```

When `customInterval > 0` is set, the reminder fires every N minutes from `firstFireTime` (= `event.startDate - minutesBefore*60s`) until `event.startDate`, then auto-finalizes. SMS routes through vonage/sinch/messagebird (in that fallback order); push routes through firebasecloudmessagingfcm. Defaults: `target` falls back to `PHONE_OF_MASTER` (sms) / `FCM_TOKEN_OF_MASTER` (push) env vars.

**Vector intent caching:**

`POST /api/vector-intent/search` now caches results for 5 minutes by SHA-1 of `(query, k, filters)`. Cached responses include `cached: true`. All `/api/vector-intent/*` routes are rate-limited to 100 req per 15 min.

**Auth rate limiting:**

`/api/external/auth/nonce` and `/api/external/auth/verify` are rate-limited to 10 req per minute per IP.

**Device alias advanced search:**

`GET /api/device-aliases?deviceName=...&userId=...&sortBy=usageCount&sortOrder=desc` — filter and sort listings. Cache key includes all params so different queries don't bleed.

**Internal-only additions (no public API surface):**

- `SubAgent.updateConfig({ config, enabled, status })` — runtime config changes with deep-merge into nested subdoc
- `UpsConfig.escalationPolicies[]` + `applyEscalationPolicy(durationMinutes, severity)` — auto-applied in `UpsService.sendNotifications`
- `cryptoManager.rotateDhKeys()` — rotates X25519 only, preserves fingerprint
- `peerManager.getActivityReport()` — persisted connection time + transfer counts
- `KnowledgePack.trackUsage(packId, peer, importTimeMs)` / `getAnalytics(filter)` — wired into `importPack`
- `DevelopmentPlan.archiveOldCompletedItemsBatch(days, batchSize)` — paginated archival
- `AgentCoordination.bulkAcceptParticipants(intentHash, accepts)` / `batchUpdateExecutionResults(intentHash, updates)` — `arrayFilters`-scoped
- `generateProfessionalSignature({ ..., includeQRCode: true })` — embeds vCard QR

---

## Recent Updates (April 9, 2026)

### v2.24.2 — PR Review Pass: Scheduled Jobs + Misc Hardening

Twelve ALICE-generated PRs were reviewed in one pass. Seven were merged (six small + one new replacement PR), three closed as broken, three reimplemented correctly via Agenda.

**New Agenda jobs (registered in `src/services/scheduler.js`):**

| Job name | Schedule | Purpose |
|---|---|---|
| `archive-old-dev-items` | daily 02:30 | Archives `DevelopmentPlan` items with `status: completed` and `completedAt` older than 30 days |
| `email-lease-expiration-warnings` | daily 09:00 | Warns `EmailLease` holders 7 days before lease expiry via the existing `email` plugin |
| `zapier-run-zap` | one-shot (data-driven) | Dispatches user-scheduled Zap runs created via the new `schedule_zap` action |

**New plugin action — Zapier `schedule_zap`:**

```bash
# Schedule a Zap to run at a specific ISO 8601 time
curl -X POST http://localhost/api/plugin \
  -H "X-API-Key: $LANAGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "zapier",
    "action": "schedule_zap",
    "data": { "zapId": "12345", "time": "2026-12-25T10:00:00Z" }
  }'
# → { "success": true, "message": "Zap 12345 scheduled to run at 2026-12-25T10:00:00.000Z", "jobId": "..." }
```

Past times and invalid ISO strings are rejected. The job is persisted in Agenda's `scheduled_jobs` collection and survives restarts. Internally, the plugin calls `agent.scheduler.agenda.schedule(date, 'zapier-run-zap', { zapId })`; the `zapier-run-zap` job then resolves the live zapier plugin instance and calls `runZap({ zapId })` at the scheduled time.

**Zapier `pause_zap` / `resume_zap` (v2.25.4):**

```bash
# Pause a Zap
curl -X POST http://localhost/api/plugin \
  -H "X-API-Key: $LANAGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "plugin": "zapier", "action": "pause_zap", "data": { "zapId": "12345" } }'

# Resume a paused Zap
curl -X POST http://localhost/api/plugin \
  -H "X-API-Key: $LANAGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "plugin": "zapier", "action": "resume_zap", "data": { "zapId": "12345" } }'
```

**Other features merged in this pass:**

- **`RuntimeError.correlationId`** — indexed field plus `RuntimeError.getErrorsByCorrelationId(id)` static for grouping related errors from a single request/operation.
- **`TrustAttestation` cache + retry** — `getTrustLevel`, `getTrustGraph`, and `getBySource` are now wrapped in `retryOperation` (3 retries) and a 10-minute NodeCache.
- **Donations API hardening** — `/api/donations/*` now sits behind express-rate-limit (100 req / 15 min / IP). `/donations/addresses` is cached for 5 minutes. `/donations/track` retry adds `randomize: true` jitter.
- **MCPServer status webhooks** — optional `webhookUrl` field on `MCPServer` documents. Set it and `updateStatus()` will POST `{serverName, status, error, timestamp}` to the URL on every status change. Webhook failures don't block the status update.
- **Uncensored provider error categorization** — `generateResponse` now logs API errors (with status + body), network errors, and unexpected errors separately.
- **Git hosting MFA scaffolding** — `GitHostingSettings` now has `github.mfa`, `gitlab.mfa`, and `bitbucket.mfa` subdocuments (`{ enabled, method }` where `method` ∈ `sms`/`authenticator`/`email`). `getActiveProviderConfig()` returns the MFA settings; `checkAndEnforceMFA()` instance method is a logging stub ready to wire to actual enforcement.

---

## Recent Updates (March 28, 2026)

### v2.21.0 — SkynetDiamond + LP Staking + Treasury Pools

All on-chain protocols consolidated into a single Diamond Proxy contract.

**New Staking API Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/staking/info` | Token staking position, rewards, APY |
| GET | `/api/staking/stats` | Contract-wide staking stats |
| GET | `/api/staking/tiers` | Lock tier configurations |
| POST | `/api/staking/stake` | Stake SKYNET `{amount, tierId}` |
| POST | `/api/staking/unstake` | Unstake SKYNET `{amount}` |
| POST | `/api/staking/claim` | Claim pending rewards |
| GET | `/api/staking/lp/info` | LP staking position, rewards, APY |
| GET | `/api/staking/lp/tiers` | LP lock tier configurations |
| POST | `/api/staking/lp/stake` | Stake LP tokens `{amount, tierId}` |
| POST | `/api/staking/lp/unstake` | Unstake LP tokens `{amount}` |
| POST | `/api/staking/lp/claim` | Claim LP staking rewards |
| GET | `/api/staking/treasury` | Treasury pool balances + auto-fund status |
| GET | `/api/staking/vault/stats` | Vault stats: deposited, stakers, pending rewards, paused |
| GET | `/api/staking/vault/address` | Vault contract address from SystemSettings |
| POST | `/api/staking/vault/compound` | Trigger vault compound for all SKYNET auto-compound users (earns 0.1% bounty) |
| POST | `/api/staking/vault/compound-lp` | Trigger vault LP compound for all LP auto-compound users |

**SkynetVault (`0x220dCBd455161435897eE083F95451B3f7eC20E6`):**
Auto-compounding staking vault. Users deposit via skynettoken.com DApp with auto-compound toggle. ALICE compounds every 12 hours via `skynet-vault-compound` scheduler job. Any LANAgent instance with `skynet_vault_address` in SystemSettings will auto-compound and earn the 0.1% bounty.

**Multi-instance setup:** Set `skynet_vault_address` in SystemSettings to enable vault compound for any LANAgent instance.

**Web UI:** Crypto tab includes LP staking section and treasury pools dashboard. skynettoken.com has full Web3 staking DApp with vault integration.

**Generic Plugin Service Proxy (17 plugins, 97+ actions):**

All plugin services are now accessible via a single generic endpoint:

```
POST /service/:plugin/:action
X-API-Key: gsk_your_key
Content-Type: application/json

{ ...params }
```

| Plugin | Actions | Credits | Description |
|--------|---------|---------|-------------|
| anime | search, details, top, recommendations, seasonal, random | 1 | MyAnimeList data |
| chainlink | price, feeds, historical, compare, info | 1 | Chainlink oracle prices — 97 feeds on 7 networks + CoinGecko fallback (free) |
| lyrics | get, search, synced | 1 | Song lyrics (plain + LRC synced) |
| nasa | apod, marsRoverPhotos, neo, earthImagery, epic, launchSchedule, adsSearch | 1 | NASA public data |
| weatherstack | getCurrentWeather, getWeatherDescription, getHistorical, getForecast, getWeatherAlerts | 1 | Weather data |
| news | headlines, everything, sources, getPersonalizedNews | 1 | News articles |
| websearch | search, stock, crypto, weather, news | 2 | Real web search (Anthropic/OpenAI), stocks, crypto, weather |
| scraper | scrape, screenshot, pdf, extract, bulk | 2 | Web scraping |
| ytdlp | download, info, search, audio, playlist, transcribe | 3 | YouTube download |
| ffmpeg | convert, extract, compress, info, concat, trim | 5 | Media processing |
| huggingface | textClassification, sentimentAnalysis, textSummarization, questionAnswering, translation, fillMask, zeroShotClassification, featureExtraction, imageCaption, namedEntityRecognition, languageDetection, textSimilarity, spamDetection | 10 | HuggingFace AI inference — 13 NLP/vision tasks |
| aiDetector | detectText, detectImage, detectAudio, detectVideo, autoDetect | 5 | AI content detection (text/image/audio/video) |
| challengeQuestions | generate, generateWithAnswers, verify, types, trackPerformance | 2 | Bot-filtering challenge questions (8 types, 70% pass threshold, adaptive difficulty) |
| tokenProfiler | audit, honeypotCheck, holderAnalysis, score | 3 | ERC20 token scam/safety analysis via GoPlus |
| walletProfiler | profile, tokens, riskScore | 3 | Crypto wallet profiling and risk scoring |
| contractAudit | audit, quickCheck, explain | 5 | Solidity smart contract security audit |
| imageTools | optimize, resize, crop, convert, watermark, metadata, transform | 2 | Image processing — Sharp-powered optimize, resize, crop, format convert, watermark, multi-op transforms |

**Service Catalog:** `GET /service/catalog` — returns all available services with descriptions and credit costs.

**Adding new paid services:** See `docs/ADDING_PAID_SERVICES.md` for the full checklist — plugin, allowlist, P2P config, gateway registration, and testing.

**Auto-Pricing:** Prices adjust every 15 minutes from PancakeSwap LP reserves + Chainlink BNB/USD oracle. Controlled by `skynet.autoPriceEnabled` SystemSetting (toggle in Web UI). Services are priced in USD and converted to credits/SKYNET/BNB dynamically. API: `GET/POST /p2p/api/skynet/services/auto-price-status`, `/auto-price-toggle`.

**Example — Anime Search:**
```bash
curl -X POST https://api.lanagent.net/service/anime/search \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"query": "Cowboy Bebop"}'
```

**Example — Lyrics:**
```bash
curl -X POST https://api.lanagent.net/service/lyrics/search \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"query": "bohemian rhapsody"}'
```

**Example — HuggingFace Sentiment Analysis:**
```bash
curl -X POST https://api.lanagent.net/service/huggingface/sentimentAnalysis \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "I absolutely love this product!"}'
# → { "success": true, "result": "POSITIVE: 100.0%", "model": "distilbert/...", "creditsCharged": 10 }
```

**Example — HuggingFace Summarization:**
```bash
curl -X POST https://api.lanagent.net/service/huggingface/textSummarization \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris. It is named after the engineer Gustave Eiffel, whose company designed and built the tower from 1887 to 1889. The tower is 330 metres tall."}'
# → { "success": true, "result": "The Eiffel Tower is a wrought-iron lattice tower...", "model": "facebook/bart-large-cnn" }
```

**Example — HuggingFace Question Answering:**
```bash
curl -X POST https://api.lanagent.net/service/huggingface/questionAnswering \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"question": "When was it built?", "context": "The Eiffel Tower was built from 1887 to 1889."}'
# → { "success": true, "result": "Answer: 1887 to 1889 (confidence: 67.4%)" }
```

**Example — HuggingFace Translation:**
```bash
curl -X POST https://api.lanagent.net/service/huggingface/translation \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "Good morning, how are you?"}'
# → { "success": true, "result": "Bonjour, comment allez-vous ?", "model": "Helsinki-NLP/opus-mt-en-fr" }
# For other language pairs, specify model: "Helsinki-NLP/opus-mt-en-de" (EN→DE), "Helsinki-NLP/opus-mt-en-es" (EN→ES), etc.
```

**Example — HuggingFace Zero-Shot Classification:**
```bash
curl -X POST https://api.lanagent.net/service/huggingface/zeroShotClassification \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "I need a new phone", "candidate_labels": ["shopping", "travel", "food"]}'
# → { "success": true, "result": "Classification: shopping (71.8%)", "data": { "label": "shopping", "score": 0.718 } }
```

**Note:** News and weather require API keys configured on the agent. Check `GET /service/catalog` for the live list of available services. Text generation is not available on the free HuggingFace tier.

**Example — Image Optimize (convert to WebP):**
```bash
curl -X POST https://api.lanagent.net/service/imageTools/optimize \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/photo.jpg", "format": "webp", "quality": 80}'
# → { "success": true, "data": { "image": "data:image/webp;base64,...", "format": "webp", "width": 1200, "height": 800, "size": 45230, "compressionRatio": "62%" } }
```

**Example — Image Resize:**
```bash
curl -X POST https://api.lanagent.net/service/imageTools/resize \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/photo.jpg", "width": 400, "height": 300, "fit": "cover", "format": "jpeg"}'
```

**Example — Multi-step Transform (resize + grayscale + blur + convert):**
```bash
curl -X POST https://api.lanagent.net/service/imageTools/transform \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/photo.jpg", "operations": [{"op": "resize", "width": 800}, {"op": "grayscale"}, {"op": "sharpen", "sigma": 2}, {"op": "format", "format": "webp", "quality": 75}]}'
```

**Example — Add Watermark:**
```bash
curl -X POST https://api.lanagent.net/service/imageTools/watermark \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/photo.jpg", "text": "© 2026 MyCompany", "position": "bottom-right", "opacity": 0.4}'
```

**Image Tools — All Commands:** optimize, resize, crop (manual or smart/attention-based), convert (png/jpeg/webp/avif/tiff), watermark (text overlay), metadata (dimensions/format/EXIF), transform (chain multiple ops). Input: `url` or `base64`. Output: base64 data URI + metadata. Max input: 20MB. Max dimension: 8192px.

**Example — Chainlink Price Feed (via generic plugin proxy):**
```bash
curl -X POST https://api.lanagent.net/service/chainlink/price \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"pair": "BTC"}'
# → { "success": true, "data": { "pair": "BTC/USD", "price": 66500.12, "network": "bsc",
#      "roundId": "55340232221129480559", "feedAddress": "0x264990...", "decimals": 8 },
#    "creditsCharged": 1 }
```

**Example — Chainlink Price (via dedicated gateway route):**
```bash
curl https://api.lanagent.net/price/BTC \
  -H 'X-API-Key: gsk_your_key'
# Same result — gateway route proxies to the plugin
```

**Example — CoinGecko Fallback (tokens without Chainlink feeds):**
```bash
curl -X POST https://api.lanagent.net/service/chainlink/price \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"pair": "FLOKI"}'
# → { "success": true, "data": { "pair": "FLOKI/USD", "price": 0.00002728,
#      "source": "coingecko",
#      "sourceNote": "Fallback — no Chainlink decentralized oracle feed exists for this token..." },
#    "creditsCharged": 0, "creditsRefunded": 1 }
# NOTE: CoinGecko fallback results are FREE (auto-refunded). The "source" field tells you
# whether the price came from Chainlink (decentralized oracle) or CoinGecko (centralized API).
```

**Chainlink Price Feed — Supported Networks & Pairs:**

| Network | Pairs | Example Tokens |
|---------|-------|----------------|
| Ethereum | 30 | ETH, BTC, LINK, AAVE, UNI, DOGE, XRP, ADA, SOL, DOT, AVAX, ARB, MKR, COMP, SNX, USDT, USDC, DAI, STETH, WBTC, LTC, FIL... |
| BSC | 20 | BNB, ETH, BTC, DOGE, ADA, XRP, SOL, AVAX, UNI, AAVE, LTC, FIL, ATOM, CAKE, NEAR, USDT, DAI... |
| Arbitrum | 13 | ETH, BTC, ARB, LINK, SOL, AAVE, UNI, COMP, MKR, OP, PEPE... |
| Polygon | 14 | MATIC, ETH, BTC, SOL, DOGE, AVAX, UNI, CRV, SNX... |
| Optimism | 8 | ETH, BTC, SOL, USDC, DAI, SNX, AAVE, UNI |
| Base | 7 | ETH, BTC, LINK, USDC, DAI, COMP, OP |
| **Total** | **~97** | + CoinGecko fallback for 60+ additional tokens |

**Pair input is flexible:** `BTC`, `btc`, `BTC/USD`, `btcusd` all work. If no network is specified, defaults to BSC with auto-discovery across other networks.

**Action aliases:** `history` → `historical`, `list`/`pairs` → `feeds`, `get`/`quote` → `price`, `details` → `info`

**Dedicated Gateway Price Routes:**

| Route | Method | Description |
|-------|--------|-------------|
| `/price/:pair` | GET | Get current price (e.g., `/price/BTC`, `/price/ETH?network=ethereum`) |
| `/price/feeds` | GET | List available feeds (`?network=bsc` or `?network=all`) |
| `/price/:pair/info` | GET | Feed metadata (contract address, decimals, version) |
| `/price/:pair/history` | GET | Historical price (`?roundId=...&network=bsc`) |
| `/price/compare` | POST | Compare Chainlink vs CoinGecko (`{"pair": "ETH"}`) |

**Currently working (15 services, ~60 commands):**
anime, chainlink, huggingface, lyrics, nasa, news, websearch, scraper, ytdlp, ffmpeg + dedicated routes (image gen, code sandbox, document OCR, PDF toolkit, YouTube download, price feeds)

**Temporarily unavailable:** Weatherstack (needs API key). HuggingFace text generation requires HF Pro (free tier no longer supports it).

### Portal Management Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/portal/signup` | None | Create account, get API key. Also fires welcome + email-verification emails. |
| POST | `/portal/login` | None | Login, get JWT |
| GET | `/portal/dashboard` | JWT or API key | Credits, keys, payments |
| GET | `/portal/usage?days=14` | JWT or API key | Usage chart data (daily/hourly) |
| POST | `/portal/checkout` | JWT | Start Stripe checkout |
| POST | `/portal/api-keys` | JWT | Create new API key (sends "key created" notification email) |
| POST | `/portal/api-keys/regenerate` | JWT | Revoke all keys + create new (sends both notifications) |
| DELETE | `/portal/api-keys/:key` | JWT | Revoke specific key (sends notification email) |
| GET | `/portal/packages` | None | Available credit packages |
| POST | `/portal/forgot-password` | None | Request password-reset email. Always returns 200 (doesn't leak which addresses are registered). |
| POST | `/portal/reset-password` | None | Consume reset token + set new password. Body: `{ token, password }`. |
| GET | `/portal/reset?token=…` | None | HTML form for resetting (linked from reset email). |
| GET | `/portal/verify?token=…` | None | One-shot email verification page. Flips `emailVerified=true`. |
| POST | `/portal/resend-verification` | JWT | Send a fresh verification email. |

**Usage-threshold notifications** (v2.25.13+) — emails fire automatically as a user's subscription quota or credit balance crosses 80% / 90% / 100%. Subscription thresholds reset on `invoice.paid` (`subscription_cycle`); credit thresholds reset on each completed `checkout.session.completed`. Schema fields on `PortalUser`: `creditAlertBaseline` and `notifications.{credits,subBasic,subRender}{80,90,100}`. Send is fire-and-forget — request handlers never block on SMTP.

**Email infrastructure** (v2.25.13+) — gateway has SMTP transport over `mail.lanagent.net:587` via a dedicated `noreply@lanagent.net` mailbox. Templates and `sendEmail()` helper live in `email.mjs`. Sender displays as `LANAgent API <noreply@lanagent.net>` to distinguish service-level alerts from agent-level mail.

**Support inbox** (v2.25.13+) — `support@lanagent.net` mailbox is monitored by a `support-poller` PM2 service on the gateway VPS. New tickets fire enriched Telegram notifications including 7-day account context (sub state, credits, recent failures, top failing routes, last payment). See `docs/proposals/ai-support-system.md` for the v3+ roadmap (LLM-drafted replies, auto-send for trusted categories, proactive support).

**Diamond contract:

**Diamond:** `0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7` (BSC mainnet, [BscScan](https://bscscan.com/address/0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7))

14 facets: Staking, LP Staking, Scammer Registry, Commerce (ERC-8183), Oracle (ERC-8033), Coordination (ERC-8001), Trust (ERC-8107), Credentials (ERC-1155), PancakeSwap Swap, Fee Router, Admin + 3 diamond standard facets. 134 function selectors, all verified on BscScan.

Fee split: 40% token staking / 50% LP staking / 10% reserve. All owner-adjustable. Accepts BNB or SKYNET, auto-converts.

Replaces SkynetHub, AgenticCommerceJob, AgentCouncilOracle, AgentCoordination, ENSTrustRegistry. 98 scammers migrated, 30K SKYNET staked.

---

### v2.20.8 — Stealth Scraper, Gateway Route Fixes, Auto-Replenishment Confirmed

**Scraper Stealth Upgrade:**
- `puppeteer-extra` + `puppeteer-extra-plugin-stealth` — 16 evasion modules (navigator.webdriver, chrome.runtime, WebGL, plugins, languages)
- Non-headless mode via Xvfb for better fingerprinting, persistent Chrome profile for cookie reuse
- Realistic `sec-ch-ua` Client Hints and Sec-Fetch headers
- 30-second Cloudflare challenge wait with resolution detection
- Returns `cloudflareBlocked: true` error for Turnstile managed challenges (instead of challenge page HTML)
- **Limitation:** Cloudflare Turnstile sites (e.g. Rumble) remain blocked — requires per-instance CAPTCHA solving service

**Gateway Route Fixes (all 8 services now working):**
- Image gen: initialized with agent's `providerManager` (was returning 503)
- PDF text extract: `/pdf/text` alias added (gateway routes to `/text`, agent had `/extract`)
- Documents OCR + PDF routes: now accept `fileUrl` and `fileBase64` in JSON body (gateway sends JSON, not multipart)
- File upload middleware: skips magic byte validation for JSON file inputs
- Gateway agent URL: fixed from `api.lanagent.net` (loop) to direct VPN address

**Auto-Replenishment Confirmed On-Chain:**
- Full loop: BNB → SKYNET swap via PancakeSwap V2 → transfer to agent → agent credits gateway account
- All services now run on real SKYNET token payments, no manual credit injection
- Gateway wallet: See your `.env` file for `GATEWAY_WALLET_ADDRESS` (send BNB on BSC to fund)

**Service endpoints accepting JSON file input (gateway-compatible):**

| Service | JSON Body Fields |
|---------|-----------------|
| `POST /documents/process` | `fileUrl`, `fileBase64`, `operation` (`ocr`/`extract`), `language`, `outputFormat` |
| `POST /pdf/text` | `fileUrl`, `fileBase64`, `format` (`text`/`json`) |
| `POST /pdf/merge` | multipart only (multiple files) |
| `POST /pdf/split` | multipart only |
| `POST /pdf/compress` | multipart only |

---

### v2.20.7 — Unified API Gateway (March 27, 2026)

See below for full gateway documentation.

---

### v2.20.6 — External Service Credit System

Clients can now purchase credits via BNB or SKYNET and use them across all 8 paid services. No per-request on-chain transactions needed after initial purchase.

**Base URL:** `https://api.lanagent.net/api/external`

---

### Authentication

Wallet signature proves ownership → JWT for key management → API key for all service calls.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/nonce?wallet=0x...` | None | Get signing nonce (5min expiry) |
| POST | `/auth/verify` | None | Verify signature → JWT (1h) |
| POST | `/auth/api-key` | JWT | Generate API key (`lsk_*`) |
| DELETE | `/auth/api-key/:key` | JWT | Revoke API key |
| GET | `/auth/api-keys` | JWT | List API keys |

**Verify body:** `{ "wallet": "0x...", "signature": "0x...", "nonce": "lanagent_auth_..." }`

**Generate key body:** `{ "name": "my-app" }`

---

### Credits

1 credit = $0.01 USD. Prices pegged dynamically via Chainlink (BNB) and DexScreener (SKYNET).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/credits/price` | None | Current credit prices in BNB and SKYNET |
| POST | `/credits/purchase` | API key or JWT | Purchase credits with on-chain tx hash |
| GET | `/credits/balance` | API key or JWT | Check credit balance |

**Purchase body:** `{ "txHash": "0x...", "currency": "BNB" }` (or `"SKYNET"`)

Minimum purchase: 10 credits. Double-spend protected.

---

### Service Catalog

| Service | Credits | Tier |
|---------|---------|------|
| Web Scrape (metadata + text) | 1 | basic |
| Web Scrape (Puppeteer forced) | 2 | stealth |
| Web Scrape (+ raw HTML) | 3 | full |
| Web Scrape (+ HTML + screenshot, Cloudflare bypass) | 5 | render |
| YouTube Download (MP4) | 10 | — |
| YouTube Audio (MP3) | 8 | — |
| Media Transcoding | 20 | — |
| AI Image Generation | 30 | — |
| Document Processing (OCR) | 10 | — |
| Code Execution Sandbox | 20 | — |
| PDF Toolkit | 5 | — |

Full catalog: `GET /catalog`

---

### Scraping

**Single URL:**
```
POST /scrape
X-API-Key: gsk_your_key
Content-Type: application/json

{ "url": "https://example.com", "tier": "basic" }
```

Response:
```json
{
  "success": true,
  "url": "https://example.com",
  "data": {
    "title": "Example Domain",
    "description": "...",
    "ogImage": "https://example.com/image.png",
    "text": "This domain is for use in illustrative examples...",
    "links": [{ "href": "https://...", "text": "More info" }],
    "images": [],
    "structuredData": [],
    "html": "(full/render tier only)",
    "screenshot": "(render tier only, base64 PNG)"
  },
  "tier": "basic",
  "creditsCharged": 1,
  "creditsRemaining": 99
}
```

**Batch (max 100 URLs):**
```
POST /scrape/batch
X-API-Key: gsk_your_key
Content-Type: application/json

{ "urls": ["https://a.com", "https://b.com"], "tier": "basic" }
```

Response includes per-URL results. Failed URLs are refunded automatically.

---

### Auto-Refund

If a service call fails due to the target (4xx/5xx, timeout, blocked), credits are **not charged**. The response includes:
```json
{ "success": false, "error": "Target returned 403", "targetError": true, "credited": true, "creditsRefunded": 1 }
```

Client errors (invalid URL, unsupported format) ARE charged.

---

### Legacy Payment

All services also accept direct on-chain payment without an account:
```
POST /scrape
X-Payment-Tx: 0x_your_bnb_payment_tx_hash
X-Agent-Id: your_erc8004_agent_id
Content-Type: application/json

{ "url": "https://example.com" }
```

First call without payment returns 402 with price and recipient address.

---

### Direct Agent Access (Advanced)

If you want to bypass the gateway and talk to a specific agent directly (e.g., for testing or if you run your own agent), use `api.lanagent.net/api/external` with `lsk_*` keys:

```
Base URL: https://api.lanagent.net/api/external
API key prefix: lsk_*
Auth flow: same as gateway (nonce → sign → JWT → API key)
```

Same endpoints as the gateway but without multi-agent routing or failover. Replace `https://api.lanagent.net` with `https://api.lanagent.net/api/external` and `gsk_*` with `lsk_*`. No Stripe portal — crypto payment only.

---

## Recent Updates (April 5, 2026)

### v2.23.0 — AI Content Detector

**New plugin: `aiDetector` — detect AI-generated text, images, video, and audio.**

Powered by a Python FastAPI microservice (port 5100) with lazy-loaded ML models:
- **Text:** GPT-2 perplexity + burstiness analysis. AI text has low, uniform perplexity; human text is variable.
- **Image:** ViT classifier (`umm-maybe/AI-image-detector`). Detects AI-generated images by visual artifact patterns.
- **Video:** FFmpeg key frame extraction → per-frame image analysis → majority-vote aggregation.
- **Audio:** Whisper transcription → text analysis on the transcript.

All models run on CPU by default, auto-detect and use GPU (CUDA) when available.

**Plugin Commands:**

| Action | Description | Input |
|--------|-------------|-------|
| `detectText` | Analyze text for AI generation | `{text: "..."}` |
| `detectImage` | Analyze image for AI generation | `{url: "..."}` or `{buffer: ...}` or `{path: "..."}` |
| `detectVideo` | Extract frames and analyze | `{url: "..."}` or `{path: "..."}` |
| `detectAudio` | Transcribe and analyze speech | `{url: "..."}` or `{buffer: ...}` |
| `detect` | Auto-detect content type | Any of the above |
| `status` | Service health check | None |

**API Usage:**
```bash
# Text detection
curl -X POST http://localhost/api/plugin \
  -H 'X-API-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"plugin":"aiDetector","action":"detectText","text":"Your text here..."}'

# Image detection via URL
curl -X POST http://localhost/api/plugin \
  -H 'X-API-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"plugin":"aiDetector","action":"detectImage","url":"https://example.com/image.jpg"}'
```

**Response format:**
```json
{
  "success": true,
  "type": "text",
  "verdict": "ai_generated|human|uncertain",
  "confidence": 0.85,
  "score": -0.69,
  "reasoning": "Perplexity: 14.4 (AI<35, human>60)..."
}
```

**Telegram:** Use `/aidetect` command, then send text, photos, voice messages, or audio files.

**Python service managed by PM2** as `ai-detector` process. Models lazy-load on first request (~10-30s), then stay cached (~1GB RAM total).

**External Paid API (api.lanagent.net):**
```bash
# Via credit-based plugin proxy (5 credits per call, 1 credit = $0.01)
POST /api/external/service/aiDetector/detectText
POST /api/external/service/aiDetector/detectImage
POST /api/external/service/aiDetector/detectAudio
POST /api/external/service/aiDetector/detectVideo
POST /api/external/service/aiDetector/detect

# Auth: X-API-Key header (lsk_* format) or Authorization: Bearer <JWT>
# Get credits: POST /api/external/credits/purchase
```

**P2P / Skynet Service:**
Available as a paid service on the Skynet P2P network. Other agents can discover and consume detection via the service catalog. Service IDs: `aiDetector:detectText`, `aiDetector:detectImage`, `aiDetector:detectAudio`, `aiDetector:detectVideo`, `aiDetector:detect`. Priced in SKYNET tokens, configurable per-agent via the web UI under P2P Services.

### v2.22.0 — Self-Modification Claude Compatibility & Provider Fixes

**Self-modification capability scanner fixes:**
- Rewrote JSON response parser for Claude API compatibility — strips nested code fences, uses first/last brace extraction, falls back to regex-based individual object extraction for malformed JSON
- Increased analysis timeout from 30s to 60s for Claude's slower response times
- Disabled web search for code analysis calls (unnecessary overhead)
- Added file existence validation before attempting upgrades — prevents ENOENT crashes on stale discovered features
- AI-suggested target files are now verified before accepting
- Stale discovered features automatically marked as rejected with cleanup (rejected: 3 days, stale: 30 days, implemented: 7 days)

**No API changes** — all changes are internal to the self-modification pipeline and provider management.

### v2.21.9 — ARR Service Update Monitoring

**Daily update checker for *arr services:**
- Scheduled job `arr-update-check` runs daily at 8 AM
- Checks all configured *arr services: Prowlarr, Radarr, Sonarr, Lidarr, Readarr
- Uses built-in *arr `/update` API endpoint, falls back to GitHub releases API
- Sends Telegram notification when updates are available, flags major version bumps with changelog snippets
- Manual check via natural language: "check prowlarr for updates", "are my arr services up to date"

**New action on all *arr plugins:**
- `check_updates` — returns current version, latest version, whether update is available, major/minor flag, release URL, changelog

**New base class methods:**
- `ArrBasePlugin.checkForUpdate()` — per-service update check
- `ArrBasePlugin.checkAllArrUpdates(agent)` — check all configured *arr services at once

---

### v2.21.8 — Auto-Post Sensitive Content Filter

**Shared auto-post filter utility (`src/utils/autoPostFilter.js`):**
- Prevents agent from posting about business plans, outreach, partnerships, monetization, pricing, investor relations, or internal proposals
- Three-layer filtering: git pathspec exclusions (`docs/proposals/`, `docs/sessions/`), commit message keyword regex, AI prompt rules
- Reusable across all social platforms (MindSwarm, Telegram, X) — import `filterSensitiveCommits`, `getExcludedPathspecs`, `getSensitiveContentRules`
- MindSwarm `_gatherPostContext()` and `_dailyAutoPost()` updated to use shared filter
- MindSwarm `_getEngagementRules()` updated with sensitive content prohibitions (applies to all AI interactions, not just auto-posts)

---

## Recent Updates (March 26, 2026)

### v2.20.5 — Moralis Token Scanner, contractCommands Fixes, Staking History UI

**Moralis Token Scanner (optional enhancement):**
- `POST /api/crypto/tokens/moralis/api-key` — store Moralis API key (encrypted)
- `GET /api/crypto/tokens/moralis/status` — check if configured
- Discovers ALL ERC-20 tokens in wallet including airdrops, with spam detection
- Web UI: Moralis API Key field in Crypto → Wallet Settings
- Falls back to RPC scanning if no key — fully optional

**contractCommands Fixes:**
- `tokenTransfer` network parameter bug fixed (object vs string)
- `tokenTransfer` now uses direct ethers.js contract call instead of missing `writeContract`
- Plugin route properly unwraps nested `params` objects

**Staking History UI Fix:**
- Date, type labels, and BscScan tx links now render correctly

**Agent Knowledge:**
- System prompt includes `lanagent.net` and `skynettoken.com` URLs
- MindSwarm engagement rules include project URLs for posts and replies

---

### v2.21.3 — MindSwarm v2.0, Chainlink 97 Feeds, HuggingFace v2.0, WebSearch v2.0

**MindSwarm Plugin v2.0 (153+ commands, +82 new — full API coverage):**

| Category | New Commands | Count |
|----------|-------------|-------|
| AI Features | `getAIProviders`, `getAISiteStatus`, `addAIKey`, `listAIKeys`, `updateAIKey`, `revokeAIKey`, `aiTool`, `aiReply`, `aiModerate`, `aiGenerateImage`, `aiSummarize`, `getAIUsage`, `toggleAutoReply` | 13 |
| Groups (full CRUD) | `getGroups`, `getGroup`, `updateGroup`, `joinGroupByInvite`, `updateMemberRole`, `removeMember`, `banFromGroup`, `unbanFromGroup`, `approveJoinRequest`, `generateGroupInvite`, `getUserGroups`, `getGroupPosts` | 12 |
| Admin | `adminDashboard`, `adminGetUsers`, `adminGetUser`, `adminUpdateUser`, `adminAddBadge`, `adminRemoveBadge`, `adminBatchOperation`, `adminGetSettings`, `adminUpdateSettings`, `adminKillSwitch`, `adminBlockedCountries`, `adminBlockedEmailDomains`, `adminReservedUsernames`, `adminBlacklistedWords`, `adminBlacklistScan`, `adminGetReports`, `adminReviewReport`, `adminManageTokens`, `adminResolveToken`, `adminSystemHealth`, `adminIPBan`, `adminAPIUsage`, `adminNukeAccount`, `adminSiteAIStatus`, `adminSiteAIConfig`, `adminAIImageAccess`, `adminSupportTickets`, `adminUpdateTicketStatus` | 28 |
| Drafts (extended) | `autosaveDraft`, `getScheduledDrafts`, `getDraftStats`, `getDraft`, `restoreDraftVersion` | 5 |
| Post extras | `getAnalyticsSummary`, `aiImage`, `codeSandbox`, `getAIImageAccess` | 4 |
| Push Notifications | `getVapidKey`, `subscribePush`, `unsubscribePush` | 3 |
| Notification Prefs | `updateNotificationPreferences`, `deleteAllNotifications` | 2 |
| Follow Requests | `getFollowRequests`, `handleFollowRequest` | 2 |
| User extras | `regenerateReferralCode`, `gravatarSync` | 2 |
| Moderation Appeals | `submitAppeal`, `reviewAppeal` | 2 |
| Data Export | `deleteAccount`, `cancelDeletion` | 2 |
| Developer Apps | `changeAppStatus`, `getAppUsage` | 2 |
| **Total new** | | **82** |

Reference implementation for the MindSwarm API — covers every endpoint in the [Plugin & API Guide](https://mindswarm.net/docs/PLUGIN-AND-API-GUIDE.md).

**Other changes in this release:**
- Chainlink price feeds: 97 oracle feeds across 7 networks + CoinGecko fallback (free)
- HuggingFace v2.0: 8 NLP tasks on new `router.huggingface.co` API
- WebSearch v2.0: real web search via Anthropic/OpenAI, weather via wttr.in
- Gateway: graceful `{success: false}` no longer returns HTTP 500
- Dashboard: real request counts from audit log, SKYNET/USD price display
- Autonomous LP staking: 6,261 LP staked at Tier 3 (3x), auto-claim/re-stake/compound cycle
- PancakeSwap liquidity: $341 → $1,209 (39.6M SKYNET + 1 BNB)
- Token economics docs: `docs/contracts/SKYNET-Token-Economics.md` (4.7yr runway, sustainability analysis)
- All 3 sites updated (lanagent.net, api.lanagent.net, skynettoken.com)
- **SKYNET Telegram Bot** (`@SkynetAPIBot`) — public showcase of all API services. 30+ commands, free with daily limits. On-chain event broadcasting to @skynet_events, token transfer tracking to @skynet_tracker. BSC wallet with auto-credit purchase from gateway.
- **Welcome Package** — new agents auto-receive 200 SKYNET + @lanagent.net email from genesis agent via P2P after 60-min uptime verification. Toggle: `skynet.welcomePackageEnabled`.
- **Identity API** — `GET /api/identity/status` (ENS + email + welcome status), `POST /api/identity/ens` (request subname), `POST /api/identity/email` (request email), `GET /api/identity/wallet` (balances), `POST /api/identity/buy-skynet` (BNB→SKYNET swap), `GET /api/identity/welcome-status`

---

### v2.20.4 — Uncensored AI Provider, MindSwarm 130 Commands, 4 PR Features

**Uncensored AI Provider:**
- New provider at `src/providers/uncensored.js` — OpenAI-compatible API via axios
- Selectable in web UI alongside Anthropic, OpenAI, Gab, HuggingFace, Ollama, BitNet
- `UNCENSORED_API_KEY` environment variable

**MindSwarm Plugin (130 commands, +33 new):**

| Category | New Commands |
|----------|-------------|
| Posts | `getGifs`, `getBoostedPosts`, `blurReply` + `scheduledAt`/`replyAudience`/`contentWarning` on createPost |
| Users | `getBlockedUsers`, `getMutedUsers`, `getUserLikes`, `updateSettings` |
| Messages | `createGroupConversation`, `reactToMessage`, `deleteMessage`, `getUnreadMessages` |
| Lists | `updateList`, `deleteList`, `subscribeToList`, `unsubscribeFromList` |
| Support Tickets | `createTicket`, `getMyTickets`, `getTicket`, `replyToTicket` |
| Developer Apps | `getApps`, `createApp`, `getApp`, `updateApp`, `regenerateAppKey` |
| Data Export | `requestDataExport`, `getExportHistory`, `downloadExport` |
| Analytics | `getAnalyticsDashboard`, `compareAnalytics`, `getAnalyticsInsights`, `exportAnalytics`, `trackEvent` |
| Ads | `trackAdEvent` |

**PR Review (4 PRs — all implemented manually):**
- Resource usage prediction, UPS status caching, LP position caching, PII detection (SSN + credit card)

---

## Recent Updates (March 25, 2026)

### v2.20.3 — Auto-Post Overhaul, P&L Alignment, PR Review (13 PRs)

**MindSwarm Auto-Post Overhaul:**
- 1-3 posts/day (configurable), 4-hour minimum gap between posts
- PST timezone for posting window (8am-10pm local)
- Draws from real agent activity: git commits, scam detections, services, self-mod PRs, plugin count, P2P status
- Fetches recent posts to avoid repeating topics
- No trading/financial/private content — can promote services
- Following tab now default, banner full-width fix
- 401 auth fallback: token refresh → full re-login with saved credentials

**Crypto P&L Alignment:**
- Daily Telegram report now includes both dollar_maximizer + token trader P&L
- Per-token breakdown in report (symbol, balance, P&L, regime)
- Web UI `totalPnL` combines both strategies instead of showing DM-only

**PR Review (13 PRs — 2 merged, 6 implemented manually, 5 closed):**
- Merged: DCA risk tolerance (#1808), custom indicator registration (#1815)
- Implemented: scammer registry rate limiting, TokenUsage error handling, NASA Mars rover history, Twitter profile fetch, GitHostingSettings caching, DeviceAlias expiration
- Closed with comments: 5 PRs (broken implementations, no-ops, breaking schema changes)

**New Endpoints/Features:**
- `express-rate-limit` on `/api/scammer-registry/*` routes (10 req/min report, 30 req/min read)

---

## Recent Updates (March 24, 2026)

### v2.20.2 — Token Trader Persistence, Staking Auto-Claim, MindSwarm Daily Auto-Post

**Token Trader Fixes:**
- `POST /api/crypto/strategy/token-trader/configure` now persists registry state to DB immediately (tokens survive restarts)
- `POST /api/crypto/strategy/token-trader/exit` also persists (removed tokens don't reappear)
- Reconfiguring the same token no longer wipes position/P&L data

**Staking Auto-Claim:**
- Agent auto-claims staking rewards every 6 hours when pending > 1,000 SKYNET
- `POST /api/staking/claim` now returns `claimedAmount` and logs to `HistoricalTransaction`
- `GET /api/staking/history` now returns actual data (staking claims, epoch funding, fee routing events)

**MindSwarm Daily Auto-Post:**
- Agent posts once per day (9am–9pm UTC) about non-sensitive recent activity
- AI composes post from context: scam registry stats, staking, uptime, trading activity, P2P status
- Owner receives Telegram notification with direct link to post (`mindswarm.net/{username}/{postId}`)
- Engagement loop moved from `setInterval` to Agenda scheduler (MongoDB-backed, reliable across restarts)
- Togglable via `engagement({ autoDailyPost: false })`

**Fee Routing History:**
- Fee-to-staking routing events now logged to `HistoricalTransaction` model

---

## Recent Updates (March 23, 2026)

### v2.20.1 — PR Review + MindSwarm UI Fixes

Reviewed 53 AI-generated PRs: merged 14, closed 28. Merged features include SignalWire batch messaging, HuggingFace summarization, MCP parallel registration, SkynetTokenLedger audit logging, Hardhat rate limiting, branch protection stubs, priority job queues, StatusCake bulk ops, preference rollback, aggregation optimizations, Vonage tracking, GCF triggers, wallet analysis, and device group caching.

MindSwarm web UI fixed: script execution (escaped quotes in dynamically injected scripts), profile images (proxied through LANAgent to avoid CORS), tab switching, mobile layout (tabs wrap into grid), feed filter highlighting.

**New Plugin Route:**

| Route | Description |
|-------|-------------|
| `GET /api/mindswarm/img?p=/uploads/...&token=JWT` | Image proxy for MindSwarm assets (avoids CORS) |

---

## Recent Updates (March 22, 2026)

### v2.20.0 — MindSwarm Social Network Plugin (61 commands)

Full autonomous integration with MindSwarm (https://mindswarm.net). Each agent instance auto-registers, sets up its profile (name, bio, avatar, banner), verifies its email, and runs an autonomous engagement loop — all without manual setup.

**Key features:**
- **Auto-registration** — uses agent's `EMAIL_USER` and `AGENT_NAME`, solves challenge, saves credentials encrypted
- **Auto-profile setup** — uploads VRM bust avatar from `data/agent/avatar.png`, AI-generated bio, banner from `data/agent/banner.png`
- **Email verification via IMAP** — reads verification email from agent's inbox, completes verification automatically
- **Autonomous engagement loop** — polls every 5 min, AI-replies to replies, auto-follows back, auto-likes mentions
- **Multi-instance safe** — configurable `MINDSWARM_API_URL`, no hardcoded names/URLs, per-instance state

**All actions use:** `POST /api/plugin` with `"plugin": "mindswarm"` and the relevant `"action"`.

**Commands (91 total):**

| Category | Actions |
|----------|---------|
| Auth | `login`, `register`, `logout`, `configure` |
| Posts | `createPost`, `getFeed`, `getPost`, `getReplies`, `reply`, `editPost`, `deletePost`, `like`, `repost`, `savePost`, `vote`, `uploadMedia`, `boostPost` |
| Users | `getProfile`, `updateProfile`, `follow`, `unfollow`, `getFollowers`, `getFollowing`, `changeUsername`, `changeEmail`, `blockUser`, `unblockUser`, `muteUser`, `unmuteUser` |
| Account | `getMe`, `checkAvailability`, `getUserPosts`, `getEditHistory`, `getSavedPosts`, `pinPost`, `updateSocialLinks`, `uploadAvatar`, `uploadBanner`, `verifyEmail`, `resendVerification` |
| Groups | `searchGroups`, `joinGroup`, `leaveGroup`, `groupPost`, `createGroup`, `getGroupMembers`, `getMyGroups` |
| Lists | `createList`, `getLists`, `getListTimeline`, `addToList`, `removeFromList` |
| Drafts | `saveDraft`, `getDrafts`, `publishDraft`, `deleteDraft` |
| Tipping | `sendTip`, `tipHistory`, `tipStats`, `getSupportedTokens`, `getTipsOnPost`, `updateCryptoAddresses`, `verifyTip`, `getTipStatus` |
| DMs | `getConversations`, `sendMessage`, `getMessages`, `startConversation` |
| Notifications | `getNotifications`, `getUnreadCount`, `markNotificationsRead` |
| Discovery | `searchPosts`, `searchUsers`, `trending`, `suggestedUsers`, `searchHashtags` |
| Analytics | `getAnalytics`, `getPostAnalytics` |
| Moderation | `reportContent`, `getModQueue`, `reviewReport`, `issueWarning`, `banUser`, `liftBan`, `getModStats`, `getUserWarnings`, `getBanStatus` |
| Referrals | `getReferralCode`, `getReferralStats` |
| Engagement | `engagement` (configure auto-reply, auto-follow, auto-like, poll interval) |
| Status | `status` |

**Moderation:** Requires moderator role on MindSwarm. Non-moderator instances get a clean "Permission denied" message instead of a crash. `reportContent` works for any user.

**REST Routes (direct, no plugin wrapper):**

| Route | Description |
|-------|-------------|
| `GET /api/mindswarm/status` | Connection and auth status with engagement info |
| `GET /api/mindswarm/feed?type=algorithm&page=1` | Browse feed |
| `GET /api/mindswarm/notifications?page=1` | Get notifications |
| `GET /api/mindswarm/trending?limit=10` | Trending hashtags |
| `GET /api/mindswarm/profile/:username` | User profile |
| `POST /api/mindswarm/post` | Create post |
| `POST /api/mindswarm/like/:postId` | Like/unlike |
| `POST /api/mindswarm/reply/:postId` | Reply to post |
| `GET /api/mindswarm/search/posts?q=keyword` | Search posts |
| `GET /api/mindswarm/search/users?q=name` | Search users |

**Web UI:** Dashboard with 7 tabs (Feed, Compose, Notifications, Search, Trending, Profile, Settings).

**Autonomous Engagement:**
The agent runs an engagement loop every 5 minutes that uses AI for all decisions:
- Replies: AI decides whether to like, reply, both, or ignore based on content and sentiment. Full thread context (original post + all replies) included in the decision
- Mentions/quotes: sentiment analysis — won't like hostile content, may reply calmly to criticism
- Follows: checks profile before following back (skips empty/spam accounts)
- DMs: always replies with conversation context, intent classification for hostile/spam/phishing, daily limit of 5
- Financial deflection: refuses to discuss wallets, positions, or P&L. Can promote Skynet project and share MindSwarm referral link naturally
- Handles all 18 MindSwarm notification types (reply, like, follow, mention, quote, dm, tip, group, badge, warning, etc.)

**AI-Composed Posts:**
When posting via NLP (e.g. "post about self-healing networks"), topics are composed into natural social media posts with opinion and hashtags. Ready-made posts pass through unchanged.

**Conversational Context:**
The NLP pipeline tracks recent exchanges in memory (10 messages, 30-min expiry). Follow-up messages ("tell me more", "is that right?", "why?") are routed to AI with conversation history instead of re-triggering intent detection.

**Registration Convention:**
- Username: `{agentname}_lanagent` (auto-increments if taken)
- Display name: `AGENT_NAME`
- Referral link cached on login for engagement use

**Environment variables (all optional):**

| Variable | Description |
|----------|-------------|
| `MINDSWARM_API_URL` | Override base URL (default: `https://mindswarm.net/api`) |
| `MINDSWARM_EMAIL` | Fallback email (normally uses `EMAIL_USER`) |
| `MINDSWARM_USERNAME` | Fallback username (normally uses `AGENT_NAME`) |
| `MINDSWARM_PASSWORD` | Fallback password (normally auto-generated) |

### P2P Paid Services — Email Leasing & ENS Subnames

Fork instances can lease `@lanagent.net` email addresses and `.lanagent.eth` ENS subnames from the genesis instance via P2P, paid in SKYNET tokens on BSC.

**Natural Language:**
- "get me an email address" → requests `@lanagent.net` email lease
- "check my email lease" → shows status, expiry, IMAP/SMTP config
- "get me an ENS subname" → requests `*.lanagent.eth` subname

**Payment Flow:**
1. Fork requests service from genesis via encrypted P2P
2. Genesis responds with `payment_required` (amount, SKYNET token address, recipient wallet)
3. Fork auto-pays SKYNET tokens on BSC
4. Genesis verifies on-chain (3+ confirmations, Transfer event parsing, double-spend check)
5. Genesis creates the resource and sends credentials back via P2P

**Crypto Send Endpoint:**
```
POST /api/crypto/send
{ "chain": "bsc", "toAddress": "0x...", "amount": "100", "token": "0x8Ef0ecE5687417a8037F787b39417eB16972b04F" }
```
Omit `token` for native sends (BNB/ETH).

**Token Scanner Whitelist:**
Skynet ecosystem tokens are whitelisted and excluded from sell attempts:
- `SKYNET` (`0x8Ef0ecE5687417a8037F787b39417eB16972b04F`) — project token
- `SENTINEL` (`0xAE1908C7d64562732A25E7B55980556514d46C35`) — soulbound reporter badge
- `SCAMTOKEN` (`0xB752e44E1E67E657Cf0553993B4552644ce2C352`) — soulbound scam flag badge

**Scammer Registry:**
- Deduplicates by address (checks on-chain cache + pending queue)
- Requires confidence >= 50 for auto-reporting
- Report fee: 50,000 SKYNET (routes to staking reward pool)

---

## Recent Updates (March 21, 2026)

### v2.19.2 — P2P Auto-Discovery, Crypto Counter Separation, BETA Testing

P2P auto-introduction protocol enables automatic peer discovery without manual setup. Separated dollar\_maximizer and token trader trade counters and P&L tracking. Token trader P&L now computed from actual instance data. BETA instance tested successfully on same server. ScammerRegistry updated for full Hub ABI. Auto-epoch renewal verified with 24h epochs.

**New/Updated Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /api/crypto/token-balance?token=&network=` | ERC-20 token balance for agent wallet |
| `GET /api/crypto/strategy/status` | Now includes `tokenTraderTradesExecuted`, `tokenTraderPnL` in state |

**Multi-Instance Setup:**
To run a second instance on the same server, set in `.env`: `PM2_PROCESS=lan-agent-beta`, `AGENT_PORT=8180`, `MONGODB_URI=mongodb://localhost:27017/lanagent2`, `TELEGRAM_ENABLED=false`, `ENABLE_MQTT=false`. Use PM2 fork mode. Instances auto-discover each other via P2P.

### v2.19.0 — SkynetHub, Lock Tiers, Soulbound Badges

Unified SkynetHub contract deployed combining staking, scammer registry, and soulbound badges. Lock tiers with reward multipliers (1x-3x). Report fees route directly to staking pool. Three ERC-20 badge tokens (SCAMMER, SCAMTOKEN, SENTINEL) for BscScan visibility. Web UI updated with tier selector, lock status, and Hub dashboard.

**New/Updated Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /api/staking/tiers` | Available lock tiers with duration and multiplier |
| `POST /api/staking/stake` | Now accepts `tierId` param for lock tier selection |
| `GET /api/staking/info` | Returns lockTier, multiplier, locked, effectiveBalance, scammerCount, totalFeesRouted |


### v2.18.1 — Swap Sanity Fix, Memory System Overhaul

Fixed swap output sanity check that compared raw token amounts against USD values (stablecoin→native swaps always failed). Memory system fixes: `isPermanent` field now syncs correctly, personal questions recall from memory before intent routing, junk/duplicate memories cleaned up, preference regex tightened, AI filter no longer skips question-word messages. LanceDB vector index rebuilt.

**Fixes:**

| Fix | Description |
|-----|-------------|
| Swap sanity check | `outputTokenPriceUsd` converts output to USD before comparing (was comparing 0.078 BNB against $50) |
| Memory `isPermanent` | Root field now synced from `metadata.isPermanent` on store |
| Memory recall | Personal questions ("what is my name?") recall from memory before intent detection |
| Memory learning | AI filter no longer blocks question-word messages; preference regex requires statement form |

### v2.17.2 — Deploy Safeguards, PR Review, Caching, Shazam Song Details

Deploy scripts now block 0-byte files and JS syntax errors before deploying. Fixed crypto trading system that was offline due to an empty file deploy. Reviewed 26 AI-generated PRs: merged 4, manually implemented 3, closed 19. New features: Shazam `getSongDetails` command (track_info API), Hardhat API read caching with proper invalidation, WebLoader URL caching for RAG, Skynet partial unstaking, configurable MCP token usage thresholds, ContractABI extended query filters, accounts API rate limiting.

**New/Updated Endpoints & Features:**

| Feature | Description |
|---------|-------------|
| Shazam `getSongDetails` | Fetch song metadata by track ID (title, artist, genre, album, cover, link) |
| `POST /api/staking/unstake` | Now supports `{ "percentage": 50 }` for partial unstaking (1-100%) |
| Hardhat GET endpoints | Cached (5-min TTL) with invalidation on mutating routes |
| Accounts API | Rate limited (100 req/15min per IP) |

### v2.17.1 — Auto-Sell Honeypot Fix, Vector Intent Safety

Fixed auto-sell reporting reverted swap transactions as successful (checked hash existence instead of success flag). Reverted on-chain transactions now treated as honeypot indicators. Vector intent detection: per-plugin similarity thresholds for high-confusion CRUD plugins (Dry.AI 0.65), destructive action safety net prevents delete-intent misrouting. Expanded Dry.AI intent examples across 10+ actions.

### v2.17.0 — Playground, VRM Persistence, Telegram Files, Dry.AI Improvements

New Playground page for interactive 3D user-agent interaction with chat, emote studio, mirror mode (VR + webcam), and VR floating menu. VRM model selection persisted server-side in MongoDB. "Update Agent Avatar Everywhere" renders bust portrait and syncs to profile, Gravatar, Telegram, and ERC-8004 NFT. Telegram bot now receives files and photos. 49 VRMA animations. 10 VRM models. Dry.AI plugin: uploadFile, regeneratePage, modifyPage + graceful error handling.

**New API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agent/vrm` | Get active VRM model ID (public, no auth) |
| PUT | `/api/agent/vrm` | Set active VRM model ID (persists in MongoDB) |

**New Pages:**

| Page | URL | Description |
|------|-----|-------------|
| Playground | `/playground.html` | Interactive 3D agent interaction — chat, emote studio, mirror mode, VR |

### v2.16.0 — VRM Animated Avatars, WebXR VR Controls, BitNet Provider, Memory Cleanup

VRM animated avatar system with motion-captured idle animations, facial expressions, eye tracking, lip sync, and spring bone physics. WebXR VR controller interactions with 3D info cards. BitNet CPU-only LLM provider. Memory system cleanup (21K→76 entries). Self-modification pipeline fixes. CoW Protocol DEX aggregator. Three.js upgraded r128→r140.

**New API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/avatar/:avatarId/rig` | Auto-rig avatar with Blender (19-bone humanoid skeleton) |
| PUT | `/api/avatar/:avatarId/rename` | Rename an avatar |
| DELETE | `/api/avatar/:avatarId` | Delete avatar and all associated files |

**Avatar Rig Request:**
```
POST /api/avatar/57e01487-f9d1-4586-8415-1a3f52746e03/rig
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": { "bones": 19, "vertices": 28963, "size": 11942324, "height": 1.988 }
}
```

**Avatar Rename Request:**
```json
PUT /api/avatar/:avatarId/rename
{ "name": "ALICE Full Body" }
```

**Avatar Delete:**
```
DELETE /api/avatar/:avatarId
```

**Email API Pagination (updated):**

| Parameter | Description |
|-----------|-------------|
| `limit` | Max results (1-1000, default 100) |
| `skip` | Skip N results for pagination |
| `type` | Filter by `sent`, `received`, or `all` |

**CoW Protocol Swap (internal):**

CoW Protocol is automatically used by the swap service when it offers the best price. No separate API endpoint — it competes alongside V2/V3/V4 in `POST /api/crypto/swap/execute`.

**Avatar Auth Query Token:**

Model and export endpoints now accept `?token=<jwt>` for use in `<img>` tags and Three.js GLTFLoader:
```
GET /api/avatar/:avatarId/model?token=<jwt>
GET /api/avatar/:avatarId/export?format=png&token=<jwt>
```

**New Visualization Tabs:**
- P2P Network (`/js/p2p-network.js`) — Federation peers
- Email Contacts (`/js/email-contacts.js`) — Email communication graph
- Plugin Constellation (`/js/plugin-constellation.js`) — Plugin ecosystem

**Dry.AI Owner Auto-Invite:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/plugin` | `{ plugin: "dry-ai", action: "setOwnerEmail", email: "user@example.com" }` — Set owner email for auto-invite |

When the agent creates spaces or app spaces on Dry.AI, the owner is automatically invited as admin. The `shareItem` action now also works without an explicit `itemId` — it searches spaces by name or uses the most recent.

---

### v2.15.12 — Wallet Interactions, Avatar 3D Fix, ENS Name Lookup

Wallet counterparty interaction API for Wallet Graph visualization, fixed avatar 3D generation via Python bridge, dynamic ENS name resolution.

**New API Endpoint:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/crypto/interactions` | Wallet counterparty interactions for graph visualization |

**Query Parameters:**
- `network` — Chain to query (default: `bsc`)

**Response:**
```json
{
  "success": true,
  "wallet": "0x...",
  "ensName": "alice.lanagent.eth",
  "interactions": [
    { "address": "0x...", "count": 5, "isContract": true, "totalValue": 142.50, "label": "USDT" }
  ]
}
```

**Avatar 3D Generation Fix:**
- Switched from JS `@gradio/client` to Python `gradio_client` subprocess bridge (`scripts/hf-3d-generate.py`)
- JS client fails ZeroGPU Pro auth; Python client authenticates correctly
- Cascade: Hunyuan3D-2.1 → Hunyuan3D-2 → TRELLIS
- Requires `HUGGINGFACE_TOKEN` env var and `pip install gradio_client`

### v2.15.11 — P&L History Chart & Network Topology Trust Coloring

Cumulative P&L line chart with log backfill and live updates. Network topology trust-based device coloring.

**New API Endpoint:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/revenue/report/daily-pnl` | Daily P&L history with cumulative totals |

**Query Parameters:**
- `startDate` — ISO date (default: 30 days ago)
- `endDate` — ISO date (default: now)

**Response:**
```json
{
  "success": true,
  "data": [
    { "date": "2026-03-12", "dailyPnL": 17.18, "cumulativePnL": -39.87 },
    { "date": "2026-03-13", "dailyPnL": -33.92, "cumulativePnL": -73.79 }
  ]
}
```

**Data Sources:**
- Historical: `DailyPnL` MongoDB collection, backfilled from trade logs via `scripts/backfill-pnl.js`
- Live: Updated every 15 minutes from token trader realized + unrealized P&L
- Calibrated: Cumulative totals match actual token trader lifetime P&L (not raw revenue/expense deltas)

### v2.15.10 — Email Lease Service (P2P Email Provisioning)

P2P email account provisioning via `mail.lanagent.net`. Genesis agent provisions `username@lanagent.net` accounts for fork agents, paid in SKYNET tokens.

**New API Endpoints (Email Leases):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/p2p/api/email-leases` | List all email leases (optional `?status=active`) |
| GET | `/p2p/api/email-leases/stats` | Lease stats: active, total, expiring soon, revenue |
| GET | `/p2p/api/email-leases/config` | Get pricing and settings |
| PUT | `/p2p/api/email-leases/config` | Update pricing and settings |
| POST | `/p2p/api/email-leases/:leaseId/revoke` | Revoke a lease and delete mail account |
| POST | `/p2p/api/email-leases/:leaseId/reset-password` | Reset password and deliver via P2P |

**Config Example:**
```bash
PUT /p2p/api/email-leases/config
{
  "leasePrice": 100,
  "renewalPrice": 80,
  "leaseDurationDays": 365,
  "defaultQuotaMB": 500,
  "maxLeasesPerPeer": 3
}
```

**Response (Config):**
```json
{
  "success": true,
  "config": {
    "leasePrice": 100,
    "renewalPrice": 80,
    "leaseDurationDays": 365,
    "defaultQuotaMB": 500,
    "maxLeasesPerPeer": 3,
    "enabled": true,
    "mailApiConfigured": true
  }
}
```

**P2P Message Flow:**
1. Fork sends `email_lease_request` with desired username
2. Genesis responds with `email_lease_payment_required` (amount, wallet, token address)
3. Fork pays SKYNET tokens on BSC, resends request with `paymentTxHash`
4. Genesis verifies payment, creates mail account, sends `email_lease_response` with credentials (IMAP/SMTP config + password)
5. Renewals via `email_lease_renew`, revocations via `email_lease_revoke`

**Environment Variables:**
```
EMAIL_LEASE_ENABLED=true
MAIL_API_URL=http://YOUR_MAIL_SERVER:9100
MAIL_API_SECRET=<64-char-hex>
```

**New Files:**
- `mail-api/` — Standalone Express app for mail server (HMAC auth, rate limiting, docker exec)
- `src/models/EmailLease.js` — Mongoose model for lease tracking
- `src/services/email/emailLeaseService.js` — Core service (genesis + fork sides)

**Modified Files:**
- `src/services/p2p/messageHandler.js` — 5 new handlers + `email_provider` capability
- `src/services/p2p/p2pService.js` — `requestEmailLease()`, `requestEmailLeaseRenewal()`
- `src/interfaces/web/p2p.js` — 6 admin routes

### v2.15.9 — Avatar Designer, Live Visualizations, Portfolio API

#### Avatar Designer Page (`/avatar.html`)

Full 3D avatar viewer/designer with Three.js GLB model loading, customization, and NFT minting.

**New Endpoint:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/avatar/:avatarId/model` | Serve raw GLB binary for Three.js viewer |

#### Portfolio API

Combined portfolio endpoint for the Crypto Token Space visualization.

```bash
GET /api/crypto/portfolio
```

**Response:**
```json
{
  "success": true,
  "tokens": [
    { "symbol": "ETH", "name": "Ethereum", "balance": 0.093, "price": 2130, "value": 198.09, "change24h": 2.5, "network": "ethereum", "type": "native" },
    { "symbol": "BNB", "name": "BNB", "balance": 0.457, "price": 672, "value": 307.10, "change24h": -1.2, "network": "bsc", "type": "native" },
    { "symbol": "USDT", "name": "USDT (bsc)", "balance": 63, "price": 1, "value": 63, "change24h": 0, "network": "bsc", "type": "stablecoin" }
  ]
}
```

#### Visualization Fixes

- **Agent Brain**: Now dynamically built from live `/api/system/status` data
- **Trust Graph**: Parses real attestation data from `/api/external/trust/admin/graph`
- **Crypto Token Space**: Fetches real portfolio from `/api/crypto/portfolio`

### v2.15.8 — Protocol Dashboard, Auto Gas Top-Up, Swap Fixes

#### Unwrap WETH/WBNB Endpoint

Converts wrapped native tokens (WETH, WBNB) back to native ETH/BNB.

```bash
POST /api/crypto/swap/unwrap
{
  "amount": "0.05",
  "network": "ethereum"
}
```

**Response:**
```json
{
  "success": true,
  "hash": "0x...",
  "amount": "0.05",
  "network": "ethereum",
  "token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "message": "Unwrapped 0.05 to native on ethereum"
}
```

#### Protocol Dashboard Cards (Web UI)

Three new status cards on the crypto page showing live protocol data:
- **ERC-8033 Oracle Council** — Active participations, win rate, earnings, domain tags
- **ERC-8107 Trust Registry** — ENS node, trust scopes, trust level indicators
- **ERC-8001 Coordination** — Active/total intents, coordination type badges

Cards show "Not Configured" gracefully when contract addresses aren't set.

### Dry.AI Plugin (v2.15.13)

Full Dry.AI integration for natural language data management. All operations use direct REST API endpoints with the user's MCP Bearer token — no AI service dependency.

**Authentication:** The plugin supports automated auth via `autoAuth` (register → read verification email → verify → save token) or manual `register`/`verify`/`setToken` flows. Tokens are persisted in MongoDB via PluginSettings.

**All actions use:** `POST /api/plugin` with `"plugin": "dry-ai"` and the relevant `"action"`.

#### Auth Actions

| Action | Params | Description |
|--------|--------|-------------|
| `autoAuth` | `email?` | Full automated auth flow (register, read email, verify, save token) |
| `register` | `email?` | Send verification code (defaults to `EMAIL_USER` env var) |
| `verify` | `code`, `userId`, `email` | Verify email with code from register response |
| `status` | — | Check authentication status |
| `setToken` | `token`, `email?` | Manually set MCP token |
| `clearToken` | — | Remove stored credentials |

#### Create Actions

| Action | Params | Description |
|--------|--------|-------------|
| `createAppSpace` | `name`, `prompt?` | Create AI-powered app space with custom types and pages |
| `createItem` | `query`, `folder?` | Create item via natural language |
| `createType` | `query`, `folder?`, `forceCreate?` | Create custom type/schema in a space |
| `createSpace` | `query` | Create a new smartspace |
| `createFolder` | `query`, `folder?`, `forceCreate?` | Create a folder in a space |
| `importItems` | `query`, `folder?` | Batch import multiple items |

#### Read Actions

| Action | Params | Description |
|--------|--------|-------------|
| `listSpaces` | — | List all spaces/smartspaces |
| `search` | `query`, `folder?` | Search data across spaces |
| `listItems` | `folder?`, `query?` | List items in a folder |
| `getItem` | `itemId` | Get item details |
| `help` | `query?` | Get Dry.AI help/documentation |
| `prompt` | `query`, `folder?` | Multi-intent natural language prompt |
| `report` | `query`, `folder?` | Generate structured report |

#### Update Actions

| Action | Params | Description |
|--------|--------|-------------|
| `updateItem` | `itemId`, `query` | Update item via natural language |
| `updateItems` | `folder`, `query` | Bulk update items in a folder |
| `updateType` | `itemId`, `query` | Update a type/schema |
| `updateSpace` | `itemId`, `query` | Update a smartspace |
| `updateFolder` | `itemId`, `query` | Update a folder |
| `shareItem` | `itemId`, `query?` | Share an item |

#### Delete Actions

| Action | Params | Description |
|--------|--------|-------------|
| `deleteItem` | `itemId` | Delete a single item |
| `deleteByQuery` | `query`, `folder?` | Delete items matching a query |

**Example — Create App Space:**
```json
{
  "plugin": "dry-ai",
  "action": "createAppSpace",
  "name": "Bug Tracker",
  "prompt": "A bug tracker with bugs and releases"
}
```
Response: `{ "success": true, "message": "...", "space": { "name": "Bug Tracker", "id": "...", "url": "https://dry.ai/..." } }`

**Example — Create Item:**
```json
{
  "plugin": "dry-ai",
  "action": "createItem",
  "query": "A note about testing the plugin",
  "folder": "SPACE_ID"
}
```

**Example — Search:**
```json
{
  "plugin": "dry-ai",
  "action": "search",
  "query": "what wines do I have?"
}
```

**NLP examples:** "build me a bug tracker on dry ai", "list my dry.ai spaces", "add a note to dry ai", "search dry ai for recipes", "delete completed tasks in dry ai", "create a recipe type in dry ai"

### Plugin Directory Consolidation (v2.15.6)

Migrated 5 plugins from legacy `src/plugins/` to `src/api/plugins/`:
- `contractCommands` and `cryptoMonitor` — fully rewritten from old `Plugin` class to `BasePlugin` (ethers v5 → v6)
- `ipgeolocation`, `jsonplaceholder`, `numbersapi` — migrated with corrected import paths
- `cloudwatch` — removed (duplicate of existing `amazoncloudwatch`)
- Legacy `src/plugins/` directory deleted

### BSC Mainnet Contracts & Protocol APIs (v2.15.7)

5 smart contracts deployed to BSC mainnet with full service integration, event listeners, and API endpoints.

#### Agent Coordination API

Multi-agent coordination protocol (ERC-8001) with intent-based propose/accept/execute lifecycle.

**Endpoints:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/coordination/types` | List available coordination types |
| GET | `/api/coordination/active` | Get active/pending coordination intents |
| GET | `/api/coordination/history` | Past coordinations with filters |
| GET | `/api/coordination/stats` | Success rate, avg time to ready |
| POST | `/api/coordination/propose` | Create new coordination intent |
| POST | `/api/coordination/:intentHash/accept` | Accept a coordination intent |
| POST | `/api/coordination/:intentHash/execute` | Execute a ready coordination |
| POST | `/api/coordination/:intentHash/cancel` | Cancel a proposed coordination |

**Propose Example:**
```bash
curl -X POST http://localhost/api/coordination/propose \
  -H 'X-API-Key: your_key' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "JOINT_MONITORING",
    "participants": ["peer_ens_name.lanagent.eth"],
    "payload": { "target": "network", "interval": 300 },
    "value": "0.01",
    "expiryHours": 24
  }'
```

**Coordination Types:** `JOINT_MONITORING`, `COORDINATED_TRADE`, `SHARED_COST`, `CODE_UPGRADE`, `ORACLE_CONSENSUS`, `COLLECTIVE_STAKE`

#### VR Avatar API

Photo/text-to-3D avatar creation with customization, NFT minting, and gallery.

**Endpoints:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/avatar/create` | Create avatar from photo upload or text prompt |
| GET | `/api/avatar/gallery` | List all avatars |
| GET | `/api/avatar/stats` | Avatar creation statistics |
| GET | `/api/avatar/:avatarId` | Get avatar details |
| PUT | `/api/avatar/:avatarId/customize` | Update customizations |
| GET | `/api/avatar/:avatarId/export` | Export avatar (GLB/PNG) |
| POST | `/api/avatar/:avatarId/mint` | Mint avatar as ERC-721 NFT |
| GET | `/api/avatar/:avatarId/items` | Available + unlocked items |
| POST | `/api/avatar/:avatarId/items/unlock` | Unlock cosmetic item |

**Create from photo:**
```bash
curl -X POST http://localhost/api/avatar/create \
  -H 'X-API-Key: your_key' \
  -F 'photo=@my_photo.jpg'
```

**Create from prompt:**
```bash
curl -X POST http://localhost/api/avatar/create \
  -H 'X-API-Key: your_key' \
  -H 'Content-Type: application/json' \
  -d '{ "prompt": "futuristic robot with blue armor" }'
```

Default 3D provider: TRELLIS (free, no API key needed). Alternatives: Meshy.ai (`MESHY_API_KEY`), Tripo3D (`TRIPO_API_KEY`).

#### External Gateway — Commerce Jobs API

ERC-8183 agentic commerce endpoints on the external gateway (`/api/external`).

**Endpoints:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/external/jobs/services` | List available job types and pricing |
| POST | `/api/external/jobs/create` | Create a new job with escrow |
| GET | `/api/external/jobs/:jobId/status` | Check job status |
| POST | `/api/external/jobs/:jobId/fund` | Fund a created job |
| GET | `/api/external/jobs/:jobId/deliverable` | Get job deliverable |
| GET | `/api/external/admin/jobs/active` | Admin: list active jobs |
| GET | `/api/external/admin/jobs/revenue` | Admin: revenue stats |

#### External Gateway — Trust API

ERC-8107 trust registry endpoints on the external gateway.

**Endpoints:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/external/trust/level?agent=name.eth` | Get trust level for an agent |
| GET | `/api/external/trust/path?from=a.eth&to=b.eth` | Find trust path between agents |
| POST | `/api/external/trust/attest` | Submit trust attestation |
| GET | `/api/external/admin/trust/graph` | Admin: full trust graph |
| POST | `/api/external/admin/trust/set` | Admin: set trust level |
| POST | `/api/external/admin/trust/revoke` | Admin: revoke trust |
| GET | `/api/external/admin/trust/stats` | Admin: trust statistics |

#### External Gateway — Oracle API

ERC-8033 oracle agent endpoints on the external gateway.

**Endpoints:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/external/oracle/capabilities` | Agent oracle capabilities and domains |
| GET | `/api/external/oracle/stats` | Oracle participation statistics |
| GET | `/api/external/admin/oracle/active` | Admin: active oracle requests |
| GET | `/api/external/admin/oracle/history` | Admin: past participations |
| GET | `/api/external/admin/oracle/stats` | Admin: detailed oracle stats |
| POST | `/api/external/admin/oracle/config` | Admin: update oracle config |
| POST | `/api/external/admin/oracle/pause` | Admin: pause oracle participation |
| POST | `/api/external/admin/oracle/resume` | Admin: resume oracle participation |

#### 3D Visualizations

5 interactive Three.js visualizations accessible at `/visualizations.html`:
- **Agent Brain**: Neural network of agent services with pulsing activity
- **Network Topology**: Force-directed 3D graph of LAN devices
- **Crypto Token Space**: 3D portfolio sized by value, colored by performance
- **Trust Graph**: ERC-8107 trust attestation relationships
- **Log Waterfall**: Matrix-rain style log display by service

Loaded from CDN (Three.js r160), no npm dependency needed. Data fetched from existing API endpoints with API key auth.

#### Deployed Contracts (BSC Mainnet)

| Contract | Address | Standard |
|----------|---------|----------|
| AgenticCommerceJob | `0x9aFD27822be743f28703325cC5895C9e83160dE5` | ERC-8183 |
| ENSTrustRegistry | `0x0C75d229de505175B75E0553d7CA54358a6d300c` | ERC-8107 |
| AgentCouncilOracle | `0xF839287DDFeaD0E9D19bdD97D7F34F2f925ba274` | ERC-8033 |
| AgentCoordination | `0xFFeD9F5775278Bb04856caE164C94A7d976372f1` | ERC-8001 |
| AvatarNFT | `0x91Eab4Dd5C769330B6e6ed827714A66136d24842` | ERC-721 |

### ENS Name Service (v2.15.5)

Register, manage, and auto-renew `.eth` names on Ethereum mainnet. Supports subnames for multi-agent setups (e.g., `alice.lanagent.eth`). Names resolve cross-chain on BSC, Ethereum, and all EVM chains.

**New API Endpoints:**
```
GET  /api/ens/status            # Configuration, expiry, subnames, resolved address
GET  /api/ens/available/:name   # Check name availability with pricing
GET  /api/ens/expiry/:name      # Check name expiry date
POST /api/ens/commit            # Step 1: submit registration commitment
POST /api/ens/register          # Step 2: complete registration (after 60s wait)
POST /api/ens/subname           # Create subname under base name
POST /api/ens/reverse           # Set reverse resolution (address → name)
POST /api/ens/renew             # Manually renew a name
POST /api/ens/settings          # Toggle auto-renewal, set subname price { autoRenew, subnamePrice }
POST /api/ens/request-subname   # Request subname from genesis via P2P { label: "myagent" }
```

**Status Response:**
```json
{
  "configured": true,
  "baseName": "lanagent.eth",
  "expiry": "2027-03-12T16:56:35.000Z",
  "daysUntilExpiry": 364,
  "resolvedAddress": "0xc0C0D080650C941D8901889248c6eD4C31Ef08F4",
  "subnames": [{ "label": "alice", "fullName": "alice.lanagent.eth" }],
  "autoRenew": true
}
```

**Registration flow:**
1. `POST /api/ens/commit` with `{ "name": "myname", "years": 1 }` — submits commitment hash on-chain
2. Wait 60+ seconds (anti-frontrunning)
3. `POST /api/ens/register` with `{ "name": "myname" }` — completes registration, sets resolver + reverse record

**Auto-renewal:** Daily Agenda job checks expiry; renews automatically when <30 days remain.

**P2P Subname Provisioning:** Forked instances automatically request a subname from the genesis peer via the P2P network. The genesis instance advertises `ens_provider` capability during peer exchange. After wallet generation, forks wait 5 minutes for P2P to connect, then request `{agentName}.lanagent.eth`. Optional SKYNET token pricing is supported — set `subnamePrice` via the settings endpoint (0 = free). If the name is taken, the system auto-retries with a fingerprint suffix. If payment fails (insufficient funds), the request is saved and retried daily.

**NLP Intents (128-129):** Users can manage ENS via natural language:
- "what is my ENS name" / "check ENS status" / "when does my ENS expire" → intent 128 (`ensStatus`)
- "get me an ENS subname" / "request subname coolbot" / "get me alpha.lanagent.eth" → intent 129 (`ensRequestSubname`)

### Fee-to-Staking Flywheel (v2.15.4)

Registry fee income now automatically funds staking reward epochs. When scam tokens are reported (by self or external LANAgent instances), the SKYNET fee income is tracked in a separate `registryFees` ledger bucket and routed to the staking contract when thresholds are met.

**New API Endpoints:**
```
GET  /api/staking/fee-routing    # Get settings + current fee balance
POST /api/staking/fee-routing    # Update: { enabled, threshold, percent, epochDuration }
```

**Fee Routing Response:**
```json
{
  "enabled": true,
  "threshold": 500000,
  "percent": 100,
  "epochDuration": 604800,
  "feeBalance": 3950000
}
```

**How it works:**
- Scans `ScammerRegistered` events on-chain (captures both self and external reporter fees)
- First run bootstraps from `getScammerCount() × reportFee()` (BSC RPCs prune old event logs)
- Fee income tracked in `registryFees` ledger category — isolated from LP/treasury/reserve
- Routes to staking when: epoch ended + fee balance ≥ threshold (default 500K = 10 reports)
- Configurable routing percent (default 100%) and epoch duration (default 7 days)

### Automatic Scam Token Reporting & Owned Token Protection (v2.15.3)

**Automatic Scam Token Reporting:**
- Agent autonomously detects scam tokens via confidence scoring (honeypot, scam names, no code, dust amounts)
- Requires 2+ signals (threshold 50) — "no swap path" alone never triggers false positives
- Queues reports during deposit scan and residual sweep, batch-reports at end of cycle
- Maps signals to registry categories: Honeypot, Phishing, Fake Contract, Dust Attack, Other
- WebUI toggle on crypto page (enabled by default)

**New API Endpoints:**
```
GET  /api/crypto/settings/auto-report-scams    # Check auto-report state
POST /api/crypto/settings/auto-report-scams    # Toggle: { "enabled": true/false }
```

**Owned Token Whitelist:**
- Protects owned tokens (dead projects, LP tokens, minted tokens) from auto-sell
- Separate from scam blacklist — owned tokens are never reported to registry

**Bug Fixes:**
- Scam token error spam (17,000+ errors/rotation) — blacklist + registry cache skip
- 7-day cleanup no longer wipes permanently-failed tokens (failCount >= 3)
- `TRANSFER_FROM_FAILED` and `Output sanity check failed` now trigger permanent blacklist

### Upstream Sync & ERC-8004 Recovery (v2.15.2)

**Upstream Sync for Forked Instances:**
- `git-monitor` now fetches from `UPSTREAM_REPO` (genesis repo) every 30 minutes
- Merges new upstream commits into local `main` and pushes to `origin` (the fork)
- Genesis instances auto-skip (detects origin === upstream with URL normalization)
- Handles merge conflicts, local changes, and lock contention gracefully
- Adds `upstream` git remote automatically on first run

**ERC-8004 On-Chain State Recovery:**
- `getIdentityStatus()` auto-recovers lost registration state from on-chain data
- Queries `ownerOf()`, `tokenURI()`, `getAgentWallet()` on the Identity Registry
- Zero overhead when DB state is intact — only triggers when `agentId` exists but status is `none`

**No API changes** — upstream sync is internal to the scheduler; ERC-8004 recovery is transparent to the existing `/api/agent/erc8004/status` endpoint.

### Ethereum Token Auto-Sell Fixes (v2.15.1)

Fixed 5 bugs preventing Ethereum token deposits from being sold:
- `getQuote()` used wrong decimals for USDC output (18 instead of 6), making all tokens appear as $0.00
- `classifyToken()` returned `scam` on RPC errors instead of `safe_unknown`
- No throttling between batch classifications caused RPC rate-limit cascade
- Corrupted DAI address broke multi-hop swap routing
- `ignored_scam` deposit entries now expire after 24h for re-classification

### Multi-Instance Framework, Cross-Fork PRs, Docker Packaging (v2.15.0)

LANAgent is now installable by anyone. Interactive install wizard, Docker support, cross-fork upstream contributions, and full credential isolation between instances.

**Install:**
- `scripts/setup/install.sh` — 10-step interactive wizard (agent name, AI keys, wallet, Telegram, P2P, self-mod, SSL/HTTPS)
- `--docker` mode auto-builds and launches containers with Docker Compose
- `--unattended` mode for non-interactive CI/scripted installs
- `--domain` flag for automatic HTTPS via Caddy (works with both native and Docker)
- `--quick` mode for minimal setup (agent name + AI key only)

**Cross-Fork Upstream PRs:**
- `GitHubProvider.createUpstreamPR()` — agents contribute improvements to upstream via GitHub API cross-fork PRs
- Controlled by `UPSTREAM_CONTRIBUTIONS=true` env var (default: enabled)
- Non-blocking: fires after fork PR creation, failures silently logged

**Docker:**
- `Dockerfile` + `docker-compose.yml` — agent + MongoDB 7 with health checks
- Configurable ports via `AGENT_PORT` and `AGENT_SSH_PORT` env vars
- SSL/Caddy support: installer auto-detects Caddy, changes `AGENT_PORT` to 3000 so Docker doesn't conflict with Caddy on port 80/443

**Security:**
- `.gitleaks.toml` + GitHub Actions CI to scan PRs for credential leaks
- All hardcoded credentials removed from scripts and source (~60 files)

**Agent Identity:**
- `process.env.AGENT_NAME` used in DB queries, PR titles, git config, P2P display name
- Centralized paths via `src/utils/paths.js` (DATA_PATH, LOGS_PATH, REPO_PATH, etc.)

**No API changes** — all changes are infrastructure, deployment, and self-modification internals.

### V4 Swap Execution, Uniswap V4 Support, Background Discovery & Token Scanner Fixes (v2.14.23)

PancakeSwap Infinity V4 swaps execute end-to-end through hooked CLAMM pools. Uniswap V4 quoting and swap execution added for Ethereum and BSC. Background hook discovery and dedicated RPC providers. Token scanner improved for unreliable RPCs.

**V4 Swap Execution (Plan/Actions):**
- INFI_SWAP uses Plan/Actions encoding: `CL_SWAP_EXACT_IN_SINGLE(0x06)` + `SETTLE_ALL(0x0c)` + `TAKE_ALL(0x0f)` as `abi.encode(bytes, bytes[])`
- Permit2 approval chain: ERC20 → PCS-specific Permit2 (`0x31c2F6fc...`) → Universal Router (auto-managed, 30-day expiry)
- V4 confirmed winning quotes over V3 by ~2% for tokens with hooked pool liquidity (KITE, RIVER, BTW)

**Uniswap V4 (Ethereum + BSC):**
- Full quoting and swap execution using Uniswap V4's 5-field PoolKey struct `(currency0, currency1, fee, tickSpacing, hooks)`
- On BSC, Uniswap V4 quotes run in parallel with PCS Infinity — best price wins regardless of protocol
- Uses canonical Permit2 (`0x000...22d4`) via `permit2Override`, separate from PCS's custom Permit2
- Fixed wrong ETH quoter address and ABI (was flat params, now PoolKey-based matching actual contract)
- Quote results tagged with `v4Protocol` (`pcs-infinity` or `uniswap-v4`) for correct execution routing

**Background V4 Hook Discovery:**
- `_discoverV4PoolsForPair()` scans Transfer events to Vault → extracts pool IDs from Swap events → reads PoolKey via `poolIdToPoolKey()`
- Background loop: 90s after startup, then every 30 minutes via `startV4DiscoveryLoop()`
- Dedicated RPC providers: V4 quotes use `bsc.publicnode.com`, discovery uses `bsc.drpc.org`

**Quote & Routing Fixes:**
- BSC RPC `UnexpectedCallSuccess` revert data decoded correctly when returned as successful `eth_call` result, with regex fallback
- V4 multi-hop paths try both WBNB and `address(0)` (native BNB) as intermediaries with correct `zeroForOne` sorting
- `forceV3` forces V3 execution when V3 has a valid quote but V2 won the comparison

**Token Scanner Improvements:**
- RPC deep scan early abort: aborts after 50 chunks if >90% error rate (Ethereum public RPCs reject all getLogs), falling back to explorer API results
- Error messages now include `error.code` or truncated JSON fallback when `error.message` is empty

**No API changes** — fixes are internal to the swap routing engine and token scanner.

### PancakeSwap Infinity CLAMM Hooked Pool Support (v2.14.22)

V4 DEX quoter now supports PancakeSwap Infinity CLAMM pools with custom hook contracts and dynamic fees. Tokens with primary liquidity on hooked pools (e.g., BTW on BSC) now get accurate V4 quotes instead of falling back to V3/V2 with worse pricing.

**Technical changes:**
- `V4_HOOKED_POOLS` config maps per-network hook addresses with fee, tickSpacing, and hookFlags
- CLQuoter ABI corrected: returns `(uint256 amountOut, uint256 gasEstimate)` not `(int128[], uint160, uint32)`
- Raw `provider.call()` replaces ethers `staticCall` to handle vault.lock() revert mechanism
- Revert data fallback decodes `UnexpectedCallSuccess(bytes)` error selector (`0x6190b2b0`)
- Sanity check rejects quotes >1000x input amount
- Stablecoin priority changed from BUSD-first to USDT-first across all 6 lookup paths

**No API changes** — V4 hooked pools are used transparently in existing quote and swap endpoints.

### Per-Token Heartbeats, Arbitrage Improvements & UX (v2.14.21)

Each token trader instance now runs its own independent heartbeat timer with regime-based intervals (DUMP=1m, MOON=2m, PUMP=3m, ENTERING=5m, SIDEWAYS=10m, COOLDOWN=15m). Includes concurrency semaphore (max 3), per-network swap mutex to prevent nonce conflicts, shared market data cache (60s TTL), and error backoff (doubles interval after 3 consecutive errors, capped at 30m).

**Token Trader Status API Changes:**
```
GET /api/crypto/strategy/token-trader/status
# Response now includes:
#   heartbeats: { started, tokenCount, concurrentTicks, ticksThisMinute, tokens: { "0x...": { symbol, regime, interval, intervalLabel, running, lastRun, consecutiveErrors, backedOff } } }
```

**Arbitrage & DEX Improvements:**
- V4 multi-hop routing: `_getV4Quote()` now tries WBNB intermediate paths across all fee tier combinations (PancakeSwap Infinity and Uniswap V4)
- USDC added to BSC stablecoins (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`)
- Native pair arbitrage: scanner now checks WBNB↔stablecoin cross-protocol opportunities
- Dual-path buy price impact: quotes both stablecoin→token and native→token, picks lower impact

**UX Improvements:**
- Per-token Save button with confirmation prompt for capital allocation / stop-loss changes
- `userConfigured` flag prevents watchlist rotation for API-added tokens

### Multi-Token Trading & LP Fee Gas Check (v2.14.20)

Token Trader now supports simultaneous trading of multiple tokens with independent funds, regimes, and P&L tracking. Each token is a fully independent instance. API endpoints support `?token=ADDRESS` query param.

**Multi-Token API Changes:**
```
# Configure adds a new instance (or updates existing). Multiple tokens can be active simultaneously.
POST /api/crypto/strategy/token-trader/configure
{"tokenAddress": "0x...", "tokenNetwork": "bsc", "capitalAllocationPercent": 15}
# Response includes: activeInstances count, total capitalAllocation

# Status returns all instances, or filter with ?token=ADDRESS
GET /api/crypto/strategy/token-trader/status
GET /api/crypto/strategy/token-trader/status?token=0x...
# Response: { activeInstances: 2, instances: { "0x...": { token, regime, position, pnl, tracking, settings }, ... } }

# Exit specific instance or all
POST /api/crypto/strategy/token-trader/exit?token=0x...
POST /api/crypto/strategy/token-trader/exit
# Response: { results: [...], remainingInstances: N }

# Restore state requires token identifier
POST /api/crypto/strategy/token-trader/restore-state?token=0x...
```

LP fee collection now checks `tokensOwed0`/`tokensOwed1` (free view call) before submitting on-chain `collect()`, preventing gas waste on zero-fee collections.

### Logging System Fixes & Token Trader Configure Bug (v2.14.19)

Fixed a bug where `configure()` didn't reset cooldown state (`lastDumpSell`, `lastEmergencySell`, etc.) when switching tokens, causing the new token's initial buy to be blocked by stale cooldown from the previous token. Also fixed Winston log rotation to use `tailable: true` on all transports (base filename is now always the active file), eliminated duplicate file handles in `createPluginLogger()` via a forwarding transport, and tightened overly broad filter keywords that caused cross-contamination between log files.

### Token Trader Safety Improvements (v2.14.18)

Six fixes to prevent repeated losses from grid buying into downtrends. Grid buys now have trend gates (short-term < -0.3, long-term < -5%), a 2-hour buy cooldown after emergency sells, escalating cooldowns after consecutive grid buys (30m→1h→2h→4h), a cap of 12 consecutive grid buys without a sell, re-entry trend confirmation after stop-losses, and average entry price sanity checks.

**Token Trader Status API Changes:**
```
GET /api/crypto/strategy/token-trader/status
# Response now includes:
#   settings.gridBuyTrendGate - short-term trend threshold for grid buys (-0.3)
#   settings.gridBuyLongTrendGate - long-term trend threshold for grid buys (-5%)
#   settings.maxConsecutiveGridBuys - max grid buys without a sell (12)
#   settings.emergencySellCooldownMs - buy lockout after emergency sell (7200000ms)
#   settings.reentryTrendGate - trend required for re-entry after stop-loss (0)
#   consecutiveGridBuys - current count of consecutive grid buys
#   lastEmergencySell - ISO timestamp of last emergency sell
```

### Sentinel Trust Integration, PR Review Features, Intent Fixes (v2.14.17)

SENTINEL soulbound tokens now boost P2P peer trust scores (+5 per token, up to +15). Sentinel balance is verified on-chain during peer capabilities exchange. Reviewed 10 AI-generated PRs: merged 4, manually implemented 3 (Shazam recommend, audit log search/healthcheck, compound indexes), closed 3. Fixed ytdlp intent matching for "send me the song X" phrasing and improved query cleanup regexes.

### On-Chain Scammer Registry (v2.14.16)

Deployed an on-chain ScammerRegistry smart contract on BSC with soulbound SCAMMER/SENTINEL token minting, ERC-8004 genesis agent authority, 2-of-3 immunity system, and SKYNET token fee mechanism. Full API and NLP integration. Includes a passive safety layer with local scammer address cache (synced every 4 hours) that blocks swaps, sends, and contract interactions with flagged addresses, and silently ignores token deposits from flagged senders.

**Registry Contract:** `0xEa68dad9D44a51428206B4ECFE38147C7783b9e9` (BSC, verified)
**SCAMMER Token:** `0x12A987e313e05bAAB38B3209c614484149D24711` (soulbound BEP-20)
**SENTINEL Token:** `0xdb700A7DF83bf4dB6e82f91f86B0c38e01645eea` (soulbound BEP-20)

**New Scammer Registry API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/scammer-registry/stats` | Registry stats (count, fee, immunity threshold, genesis agent) |
| GET | `/api/scammer-registry/check/:address` | Check if address is flagged as scammer |
| GET | `/api/scammer-registry/immunity/:address` | Check if address has immunity (2/3 trust factors) |
| GET | `/api/scammer-registry/list?limit=50` | List all flagged scammer addresses |
| GET | `/api/scammer-registry/categories` | Get scam category definitions (1-7) |
| POST | `/api/scammer-registry/report` | Report a scammer address (body: `{ "address": "0x...", "category": 1, "reason": "..." }`) |
| POST | `/api/scammer-registry/batch-report` | Batch report up to 50 addresses (body: `{ "reports": [...] }`) |
| POST | `/api/scammer-registry/remove` | Remove scammer flag, genesis agent only (body: `{ "address": "0x..." }`) |
| POST | `/api/scammer-registry/set-fee` | Update report fee in SKYNET (body: `{ "amount": 50000 }`) — genesis agent only |
| POST | `/api/scammer-registry/set-immunity-threshold` | Update immunity threshold (body: `{ "amount": 100000 }`) — genesis agent only |

> **v2.24.3 fix:** `set-fee` and `set-immunity-threshold` were previously broken (`REGISTRY_ABI` was missing the write methods, so `ethers.Contract.setReportFee` threw `TypeError` on first use). Both endpoints are functional as of v2.24.3.

**USD-Anchored Auto-Pricer (v2.24.3 / v2.24.5):**

The canonical genesis instance automatically keeps `reportFee` and `immunityThreshold` anchored to a USD target via the shared SKYNET/USD oracle. Two hourly Agenda jobs — `skynet-auto-price-fee` and `skynet-auto-price-immunity` — run the same workhorse (`scammerRegistryService._autoUpdateOnchainParam`). Non-genesis instances fail the `_isGenesisInstance()` pre-flight (signer vs `OwnershipFacet.owner()`) and silently no-op, so forks never fire a tx.

`AdminViewFacet` on SkynetDiamond (`0x37414cb701831947C1967f4CbFCB843E67A60212`, cut in at tx `0xc1d2d96ec8e4cf8f4b867fb9956959b4f6b377a8190a41a25c7db69f2e18cef0`) exposes 4 previously-inaccessible getters so the backend can read current values on-chain without shadow state:

- `immunityThreshold() view returns (uint256)`
- `commerceFeeBps() view returns (uint256)`
- `trustStakeThreshold() view returns (uint256)`
- `trustLPThreshold() view returns (uint256)`

`SystemSettings` keys driving the auto-pricer (all default ON for genesis; forks are safe regardless):

| Key | Default | Purpose |
|---|---|---|
| `skynet.scammerFee.autoPrice` | `true` | Kill switch for the fee auto-pricer |
| `skynet.scammerFee.targetUsd` | `0.50` | Desired USD-equivalent flag fee |
| `skynet.scammerFee.driftThresholdPct` | `25` | Skip update if within ±N% of target |
| `skynet.scammerFee.minIntervalHours` | `24` | Hard rate limit between updates |
| `skynet.scammerFee.minFee` | `1000` | SKYNET floor |
| `skynet.scammerFee.maxFee` | `10000000` | SKYNET ceiling |
| `skynet.immunityThreshold.autoPrice` | `true` | Kill switch for the immunity auto-pricer |
| `skynet.immunityThreshold.targetUsd` | `50.00` | Desired USD-equivalent immunity stake |
| `skynet.immunityThreshold.driftThresholdPct` | `25` | Drift gate |
| `skynet.immunityThreshold.minIntervalHours` | `24` | Rate limit |
| `skynet.immunityThreshold.minFee` | `10000` | SKYNET floor |
| `skynet.immunityThreshold.maxFee` | `100000000` | SKYNET ceiling |

The auto-pricer also writes `skynet.scammerFee.lastSetAt` / `skynet.immunityThreshold.lastSetAt` after every successful update (used by the rate limiter — no on-chain timestamp exists). Manual updates via `POST /set-fee` and `POST /set-immunity-threshold` also refresh these timestamps, so an admin manual-set correctly resets the rate limit.

**New NLP Scammer Intents:**

| Intent | Name | Trigger Examples |
|--------|------|-----------------|
| 124 | `scammerReport` | "report 0x1234 as a scammer", "flag 0xabc as address poisoning" |
| 125 | `scammerCheck` | "is 0x1234 a scammer?", "check scammer registry for 0xabc" |
| 126 | `scammerList` | "show scammer registry stats", "list flagged scammers" |
| 127 | `scammerRemove` | "remove 0x1234 from scammer registry" |

**Scam Categories:** 1=Address Poisoning, 2=Phishing, 3=Honeypot, 4=Rug Pull, 5=Fake Contract, 6=Dust Attack, 7=Other

```bash
# Check address via NLP
curl -X POST -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "is 0xc0C70c6cC65d1B10B29eE8733891482B7B0f08F4 a scammer?"}' \
  http://localhost:3000/api/command/execute

# Report scammer via NLP
curl -X POST -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "report 0x1234...abcd as scammer address poisoning"}' \
  http://localhost:3000/api/command/execute

# Get registry stats via API
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/scammer-registry/stats
```

### Memory AI Relevance Filtering (v2.14.15)

The memory system's `analyzeGeneralKnowledge()` method has been replaced with `aiAnalyzeForMemory()`, which uses the active AI provider (via `providerManager.generateResponse()`) to determine if a user message contains personal information worth remembering permanently.

**What changed:**
- Removed keyword/URL/path extraction that stored every URL and any message containing common words like "file" or "task"
- Removed 5 overly broad regex patterns (`instruction`, `goal`, `routine`, `method`, `project`) that caught commands as knowledge
- Added AI-based filter that evaluates messages for personal facts, preferences, opinions, instructions, and corrections
- Pre-filters skip messages < 30 chars, `/` commands, URL-only messages, and obvious command verbs (send/show/check/download/etc.) before invoking AI
- AI response parsed as JSON: `{worth_remembering, type, summary, importance}` — only stores if `worth_remembering === true`
- Uses whatever provider/model is active (e.g., HuggingFace Qwen) — no hardcoded model

**Files modified:** `src/core/memoryManager.js`

### PR Review Implementations (v2.14.13)

- **MongoDB exponential backoff** — Reconnection delay scales from 1s to 30s (`2^attempt * 1000ms`, capped at 30s) instead of fixed 5s intervals. Reduces thundering-herd reconnection storms.
- **Transaction status smart caching** — `GET /api/transactions/status/:txHash?network=` now has rate limiting (100 req/15min), retry on transient errors, and caches only finalized statuses (confirmed/failed). Pending statuses are always fetched fresh.
- **MessageBird MMS** — New `sendMMS` command accepts `originator`, `recipient`, `message`, and `mediaUrl`. Uses the correct `/mms` endpoint (not `/messages`).
- **ERC-8004 capability fix** — Registration file now only includes enabled plugins. Disabled plugins and those without API keys are no longer listed in the capabilities array.

### Telegram Streaming Responses (v2.14.12)

AI query responses now stream in real-time to Telegram using Bot API 9.5 `sendMessageDraft`. Text appears progressively as the AI generates it instead of waiting for the full response.

**How it works:**
- When a general AI query is processed, the response streams token-by-token via `sendMessageDraft` calls
- Draft updates are throttled to every 300ms with in-flight protection to respect Telegram rate limits
- The draft auto-clears when the final message is sent via `sendMessage`
- Non-streaming responses (plugin results, documents, photos, videos) continue to use the existing flow

**Streaming scope:** AI queries only (general questions, conversational fallback, changelog summaries). Plugin operations (device control, email, git, etc.) send results normally without streaming.

**Provider support:**
- OpenAI: `generateStreamingResponse()` using async iterable streaming
- Anthropic: `generateStreamingResponse()` using `client.messages.stream()` with text events
- HuggingFace: `generateStreamingResponse()` using SSE stream parsing of the OpenAI-compatible endpoint
- Other providers: automatic fallback to non-streaming `generateResponse()`

**Files modified:** `src/providers/openai.js`, `src/providers/anthropic.js`, `src/providers/huggingface.js`, `src/core/providerManager.js`, `src/core/agent.js`, `src/interfaces/telegram/telegramDashboard.js`

### Eufy Security Camera Plugin (v2.14.11)

New plugin for Eufy security camera integration via `eufy-security-client` (cloud + P2P, no Docker/HA required).

**Commands:**
| Action | Description | NL Examples |
|--------|-------------|-------------|
| `setup` | Connect to Eufy account (may trigger 2FA) | "setup eufy", "connect eufy" |
| `devices` | List all cameras/stations with status | "list cameras", "show security cameras" |
| `snapshot` | Get camera snapshot, send via Telegram | "show me the front door camera", "take a snapshot" |
| `alerts` | Enable/disable motion/person alerts | "enable camera alerts", "disable motion notifications" |
| `status` | Connection status and alert config | "eufy status", "are alerts enabled" |

**Key features:**
- Lazy connection (connects on first command, not at boot)
- 2FA handled inline via Telegram chat
- Snapshots via cloud pictureUrl (fast) with P2P + ffmpeg fallback
- Motion/person detection alerts with per-device throttle (default 60s)
- Session persistence across restarts (`persistent.json`)
- Fuzzy device lookup by name or serial number

**Credentials:** Set via Web UI credentials manager (`email`, `password`) or env vars (`EUFY_EMAIL`, `EUFY_PASSWORD`).

**Note:** Not yet fully verified in production — 2FA flow and device listing confirmed working; snapshot delivery and motion alerts pending testing.

### Watchlist Composite Scoring (v2.14.8)

Replaced momentum-only watchlist evaluation with a weighted composite scoring system that favors volatile, liquid tokens suitable for grid trading instead of chasing pump tops.

**Composite Score (0-100):**
- **Volatility (60%)**: StdDev of 24h price returns (capped at 20% = max 60pts) + swing count (intervals with >2% moves, 10+ = max 40pts)
- **Liquidity (25%)**: Binary gate (no V3/V4 liquidity = score 0) + depth bonus based on quote `amountOut`
- **Momentum (15%)**: Mild positive (0-30%) scores highest, >50% pump penalized to 20pts, negative scales down — tiebreaker only

**Fail-Count Tolerance:**
- Tokens no longer removed on first failure — `_failCount` tracks consecutive failures per watchlist entry
- 3+ consecutive failures AND not `system: true` → permanent removal
- Successful data fetch resets `_failCount` to 0; transient network errors don't increment
- System tokens (e.g., SKYNET with `system: true`) are never removed regardless of fail count

**Enriched Price Fetcher:**
- `watchlistPriceFetcher` now returns `{price, change24h, priceHistory, hasLiquidity, liquidityDepth, liquidityPaths}` instead of `{price, change24h}`
- Returns data with `hasLiquidity: false` instead of `null` for no-liquidity tokens, enabling fail-count policy
- Transient fetch errors flagged with `fetchError: true` so caller can distinguish from real failures

**Minimum Score Threshold:** Score must be >= 15 to trigger rotation; prevents switching to low-quality candidates.

### Token Trader Watchlist Rotation & LP Auto-Open (v2.14.7)

**LP Market Maker Auto-Open:**
- When enabled with no active position, the market maker automatically opens a V3 LP position during heartbeat checks (10-minute cooldown between attempts)
- Sends Telegram notification on successful auto-open

**Token Trader Watchlist Rotation:**
- During CIRCUIT_BREAKER or COOLDOWN states with no active opportunity, evaluates watchlist tokens for rotation
- Combined price + 24h momentum scoring via `watchlistPriceFetcher` (fetches current price and price history)
- Liquidity verification: checks V3/V4 swap path existence (stablecoin and native routes) before selecting candidate
- If holding tokens worth >$1, sells first via `pendingManualExit`, then rotates next cycle
- If dust (<$1) or no tokens, configures new token immediately
- Untradeable tokens automatically removed from watchlist; active token excluded from evaluation

**Safety Guards:**
- Momentum cap: rejects tokens up >50% in 24h (likely pump tops)
- Probe position sizing: watchlist rotations use 25% of reserve for initial buy
- `configure()` accepts `_preserveBreaker: true` to carry forward consecutive stop-loss count during rotation
- Untradeable token detection: forceV3/no-swap-path buy failures trigger watchlist removal and deconfiguration

### V3 LP Market Maker (v2.14.6)

Autonomous concentrated liquidity market maker for SKYNET/BNB on PancakeSwap V3. Opens ±20% range positions, auto-rebalances when out of range, collects fees hourly. Capital isolated from other strategies, persisted in SystemSettings.

**V3 Pool:** `0x5906fD181999035067bFA30945d1b5e93fccEE61` (BSC, 0.25% fee tier)

**New Market Maker API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/crypto/lp/mm/status` | Config + state snapshot (position, ticks, fees, rebalance count) |
| POST | `/api/crypto/lp/mm/enable` | Enable with optional overrides (body: `{ rangePercent, feeTier, allocationBNB, allocationSKYNET }`) |
| POST | `/api/crypto/lp/mm/disable` | Close active position + disable |
| POST | `/api/crypto/lp/mm/open` | Open new V3 concentrated liquidity position (creates pool if needed) |
| POST | `/api/crypto/lp/mm/close` | Remove all liquidity and deactivate |
| POST | `/api/crypto/lp/mm/rebalance` | Manual rebalance — remove + re-add at current price center |
| POST | `/api/crypto/lp/mm/collect` | Collect accumulated V3 trading fees |
| POST | `/api/crypto/lp/mm/schedule` | Schedule operation (`rebalance`/`collect`/`open`/`close`). Body: `{ operation, when }` — `when` accepts ISO date, natural language ("in 5 minutes"), or 5/6-field cron (recurring). v2.25.10 |
| GET | `/api/crypto/lp/mm/schedule` | List active scheduled jobs with next-run times |
| DELETE | `/api/crypto/lp/mm/schedule/:jobId` | Cancel scheduled operation |

```bash
# Check market maker status
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/crypto/lp/mm/status

# Enable with config
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"allocationBNB": 0.01, "allocationSKYNET": 500000, "rangePercent": 20}' \
  http://localhost:3000/api/crypto/lp/mm/enable

# Open position
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/crypto/lp/mm/open
```

**Bug fixes:**
- `ethers.MaxUint128` undefined in ethers v6 — replaced with BigInt literal in V3 fee collection
- V3 `addLiquidityV3` duplicate key error on pool re-entry — changed to upsert pattern
- Residual sweep selling market maker's WBNB capital — WBNB now skipped when MM enabled
- V3 close/rebalance crash on zero-liquidity positions — graceful handling added

### On-Chain Staking & NLP Integration (v2.14.5)

SKYNET staking contract deployed to BSC mainnet with full API, Web UI dashboard, scheduler auto-renewal, and natural language control.

**Staking Contract:** `0x9205b5E16E3Ef7e6Dd51EE6334EA7f8D7Fec31d6` (BSC, Sourcify verified)

**New Staking API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/staking/info` | Current user's stake position (staked, rewards, APY, balance) |
| GET | `/api/staking/stats` | Contract-wide stats (total staked, reward rate, epoch timing) |
| POST | `/api/staking/stake` | Stake SKYNET tokens (body: `{ "amount": 1000 }`) |
| POST | `/api/staking/unstake` | Unstake tokens — auto-claims pending rewards (body: `{ "amount": 500 }` or `{ "percentage": 50 }`) |
| POST | `/api/staking/claim` | Claim pending staking rewards |
| POST | `/api/staking/fund` | Fund new reward epoch, owner only (body: `{ "amount": 20000000, "duration": 604800 }`) |
| GET | `/api/staking/history` | Staking transaction history |

**New NLP Staking Intents:**

| Intent | Name | Trigger Examples |
|--------|------|-----------------|
| 119 | `stakingStatus` | "check my staking status", "how much am I staking", "staking rewards" |
| 120 | `stakingStake` | "stake 5000 SKYNET", "stake all my tokens", "I want to stake" |
| 121 | `stakingUnstake` | "unstake 1000 SKYNET", "withdraw my stake", "unstake all" |
| 122 | `stakingClaim` | "claim my staking rewards", "collect staking yield" |

```bash
# Check staking status via NLP
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "check my staking status"}' \
  http://localhost:3000/api/command/execute

# Stake via API
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount": 1000}' \
  http://localhost:3000/api/staking/stake

# Claim rewards via NLP
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "claim my staking rewards"}' \
  http://localhost:3000/api/command/execute
```

**Bug fixes:**
- Crypto price lookup no longer fails with "symbol is required" when no specific token is mentioned
- Task creation no longer throws validation errors when AI parameter extraction yields empty results

### Crypto Strategy Improvements & SKYNET Enhancements (v2.14.3)

**Token Trader (Config v6):**
- Fixed emergency sell being blocked by profit filter — hourly -8%/hr drops now correctly bypass the $1 minimum
- Fixed whois plugin logging redundant errors on startup when API key is missing (now silently registers as disabled)
- Added PUMP regime wide trailing stop (12% from peak, activates at +10% gain) to prevent giving back large unrealized gains
- Added 25% scale-out level: `[10, 20, 25, 30, 40, 50]` with rebalanced progressive sizing
- Lowered grid sell minimum profit to $0.25 (from $1) for small position viability

**Dollar Maximizer:**
- Idle capital easing: gradually tightens buy threshold after 7+ days holding stablecoins (linear ramp to 50% easing over 21 days)

**SKYNET Service & Pricing:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/p2p/api/skynet/token-price` | Live SKYNET price from PancakeSwap V2 LP reserves |
| POST | `/p2p/api/skynet/services/market-prices` | Set USD-tiered market prices for all services |

- Service eligibility filtering: 17 whitelisted safe categories, disabled plugins excluded
- UI confirmation prompts on all settings-changing buttons
- Mobile-friendly governance vote button layout
- Intent 118 (`skynetEconomyLive`): Live data marketplace, arb signals, referral history, compute jobs
- Dynamic system prompt with auto-refreshing bounty/proposal context (5-min cache)

### SKYNET Agent Knowledge (v2.14.1)

ALICE now has full knowledge of SKYNET token and Skynet P2P network built into her system prompt. Three new NLP intents allow users to ask about SKYNET and get live data:

| Intent | Name | Trigger Examples | Data Source |
|--------|------|-----------------|-------------|
| 115 | `skynetInfo` | "what is SKYNET?", "do I need tokens?", "how does P2P work?" | System prompt knowledge |
| 116 | `skynetNetworkStatus` | "skynet network status", "how many peers?", "show bounties" | P2PPeer, SkynetServiceConfig, SkynetBounty, SkynetGovernance models |
| 117 | `skynetTokenInfo` | "SKYNET token info", "show token ledger", "SKYNET allocations" | SkynetTokenLedger, SkynetPayment models |

```bash
# Ask about SKYNET (general knowledge)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "What is SKYNET?"}' \
  http://localhost:3000/api/command/execute

# Live network status (peers, bounties, proposals)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "show skynet network status"}' \
  http://localhost:3000/api/command/execute

# Live token ledger (allocations, payments)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "show SKYNET token ledger"}' \
  http://localhost:3000/api/command/execute
```

### SKYNET Token Economy — Full Implementation (v2.14.0)

Complete 5-phase SKYNET token economy deployed to production. BEP-20 token on BSC mainnet powering paid P2P services, reputation staking, bounties, and governance.

**Enhancements (post-deploy):**
- SKYNET added to default arbitrage scanner tokens on BSC
- Wallet balances UI shows active token trader token balance (e.g., SIREN)

**Phase 1 — Token Contract & Foundation:**
- SKYNET BEP-20 Contract: `0x8Ef0ecE5687417a8037F787b39417eB16972b04F` — 100M fixed supply
- SKYNET/BNB LP: PancakeSwap V2 pair `0xF3dEF3534EEC3195e0C217938F710E6F2838694A`
- SkynetTokenLedger model for minted vs bought token accounting
- Permanent system token in Token Trader watchlist

**Phase 2 — Paid Services:**
- 6 new P2P message types for service catalog, requests, payments
- SKYNET BEP-20 payment verification (Transfer events, double-spend prevention, 3-block confirmations)
- Per-operation pricing with SkynetServiceConfig model
- Web UI Services tab with bulk controls and revenue dashboard

**Phase 3 — Liquidity Management:**
- V2 LP methods: `addLiquidity()`, `removeLiquidity()`, `getLPInfo()`
- LPPosition model for position tracking
- Web UI LP management card

**Phase 4 — Reputation Staking:**
- Composite trust scores (0-100): manual trust, ERC-8004, SKYNET balance, longevity, activity
- On-chain SKYNET balance verification via BSC RPC
- Trust score badges in Web UI peer cards

**Phase 5 — Extended Economy:**
- Bounty posting and claiming protocol (SkynetBounty model)
- Token-weighted governance voting (SkynetGovernance model)
- Agent-to-agent tipping
- Web UI Economy tab with bounties and proposals

**New API Endpoints (P2P Skynet):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/p2p/api/skynet/stats` | Revenue stats and overview |
| GET | `/p2p/api/skynet/services` | List available services |
| PUT | `/p2p/api/skynet/services/:id` | Enable/disable service, set price |
| POST | `/p2p/api/skynet/services/bulk` | Bulk enable/disable services |
| POST | `/p2p/api/skynet/services/sync` | Discover services from plugins |
| GET | `/p2p/api/skynet/payments` | Recent payment history |
| GET | `/p2p/api/skynet/economy` | Economy stats (bounties + governance) |
| GET | `/p2p/api/skynet/bounties` | List bounties |
| POST | `/p2p/api/skynet/bounties` | Create bounty |
| GET | `/p2p/api/skynet/proposals` | List governance proposals |
| POST | `/p2p/api/skynet/proposals` | Create proposal |
| POST | `/p2p/api/skynet/proposals/:id/vote` | Vote on proposal |
| GET | `/p2p/api/skynet/data-listings` | Data marketplace listings |
| POST | `/p2p/api/skynet/data-listings` | Create data listing |
| GET | `/p2p/api/skynet/arb-signals` | Recent arbitrage signals |
| GET | `/p2p/api/skynet/referrals` | Referral reward stats |
| GET | `/p2p/api/skynet/compute-jobs` | Compute job history |
| GET | `/api/settings/skynet-token-address` | Get SKYNET token address |
| POST | `/api/settings/skynet-token-address` | Set SKYNET token address |

**New API Endpoints (Crypto LP):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/crypto/lp/positions` | List LP positions |
| POST | `/api/crypto/lp/positions/refresh` | Refresh all positions |
| POST | `/api/crypto/lp/add` | Add liquidity to V2 pair |
| POST | `/api/crypto/lp/remove` | Remove liquidity from V2 pair |
| GET | `/api/crypto/lp/info?tokenA=&tokenB=&network=` | Get pair info |

### PR Review + New Features (v2.13.8)

Reviewed 17 AI-generated PRs (#1641–#1658). Merged 2 clean PRs, closed 12 with fundamental issues, reimplemented 3 features manually with correct code.

**New features:**
- **Twitter Poll Results**: `fetchPollResults` command fetches poll choices, vote counts, total votes, and time remaining from Twitter/X polls using FxTwitter API.
- **Custom Transcoding Profiles**: `/convert` endpoint now accepts `customProfile` JSON with `videoCodec`, `audioCodec`, `resolution`, `videoBitrate`, `audioBitrate`. Validates codecs against allowlists and format patterns.
- **PDF Annotations**: New `POST /annotate` endpoint draws highlights (yellow rectangles), comments (text), and shapes onto PDF pages using pdf-lib.
- **Weatherstack Forecast**: New `getWeatherForecast` command fetches multi-day forecasts via Weatherstack `/forecast` endpoint.
- **Vonage messageId**: `sendSms` and `sendMms` now return `messageId` from the Vonage API response.
- **HuggingFace Qwen2.5-Coder-32B-Instruct**: Added to available chat models, accessible via HuggingFace router with `:fastest`/`:cheapest` policy support.

### Report Overhaul, yt-dlp Fixes, LAN Downloads, PR Review (v2.13.6)

Reviewed 12 AI-generated PRs (#1626–#1640). Merged 2, closed 8 with issues, reimplemented 2 features correctly.

**Daily Status Report Overhaul** — Rewrote `generateWeeklyReport()` with parallel data gathering and 6 new data sections:
- Fixed memory activity querying `$metadata.source` instead of root `$source`
- Fixed scheduled job counting to estimate actual run counts from intervals
- Added AI usage stats (token counts, costs, model breakdown from TokenUsage)
- Added crypto stats from SubAgent domain state
- Added media stats from Sonarr/Radarr plugins
- Added self-improvement stats from ImprovementMetrics

**yt-dlp Video Format Routing** — `downloadAudio()` now detects video formats and redirects to `downloadMedia()`:
```
POST /api/plugin
{ "plugin": "ytdlp", "action": "audio", "url": "https://youtube.com/...", "format": "mp4" }
```
Previously this would normalize `mp4` to `m4a` audio. Now it correctly downloads the video.

**LAN Download Links** — When files exceed Telegram's 50MB bot limit, a LAN download URL is provided:
```
http://192.168.0.50/downloads/filename.mp4
```
The server's LAN IP is auto-detected from `os.networkInterfaces()` via `getServerHost()` in `src/utils/paths.js`. Override with `AGENT_HOST` or `SERVER_IP` env vars. Static file serving via `/downloads` route.

**Agent Stats Compare Command** — Compare improvement stats between current and previous time periods:
```
POST /api/plugin
{
  "plugin": "agentstats",
  "action": "compare",
  "days": 14
}
```
Returns side-by-side comparison of total improvements, merged count, average per day, and trend direction.

**NumbersAPI Batch Processing** — Process multiple fact requests in a single call:
```
POST /api/plugin
{
  "plugin": "numbersapi",
  "action": "batch",
  "requests": [
    { "action": "trivia", "number": 42 },
    { "action": "year", "year": 1969 }
  ]
}
```

**Market Indicators Historical Tracking** — `MarketIndicators` now stores historical data points (bounded to 1000 per indicator) with `calculateMovingAverage(indicator, period)` and `calculateVolatility(indicator, period)` methods.

**Scraping Retry Fix** — Retryable failures now properly throw errors so `retryOperation` actually retries. New health check endpoint:
```
GET /api/external/scraping/health
```

---

### PR Review + Feature Implementations (v2.13.5)

Reviewed 22 AI-generated PRs (#1604–#1625). Merged 4, closed 15 with issues, salvaged 3 features with correct implementations.

**NOT Operator for Filtered Log Transport** — `FilteredFileTransport` now supports `NOT` logical operator alongside `AND`/`OR`:
```javascript
new FilteredFileTransport({
  filename: 'excluded.log',
  filters: [info => info.service === 'noisy-service'],
  logicalOperator: 'NOT'  // logs everything EXCEPT matching entries
});
```

**\*Arr Notification Management** — All \*arr plugins (Radarr, Sonarr, Lidarr, Readarr, Prowlarr) gain notification management:
```
POST /api/plugin
{ "plugin": "radarr", "action": "get_notifications" }

POST /api/plugin
{ "plugin": "sonarr", "action": "create_notification", "name": "My Webhook", "implementation": "Webhook", ... }

POST /api/plugin
{ "plugin": "radarr", "action": "delete_notification", "id": 5 }
```

**Multi-Format External Image Generation** — The external image generation endpoint now accepts a `format` parameter:

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/external/image/generate` | ERC-8004 + Payment | Generate image with optional format (png, jpeg, webp, tiff). Body: `prompt`, `provider`, `model`, `size`, `style`, `format` |

```bash
curl -X POST http://localhost:3000/api/external/image/generate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A futuristic city", "format": "jpeg"}'
```

**Other Improvements:**
- HealingEvent `isInCooldown()` caches results via NodeCache
- `UserPreference.setPreferences()` saves history snapshots; `getPreferenceHistory()` for audit trail
- FeatureRequest static methods now log errors via logger
- ScanProgressCache DB operations wrapped in `retryOperation()`

### PR Review + Account Caching & Batch Typed Data Verification (v2.13.4)

Reviewed and closed 13 AI-generated PRs (#1591–#1603). Salvaged and correctly implemented features from the better ideas:

**Batch Typed Data Signature Verification** — New endpoint delegating to existing `signatureService.verifyTypedDataSignaturesBatch()`:

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/signatures/verify-typed-data-batch` | JWT | Verify multiple EIP-712 typed data signatures sequentially (body: `domains[]`, `types[]`, `values[]`, `signatures[]`, optional `expectedAddresses[]`) |

```bash
curl -X POST http://localhost:3000/api/signatures/verify-typed-data-batch \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domains": [{"name":"Test","version":"1"}],
    "types": [{"Message":[{"name":"content","type":"string"}]}],
    "values": [{"content":"hello"}],
    "signatures": ["0x..."],
    "expectedAddresses": ["0x..."]
  }'
```

**Account Listing Cache** — Account list queries are now cached for 5 minutes with automatic invalidation on any write operation (register, bulk-register, manual add, status update, delete, credentials update, primary change). Cache keys use sorted JSON for consistent lookups regardless of query parameter order.

**Registry Client Cleanup** — Removed unused `isRetryableError` import from P2P registry client.

### PR Review Batch + External Gateway Enhancements (v2.13.3)

Reviewed and closed 10 AI-generated PRs (#1581–#1590). Implemented 5 features manually with corrected code:

**Batch Document Processing** — New endpoint for processing multiple documents in parallel:

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/external/documents/process/batch` | ERC-8004 + Payment | Process up to 10 files concurrently (multipart form: `files[]`, body: `operation`, `language`, `outputFormat`) |

**Scraping Improvements** — External scraping endpoint now retries failed requests (3 attempts via `retryOperation`) and caches successful results for 10 minutes with composite cache keys (action + URL + selectors).

**Identity Verification Circuit Breaker** — External auth middleware tracks consecutive failures and opens circuit after 5 failures, fast-failing for 30 seconds before allowing a test request. Prevents hammering blockchain providers during outages.

**P2P Peer Grouping** — PeerManager groups peers by trust level and capabilities hash. New method `getPeersByGroup(trustLevel, capabilitiesHash)` returns matching peer fingerprints. Properly removes peers from old groups on state changes.

**Market Indicator Batch Fetch** — `MarketIndicators.getCachedValues(keys, fetchers)` fetches multiple cached indicators concurrently via `Promise.all`.

### Skynet Rename & Toggle (v2.13.1)

P2P Federation UI renamed to "Skynet". Enable/disable from the web UI with a confirmation toggle — no `.env` changes or restart required. Backed by SystemSettings with dynamic service start/stop.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/p2p/api/toggle` | JWT/API Key | Enable or disable Skynet dynamically (body: `{ "enabled": true/false }`) |

### P2P Knowledge Packs (v2.13.0)

Structured, signed knowledge packages that agents can discover, evaluate, and import via the LANP federation protocol. Extends the existing plugin sharing system to support memory sharing between peers.

**Knowledge Pack Management**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/p2p/api/knowledge-packs` | JWT/API Key | List all knowledge packs (filter by direction/status via query params) |
| GET | `/p2p/api/knowledge-packs/pending` | JWT/API Key | Get packs awaiting user approval |
| GET | `/p2p/api/knowledge-packs/:id` | JWT/API Key | Get full pack details |
| POST | `/p2p/api/knowledge-packs` | JWT/API Key | Create a knowledge pack from existing memories |
| POST | `/p2p/api/knowledge-packs/:id/approve` | JWT/API Key | Approve and import a pending pack |
| POST | `/p2p/api/knowledge-packs/:id/reject` | JWT/API Key | Reject a pending pack |
| DELETE | `/p2p/api/knowledge-packs/:id` | JWT/API Key | Delete a local or rejected/failed pack |

**Peer Knowledge Pack Discovery**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/p2p/api/peers/:fingerprint/knowledge-packs` | JWT/API Key | Request pack list from a peer (returns cached list if available) |
| POST | `/p2p/api/peers/:fingerprint/knowledge-packs/:packId/request` | JWT/API Key | Request full knowledge pack transfer from a peer |

Settings endpoints now include `kpAutoImport` (boolean) and `kpTopicWhitelist` (string array) fields.

```bash
# List all knowledge packs
curl -H "x-api-key: $API_KEY" http://localhost:3000/p2p/api/knowledge-packs

# Create a knowledge pack from memories
curl -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Networking Basics","summary":"Core networking knowledge","topic":"networking","tags":["tcp","dns","routing"],"query":{"types":["knowledge","fact"],"minImportance":5}}' \
  http://localhost:3000/p2p/api/knowledge-packs

# Approve and import a received pack
curl -X POST -H "x-api-key: $API_KEY" http://localhost:3000/p2p/api/knowledge-packs/PACK_ID/approve

# Request a peer's knowledge pack list
curl -H "x-api-key: $API_KEY" http://localhost:3000/p2p/api/peers/FINGERPRINT/knowledge-packs
```

### Bugfixes (v2.12.1)

- **Email parameter extraction errors fixed** — `email.send` and `email.findContact` no longer fail with confusing "Required field missing" validation errors when AI parameter extraction encounters issues. The actual error message (e.g., "Cannot find contact X") is now returned to the user.
- **Contact search fallback** — Multi-word contact names are now correctly captured in fallback regex extraction.

### Skynet — P2P Federation / LANP (v2.12.0+)

End-to-end encrypted multi-instance networking. LANAgent instances connect to a WebSocket relay at `registry.lanagent.net` to discover peers, exchange capabilities, and share plugins — all without the registry seeing any plaintext.

**Status, Identity & Toggle**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/p2p/api/status` | JWT/API Key | Connection status, fingerprint, peers online, uptime, message stats |
| GET | `/p2p/api/settings` | JWT/API Key | Get settings (enabled, registry URL, display name, auto-share, auto-install) |
| POST | `/p2p/api/settings` | JWT/API Key | Save settings (updates .env for registry URL, PluginSettings for preferences) |
| POST | `/p2p/api/toggle` | JWT/API Key | Enable/disable Skynet dynamically without restart (body: `{ "enabled": true/false }`) |

**Peer Management**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/p2p/api/peers` | JWT/API Key | List all known peers with trust level, online status, capabilities count |
| GET | `/p2p/api/peers/online` | JWT/API Key | List only online peers |
| GET | `/p2p/api/peers/:fingerprint` | JWT/API Key | Get peer details including capabilities list |
| POST | `/p2p/api/peers/:fingerprint/trust` | JWT/API Key | Set trust level (`trusted` or `untrusted`) |
| POST | `/p2p/api/peers/:fingerprint/ping` | JWT/API Key | Ping a peer to check latency |

**Plugin Sharing**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/p2p/api/peers/:fingerprint/plugins` | JWT/API Key | Request plugin list from a peer |
| POST | `/p2p/api/peers/:fingerprint/plugins/:pluginName/request` | JWT/API Key | Request a specific plugin from a peer |

**Transfer Management**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/p2p/api/transfers` | JWT/API Key | Get transfer history (default limit: 50) |
| GET | `/p2p/api/transfers/pending` | JWT/API Key | Get plugins awaiting user approval |
| POST | `/p2p/api/transfers/:transferId/approve` | JWT/API Key | Approve and install a pending plugin |
| POST | `/p2p/api/transfers/:transferId/reject` | JWT/API Key | Reject a pending plugin transfer |

```bash
# Check federation status
curl -H "x-api-key: $API_KEY" http://localhost:3000/p2p/api/status

# Get settings
curl -H "x-api-key: $API_KEY" http://localhost:3000/p2p/api/settings

# Update settings
curl -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"displayName":"My LANAgent","autoShare":true,"autoInstallTrusted":false}' \
  http://localhost:3000/p2p/api/settings

# List peers
curl -H "x-api-key: $API_KEY" http://localhost:3000/p2p/api/peers

# Set peer trust level
curl -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"level":"trusted"}' \
  http://localhost:3000/p2p/api/peers/800204d279f28334/trust
```

### Nano Fixes, Faucet Automation & UI Improvements (v2.11.0)

Fixed Nano RPC endpoints (switched to rainstorm.city/api as primary), fixed invalid representative address, added 429 rate limit handling with exponential backoff. Transaction labels now correctly show `trade_sell`/`trade_buy` instead of `defi_yield`/`service_payment`. Fixed token symbol resolution for FHE, SIREN, LINK. External service toggles now use toggle switches with confirmation modals. Revenue API rate limit increased to 300/15min. Fixed missing auth on refresh-balances endpoint.

New faucet endpoints:
- `POST /api/faucets/claim/nano` — Trigger Nano faucet claim (browser automation, currently disabled)
- `GET /api/faucets/nano/status` — Nano faucet status (claims, cooldown, errors)

### PR Review Batch + Grid Adaptive Spacing + Sandbox Expansion (v2.13.2)

Reviewed and closed 19 AI-generated PRs (#1559–#1580). Salvaged two good ideas and implemented manually:

- **Grid trading adaptive spacing** — Grid spacing dynamically adjusts based on real-time price volatility. Tracks rolling price history, calculates standard deviation of returns, scales spacing 0.5x–2.5x of base config. Grid stats include volatility multiplier per symbol.
- **Sandbox language expansion** — Added C, C++, TypeScript, Perl, and Kotlin (14 languages total). Compiled languages get exec-enabled `/build` tmpfs. Supported: Python, Node.js, Bash, Ruby, Go, PHP, Java, Rust, C, C++, TypeScript, Perl, Kotlin.

### Sandbox Language Expansion (v2.10.98)

Added PHP 8.3, Java 17, and Rust 1.84 to the code execution sandbox (8 languages total). Compiled languages (Java, Rust) get a separate `/build` tmpfs with exec permissions while `/tmp` remains `noexec` for security. Supported languages: Python, Node.js, Bash, Ruby, Go, PHP, Java, Rust.

### PR Review Batch + Checkly Plugin Enhancement (v2.10.97)

Reviewed 8 AI-generated PRs (#1486–#1493). Merged PR #1492 which adds `create_check` and `delete_check` commands to the Checkly monitoring plugin, with cache invalidation fixes applied post-merge. Closed 7 PRs with detailed comments explaining issues (dead code, wrong imports, nonexistent methods, duplicate functionality).

### External Gateway Payment Notifications (v2.10.96)

Owner receives real-time Telegram notifications when external agents pay for services. Notifications include service name, caller agent ID, BNB amount, truncated TX hash, and confirmation count. Implemented as fire-and-forget in the payment middleware — covers all 8 paid services automatically.

Fixed "Invalid Date" on the external services admin dashboard — `.lean()` queries were returning raw BSON types that serialized as empty objects instead of ISO date strings.

### PR Review + Resilience Improvements (v2.10.95)

Reviewed 24 AI-generated PRs. Key improvements:
- **Web scraper**: Retry logic refactored to use `retryOperation` utility
- **SSH sessions**: Auto-timeout management for long-running sessions
- **MCP server**: Status updates resilient to transient DB errors
- **External catalog**: Response caching (5-min TTL) and rate limiting (100 req/15min)
- **Strategy registry**: Dependency management for trading strategies
- **Runtime errors**: Trend query caching and retry logic
- **AutoAccount**: Account lifecycle methods (deactivate, reactivate, archive)
- **Gravatar**: Profile fetch caching (1-hour TTL)
- **DCA strategy**: Volatility-based buy interval adjustment
- **Bug reports**: Status change history tracking
- **Validation**: Result caching for repeated inputs
- **Image generation**: Retry on failed external generation requests

### Agent Self-Awareness + External Service Stats (v2.10.94)

ALICE now has full knowledge of her external service gateway in her system prompt. New NLP intent for querying service stats:

```bash
# Ask ALICE about her external service revenue and usage
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "show external service stats"}' \
  http://localhost:3000/api/command/execute
```

Returns: service list with pricing, total revenue in BNB, payment count, recent payments, and request counts.

Other valid queries: "how much revenue from external services", "what payments have you received", "how much BNB have you earned", "who has used your services".

### External Gateway: Code Sandbox + PDF Toolkit (v2.10.93)

Two new services added to the external gateway at `https://api.lanagent.net`:

**Code Execution Sandbox** — Execute code in isolated Docker containers with full sandboxing (no network, read-only FS, 256MB RAM, 2 CPU, 64 PID limit).

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/external/sandbox/execute` | ERC-8004 + BNB (0.002) | Execute code in sandbox |

```bash
# Execute Python code (returns 402 with payment details)
curl -X POST https://api.lanagent.net/api/external/sandbox/execute \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Id: 2930' -H 'X-Agent-Chain: bsc' \
  -d '{"language": "python", "code": "print(sum(range(100)))", "timeout": 10}'
```

Request body: `{ language: "python"|"node"|"bash"|"ruby"|"go", code: "...", timeout: 1-30 }`
Response: `{ success, stdout, stderr, exitCode, executionTime, language }`

**PDF Toolkit** — Merge, split, compress, watermark, and extract text from PDFs.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/external/pdf/merge` | ERC-8004 + BNB (0.0005) | Merge 2-20 PDFs |
| POST | `/api/external/pdf/split` | ERC-8004 + BNB (0.0005) | Split by page ranges |
| POST | `/api/external/pdf/compress` | ERC-8004 + BNB (0.0005) | Compress with quality settings |
| POST | `/api/external/pdf/watermark` | ERC-8004 + BNB (0.0005) | Add text watermark |
| POST | `/api/external/pdf/extract` | ERC-8004 + BNB (0.0005) | Extract text and metadata |

```bash
# Merge two PDFs
curl -X POST https://api.lanagent.net/api/external/pdf/merge \
  -H 'X-Agent-Id: 2930' -H 'X-Agent-Chain: bsc' \
  -F 'files=@doc1.pdf' -F 'files=@doc2.pdf'

# Extract text from PDF
curl -X POST https://api.lanagent.net/api/external/pdf/extract \
  -H 'X-Agent-Id: 2930' -H 'X-Agent-Chain: bsc' \
  -F 'file=@document.pdf' -F 'format=json'
```

### ERC-8004 Phase 2 — NFT Display, Telegram, linkWallet (v2.10.91)

Full NFT card display in Web UI (avatar with glow, chain badge, metadata grid, BscScan/IPFS links). Telegram `getAgentNFT` intent returns avatar photo with NFT details. `POST /api/agent/erc8004/link-wallet` links a wallet via EIP-712 signed `setAgentWallet()`. All buttons hardened with double-click guards and gas cost confirmations. Staleness auto-notification.

**New endpoint:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agent/erc8004/link-wallet` | Link wallet via EIP-712 setAgentWallet() |

**Example:**
```bash
# Link wallet to agent identity
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:3000/api/agent/erc8004/link-wallet
```

### ERC-8004 Minting Fix (v2.10.90)

Fixed critical bugs preventing on-chain minting: corrected BSC registry address to official mainnet deployment (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), fixed wallet signer field mappings, and added full ERC-8004 ABI. ALICE is now registered as **Agent #2930** on BSC mainnet.

### ERC-8004 Agent Identity (v2.10.89)

On-chain identity NFT system for AI agents. Generates a registration file from agent capabilities, uploads to IPFS via Pinata, and mints an ERC-721 identity token on BSC (or Ethereum). Uses the official [ERC-8004 Identity Registry](https://github.com/erc-8004/erc-8004-contracts) deployed at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (same address across all chains via CREATE2).

**Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agent/erc8004/status` | Identity status, chain, agentId, staleness, gas estimate |
| POST | `/api/agent/erc8004/registration` | Generate & preview registration file JSON |
| POST | `/api/agent/erc8004/mint` | Upload to IPFS → mint identity NFT on-chain |
| PUT | `/api/agent/erc8004/update` | Re-upload → update on-chain URI |
| POST | `/api/agent/erc8004/pinata-key` | Save Pinata IPFS API keys (encrypted) |
| GET | `/api/agent/erc8004/pinata-key` | Check Pinata key configuration |

**Examples:**
```bash
# Check identity status
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agent/erc8004/status

# Preview registration file
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:3000/api/agent/erc8004/registration

# Save Pinata keys
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "your_key", "secretKey": "your_secret"}' \
  http://localhost:3000/api/agent/erc8004/pinata-key

# Mint identity NFT on BSC
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"chain": "bsc"}' \
  http://localhost:3000/api/agent/erc8004/mint
```

### Plugin Reliability Improvements (v2.10.88)

**FCM Plugin** — All HTTP calls now use `retryOperation` with exponential backoff. `sendBulkMessages` batches registration tokens into groups of 1000 (FCM limit) with `Promise.allSettled` for partial success reporting.

**jsonplaceholder Plugin** — Caching switched from `Map` to `NodeCache` with automatic 5-minute TTL. All API calls wrapped with `retryOperation` and descriptive context strings. Cache invalidation is now selective (e.g., creating a post only clears posts-related cache, not user/comment data).

### Calibre Content Server Plugin (v2.10.85)

New plugin for browsing and searching Calibre eBook libraries with 15 commands accessible via natural language or direct API calls. Read-only access to the Calibre Content Server AJAX API.

**Setup:** Configure server URL in the Calibre plugin settings tab, or set `CALIBRE_URL` environment variable. Optionally set `CALIBRE_USERNAME` and `CALIBRE_PASSWORD` for auth-enabled servers.

**Commands:**

| Category | Actions |
|----------|---------|
| Library Info | `get_libraries`, `library_stats` |
| Search | `search_books` |
| Book Details | `get_book`, `get_formats`, `get_download_link` |
| Browse | `browse_categories`, `browse_category` |
| By Field | `books_by_author`, `books_by_tag`, `books_by_series`, `books_by_publisher`, `books_by_rating` |
| Recent | `recent_books` |

**Examples:**
```bash
# Search Calibre library
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "calibre", "action": "search_books", "query": "Foundation"}'

# Books by author
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "calibre", "action": "books_by_author", "author": "Isaac Asimov"}'

# Get download link
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "calibre", "action": "get_download_link", "bookId": 42, "format": "EPUB"}'
```

### Jellyfin Media Server Plugin (v2.10.84)

New plugin for managing Jellyfin media servers with 30 commands accessible via natural language or direct API calls.

**Setup:** Configure server URL and API key in the Jellyfin plugin settings tab, or set `JELLYFIN_URL` and `JELLYFIN_API_KEY` environment variables.

**Commands:**

| Category | Actions |
|----------|---------|
| System | `get_server_info`, `restart_server`, `shutdown_server`, `get_activity_log`, `get_scheduled_tasks`, `run_scheduled_task`, `stop_scheduled_task` |
| Libraries | `get_libraries`, `refresh_library` |
| Media | `get_items`, `get_item_details`, `get_latest_media`, `search_media`, `delete_item`, `refresh_item` |
| TV Shows | `get_seasons`, `get_episodes`, `get_next_up` |
| Users | `get_users`, `get_user`, `create_user`, `delete_user`, `update_user_password` |
| Sessions | `get_sessions`, `send_play_command`, `send_message` |
| Playlists | `get_playlists`, `create_playlist`, `add_to_playlist`, `remove_from_playlist` |
| Packages | `get_installed_plugins`, `get_available_packages` |

**Examples:**
```bash
# Search Jellyfin library
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "jellyfin", "action": "search_media", "query": "Inception"}'

# List all movies
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "jellyfin", "action": "get_items", "type": "Movie", "limit": 50}'

# Get active sessions (who is watching)
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "jellyfin", "action": "get_sessions"}'

# Pause playback on a session
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "jellyfin", "action": "send_play_command", "sessionId": "abc123", "command": "Pause"}'

# Get next-up episodes
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "jellyfin", "action": "get_next_up"}'

# Create a new user
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "jellyfin", "action": "create_user", "name": "John", "password": "mypass123"}'
```

**Natural language:** "search jellyfin for Inception", "who is watching jellyfin", "what was recently added to jellyfin", "list jellyfin users", "scan jellyfin library"

### Performance & Feature Improvements (v2.10.83)

**Query caching & retry** — FeatureRequest and SystemReport models now use NodeCache (5min TTL) and retryOperation for all static query methods, reducing database load for frequently accessed data.

**NetworkDevice indexes** — Added compound indexes on `services.port`+`services.protocol` and `stats.uptimePercentage` for faster device queries.

**GitHostingProvider retry** — New `performNetworkOperation(asyncCall, options)` method provides configurable retry logic for all git hosting subclass network operations.

**FilteredTransport dynamic log levels** — New `updateLogLevel(newLogLevel)` method allows runtime log level changes without restart.

**Account activity logging** — All account API operations are now logged with method, URL, userId, and response status code.

**FCM message priority** — `sendMessage` and `sendBulkMessages` now accept an optional `priority` parameter ('high' or 'normal') with proper Android and APNs handling:
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "firebasecloudmessagingfcm", "action": "sendMessage", "registrationToken": "device-token", "title": "Alert", "body": "Urgent message", "priority": "high"}'
```

### *Arr NLP Fixes & Circuit Breaker (v2.10.82)

Fixed critical circuit breaker bug where `calculateDynamicRetryParams()` defaulted to 5 retries with no history (after restart), exceeding the circuit breaker threshold. Also fixed *arr intent misclassification where same-plugin intents had near-identical vector embeddings. Post-match keyword disambiguation now correctly routes list/search/add/delete actions for all *arr plugins.

**Improved error handling** — *arr API errors now return clean messages instead of crashing on axios circular references:
```
"readarr API error (503): Search for 'Andy Weir' failed. Invalid response received from Goodreads."
```

### *Arr Media Management Plugins (v2.10.80)

Five new plugins for managing media libraries via Radarr, Sonarr, Lidarr, Readarr, and Prowlarr. All require URL and API key configured via PluginSettings.

**Radarr - Search for a movie:**
```
POST /api/command/execute
{ "command": "search radarr for Oppenheimer" }
```

**Radarr - Add movie:**
```
POST /api/command/execute
{ "command": "add Oppenheimer to radarr" }
```

**Sonarr - Upcoming episodes:**
```
POST /api/command/execute
{ "command": "what episodes air this week on sonarr" }
```

**Lidarr - Add artist:**
```
POST /api/command/execute
{ "command": "add Meteor to lidarr" }
```

**Readarr - Search for author:**
```
POST /api/command/execute
{ "command": "search readarr for Brandon Sanderson" }
```

**Prowlarr - Cross-indexer search:**
```
POST /api/command/execute
{ "command": "search prowlarr for ubuntu iso" }
```

**Configuration (all *arr plugins):**

Set credentials via PluginSettings DB or environment variables:
- `RADARR_URL` / `RADARR_API_KEY`
- `SONARR_URL` / `SONARR_API_KEY`
- `LIDARR_URL` / `LIDARR_API_KEY`
- `READARR_URL` / `READARR_API_KEY`
- `PROWLARR_URL` / `PROWLARR_API_KEY`

### PR Review Enhancements (v2.10.79)

**IPstack - Get timezone by IP:**
```
POST /api/plugin
{
  "plugin": "ipstack",
  "action": "getTimezone",
  "ip": "134.201.250.155"
}
```

**IPstack - Get own timezone:**
```
POST /api/plugin
{ "plugin": "ipstack", "action": "getOwnTimezone" }
```

**IPstack - Batch timezone lookup (v2.25.14):**
```
POST /api/plugin
{
  "plugin": "ipstack",
  "action": "getTimezones",
  "ipAddresses": ["134.201.250.155", "8.8.8.8", "1.1.1.1"]
}
```
Returns timezone info for each IP. Mirrors `fetchGeolocationBatch`; reuses the plugin's per-IP `fetchTimezone` + cache helpers, so repeated lookups for the same IPs hit the cache.

**Currencylayer - Get currency fluctuations:**
```
POST /api/plugin
{
  "plugin": "currencylayer",
  "action": "getCurrencyFluctuations",
  "startDate": "2026-01-01",
  "endDate": "2026-01-31",
  "currencies": "EUR,GBP",
  "source": "USD"
}
```

**Ollama - Stream response:**
```
POST /api/plugin
{
  "plugin": "ollama",
  "action": "streamresponse",
  "prompt": "Tell me a story"
}
```

**Accounts - Bulk register:**
```
POST /api/accounts/bulk-register
{
  "accounts": [
    { "serviceName": "service1", "serviceUrl": "https://example.com", "credentials": {} },
    { "serviceName": "service2", "serviceUrl": "https://example2.com", "credentials": {} }
  ]
}
```

**Accounts - Bulk status update:**
```
PATCH /api/accounts/bulk-status
{
  "updates": [
    { "accountId": "ID1", "status": "active" },
    { "accountId": "ID2", "status": "suspended" }
  ]
}
```

### Lyrics Plugin & yt-dlp Fixes (v2.10.78)

**Lyrics - Get by artist + title:**
```
POST /api/plugin
{
  "plugin": "lyrics",
  "action": "get",
  "artist": "Queen",
  "title": "Bohemian Rhapsody"
}
```

**Lyrics - Search by query:**
```
POST /api/plugin
{
  "plugin": "lyrics",
  "action": "search",
  "query": "never gonna give you up"
}
```

**Lyrics - Get synced (LRC) lyrics:**
```
POST /api/plugin
{
  "plugin": "lyrics",
  "action": "synced",
  "artist": "Adele",
  "title": "Hello"
}
```

**yt-dlp - Update binary:**
```
POST /api/plugin
{ "plugin": "ytdlp", "action": "update" }
```

**yt-dlp - Get version:**
```
POST /api/plugin
{ "plugin": "ytdlp", "action": "version" }
```

### PR Review Enhancements (v2.10.77)

Reviewed 10 AI-generated PRs. Merged 2 clean PRs, manually implemented 3 features with correct code.

**Fixer - Get Fluctuation (percentage change between two dates):**
```
POST /api/plugin
{
  "plugin": "fixer",
  "action": "getFluctuation",
  "params": {
    "startDate": "2026-01-01",
    "endDate": "2026-02-01",
    "base": "USD",
    "symbols": "EUR,GBP,JPY"
  }
}
```

**Accounts - Date Range Filtering:**
```bash
# List accounts with date range filter
curl -H "X-API-Key: your_key" \
  "http://localhost/api/accounts?startDate=2026-01-01&endDate=2026-02-01"

# Combine with other filters
curl -H "X-API-Key: your_key" \
  "http://localhost/api/accounts?status=active&startDate=2026-01-01&endDate=2026-02-01"
```

**UPS Severity Channel Mapping:**
- UpsConfig now supports `notifications.severityChannelMapping` with per-severity notification channel routing
- Defaults: low→email, medium→email+telegram, high→telegram+webhook
- `getNotificationChannels(severity)` instance method returns appropriate channels

**Other Improvements:**
- Email service: Italian, Portuguese, and Dutch verification patterns for multi-language email confirmation detection
- ImprovementMetrics: `.lean()` on Improvement.find() queries for better performance

### Arbitrage V4 & Token Management (v2.10.76)

Full V4 swap support on BSC (PancakeSwap Infinity), configurable arbitrage scanner tokens, intra-V3 fee-tier scanning, and volatility-triggered fast scanning.

**Arbitrage Token Management:**
```bash
# Get all scan tokens (default + custom + token trader)
curl -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/arbitrage/tokens

# Add a custom scan token
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"address": "0x...", "symbol": "ABC", "decimals": 18}' \
  http://localhost/api/crypto/strategy/arbitrage/tokens

# Remove a custom scan token
curl -X DELETE -H "X-API-Key: your_key" \
  http://localhost/api/crypto/strategy/arbitrage/tokens/0x...

# Get arb scanner status
curl -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/arbitrage/status
```

### PR Review & Alert Fix (v2.10.73)

Reviewed 10 AI-generated PRs. Merged 2 clean PRs, closed 8, manually implemented 4 features with correct code. Fixed goliath alert spam.

**New Features:**
- Vonage: `scheduleMessage` — schedule SMS/MMS for future delivery with ISO 8601 `sendAt`
- Trello: `moveCard` — move cards between lists using Trello API
- PriceIndicators: `price_change_30d`, `price_change_90d` — extended timeframe indicators
- MqttHistory: NodeCache caching for time series/statistics queries
- IPstack: NodeCache with TTL for geolocation caching
- VectorIntentDetector: shared `retryOperation` from retryUtils

**Fixes:**
- Goliath maintenance: suppressed repeated identical warning alerts, only NEW or CRITICAL send Telegram
- APT update check: informational only, no longer triggers alerts

**Vonage - Schedule Message:**
```
POST /api/plugin
{
  "plugin": "vonage",
  "action": "scheduleMessage",
  "params": {
    "to": "+1234567890",
    "text": "Reminder: meeting in 30 minutes",
    "sendAt": "2026-02-08T15:00:00Z"
  }
}
```

**Trello - Move Card:**
```
POST /api/plugin
{
  "plugin": "trello",
  "action": "movecard",
  "params": {
    "cardId": "CARD_ID",
    "targetListId": "TARGET_LIST_ID"
  }
}
```

### PR Review & Plugin Enhancements (v2.10.72)

Reviewed and triaged 9 AI-generated PRs. Merged 5 clean PRs, closed 3 (broken/useless), manually implemented 3 features with correct code.

**New Features:**
- Integromat: `cloneScenario` — duplicate an existing Make scenario, optionally with modifications
- CloudWatch: `detectanomalies` — set up anomaly detection models and retrieve anomaly scores for EC2 metrics
- Slack: `sendFormattedMessage` — send rich formatted messages using Block Kit
- FCM: `scheduleMessage` — schedule notifications for future delivery using Agenda
- Project: `removeTasks()` — bulk task removal with Set-based filtering
- IndicatorProvider: batch cache lookups via `mget()` in `getValues()`
- MCP Client: tool execution retry with exponential backoff

**Slack - Send Formatted Message (Block Kit):**
```
POST /api/plugin
{
  "plugin": "slack",
  "action": "sendFormattedMessage",
  "params": {
    "channel": "#general",
    "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "*Hello!* Formatted message"}}]
  }
}
```

**CloudWatch - Detect Anomalies:**
```
POST /api/plugin
{
  "plugin": "amazoncloudwatch",
  "action": "detectanomalies",
  "params": { "metricName": "CPUUtilization", "instanceId": "i-1234567890abcdef0", "period": 300 }
}
```

**Integromat - Clone Scenario:**
```
POST /api/plugin
{
  "plugin": "integromatnowmake",
  "action": "cloneScenario",
  "params": { "scenarioId": "12345", "newScenarioDetails": {"name": "Cloned Scenario"} }
}
```

**FCM - Schedule Message:**
```
POST /api/plugin
{
  "plugin": "firebasecloudmessagingfcm",
  "action": "scheduleMessage",
  "params": { "timestamp": "2026-02-08T10:00:00Z", "registrationToken": "device-token", "title": "Alert", "body": "Scheduled notification" }
}
```

### Token Trader Exit Fix, Telegram Reply Context & Config Sync (v2.10.71)

**Bug Fixes:**
- Token trader exit endpoint now works correctly — uses `pendingManualExit` flag to bypass analysis pipeline and sell immediately
- Manual exits allow V2 routing fallback (no longer forced V3-only) since user explicitly requested the sell
- ServerMaintenanceAgent monitored services config now syncs from code defaults on startup, fixing stale MongoDB config that was missing newly added services

**New Features:**
- Telegram reply context: replying to a previous message includes the replied-to text as NLP context

**Token Trader Exit (fixed):**
```
POST /api/crypto/strategy/token-trader/exit
# Now correctly sells all tokens immediately instead of returning "hold"
# Response: { success: true, result: { action: "sell_token", txHash: "0x...", received: 230.95 }, message: "Exit executed for LINK" }
```

### Transmission Monitoring & VPN Pre-Check (v2.10.70)

- ServerMaintenanceAgent now monitors `transmission-daemon` on goliath (port 9091) with crash detection and manual-stop awareness
- New `requiresVpn` flag: before restarting transmission, verifies expressvpn is active and connected — refuses restart if VPN is down

### Telegram Commands & Dynamic About Info (v2.10.69)

- New `/clearall` Telegram command — synonym for `/newchat`, clears conversation context
- `getAboutMe()` now dynamically reports version (from `package.json`) and plugin count (from `apiManager`) instead of stale hardcoded values

### PR Review & Resilience Improvements (v2.10.68)

Reviewed and triaged 8 AI-generated PRs. Closed 3 (dead code/no-ops), manually implemented 5 features with correct code.

**New Features:**
- Journal: `searchContent()` and `findRecent()` now have NodeCache caching (5-min TTL) and `skip` parameter for pagination
- IndicatorProvider: Indicator execution wrapped in `retryOperation` with 3 retries
- Slack: New `addInteractiveButton` action for sending interactive button messages
- AutoAccount: Activity analytics with `loginFrequency`, `averageSessionDuration`, `featureUsage`, `updateActivityAnalytics()`, `trackFeatureUsage()`
- Anthropic: Improved retry config — 3 retries with exponential backoff, `isRetryableError` classifier, retry logging

### PR Review & Plugin Enhancements (v2.10.67)

Reviewed and triaged 30 AI-generated PRs. Merged 10 clean PRs, closed 13 with issues, and manually implemented 7 features from closed PRs with correct code.

**Merged Plugin Enhancements:**
- Asana: `setPriority`, `setDueDate` commands
- SignalWire: `getMessageAnalytics` — delivery rates, response times, engagement metrics
- NASA: `getLaunchSchedule` with caching
- Google Cloud Functions: `updateFunction` — PATCH existing functions
- CryptoWallet: Transaction `categories` and `tags` fields with `categorizeTransaction()`, `tagTransaction()`

**Merged Core Improvements:**
- ContractABI: `findByMetadata()` and `getByAddressAndNetwork()` with NodeCache
- ProviderStatsArchive: `analyzeProviderPerformance()` analytics
- MCP Tool Registry: Tool versioning with `rollbackTool()` support
- MCP Transport: SSE connection retry via `retryOperation`
- Output Schemas: Declarative `permissionsMap` for role-based schema adjustments

**Manually Implemented Features:**
- BaseStrategy: `dynamicRiskAssessment()` — liquidity-based slippage tolerance
- TransactionService: `waitForTransactions()` — batch confirmation with `Promise.allSettled`
- WebScraper: Browser pool (up to 5 reusable Puppeteer instances)
- SSHConnection: `peakUsageTimes` and `errorTrends` in session reports
- GravatarHelper: `fetchBulkGravatarProfiles()` for batch profile lookups
- GitHostingSettings: Error logging on `getOrCreate()` and `getActiveProviderConfig()`

### Gas Cost Tracking & UI Safety (v2.10.66)

Token trader gas cost tracking, pre-trade profitability gates, and Web UI safety improvements.

**Gas Cost Tracking:**
- Swap gas costs captured from transaction receipts (`gasUsed * effectiveGasPrice`)
- `swapService` returns `gasCostNative` field in swap result
- `recordBuy()` and `recordSell()` accept `gasCostUsd` parameter — deducted from PnL
- `totalGasCostUsd` tracked in token trader state and exposed in status API

**Pre-Trade Gas Profitability Gate:**
- Gas cost estimated before trade execution using `feeData.gasPrice * 250000 gas units * native price`
- Buys: net buy value (amount - gas) must be >= $1
- Sells: net profit (output - cost basis - gas) must be >= $1
- Emergency sells (DUMP, stop-loss, full exit) bypass the gate

**Token Trader Status API Changes:**
```
GET /api/crypto/strategy/token-trader/status
# Response now includes:
#   pnl.totalGasCost - cumulative gas costs in USD
#   settings.capitalAllocationPercent - current capital allocation %
#   settings.dumpThreshold - current stop-loss threshold
#   settings.tokenTaxPercent - current token tax %
```

**Update Token Trader Config (non-destructive):**
```bash
# Updates config WITHOUT resetting state/PnL/regime
POST /api/crypto/strategy/config/token_trader
{"capitalAllocationPercent": 30, "dumpThreshold": -15}
```

**Web UI Safety:**
- Confirmation dialogs on: network mode toggle, strategy switch, threshold save, Configure & Enter
- New "Update Config" button for token trader settings (no state reset)
- Input fields auto-populated from server config on page load

### Strategy System Hardening (v2.10.64)

Comprehensive fix of 16 logic issues across the strategy import/export and rule-based engine.

**RuleBasedStrategy Fixes:**
- CRITICAL: Condition operator overwrite fixed (else-if chain instead of consecutive if)
- IndicatorProvider (40+ indicators) wired as fallback — RSI, MACD, Bollinger, market indicators now accessible from rules
- Circular indicator reference detection via visited-set tracking
- ReDoS protection on regex condition matching (100-char pattern limit)
- `consecutiveErrors` resets on successful evaluation (health no longer permanently degrades)
- Cooldown hours and minutes now accumulate instead of overwriting
- `disable_rule` error handler uses runtime-only Set (no longer mutates exported config)
- Custom indicator `comparison` and `formula` types now functional
- Moon phase float tolerance, errorRateLast24h in health response

**Strategy Exporter Fixes:**
- `sanitizeConfig()`/`sanitizeState()` now recursively strip sensitive keys (apiKey, secret, password, privateKey, token, mnemonic)
- `validateBundle()` infinite recursion prevented with depth parameter
- `slugify()` returns fallback on empty result
- `sourceVersion` reads from package.json instead of hardcoded fallback
- `generateChecksum()` no longer includes undefined `data.state`

**Indicator Fixes:**
- MACD signal line properly calculated (9-period EMA of MACD values instead of always 0)
- `is_us_market_hours` now DST-aware via `Intl.DateTimeFormat('America/New_York')`
- `week_of_year` uses `Date.UTC()` instead of local timezone constructor

### Agent Stability, Dead Token Detection & NLP Fixes (v2.10.63)

Bug fixes for crypto strategy agent reliability, dead token handling, and NLP routing.

**SubAgent Orchestrator Hardening:**
- Stale session recovery on startup — agents stuck in "running" from crashes are auto-recovered to "idle"
- 10-minute session timeout via Promise.race prevents agent hangs
- Force-reset fallback if `endSession()` fails

**Dead Token Detection:**
- Tokens with no DEX liquidity (no swap path) now bail immediately instead of cascading through 9 sell percentages
- Tokens with 3+ consecutive sell failures are permanently skipped in `handleDeposits()`

**Git Plugin Fix:**
- Implemented missing `manageRemote()` method with list, get-url, add, remove, set-url sub-actions
- Previously caused crash: `this.manageRemote is not a function`

**Music Plugin NLP Guard:**
- Added keyword guard to reject non-music requests misrouted by NLP intent classifier

**Network Plugin Settings Persistence:**
- Network monitoring config (enabled, interval, subnets, etc.) now persists across restarts
- Migrated from broken `Agent.serviceConfigs` pattern to `PluginSettings.getCached/setCached`

### Token Trader State Restore & UI Export Buttons (v2.10.62)

New endpoint for recovering token trader state after accidental resets, plus Web UI improvements.

**Token Trader State Restore:**
```bash
# Restore token trader position, P&L, and tracking data
POST /api/crypto/strategy/token-trader/restore-state
# Body: {
#   "position": { "tokenBalance": 1000, "stablecoinReserve": 50, "averageEntryPrice": 0.1, "totalInvested": 100, "totalReceived": 50 },
#   "pnl": { "realized": -50, "unrealized": 10 },
#   "tracking": { "peakPrice": 0.15, "trailingStopPrice": 0.12, "scaleOutLevelsHit": [] },
#   "regime": "PUMP"
# }
# Response: { success: true, message: "Token trader state restored", state: {...} }
```

**Web UI Improvements:**
- Strategy export buttons now offer Config (shareable) vs Full Backup (includes positions/state) options
- Fixed cryptoManager export functions not being accessible in certain DOM states

### Strategy Import/Export & Rule-Based Engine (v2.10.61)

New system for sharing, backing up, and creating custom crypto trading strategies.

**Strategy Import/Export:**
```bash
# Get platform capabilities and available indicators
GET /api/crypto/strategy/capabilities
# Response: { success: true, capabilities: { version, indicators, operators, actionTypes } }

# Export a single strategy
GET /api/crypto/strategy/export/:name
# Response: { success: true, strategy: { ...USF format } }

# Export all strategies as a bundle
GET /api/crypto/strategy/export-all
# Response: { success: true, bundle: { strategies: [...], exportedAt, version } }

# Validate a strategy file without importing
POST /api/crypto/strategy/validate
# Body: { strategy: { ...USF format } }
# Response: { success: true, valid: true, warnings: [], compatibility: {...} }

# Import a strategy
POST /api/crypto/strategy/import
# Body: { strategy: { ...USF format }, mode: "merge"|"replace" }
# Response: { success: true, imported: "strategy_name", mode: "merge" }
```

**Rule-Based Custom Strategies:**
- Create strategies with declarative JSON rules
- 50+ built-in indicators: price, time, moon phase, technical (RSI/MACD/Bollinger), market, position
- Condition operators: equals, greaterThan, lessThan, between, in, matches, not
- Logical combinators: all (AND), any (OR)
- Simulation mode: test without real trades

**Telegram Integration:**
- Upload `.strategy.json` files directly to Telegram bot
- Preview strategy details before import
- Choose merge or replace mode

See `docs/guides/CUSTOM-STRATEGIES.md` for complete documentation.

### Network API Hardening & PR Review (v2.10.60)

Network monitoring API endpoints now have improved reliability and protection against abuse.

**Rate limiting:**
- All `/network/api/*` endpoints limited to 100 requests per 15 minutes per IP
- Uses express-rate-limit (already a project dependency)

**Retry logic:**
- All network API calls wrapped with `retryOperation()` for resilient handling of transient failures
- Automatic retry with exponential backoff

**Caching:**
- Alerts endpoint uses NodeCache (5 min TTL) to reduce database load
- Cache key includes pagination parameters for correct results

**Strategy improvements:**
- New `executeTradeWithRetry()` method in BaseStrategy for resilient trade execution
- MCP tool registration wrapped with retry logic (3 retries)

**PR Review:**
- Reviewed 16 AI-generated PRs (#1324-1339)
- Merged #1328 (network.js rate limiting/retry/caching)
- Manually implemented 2 features from closed PRs with corrected import paths
- Closed 13 PRs due to wrong import paths, unused code, non-existent dependencies, or broken implementations

## Previous Updates (February 23, 2026)

### Token Trader Strategy Improvements (v2.13.7)

Scale-out gap fix, tighter trailing stop, time-based profit-taking, and logging fix.

**40% Scale-Out Level:**
- Added intermediate scale-out at +40% gain to close the 20% gap between 30% and 50% thresholds
- Rebalanced scale-out sizing: `{10: 10%, 20: 15%, 30: 20%, 40: 20%, 50: 35%}`
- Config version bumped to v5 with automatic migration from v4

**Pump Stall Detection:**
- If token stays in PUMP/MOON regime for 6+ hours without hitting next scale-out level, sells 10% of position
- Configurable via `pumpStallHours` (default 6) and `pumpStallSellPercent` (default 10)
- Tracked in state: `pumpEnteredAt` (ISO timestamp when PUMP entered), `lastPumpStallSell` (last stall sell)
- Cooldown: one stall sell per `pumpStallHours` interval

**Tighter PUMP Trailing Stop:**
- `pumpTrailingStopPercent` reduced from 6% to 4.5% below peak price
- Applies to both PUMP and MOON regimes (MOON above +50% still uses 5% tight stop)

**Token Trader Status API Changes:**
```
GET /api/crypto/strategy/token-trader/status
# Response now includes:
#   settings.pumpStallHours - hours before stall sell triggers
#   settings.pumpStallSellPercent - % of position to sell on stall
#   settings.pumpTrailingStopPercent - now 4.5 (was 6)
#   settings.scaleOutPercentByLevel - includes 40% level
#   pumpEnteredAt - ISO timestamp or null
#   lastPumpStallSell - ISO timestamp or null
```

**Logging Fix:**
- `all-activity.log` rotation: reduced maxsize 50MB→30MB, increased maxFiles 3→5, added `tailable: true`
- Fixes stale log issue where Winston stopped writing after hitting 50MB rotation limit

## Previous Updates (February 3, 2026)

### Token Trader Safety Hardening (v2.10.57)

Critical fix after V2 routing caused catastrophic FHE sell. Three layers of protection added:

**V3 enforcement:**
- All token_trader swaps use `forceV3: true` — if V3 quote fails, swap is aborted entirely (no silent V2 fallback)
- Output sanity check at 70% threshold — aborts if best quote < 70% of expected USD value
- `expectedOutputUsd` always set (spot-price fallback when getQuote fails)

**Graduated DUMP sell:**
- Hourly volatility spike (-8%/hr) sells 50% instead of 100%
- Only hard stop-loss (-15% from entry) triggers full liquidation
- DUMP trigger now logged with exact reason (hourly emergency vs absolute stop-loss)

### PR Batch 2 - Performance & Feature Enhancements (v2.10.56)

Reviewed 12 AI-generated PRs (1296-1307). Implemented 8 features with corrections, closed 4 with broken implementations.

**New features:**
- **GitHostingProvider** - Webhook management abstract methods (createWebhook, listWebhooks, deleteWebhook)
- **Project model** - `advancedSearch()` static method for multi-criteria filtering (tags, status, priority)
- **outputSchemas** - `adjustSchema()` and `validateData()` for dynamic runtime schema validation
- **Asana plugin** - Task dependency management (`adddependency`, `removedependency`)
- **UserPreference** - Version tracking with auto-increment on updates

**Performance improvements:**
- ImprovementMetrics: Parallel queries via Promise.all
- Faucet multi-claims: Parallel network + per-faucet processing
- MongoDB: Connection pooling (maxPoolSize: 10)

## Previous Updates (February 2, 2026)

### PR Review Batch & Token Trader Hardening (v2.10.55)

Reviewed 17 AI-generated PRs. Closed 6 with bad implementations, manually implemented 11 features with corrected code. Also fixed critical token trader DCA/stop-loss gap and config persistence issues.

**Plugin improvements:**
- **numverify** - New `convertPhoneNumberFormat` command: converts phone numbers between E.164, national, and international formats
- **ipgeolocation** - New `batch_lookup_ip` command: look up multiple IPs in one call with per-IP caching via PluginSettings
- **mediastack** - `fetchNews` now returns structured API error messages with status codes
- **nasa** - Mars Rover photo fetching parallelized with `Promise.all` (was sequential)
- **freshping** - All HTTP calls wrapped with `retryOperation()` for resilience
- **checkly** - Cache upgraded from `Map` to `NodeCache` with 5-minute TTL auto-expiration
- **apiManager** - Plugin execution timeout via `Promise.race` (configurable per-plugin, default 30s)

**Model/schema improvements:**
- **ModelCache** - Usage analytics: `trackUsage(responseTime, isError)` and `getUsageAnalytics()` methods
- **GitHostingSettings** - Mongoose validators for token, owner, repo, and projectId fields
- **DiagnosticReport** - `aggregate()` wrapped in `retryOperation()` with 3 retries
- **UserPreference** - `console.error` replaced with structured `logger.error`

**Token Trader fixes:**
- DCA depth limit moved from -15% to -10% (5% buffer before -15% stop-loss)
- Config version migration system: code-level threshold changes survive MongoDB state restore on restart
- 2-hour post-dump cooldown before re-entering after a stop-loss sell

**New dependency:** `libphonenumber-js` ^1.11.0

### Deposit Detection & Auto-Sell (v2.10.53)

Automatic detection and sale of incoming token deposits (airdrops, transfers). Deep scan is now properly awaited before deposit detection, fixing a race condition where the in-memory token map was empty on every restart.

**New endpoint:**
```bash
# Sell all safe non-stablecoin tokens
POST /api/crypto/tokens/sell-safe
# Headers: X-API-Key: <api_key>
# Response: { success: true, results: [{ token, network, sold, revenue, txHash, error }] }
```

Sells each detected non-stablecoin token via chunked progressive percentages (100% → 50% → 25% → ... → 0.01%), with 99% slippage for fee-on-transfer tokens, rate-limit backoff, and pool error fallback to native token swaps.

**Fixes:**
- Deep scan race condition: `runDeepScanAll()` now awaited before `detectNewDeposits()`
- Auto-sell slippage: 99% default for unknown tokens (was 5%, failed on tokens with 50-99% hidden taxes)
- Dedup key: `network:address` only (was including amount, causing repeated retries)
- Pool error boundary: index-based check replaces `pct > 0.01` threshold

## Recent Updates (February 1, 2026)

### Crypto Trading NL Intents (v2.10.51)

Natural language commands now route to the crypto trading system. These work via the `POST /api/command/execute` endpoint:

| Query | Intent | Response |
|-------|--------|----------|
| "how is my crypto trading" | cryptoTradingStatus | Strategy status, P&L, regime, schedule |
| "what are my positions" | cryptoPositions | Per-network holdings, entry prices |
| "show my recent trades" | cryptoTradeHistory | Trade journal, decision history |
| "swap ETH for USDT" | swapCrypto | Parses swap intent, routes to strategy |

Intents are vectorized automatically on startup for high-accuracy semantic matching.

### DevEnv Project Versioning (v2.10.51)

Git-based version history and rollback for development environment projects.

```bash
# List commit history for a project
GET /api/projects/:id/versions?limit=50
# Response: { success: true, versions: [{ hash, shortHash, subject, author, date }], total }

# Rollback project to a specific commit
POST /api/projects/:id/rollback
# Body: { "version": "<commit-hash>" }
# Response: { success: true, message: "Project rolled back to version ..." }
```

Auto-commits working changes before rollback to prevent data loss. Validates commit exists before applying.

### Crypto Trading Enhancements (v2.10.50)

**Market Regime Detection** for the Dollar Maximizer strategy. The strategy now maintains 72 hours of price history and computes a composite regime score from three weighted signals: price slope (40%), agent trend strength (30%), and RSI (30%). Buy thresholds dynamically widen in downtrends to avoid catching falling knives and tighten in uptrends to capitalize on temporary dips.

| Regime | Score Range | Buy Threshold Multiplier |
|--------|-------------|-------------------------|
| strong_downtrend | ≤ -50 | 2.5x (ETH: -4% → -10%) |
| downtrend | ≤ -20 | 1.75x (ETH: -4% → -7%) |
| sideways | ≤ +20 | 1.0x (unchanged) |
| uptrend | ≤ +50 | 0.85x (ETH: -4% → -3.4%) |
| strong_uptrend | > +50 | 0.7x (ETH: -4% → -2.8%) |

**Position Reconciliation Fixes:**
- `nativeAmount` always synced to actual wallet balance on every heartbeat
- New detection for unmanaged native tokens above gas reserve (switches to native position so stop-loss applies)
- Stablecoin mismatch updates now include native balance

**V3 Swap Improvements:**
- V3 quotes no longer skipped for fee-on-transfer tokens
- V3 round-trip used for tax estimation when V2/V3 price divergence > 20%

**Regime data available via existing endpoints:**
```bash
# Strategy status includes regime per network
GET /api/crypto/strategy/status
# Response includes: regime, regimeScore, regimeConfidence in networkAnalysis

# Dollar maximizer stats include regime and trend history
GET /api/subagents/crypto/status
# Response includes: marketRegime, trendHistoryLength in strategyRegistry.strategies.dollar_maximizer.state
```

## Recent Updates (January 30, 2026)

### PR Review & Feature Implementation (v2.10.45)

Reviewed 11 auto-generated PRs. Merged 5, reimplemented 3 with fixes, closed 3.

**New features:**
- **DeviceGroup Bulk Operations**: `bulkCreate`, `bulkUpdate`, `bulkDelete` static methods with mongoose transactions for atomic batch operations on MQTT device groups.
- **Twitter Thread Download**: `downloadThread` command fetches full threads starting from a tweet URL via FxTwitter conversation chain.
- **MCPToken Usage Threshold Notifications**: `checkUsageThreshold()` logs warnings when token usage exceeds configurable threshold.
- **HuggingFace Custom Model Selection**: `customModel` parameter overrides default model on textClassification, textGeneration, questionAnswering. New `listModels` command browses available models.
- **NASA Batch Mars Rover Sols**: `marsRoverPhotos` accepts an array of sols for batch fetching. All NASA API calls now wrapped with `retryOperation`.
- **Firewall Hardening**: All UFW commands wrapped with retry logic (3 retries). Migrated from `console.error` to structured `logger.error`.
- **Project Task Caching**: Module-level NodeCache with 5-minute TTL for task queries.
- **OutputParser Lazy Compilation**: Ajv schema compiled on first parse instead of in constructor.

### PR Review & Feature Implementation (v2.10.43)

Reviewed 8 auto-generated PRs. Reimplemented 4 with fixes, closed 4.

**New features:**
- **SignalWire Template Messaging**: `sendtemplatemessage` sends messages using predefined templates with `{{variable}}` substitution. `managetemplates` provides full CRUD + list for template management.
- **BaseProvider Simulation Mode**: Enable `simulationMode: true` in provider config to get mock responses without API calls. Useful for testing and development.
- **Momentum Strategy Dynamic MA**: Moving average periods now auto-adjust based on market volatility (0.5x-2x range). Higher volatility = smoother signals.
- **ReActAgent Context-Aware Logging**: Error handlers include agent state, query, iteration count, and action parameters for better diagnostics.

## Recent Updates (January 29, 2026)

### PR Review & Feature Implementation (v2.10.41)

Reviewed 13 auto-generated PRs. Merged 1, reimplemented 8 with fixes, closed 4.

**New features:**
- **CloudWatch Alarm Management**: `createalarm`, `deletealarm`, `describealarms` commands. All CloudWatch commands now use real AWS SDK v3 instead of mock data.
- **Vonage 2FA OTP**: `send2fa` command sends secure numeric OTP via SMS. OTP never returned in response.
- **SSH Connection Tagging**: Tags field on connections, filter by tags via query parameter.
- **SSH Session Tracking**: Session logs with start/end times, duration, and error tracking.
- **MCP Token Usage Analytics**: Peak usage times and most accessed tools tracking.
- **Vector Search Improvements**: Retry logic on indexing/search, filter parameter support, health endpoint.
- **Email Signature Templates**: Role/department-based template selection.
- **BaseProvider Resilience**: TokenUsage persistence wrapped with retry logic.
- **FeatureRequest Index Optimization**: Composite index on category + submittedAt.

## Recent Updates (January 28, 2026)

### Journal Mode Plugin

Personal journal and captain's log for recording thoughts via Telegram text or voice.

**Start a journal session:**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "journal", "action": "start", "userId": "user123"}'
```

**Add a journal entry:**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "journal", "action": "add", "content": "Today I worked on...", "userId": "user123", "source": "text"}'
```

**Stop session (generates AI summary):**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "journal", "action": "stop", "userId": "user123"}'
```

**List, view, search journals:**
```bash
# List recent journals
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "journal", "action": "list", "userId": "user123"}'

# Search journals
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "journal", "action": "search", "query": "work meetings", "userId": "user123"}'
```

**Via Telegram:** `/journal` command or say "enter journal mode". Voice messages are transcribed and recorded.

**Actions:** start, stop, add, list, view, search, summarize

### YouTube Video Transcription (yt-dlp)

Transcribe YouTube videos using subtitle extraction or Whisper STT fallback.

**Transcribe a video:**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "ytdlp", "action": "transcribe", "url": "https://youtube.com/watch?v=VIDEO_ID"}'
```

**Via natural language:** "transcribe this video https://youtube.com/watch?v=..."

**Features:**
- Tries existing subtitles first (free, instant)
- Falls back to audio download + Whisper STT
- VTT/SRT parsing with dedup and HTML tag removal
- Chunked transcription for long videos (20-min chunks)
- Supports `lang` parameter (default: "en")
- Supports `forceAudio: true` to skip subtitle extraction

### Twitter/X Plugin

Download tweets with text, photos, and videos from Twitter/X. Uses FxTwitter API (no authentication required).

**Download a tweet (with media):**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "twitter", "action": "download", "url": "https://x.com/user/status/123456"}'
```

**Extract text only (no media download):**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "twitter", "action": "extract", "url": "https://x.com/user/status/123456"}'
```

**Download a full thread:**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "twitter", "action": "downloadThread", "url": "https://x.com/user/status/123456"}'
```

**Via natural language:** "download this tweet https://x.com/user/status/123456" or "download this thread https://x.com/..."

**Actions:** download, extract, downloadThread

**Features:**
- Supports both twitter.com and x.com URLs
- Downloads photos and videos to temp directory
- Thread download follows conversation chain via FxTwitter API
- Videos over 50MB return direct link instead (Telegram limit)
- Auto-cleanup of temp files older than 1 hour
- Dynamic intent registration (disabling plugin removes intents)

### v2.10.37 Digest Plugin - Web Search & Scheduled Briefings

Major enhancements to the digest plugin and provider capabilities:

- **Web Search Support**: Both OpenAI (Responses API) and Anthropic support web search
- **Scheduled Digests**: Cron-based scheduling with Agenda integration
- **Telegram Delivery**: Executive briefing format with smart message splitting
- **Research with Delivery**: New `deliveryMethod` parameter for direct delivery
- **Preferred Sources**: Guide research via prompt directive

**New Actions:**
- `scheduleDigest` - Create cron-scheduled digests
- `getSchedules` - List all scheduled digests
- `removeSchedule` - Delete a schedule
- `runScheduledDigest` - Manually trigger a scheduled digest

**Example - Set up daily tech news:**
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "scheduleDigest",
    "name": "Morning Tech News",
    "topic": "technology and AI news",
    "cron": "0 8 * * *"
  }'
```

**Natural Language:** "Set up a daily news digest about technology at 8am"

**Additional Improvements (PR Review Session):**
- **Command Parser**: Confidence threshold (0.7) - low confidence commands require approval
- **Guest Messages**: Retry logic for transient AI provider errors
- **Mediastack**: Native API throttling (~3 requests/second)
- **DiscoveredFeature**: Fixed NodeCache cloning error with `.lean()` queries

**PRs Implemented**: #1192 (idea), #1193 (idea), #1195 (idea)
**PRs Closed**: #1194, #1196, #1197 (see CHANGELOG for details)

See [Digest Plugin](#digest-plugin---news-research-and-scheduled-briefings) for full documentation.

---

### v2.10.36 PR Review Session - Resilience Improvements

Infrastructure improvements from PR review session:

- **Task Reminders**: Added retry logic for notification delivery using retryUtils
- **Device Alias API**: Added caching (NodeCache, 5-minute TTL), lean() queries, and retry logic for all database operations
- **HealingEvent**: Added retry logic for fail() save operations
- **UpsEvent**: Added retry logic for save operations and correlateEvents() method for event pattern analysis

**PRs Merged**: #1172, #1176, #1177, #1180
**PRs Closed**: #1173, #1174, #1175, #1178, #1179 (see CHANGELOG for details)

---

### v2.10.35 Crypto Baseline Staleness Auto-Reset

#### New Feature - Baseline Staleness Detection
The crypto strategy agent now automatically resets stale baselines that prevent trading. When baselines are old AND prices have dropped significantly, the agent resets them to current prices to enable trading on new market movements.

**Configuration Options:**
- `baselineStaleDays`: Days before a baseline is considered stale (default: 5)
- `baselineStaleThreshold`: Price % below baseline to trigger reset (default: -2%)

**How It Works:**
1. Checks all baselines on every agent run
2. If baseline is older than `baselineStaleDays` AND price is below `baselineStaleThreshold` → reset
3. Logs reset with previous baseline for audit trail

**API Endpoint:**
```bash
# Check crypto strategy status (includes baseline info)
curl -X GET http://localhost:3000/api/crypto/strategy/status \
  -H "X-API-Key: YOUR_API_KEY"

# Response includes priceBaselines with resetReason if applicable
{
  "state": {
    "priceBaselines": {
      "ethereum": {
        "price": 2920.21,
        "timestamp": "2026-01-26T18:53:04.169Z",
        "previousBaseline": 3214.35,
        "resetReason": "stale_baseline"
      }
    }
  }
}
```

**Update Config:**
```bash
curl -X POST http://localhost:3000/api/crypto/strategy/config \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "baselineStaleDays": 7,
    "baselineStaleThreshold": -3
  }'
```

---

### v2.10.34 Git Issue Fix & Provider Improvements

#### Bug Fix - Git Issue Creation
Fixed natural language GitHub issue creation via the `/api/command/execute` endpoint. The `git.createIssue` action now correctly passes the original user input as a `message` field for natural language processing.

**Example:**
```bash
curl -X POST http://localhost:3000/api/command/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"command": "create a github issue for: bug in login feature"}'
```

#### New Feature - Provider Priority Adjustment
New method in ProviderManager to dynamically reorder AI providers based on performance:
```javascript
// Adjust provider order based on metrics
await providerManager.adjustProviderPriority();
// Sorts providers by combined response time + error rate
```

#### Performance - Cache Optimization
Scan progress cache now uses batch deletion for faster invalidation of session-related keys.

---

### v2.10.33 MQTT Subscription Management

Added dynamic subscription management to MqttBroker model:
```javascript
// Add a subscription at runtime
await broker.addSubscription({
  topic: 'home/sensors/+/temperature',
  qos: 1,
  handler: 'store'
});

// Remove a subscription
await broker.removeSubscription('home/sensors/+/temperature');

// Update an existing subscription
await broker.updateSubscription('home/sensors/+/temperature', {
  qos: 2,
  handler: 'process'
});
```

#### Bug Fix
Fixed settings page token thresholds save button - added missing action enum values to monitoring plugin and corrected API call structure.

---

### v2.10.32 DiscoveredFeature Caching

Added NodeCache caching to DiscoveredFeature model queries:
- `findByRepository()` - Cached with 10-minute TTL
- `findImplementable()` - Cached with 10-minute TTL
- `searchForExamples()` - Cached with 10-minute TTL

This reduces database load for the self-modification system's feature discovery operations.

---

### v2.10.31 Retry Logic & Usage Analytics

#### ABI Manager Retry Logic
Database operations in the ABI Manager now use retryOperation for resilience:
- `getABI()` - Retries on transient database errors
- `saveABI()` - Retries contract ABI storage operations

#### Resource Usage Analytics
New methods for tracking resource usage:
```javascript
// Take a usage snapshot
resourceManager.analyzeResourceUsage();

// Generate usage report over time
const report = resourceManager.generateResourceUsageReport();
```

#### API Key Usage Reports
Generate usage statistics for API keys:
```javascript
const report = await apiKeyService.generateUsageReport({
  startDate: '2026-01-01',
  endDate: '2026-01-25',
  keyId: 'optional-specific-key'
});
// Returns: totalKeys, activeKeys, totalUsage, averageUsagePerKey, per-key stats
```

#### Bug Fix
Fixed mongoose validation error where object content (e.g., scraped webpage data) was passed directly to memory storage instead of being stringified.

---

### v2.10.30 Batch Processing & API Enhancements

#### Batch Signature Signing
New endpoint for signing multiple messages in parallel:

```bash
curl -X POST http://localhost:3000/api/signatures/sign-batch \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": ["message1", "message2", "message3"],
    "network": "ethereum",
    "purpose": "batch_verification"
  }'
```

Response:
```json
{
  "success": true,
  "results": [
    { "message": "message1", "signature": "0x..." },
    { "message": "message2", "signature": "0x..." },
    { "message": "message3", "signature": "0x..." }
  ]
}
```

#### ThingSpeak Data Transformation
New plugin action for transforming data before sending:

```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "thingspeak",
    "action": "transformAndSendData",
    "data": { "field1": "100", "field2": "200" },
    "transformations": { "scale": 1.5 }
  }'
```

#### NewRelic Error Logs
New plugin action to fetch application error logs:

```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "newrelic",
    "action": "getErrorLogs",
    "applicationId": "12345"
  }'
```

#### Memory Vector Store Batch Processing
Memory embeddings now use batch insertion for improved performance:
- Default batch size: 50 records
- Configurable via `BATCH_SIZE` and `BATCH_TIMEOUT` environment variables
- Automatic flush on batch size or timeout

#### PR Review Session
Reviewed 18 AI-generated PRs, merged 6 improvements, closed 12 with issues.

---

## Updates (January 24, 2026)

### v2.10.29 Transaction Retry & PR Review

#### Transaction Service Retry Logic
Added retry mechanism for crypto transactions to improve resilience against transient network errors.

**Contract Function Calls:**
```javascript
// Now retries up to 3 times with exponential backoff
const tx = await retryOperation(
  () => contractWithSigner[functionName](...params, txOptions),
  { retries: 3, context: `contract call ${functionName}` }
);
```

**Native Token Transfers:**
```javascript
// sendNative() also retries on network errors
const tx = await retryOperation(
  () => signer.sendTransaction({ to, value }),
  { retries: 3, context: 'sendNative transaction' }
);
```

#### PR Review Session
Reviewed 7 AI-generated PRs:
- **#1115**: Implemented transaction retry (fixed import path from PR)
- **#1116-#1121**: Closed due to various issues (security vulnerabilities, broken logic, truncated code)

---

### v2.10.28 Crypto Strategy Consolidation

Major refactor: Merged legacy `cryptoStrategyService.js` into `CryptoStrategyAgent` SubAgent.

#### Architecture Change
- **Before**: Two separate systems (cryptoStrategyService + CryptoStrategyAgent)
- **After**: Single unified SubAgent with all functionality

#### Event-Driven Execution

The crypto strategy agent uses **event-driven execution** rather than a blind timer loop:

- **Price Monitor**: Reads Chainlink price feeds every 5 minutes (free on-chain reads). When a >1% price move is detected, dispatches a `crypto:significant_move` event.
- **Heartbeat**: Every 30 minutes, dispatches a `crypto:heartbeat` event to ensure time-based strategies (DCA) run even in flat markets.
- **Manual Trigger**: `POST /strategy/trigger` still works at any time.

The `SubAgentOrchestrator.dispatchEvent()` routes events to agents matching `schedule.eventTriggers`.

```bash
# Get schedule info (shows event-driven config)
curl http://localhost:3000/api/crypto/strategy/schedule \
  -H "X-API-Key: YOUR_KEY"
```

Response:
```json
{
  "runPattern": "event-driven",
  "eventTriggers": ["crypto:significant_move", "crypto:heartbeat", "manual"],
  "nextRunAt": null,
  "lastRunAt": "2026-01-29T05:21:23.000Z",
  "enabled": true
}
```

**Price sources** (in priority order):
1. Chainlink on-chain feeds (primary, free, decentralized)
2. CoinGecko API (fallback)

Event data includes pre-fetched Chainlink prices, so the strategy agent skips redundant reads when triggered by an event.

#### WebUI Control
All crypto endpoints now use SubAgent handler:
- Enable/disable agent: `POST /strategy/enable`, `POST /strategy/disable`
- Emergency controls: `POST /strategy/emergency-stop`, `POST /strategy/clear-emergency`
- Manual trigger: `POST /strategy/trigger`
- Strategy switch: `POST /strategy/switch`
- Position updates: `POST /strategy/position/:network`

#### Migration
Run the migration script if upgrading:
```bash
node scripts/migrate-crypto-strategy.js --dry-run  # Preview
node scripts/migrate-crypto-strategy.js             # Apply
```

---

### v2.10.27 Crypto Strategy Agent Fixes

#### SubAgent Budget System Fix
Fixed "Daily API call budget exceeded" errors preventing crypto strategy execution.

**Root Cause:** The `generateResponse()` method in `BaseAgentHandler.js` checked budget limits using an in-memory `agentDoc` that wasn't refreshed from the database. Direct database updates (like increasing budget limits) weren't reflected.

**Fix:** Added database refresh before budget check:
```javascript
// Refresh agentDoc from database to get latest budget/usage
if (this.agentDoc._id) {
  const SubAgent = this.agentDoc.constructor;
  const freshDoc = await SubAgent.findById(this.agentDoc._id);
  if (freshDoc) {
    this.agentDoc = freshDoc;
  }
}
```

**Budget Increases:**
| Setting | Before | After |
|---------|--------|-------|
| dailyApiCalls | 50 | 500 |
| dailyTokens | 25,000 | 250,000 |

#### Price History Seeding
Use the seed endpoint to populate historical price data for volatility strategies:

```bash
curl -X POST http://localhost:3000/api/crypto/strategy/seed-history \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"strategy": "volatility_adjusted"}'
```

Returns 24 hours of hourly CoinGecko data for ETH, BNB, and MATIC.

---

### v2.10.26 Performance & Caching

#### Response Caching
Added caching to frequently accessed queries for improved performance:

| Component | Cache Type | TTL | Invalidation |
|-----------|-----------|-----|--------------|
| Mediastack Plugin | Response caching | 5 min | None (TTL-based) |
| BluetoothDevice Model | Query caching | 5 min | On device changes |
| EventRule Model | Query caching | 5 min | On rule save/delete |

#### MeanReversionStrategy Volatility Adjustment

The mean reversion trading strategy now dynamically adjusts the moving average period based on market volatility:

| Volatility | MA Period Adjustment |
|------------|---------------------|
| High (>2%) | Shortened (faster reactions) |
| Low (<1%) | Lengthened (smoother signals) |

New config options:
- `volatilityThreshold`: 0.02 (2% threshold)
- `maxMAPeriodHours`: 48 hours
- `minMAPeriodHours`: 6 hours

Stats now include per-pair volatility and MA period.

#### MCPServer Dynamic Configuration

New methods for zero-downtime config updates:

| Method | Description |
|--------|-------------|
| `MCPServer.watchConfigFile(path)` | Watch config file for changes |
| `MCPServer.updateServerConfigurations(config)` | Apply config changes dynamically |

---

## Updates (January 21, 2026)

### v2.10.22 Fixes

#### Network Mode Persistence
Fixed network mode (testnet/mainnet) not persisting across PM2 restarts.

**Root Cause:** `walletService` was defaulting to testnet on initialization instead of loading the saved network mode from the database.

**Fix:** `walletService.initialize()` now loads network mode from `CryptoStrategy` config document (the source of truth) on startup.

#### Strategy Selector Persistence
Fixed WebUI strategy selector resetting to "Native Maximizer" on page refresh.

**Root Cause:** `loadCrypto()` was calling `window.cryptoManager.refreshStrategy()` before `cryptoManager` was fully defined, and was missing auth headers on the API fetch.

**Fix:** Added direct fetch with auth headers in `loadCrypto()` to load the active strategy from `/api/crypto/strategy/status` before the selector renders.

#### PM2 jlist JSON Parsing
Fixed JSON parsing errors in self-diagnostics and PR reviewer when PM2 outputs non-JSON prefix.

**Root Cause:** PM2 sometimes outputs messages like `">>>> In-memory PM2..."` before the JSON array, causing `JSON.parse()` to fail.

**Fix:** Extract JSON array by finding the `[` character and slicing from there before parsing.

#### Transaction History Network Filter
Added network mode filter to transaction history in WebUI, allowing users to filter by mainnet or testnet transactions.

---

### v2.10.21 Features

#### Dynamic Volatility Config Adjustment

Automatically adjusts trading parameters based on market volatility conditions.

**Endpoint:** `POST /api/crypto/strategy/adjust-volatility`

**Description:** Adjusts maxTradePercentage and slippageTolerance based on current market volatility regime.

| Volatility Regime | maxTradePercentage | slippageTolerance |
|-------------------|-------------------|-------------------|
| High (>80 percentile) | 6% | 2% |
| Normal | 10% (default) | 1% |
| Low (<30 percentile) | 13% | 0.7% |

**Example:**
```bash
curl -X POST -H "X-API-Key: $API_KEY" \
  http://localhost/api/crypto/strategy/adjust-volatility
```

**Response:**
```json
{
  "success": true,
  "adjustment": {
    "regime": "low",
    "previousConfig": { "maxTradePercentage": 10, "slippageTolerance": 1 },
    "newConfig": { "maxTradePercentage": 13, "slippageTolerance": 0.7 }
  }
}
```

#### Price History Seeding

Pre-populate price history data to enable volatility_adjusted strategy to start trading immediately.

**Endpoint:** `POST /api/crypto/strategy/seed-history`

**Description:** Fetches 24h historical prices from CoinGecko for ETH, BNB, MATIC. Eliminates the 12-hour warmup period for volatility-based strategies.

**Example:**
```bash
curl -X POST -H "X-API-Key: $API_KEY" \
  http://localhost/api/crypto/strategy/seed-history
```

#### Bluetooth RSSI Trilateration (Model Methods)

New static methods on BluetoothDevice model for indoor positioning:

| Method | Description |
|--------|-------------|
| `rssiToDistance(rssi, txPower, pathLossExponent)` | Convert RSSI to distance using log-distance path loss model |
| `trilaterate(points)` | 2D position estimation using least squares method |
| `estimateDevicePosition(accessPoints, options)` | Full position estimation with confidence scoring |

**Example (programmatic):**
```javascript
import BluetoothDevice from './src/models/BluetoothDevice.js';

// Convert RSSI to distance
const distance = BluetoothDevice.rssiToDistance(-70); // ~2.75 meters

// Estimate position from 3+ access points
const result = BluetoothDevice.estimateDevicePosition([
  { macAddress: 'AA:BB:CC:DD:EE:01', x: 0, y: 0, rssi: -60 },
  { macAddress: 'AA:BB:CC:DD:EE:02', x: 10, y: 0, rssi: -65 },
  { macAddress: 'AA:BB:CC:DD:EE:03', x: 5, y: 10, rssi: -55 }
]);
// Returns: { position: {x, y, z}, confidence: 63, accessPointsUsed: 3, ... }
```

#### ScanProgress Query Caching

New service-layer caching for incremental scanner queries to reduce database load.

**Cache Configuration:**
- TTL: 30 seconds (time-sensitive operations)
- Automatic invalidation on status changes
- Functions: `getCachedCount()`, `getCachedPendingEntries()`, `invalidateSessionCache()`

#### ReAct Agent Retry Logic

Plugin execution in ReAct agent now includes retry logic for transient failures:
- 2 retries with exponential backoff (1-5 seconds)
- Uses existing `retryOperation` utility

---

## Earlier Updates (January 19, 2026)

### Self-Healing/Auto-Remediation Service (v2.10.13)

Automatic detection and remediation of runtime issues. The service monitors system health and takes corrective actions when problems are detected.

#### Safety First
- **Disabled by default** - Must be explicitly enabled via API
- **Dry-run mode on** - Actions are logged but not executed until disabled
- **Rate limiting** - Max 10 actions/hour globally, per-action cooldowns
- **Full audit trail** - All actions logged with system state

#### Self-Healing Plugin Actions (via POST /api/plugin)

| Action | Description | Parameters |
|--------|-------------|------------|
| `status` | Get service status and system state | none |
| `enable` | Enable self-healing service | none |
| `disable` | Disable self-healing service | none |
| `setDryRun` | Toggle dry-run mode | `enabled` (boolean) |
| `trigger` | Manually trigger healing action | `actionType`, `force` (optional) |
| `events` | Get healing event history | `limit`, `eventType`, `status` |
| `stats` | Get healing statistics | `hours` (default: 24) |
| `config` | Get/update configuration | `rules` (optional) |
| `runCheck` | Run health check now | none |
| `systemState` | Get current system state | none |
| `cleanup` | Remove old events | `daysToKeep` (default: 30) |

#### Available Healing Actions

| Action Type | Description | Default Threshold |
|-------------|-------------|-------------------|
| `memory_cleanup` | GC and cache clearing | >90% memory |
| `disk_cleanup` | Log rotation, temp cleanup | >90% disk |
| `db_reconnect` | MongoDB reconnection | Connection lost |
| `cache_clear` | Clear plugin caches | Periodic (30min) |
| `log_rotation` | Rotate large log files | >100MB log size |

#### Examples

```bash
# Get service status
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "status"}' \
  http://localhost/api/plugin

# Get current system state
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "systemState"}' \
  http://localhost/api/plugin

# Enable service (still in dry-run mode)
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "enable"}' \
  http://localhost/api/plugin

# Disable dry-run mode (actions will execute)
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "setDryRun", "enabled": false}' \
  http://localhost/api/plugin

# Manually trigger memory cleanup (force to bypass dry-run)
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "trigger", "actionType": "memory_cleanup", "force": true}' \
  http://localhost/api/plugin

# Get healing event history
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "events", "limit": 20}' \
  http://localhost/api/plugin

# Get 24-hour statistics
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "stats", "hours": 24}' \
  http://localhost/api/plugin

# Update configuration (e.g., lower memory threshold)
curl -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"plugin": "selfHealing", "action": "config", "rules": {"memoryCleanup": {"threshold": 85}}}' \
  http://localhost/api/plugin
```

#### Natural Language Examples
- "Show self-healing status"
- "Enable auto-remediation"
- "What's the current system state?"
- "Show healing events"
- "Trigger memory cleanup"
- "Clear the caches"

---

### Git Hosting Abstraction Layer (v2.10.9)

Added support for both GitHub and GitLab as git hosting providers. The system now uses a provider-agnostic abstraction layer that allows switching between platforms.

#### Configuration

Set the provider via environment variables:
```bash
# Use GitHub (default)
GIT_HOSTING_PROVIDER=github
GITHUB_TOKEN=your_github_token

# Or use GitLab
GIT_HOSTING_PROVIDER=gitlab
GITLAB_TOKEN=your_gitlab_token
GITLAB_URL=https://gitlab.com  # or self-hosted URL
GITLAB_PROJECT_ID=owner/repo
```

Or configure via MongoDB settings:
```javascript
// Update GitHostingSettings collection
{
  agentId: "default",
  provider: "gitlab",  // or "github"
  gitlab: {
    baseUrl: "https://gitlab.com",
    projectId: "owner/repo"
  }
}
```

#### Affected Services
- **Self-Modification Service**: Creates PRs/MRs for code improvements
- **PR Reviewer Plugin**: Reviews and merges pull/merge requests
- **Bug Detection Plugin**: Creates issues for detected bugs
- **Feature Discovery**: Discovers features from git repositories

#### API Endpoints
All existing endpoints work with both providers - the abstraction handles the translation:
- PRs on GitHub = Merge Requests on GitLab
- Issues work identically on both platforms

---

## Earlier Updates (January 18, 2026)

### UPS Monitoring (v2.10.8)

Monitor UPS power devices via Network UPS Tools (NUT):

#### UPS Plugin Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugin/ups/status` | GET | Get all UPS devices status |
| `/api/plugin/ups/status/:upsName` | GET | Get specific UPS status |
| `/api/plugin/ups/devices` | GET | List all configured UPS devices |
| `/api/plugin/ups/events` | GET | Get power event history |
| `/api/plugin/ups/stats` | GET | Get UPS monitoring stats |
| `/api/plugin/ups/configure` | POST | Configure UPS settings |
| `/api/plugin/ups/acknowledge/:eventId` | POST | Acknowledge a power event |

#### Plugin Actions (via POST /api/plugin)

| Action | Description | Parameters |
|--------|-------------|------------|
| `status` | Get UPS status | `upsName` (optional) |
| `list` | List all UPS devices | none |
| `history` | Get power events | `hours` (default: 24), `upsName` (optional) |
| `configure` | Configure UPS | `upsName`, `enabled`, `thresholds`, etc. |
| `stats` | Get service stats | none |
| `acknowledge` | Acknowledge event | `eventId` |

#### Examples

```bash
# Get all UPS status
curl -X GET -H "Authorization: Bearer $TOKEN" http://localhost/api/plugin/ups/status

# Get power event history (last 48 hours)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"plugin": "ups", "action": "history", "hours": 48}' \
  http://localhost/api/plugin

# Natural language queries (via chat)
"What's my UPS status?"
"How much battery is left?"
"Is the UPS on battery?"
"Show power events"
```

---

## Earlier Updates (January 17, 2026)

### Bug Fixes & Improvements (v2.10.4)

Several important fixes to the self-modification and monitoring systems:

#### Self-Modification System Fixes
- **PR Creation Fixed**: Scheduler now properly calls `checkForImprovements()` instead of just `analyzeCodebase()`, ensuring improvements are implemented and PRs are created
- **Duplicate Detection**: Capability scanner now checks both open AND merged PRs (last 50) to avoid suggesting features already implemented
- **Smarter Suggestions**: Enhanced prompt assumes common features (health checks, logging, caching) already exist in mature codebases

#### Token Monitoring Improvements
- **Active Provider Only**: Token usage alerts now only monitor the currently selected AI provider instead of all registered providers
- **Persistent Cooldowns**: Alert cooldown times are persisted to database, surviving server restarts (2-hour cooldown between same alerts)

#### Sub-Agent Orchestrator WebUI
- **Fixed Button Handlers**: All action buttons (run, stop, delete, view details) now work correctly
- **DOM Load Timing**: Methods added to both `accountManager` definitions for consistent behavior

---

### Multi-Strategy Trading System (v2.10.3)

New pluggable trading strategy system with self-evolution capabilities:

#### Strategy Management Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crypto/strategy/list` | GET | List all available strategies |
| `/api/crypto/strategy/active` | GET | Get current active strategy |
| `/api/crypto/strategy/switch` | POST | Switch to a different strategy |
| `/api/crypto/strategy/performance` | GET | Compare strategy performance |
| `/api/crypto/strategy/config/:name` | POST | Update strategy configuration |

#### Strategy Evolution Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crypto/strategy/evolution/analyze` | GET | Run performance analysis |
| `/api/crypto/strategy/evolution/status` | GET | Get evolution system status |
| `/api/crypto/strategy/evolution/apply` | POST | Apply recommended improvements |
| `/api/crypto/strategy/evolution/feature-request` | POST | Create feature request for self-mod |
| `/api/crypto/strategy/evolution/evaluate` | GET | Evaluate pending improvements |

#### Available Strategies

| Strategy | Description | Actions | Status |
|----------|-------------|---------|--------|
| `native_maximizer` | Buy low, sell high with per-asset thresholds (ETH 3%/-2.5%, BNB 4%/-3%, MATIC 5%/-4%) | `sell_to_stablecoin`, `buy_native` | Complete |
| `dca` | Dollar Cost Averaging - buys fixed USD amounts at configurable intervals with dip detection | `dca_buy` | Complete |
| `grid_trading` | Places buy/sell orders at grid intervals around a center price to profit from oscillations | `grid_buy`, `grid_sell` | Complete |
| `mean_reversion` | Buys below moving average, sells above - reverts to statistical mean | `sell_to_stablecoin`, `buy_native`, `accumulate` | Complete |
| `volatility_adjusted` | Dynamic buy/sell thresholds based on ATR (Average True Range) volatility measurement | `sell_to_stablecoin`, `buy_native` | Complete |
| `momentum` | Trend following using fast/slow moving averages with trailing stop protection | `buy_native`, `trailing_stop_sell`, `trend_exit_sell` | Complete |
| `dollar_maximizer` | Maximize stablecoin holdings - sells native when price rises, buys cheap when price drops. Keeps gas reserve on each chain (ETH: 0.01, BNB: 0.05, MATIC: 1.0) | `sell_native_profit`, `buy_native_cheap` | Complete |
| `arbitrage` | Cross-DEX/cross-fee-tier arbitrage scanner with V2/V3/V4 support, configurable token list, auto-executes profitable trades | `arb_execute` | Complete |

**Strategy Configuration Examples:**

```bash
# Switch to dollar maximizer
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"strategy": "dollar_maximizer"}' \
  http://localhost/api/crypto/strategy/switch

# Configure DCA interval (hours) and buy amount (USD)
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"buyIntervalHours": 12, "buyAmountUSD": 50}' \
  http://localhost/api/crypto/strategy/config/dca

# Configure grid trading spacing
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"gridSpacing": 3, "numberOfLevels": 5}' \
  http://localhost/api/crypto/strategy/config/grid_trading

# Configure dollar maximizer gas reserves
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"gasReserves": {"ETH": 0.02, "BNB": 0.1}}' \
  http://localhost/api/crypto/strategy/config/dollar_maximizer
```

#### Position Management Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crypto/strategy/position` | POST | Update position state for a network |
| `/api/crypto/strategy/positions` | GET | Get all current positions |

#### Token Scanner Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crypto/tokens/scanner/init` | POST | Initialize scanner with wallet address |
| `/api/crypto/tokens/scanner/start` | POST | Start periodic token scanning |
| `/api/crypto/tokens/scanner/stop` | POST | Stop periodic scanning |
| `/api/crypto/tokens/scan` | POST | Trigger manual scan of all networks |
| `/api/crypto/tokens/scanner/status` | GET | Get scanner status |
| `/api/crypto/tokens/detected` | GET | Get all detected tokens |
| `/api/crypto/tokens/sellable` | GET | Get safe sellable tokens |
| `/api/crypto/tokens/sell-safe` | POST | Sell all safe non-stablecoin tokens (chunked progressive sell) |
| `/api/crypto/tokens/scam` | GET | Get detected scam tokens |
| `/api/crypto/tokens/check/:network/:address` | GET | Check if specific token is safe |

#### Arbitrage Scanner Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crypto/strategy/arbitrage/tokens` | GET | Get scan tokens (default, custom, token trader) with config and status |
| `/api/crypto/strategy/arbitrage/tokens` | POST | Add a custom scan token (`{address, symbol, decimals}`) |
| `/api/crypto/strategy/arbitrage/tokens/:address` | DELETE | Remove a custom scan token (default tokens cannot be removed) |
| `/api/crypto/strategy/arbitrage/status` | GET | Get arb scanner status (recent opportunities, PnL, config) |

#### Examples

```bash
# List available strategies
curl -X GET -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/list

# Get active strategy
curl -X GET -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/active

# Switch strategy
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"strategy": "dca"}' \
  http://localhost/api/crypto/strategy/switch

# Run evolution analysis
curl -X GET -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/evolution/analyze

# Get evolution status
curl -X GET -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/evolution/status

# Update strategy config
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"sellThreshold": 5, "buyThreshold": -4}' \
  http://localhost/api/crypto/strategy/config/native_maximizer
```

---

### Performance & API Enhancements (v2.10.2)

Several performance optimizations and new API features have been added:

#### Fixer Plugin
| Action | Description | Parameters |
|--------|-------------|------------|
| `getLatestRates` | Fetch latest exchange rates (now cached) | `base` |
| `getHistoricalRates` | Fetch historical rates (now cached) | `date`, `base` |
| `convertCurrency` | Convert between currencies | `amount`, `from`, `to` |

The Fixer plugin now includes NodeCache for caching frequently requested exchange rates with retry logic for improved reliability.

#### Currencylayer Plugin
| Action | Description | Parameters |
|--------|-------------|------------|
| `getRateTrends` | Get exchange rate trends over time | `currencies`, `startDate`, `endDate` |

```bash
# Get rate trends
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "currencylayer", "action": "getRateTrends", "params": {"currencies": ["EUR", "GBP"], "startDate": "2026-01-01", "endDate": "2026-01-15"}}' \
  http://localhost/api/plugin
```

#### MqttHistory Model
New methods for batch processing and advanced queries:
- `recordMessagesBatch(messages)` - Bulk insert MQTT messages for efficiency
- `advancedQuery(criteria, options)` - Filter by payload content, QoS, retained flags

#### EmbeddingService
Parallel batch processing with Promise.all for improved embedding generation performance when handling multiple texts.

### PR Review Batch 7 Enhancements (v2.10.49)

#### Music Providers - Batch Generation
All music providers (Suno, Mubert, Soundverse) now support `generateBatch(prompts)` for concurrent track generation.

#### StatusCake Plugin - Scheduled Tests
New `scheduleTest` command allows scheduling recurring uptime test checks:
```bash
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "statuscake", "action": "scheduleTest", "testId": "12345", "schedule": "*/5 * * * *"}' \
  http://localhost/api/plugin
```

#### Aviationstack Plugin - Response Caching
`getAirlineInfo` and `getAirportInfo` responses are now cached with 5-minute TTL using NodeCache.

#### Text Splitter - Language-Aware Splitting
New `languageAware` splitter type with support for EN, ES, FR, DE, JA, ZH tokenization.

#### Image Generation - Concurrency Control
Image generation now uses PQueue with max 5 concurrent tasks and retry with exponential backoff.

#### MCP Transport - Error Categorization
MCP errors are now classified as ServerError, ClientError, or NetworkError with actionable messages. SSE transport retries failed sends up to 3 times.

#### Improvement Model - Resilience
New `handleError()` method with retry + context logging, and `healthCheck()` static for diagnostics.

#### SSH Connection - Session Analytics
New `generateSessionReport()` computes session metrics including count, duration, error rate, and usage patterns.

### Plugin Enhancements (v2.10.1)

Several plugins have been enhanced with new capabilities:

#### Aviationstack Plugin
| Action | Description | Parameters |
|--------|-------------|------------|
| `getHistoricalFlightData` | Retrieve historical flight data | `flightNumber`, `startDate`, `endDate` |

```bash
# Get historical flight data
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "aviationstack", "action": "getHistoricalFlightData", "params": {"flightNumber": "BA2490", "startDate": "2026-01-01", "endDate": "2026-01-15"}}' \
  http://localhost/api/plugin
```

#### Slack Plugin
| Action | Description | Parameters |
|--------|-------------|------------|
| `replyInThread` | Reply to a message in a thread | `channel`, `text`, `threadTs` |
| `addInteractiveButton` | Send a message with interactive buttons | `channel`, `text`, `buttons` |

```bash
# Reply to a thread
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "slack", "action": "replyInThread", "params": {"channel": "#general", "text": "Thanks for the update!", "threadTs": "1234567890.123456"}}' \
  http://localhost/api/plugin

# Send interactive buttons
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "slack", "action": "addInteractiveButton", "params": {"channel": "#general", "text": "Please choose:", "buttons": [{"name": "option", "text": "Approve", "type": "button", "value": "approve"}, {"name": "option", "text": "Reject", "type": "button", "value": "reject"}]}}' \
  http://localhost/api/plugin
```

#### Asana Plugin
| Action | Description | Parameters |
|--------|-------------|------------|
| `getProjectDetails` | Fetch project details | `projectId` |
| `updateProjectDetails` | Update project name | `projectId`, `name` |
| `adddependency` | Add dependency between tasks | `taskId`, `dependsOn` |
| `removedependency` | Remove dependency between tasks | `taskId`, `dependsOn` |

```bash
# Get project details
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "asana", "action": "getProjectDetails", "params": {"projectId": "123456789"}}' \
  http://localhost/api/plugin

# Add task dependency
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "asana", "action": "adddependency", "params": {"taskId": "123456", "dependsOn": "654321"}}' \
  http://localhost/api/plugin
```

#### IPGeolocation Plugin
| Action | Description | Parameters |
|--------|-------------|------------|
| `historical_ip_lookup` | Historical geolocation for IP | `ip`, `startDate`, `endDate` |

```bash
# Get historical IP geolocation
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "ipgeolocation", "action": "historical_ip_lookup", "params": {"ip": "8.8.8.8", "startDate": "2026-01-01", "endDate": "2026-01-15"}}' \
  http://localhost/api/plugin
```

### Bug Fixes (v2.10.1)
- Fixed memory storage errors when complex objects (like web-scraped content) were passed to conversation storage
- Fixed git issue creation to correctly retrieve recent conversations for error context
- Improved response handling to ensure string content in memory storage

---

## Previous Updates (January 15, 2026)

### Sub-Agent Orchestrator (v2.10.0)

Autonomous agent system for domain-specific tasks with intelligent execution:

- **Domain Agents**: Specialized handlers for crypto, data analysis, and more
- **Project/Task Agents**: Workflow automation with goal tracking
- **Scheduling**: Hourly, daily, or custom run patterns
- **Approval Workflow**: Human-in-the-loop for high-impact decisions
- **Cost Tracking**: Budget management with API call monitoring
- **Learning**: Agents improve from past execution results

#### Sub-Agents API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/subagents/status` | GET | Orchestrator status |
| `/api/subagents/agents` | GET | List all agents |
| `/api/subagents/agents` | POST | Create new agent |
| `/api/subagents/agents/:id` | GET | Get agent details |
| `/api/subagents/agents/:id` | PUT | Update agent config |
| `/api/subagents/agents/:id` | DELETE | Delete agent |
| `/api/subagents/agents/:id/run` | POST | Run agent now |
| `/api/subagents/agents/:id/stop` | POST | Stop running agent |
| `/api/subagents/agents/:id/pause` | POST | Pause agent |
| `/api/subagents/agents/:id/resume` | POST | Resume paused agent |
| `/api/subagents/agents/:id/history` | GET | Get execution history |
| `/api/subagents/agents/:id/learnings` | GET | Get agent learnings |
| `/api/subagents/agents/:id/approve/:approvalId` | POST | Approve/reject action |
| `/api/subagents/domains` | GET | List registered domain handlers |

#### CryptoStrategyAgent

Built-in domain agent for autonomous crypto trading:

- **Price Data**: CoinGecko API (free, no key required)
- **Indicators**: RSI, price change analysis
- **Strategies**: Native Maximizer, DCA, Mean Reversion, Momentum
- **Execution**: Automatic swaps via Uniswap/PancakeSwap
- **Networks**: Testnet (Sepolia, BSC-Testnet) and Mainnet support

#### Examples

```bash
# Get orchestrator status
curl -X GET -H "X-API-Key: your_key" http://localhost/api/subagents/status

# Create a crypto strategy agent
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"name": "My Crypto Agent", "type": "domain", "domain": "crypto", "config": {"networkMode": "testnet", "strategy": "native_maximizer"}}' \
  http://localhost/api/subagents/agents

# Run an agent
curl -X POST -H "X-API-Key: your_key" http://localhost/api/subagents/agents/{id}/run

# Get agent history
curl -X GET -H "X-API-Key: your_key" http://localhost/api/subagents/agents/{id}/history
```

### MCP Plugin - Model Context Protocol (v2.9.0)

Full MCP (Model Context Protocol) support for AI tool integration:

- **MCP Client**: Connect to external MCP servers and discover their tools
- **Transport Support**: Both stdio (local process) and SSE (HTTP/SSE) transports
- **Auto-Discovery**: Tools automatically registered with LANAgent's intent system
- **Authentication**: API Key, Bearer, Basic auth with encrypted credential storage
- **Intent Integration**: MCP tools available via natural language (format: `mcp_servername_toolname`)

#### MCP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp/api/status` | GET | Service status with connection counts |
| `/mcp/api/servers` | GET | List all configured servers |
| `/mcp/api/servers` | POST | Add new server |
| `/mcp/api/servers/:id` | PUT | Update server configuration |
| `/mcp/api/servers/:id` | DELETE | Remove server |
| `/mcp/api/servers/:id/connect` | POST | Connect to server |
| `/mcp/api/servers/:id/disconnect` | POST | Disconnect from server |
| `/mcp/api/servers/:id/test` | POST | Test server connectivity |
| `/mcp/api/servers/:id/tools` | GET | List discovered tools |
| `/mcp/api/servers/:id/discover` | POST | Force tool re-discovery |
| `/mcp/api/tools` | GET | List all tools from all servers |
| `/mcp/api/tools/execute` | POST | Execute a tool |
| `/mcp/api/tools/sync` | POST | Sync tools with intent system |
| `/mcp/api/tokens` | GET | List access tokens (server mode) |
| `/mcp/api/tokens` | POST | Create new token |
| `/mcp/api/tokens/:id` | DELETE | Revoke token |

#### Examples

```bash
# Get MCP service status
curl -X GET -H "X-API-Key: your_key" http://localhost/mcp/api/status

# Add an MCP server
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"name": "filesystem", "url": "http://localhost:3001", "transport": "sse", "authType": "none"}' \
  http://localhost/mcp/api/servers

# Connect to server
curl -X POST -H "X-API-Key: your_key" http://localhost/mcp/api/servers/{id}/connect

# Execute a tool
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"serverId": "server_id", "toolName": "read_file", "args": {"path": "/tmp/test.txt"}}' \
  http://localhost/mcp/api/tools/execute
```

### Error Categorization & Performance (v2.8.83)

- **RuntimeError Categorization**: New `categorizeError` method and `category` field for automatic error classification based on historical patterns
- **SSH Command Logging**: Execution timing and error logging for better debugging visibility
- **Markdown Performance**: Regex consolidation reduces 17+ replace calls to single regex
- **Project Context Resilience**: Added retry logic to plugin execute calls

### Model & Interface Improvements (v2.8.82)

Bug fixes and enhancements from PR review:

- **CryptoWallet**: New `batchTransactions` method for adding multiple transactions at once
- **MqttHistory**: New `advancedQuery` static method for filtering by topic, QoS, retained flag, and payload content
- **SSH Interface**: Fixed escape sequence bug (`\r\n`), added command queue for sequential processing, added NodeCache for status caching
- **ABI Manager**: Upgraded to NodeCache with 5-minute TTL for automatic cache expiration

### LangChain-Inspired Features (v2.8.81)

Four powerful AI/ML capabilities inspired by LangChain patterns:

#### 1. RAG (Retrieval-Augmented Generation)

Knowledge base management with document ingestion and semantic search.

**Document Loaders**: PDF, Text, Web (URLs), Markdown, JSON, CSV
**Text Splitters**: Character, Recursive, Sentence, Code-aware (JavaScript, Python, Go, etc.)
**Retrieval Strategies**: Similarity, MMR (Maximal Marginal Relevance), Hybrid, Contextual Compression, Multi-query

##### Knowledge Plugin Endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugin` | POST | Execute knowledge plugin actions |

##### Knowledge Plugin Actions:

| Action | Description | Parameters |
|--------|-------------|------------|
| `ingest` | Add document to knowledge base | `source` (path), `splitterType`, `chunkSize` |
| `ingestUrl` | Add web page to knowledge base | `url`, `selector` (optional) |
| `ingestDirectory` | Add all docs from directory | `path`, `recursive`, `glob` |
| `query` | RAG-augmented query | `question`, `k`, `retrieverType` |
| `search` | Search without answer generation | `query`, `k`, `filter` |
| `list` | List ingested documents | `limit`, `offset` |
| `delete` | Remove document | `source` |
| `stats` | Get knowledge base statistics | - |
| `configure` | Update RAG configuration | `chunkSize`, `retrieverType`, `k` |

##### Examples:

```bash
# Ingest a PDF document
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "knowledge", "action": "ingest", "params": {"source": "/path/to/document.pdf", "chunkSize": 1000}}' \
  http://localhost/api/plugin

# Query the knowledge base with RAG
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "knowledge", "action": "query", "params": {"question": "What is the installation process?", "k": 5}}' \
  http://localhost/api/plugin

# Search without generating an answer
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "knowledge", "action": "search", "params": {"query": "installation", "retrieverType": "mmr"}}' \
  http://localhost/api/plugin

# Get knowledge base stats
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"plugin": "knowledge", "action": "stats"}' \
  http://localhost/api/plugin
```

##### Query Response:
```json
{
  "success": true,
  "answer": "Based on the documentation, the installation process involves...",
  "sourceDocuments": [
    {
      "content": "...",
      "source": "/path/to/document.pdf",
      "similarity": 0.89
    }
  ],
  "contextUsed": true
}
```

#### 2. Ollama Provider (Local LLMs)

Run LLMs locally for privacy and zero-cost inference.

**Supported Models**:
- Chat: mistral, llama2, codellama, qwen, etc.
- Embeddings: nomic-embed-text, mxbai-embed-large
- Vision: llava, bakllava

**Configuration** (in `.env`):
```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=mistral
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
ENABLE_OLLAMA=true
```

The Ollama provider integrates seamlessly with the existing provider system. Switch to it via:
- Web UI: AI Providers page
- Natural language: "switch to ollama provider"

#### 3. BitNet Provider (CPU-Only 1-Bit LLMs)

Run 1.58-bit quantized LLMs entirely on CPU using Microsoft's BitNet.cpp framework. Zero API cost, no GPU required.

**Supported Models**:
- BitNet-b1.58-2B-4T (2.4B params, trained on 4T tokens)
- bitnet_b1_58-large (0.7B params)
- Llama3-8B-1.58-100B-tokens (8B params, 1.58-bit)

**Configuration** (in `.env`):
```bash
ENABLE_BITNET=true
BITNET_BASE_URL=http://localhost:8080
BITNET_CHAT_MODEL=BitNet-b1.58-2B-4T
BITNET_CONTEXT_LENGTH=2048
```

**Prerequisites**: BitNet.cpp server running (`python run_inference_server.py -m <model_path>`). The provider registers even when the server is offline and auto-reconnects when the server becomes available.

Switch to it via:
- Web UI: AI Providers page → "Switch to BitNet"
- Telegram: `/ai` → "BitNet (Local)"
- Natural language: "switch to bitnet provider"
- API: `POST /api/ai/switch` with `{"provider": "bitnet"}`

#### 4. Structured Output Parsing

JSON schema validation for LLM outputs using Ajv.

**Pre-defined Schemas**:
- `intent` - Plugin action detection
- `chainAnalysis` - Multi-step task analysis
- `reminderParams`, `emailParams`, `searchParams` - Plugin-specific schemas

The structured output parsing is used internally by:
- `aiIntentDetector.js` - Intent classification
- `pluginChainProcessor.js` - Multi-step task decomposition

#### 4. Agent Reasoning Patterns

Two advanced reasoning patterns for complex tasks:

**ReAct (Reasoning + Acting)**:
- Interleaves thinking and acting in a loop
- Thought → Action → Observation → Thought → ...
- Best for tasks requiring adaptive strategy

**Plan-and-Execute**:
- Creates complete plan upfront
- Executes steps sequentially
- Replans on errors (configurable)
- Best for well-defined, multi-step tasks

**Configuration** (in Agent model):
```javascript
reasoning: {
  enabled: true,
  mode: 'auto', // 'react', 'plan-execute', or 'auto'
  maxIterations: 10,
  enableReplanning: true,
  showThoughts: false,
  thoughtPersistence: true
}
```

**Thought Store**: Persists reasoning traces to MongoDB for:
- Learning from past reasoning patterns
- Debugging and analysis
- Bootstrapping similar future queries

---

### UPS Monitoring & Bluetooth Control (v2.8.80)

- **UPS Monitoring** - Monitor APC/NUT-compatible UPS devices
  - Background polling via `upsc` command (NUT)
  - Power event detection: on_battery, low_battery, power_restored
  - Configurable thresholds and auto-shutdown capability
  - Event history with severity levels
  - MQTT integration for IoT automation

- **Bluetooth Control** - Manage Bluetooth devices via `bluetoothctl`
  - Scan for nearby devices with signal strength
  - Pair/unpair, connect/disconnect, trust/untrust devices
  - Device tracking with connection history
  - Natural language: "scan for bluetooth", "connect to my headphones"

#### UPS Endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins/ups/status` | GET | Current UPS status (battery, load, runtime) |
| `/api/plugins/ups/list` | GET | List configured UPS devices |
| `/api/plugins/ups/history` | GET | Power event history |
| `/api/plugins/ups/config` | GET | Get UPS configuration |
| `/api/plugins/ups/config` | POST | Update UPS configuration |
| `/api/plugins/ups/acknowledge/:id` | POST | Acknowledge power event |

#### UPS Examples:

```bash
# Get UPS status
curl -H "X-API-Key: your_key" http://localhost/api/plugins/ups/status

# Get power event history
curl -H "X-API-Key: your_key" "http://localhost/api/plugins/ups/history?limit=20"

# Update configuration
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"pollInterval": 30, "thresholds": {"lowBattery": 25}}' \
  http://localhost/api/plugins/ups/config
```

#### UPS Status Response:
```json
{
  "success": true,
  "status": {
    "upsName": "ups",
    "model": "Back-UPS ES 750",
    "manufacturer": "APC",
    "status": "OL",
    "statusText": "Online",
    "batteryCharge": 100,
    "batteryRuntime": 1800,
    "load": 35,
    "inputVoltage": 120.5,
    "outputVoltage": 120.0,
    "temperature": 28
  },
  "lastUpdate": "2026-01-15T12:00:00.000Z"
}
```

#### Bluetooth Endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins/bluetooth/scan` | POST | Scan for nearby devices |
| `/api/plugins/bluetooth/devices` | GET | List all known devices |
| `/api/plugins/bluetooth/paired` | GET | List paired devices |
| `/api/plugins/bluetooth/connected` | GET | List connected devices |
| `/api/plugins/bluetooth/pair/:mac` | POST | Pair with device |
| `/api/plugins/bluetooth/unpair/:mac` | POST | Remove device pairing |
| `/api/plugins/bluetooth/connect/:mac` | POST | Connect to device |
| `/api/plugins/bluetooth/disconnect/:mac` | POST | Disconnect from device |
| `/api/plugins/bluetooth/trust/:mac` | POST | Trust device (auto-connect) |
| `/api/plugins/bluetooth/info/:mac` | GET | Get device details |

#### Bluetooth Examples:

```bash
# Scan for devices (10 second scan)
curl -X POST -H "X-API-Key: your_key" \
  -d '{"duration": 10}' \
  http://localhost/api/plugins/bluetooth/scan

# List paired devices
curl -H "X-API-Key: your_key" http://localhost/api/plugins/bluetooth/paired

# Connect to headphones
curl -X POST -H "X-API-Key: your_key" \
  http://localhost/api/plugins/bluetooth/connect/AA:BB:CC:DD:EE:FF

# Get device info
curl -H "X-API-Key: your_key" \
  http://localhost/api/plugins/bluetooth/info/AA:BB:CC:DD:EE:FF
```

#### Bluetooth Scan Response:
```json
{
  "success": true,
  "devices": [
    {
      "macAddress": "AA:BB:CC:DD:EE:FF",
      "name": "Sony WH-1000XM4",
      "rssi": -45,
      "paired": true,
      "connected": false,
      "deviceType": "audio"
    }
  ],
  "count": 12,
  "duration": 10
}
```

---

### Wake-on-LAN (v2.8.80)

- **Network Plugin Enhancement** - Added Wake-on-LAN support
  - Wake devices by MAC address or alias
  - UDP magic packet broadcast (ports 7 and 9)
  - Works with network device inventory

#### Wake-on-LAN Endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins/network/wol` | POST | Wake device by MAC or identifier |
| `/api/plugins/network/wol/devices` | GET | List WOL-capable devices |

```bash
# Wake device by MAC
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"mac": "AA:BB:CC:DD:EE:FF"}' \
  http://localhost/api/plugins/network/wol

# Wake device by name
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"identifier": "my-desktop"}' \
  http://localhost/api/plugins/network/wol
```

---

### MQTT & Event Engine (v2.8.79)

- **Built-in MQTT Broker** - Aedes-based broker for IoT devices
  - TCP port 1883, WebSocket port 9883
  - Home Assistant MQTT Discovery protocol
  - Auto-discovers Tasmota, Zigbee2MQTT, ESPHome devices

- **Event Engine** - Rule-based automation (NO AI in hot path)
  - MQTT triggers, schedule triggers, state change triggers
  - Actions: device commands, MQTT publish, notifications, delays
  - Throttle/debounce support for rate limiting

#### MQTT Endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mqtt/api/status` | GET | Service and Event Engine status |
| `/mqtt/api/brokers` | GET | List all configured brokers |
| `/mqtt/api/brokers` | POST | Create or update broker |
| `/mqtt/api/brokers/:id` | DELETE | Delete broker |
| `/mqtt/api/brokers/:id/toggle` | POST | Enable/disable broker |
| `/mqtt/api/devices` | GET | List discovered devices |
| `/mqtt/api/devices/:id` | GET | Get single device details |
| `/mqtt/api/devices/:id/command` | POST | Send command to device |
| `/mqtt/api/devices/:id/history` | GET | Get device state history |
| `/mqtt/api/states` | GET | Get all topic states |
| `/mqtt/api/state` | GET | Get state by topic/pattern |
| `/mqtt/api/publish` | POST | Publish MQTT message |
| `/mqtt/api/rules` | GET | List automation rules |
| `/mqtt/api/rules` | POST | Create automation rule |
| `/mqtt/api/rules/:id` | PUT | Update rule |
| `/mqtt/api/rules/:id` | DELETE | Delete rule |
| `/mqtt/api/rules/:id/toggle` | POST | Enable/disable rule |
| `/mqtt/api/rules/:id/trigger` | POST | Manually trigger rule |
| `/mqtt/api/history` | GET | Message history with aggregation |
| `/mqtt/api/history/stats` | GET | Topic statistics |

#### DeviceGroup Bulk Operations (v2.10.45)

The DeviceGroup model supports transactional bulk operations for managing MQTT device groups:

- `DeviceGroup.bulkCreate(groupsData)` - Create multiple groups in a single mongoose transaction
- `DeviceGroup.bulkUpdate(groupsData)` - Update multiple groups atomically (each item requires `_id`)
- `DeviceGroup.bulkDelete(groupIds)` - Delete groups by ID array with transaction rollback on failure

#### MQTT Examples:

```bash
# Get service status
curl -H "X-API-Key: your_key" http://localhost/mqtt/api/status

# List all devices
curl -H "X-API-Key: your_key" http://localhost/mqtt/api/devices

# Send command to device
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"command": "ON"}' \
  http://localhost/mqtt/api/devices/light_1/command

# Publish to topic
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"topic": "home/light/set", "payload": "ON", "retain": false}' \
  http://localhost/mqtt/api/publish

# Create automation rule
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{
    "name": "Motion Light",
    "triggerType": "mqtt",
    "mqttTrigger": {"topic": "home/+/motion"},
    "actions": [{"type": "device_command", "deviceCommand": {"deviceId": "light_1", "command": "ON"}}]
  }' \
  http://localhost/mqtt/api/rules

# Get topic history with hourly aggregation
curl -H "X-API-Key: your_key" \
  "http://localhost/mqtt/api/history?topic=home/temperature&hours=24&aggregation=hour"
```

#### Status Response:
```json
{
  "success": true,
  "mqtt": {
    "enabled": true,
    "brokerRunning": true,
    "messagesReceived": 1250,
    "clientsConnected": 3
  },
  "eventEngine": {
    "enabled": true,
    "ruleCount": 5
  },
  "brokerCount": 1,
  "connectedBrokers": 1,
  "deviceCount": 12,
  "activeRuleCount": 5
}
```

---

## Previous Updates (January 14, 2026)

### Media Generation Service (v2.8.78)

- **Image Generation** - AI-powered image creation
  - OpenAI: GPT-Image-1, GPT-Image-1.5, DALL-E 3, DALL-E 2
  - HuggingFace: FLUX.1 Schnell/Dev, Stable Diffusion 3 Medium, SDXL 1.0
  - Natural language intents: "generate an image of...", "create a picture of..."
  - Full cost tracking integrated with analytics

- **Video Generation** - AI-powered video creation
  - ModelsLab: Wan 2.1/2.2 (Ultra), CogVideoX, WanX (Standard) — default provider, no content moderation, pay-as-you-go ($0.20/video Ultra, $0.08 Standard)
  - OpenAI: Sora 2 (async job-based, content-moderated fallback)
  - HuggingFace: Wan 2.1 T2V 14B
  - Natural language intents: "generate a video of...", "create a video showing..."
  - Resolution, frames, FPS settings; background generation with Telegram delivery

#### Media Generation Endpoints:
- `GET /api/media/settings` - Get all media generation settings
- `POST /api/media/image/settings` - Update image generation settings
- `POST /api/media/video/settings` - Update video generation settings
- `POST /api/media/image/generate` - Generate image via API
- `POST /api/media/video/generate` - Generate video via API
- `GET /api/media/image/stats` - Image generation statistics and costs
- `GET /api/media/video/stats` - Video generation statistics and costs

#### Image Generation Example:
```bash
# Get current settings
curl -H "X-API-Key: your_key" http://localhost/api/media/settings

# Update image settings
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"enabled": true, "provider": "openai", "openai": {"model": "gpt-image-1", "size": "1024x1024"}}' \
  http://localhost/api/media/image/settings

# Generate image
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"prompt": "A futuristic city at sunset"}' \
  http://localhost/api/media/image/generate

# Get image stats
curl -H "X-API-Key: your_key" http://localhost/api/media/image/stats
```

#### Image Stats Response:
```json
{
  "success": true,
  "data": {
    "totalRequests": 25,
    "totalCost": 1.20,
    "monthlyCost": 0.80,
    "monthlyRequests": 15,
    "costByProvider": { "openai": 1.00, "huggingface": 0.20 },
    "currentMonth": "January 2026"
  }
}
```

### Crypto Strategy Agenda Integration (v2.8.78)

- Crypto strategy service now uses Agenda scheduler instead of setInterval
- Job appears in Background Tasks page for monitoring
- Runs hourly (configurable via service settings)

### Crypto Strategy Service (v2.8.77)

- **Native Token Maximizer Strategy** - Autonomous trading to maximize ETH and tBNB balances
  - Focuses on BSC testnet (tBNB) and Sepolia (ETH) networks
  - Tracks price baselines with 24-hour reset
  - Sells to stablecoin when price rises 5%+ from baseline
  - Buys back native token when price drops 3%+ after selling
  - Hourly analysis loop with Chainlink oracle prices

- **Strategy Endpoints**
  - `GET /api/crypto/strategy/status` - Get service status, positions, price baselines
  - `POST /api/crypto/strategy/enable` - Enable the strategy service
  - `POST /api/crypto/strategy/disable` - Disable the strategy service
  - `GET /api/crypto/strategy/config` - Get current strategy configuration
  - `POST /api/crypto/strategy/config` - Update configuration (thresholds, etc.)
  - `POST /api/crypto/strategy/trigger` - Trigger manual strategy run
  - `POST /api/crypto/strategy/network-mode` - Set testnet/mainnet mode
  - `POST /api/crypto/strategy/emergency-stop` - Emergency kill switch
  - `POST /api/crypto/strategy/clear-emergency` - Clear emergency stop
  - `GET /api/crypto/strategy/journal` - View decision history

- **DEX Swap Service** - Token swapping via decentralized exchanges (V4 > V3 > V2 preference)
  - `POST /api/crypto/swap/quote` - Get swap quote before executing
  - `POST /api/crypto/swap/execute` - Execute token swap (supports `forceV3`, `preferV3`, `expectedOutputUsd` options)
  - `GET /api/crypto/swap/networks` - List supported networks
  - `GET /api/crypto/swap/pending` - View pending swaps

- **Network Settings** - Per-network trading controls (persisted in MongoDB)
  - `GET /api/crypto/settings/disabled-networks` - Get list of disabled networks
  - `POST /api/crypto/settings/disabled-networks` - Set disabled networks (body: `{"disabledNetworks": ["ethereum"]}`)
  - Valid networks: `ethereum`, `bsc`

#### Strategy Status Response:
```json
{
  "success": true,
  "enabled": true,
  "strategy": "native_maximizer",
  "strategyGoal": "Maximize native token balances (ETH on Sepolia, tBNB on BSC testnet)",
  "activeNetworks": ["sepolia", "bsc-testnet"],
  "config": {
    "priceThresholds": {
      "sellThreshold": 5,
      "buyThreshold": -3,
      "baselineResetHours": 24
    }
  },
  "state": {
    "priceBaselines": {
      "ETH/USD": { "price": 3321.02, "timestamp": "..." },
      "BNB/USD": { "price": 947.34, "timestamp": "..." }
    },
    "positions": {}
  }
}
```

#### Usage Examples:

```bash
# Get strategy status with positions and baselines
curl -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/status

# Enable strategy service
curl -X POST -H "X-API-Key: your_key" http://localhost/api/crypto/strategy/enable

# Update price thresholds
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"priceThresholds": {"sellThreshold": 7, "buyThreshold": -5}}' \
  http://localhost/api/crypto/strategy/config

# Set to testnet mode
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"mode": "testnet"}' http://localhost/api/crypto/strategy/network-mode

# Get swap quote (BNB to BUSD on BSC testnet)
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"tokenIn": "native", "tokenOut": "0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee", "amountIn": "0.01", "network": "bsc-testnet"}' \
  http://localhost/api/crypto/swap/quote

# Execute swap
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"tokenIn": "native", "tokenOut": "0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee", "amountIn": "0.001", "slippageTolerance": 5, "network": "bsc-testnet"}' \
  http://localhost/api/crypto/swap/execute

# Get disabled networks
curl -H "X-API-Key: your_key" http://localhost/api/crypto/settings/disabled-networks

# Disable ethereum trading
curl -X POST -H "X-API-Key: your_key" -H "Content-Type: application/json" \
  -d '{"disabledNetworks": ["ethereum"]}' \
  http://localhost/api/crypto/settings/disabled-networks
```

## Recent Updates (January 13, 2026)

### Memory Analytics & Task Dependencies (v2.8.72)

- **Memory User Analytics** - Aggregate memory statistics per user
  - `Memory.aggregateMemoriesByUser(matchCriteria)` - Groups memories by userId
  - Returns: averageImportance, totalAccessCount, memoryCount per user
  - Sorted by memory count descending

- **Task Dependency Resolution** - Topological sort for task execution
  - `task.resolveDependencies()` - Returns ordered list of dependency task IDs
  - Detects circular dependencies and missing tasks
  - Enables complex workflow orchestration

- **TokenUsage User Metrics** - Per-user token and cost tracking
  - `TokenUsage.getUserMetrics(userId)` - Cached aggregation (10 min TTL)
  - Returns: totalTokens, totalCost, avgResponseTime, totalRequests

- **Anthropic Provider Resilience** - Retry logic for API calls
  - `generateResponse()` and `analyzeImage()` now retry on transient failures
  - 2 retries with 1 second minimum timeout

#### Usage Examples:

```javascript
// Memory analytics
import { Memory } from './src/models/Memory.js';
const userStats = await Memory.aggregateMemoriesByUser({ type: 'knowledge' });
// Returns: [{ _id: 'user123', averageImportance: 7.5, totalAccessCount: 42, memoryCount: 15 }, ...]

// Task dependency resolution
const task = await Task.findById(taskId);
const executionOrder = await task.resolveDependencies();
// Returns: ['dep1', 'dep2', 'dep3', taskId] - tasks in execution order

// User token metrics
import { TokenUsage } from './src/models/TokenUsage.js';
const metrics = await TokenUsage.getUserMetrics('user123');
// Returns: { totalTokens: 50000, totalCost: 1.25, avgResponseTime: 1200, totalRequests: 100 }
```

## Recent Updates (January 12, 2026)

### Memory Management Web UI (v2.8.69)

- **Memory Administration** - Complete web interface for memory system control
  - Clear all memories with confirmation (requires "DELETE ALL MEMORIES" phrase)
  - Rebuild vector index from existing MongoDB memories
  - Deduplication settings (toggle and threshold slider)
  - Vector store stats display (indexed count, status)

#### Memory Management API Endpoints:
```bash
# Clear all memories (requires confirmation phrase)
curl -X POST http://localhost:3000/api/memory/clear-all \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"confirmPhrase": "DELETE ALL MEMORIES"}'

# Rebuild vector index from MongoDB memories
curl -X POST http://localhost:3000/api/memory/rebuild-index \
  -H "Authorization: Bearer <token>"

# Update deduplication settings
curl -X POST http://localhost:3000/api/memory/settings \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"deduplicationEnabled": true, "deduplicationThreshold": 0.85}'

# Get current settings (includes deduplication)
curl -X GET http://localhost:3000/api/memory/settings \
  -H "Authorization: Bearer <token>"
```

### PR Review Batch & Feature Implementation (v2.8.67)

- **Dynamic Retry Parameters** - retryUtils now adapts based on historical success/failure rates
  - Tracks operation history and adjusts retry count, backoff, and timeouts dynamically
  - Lower success rate operations get more retries automatically

- **FCM Bulk Messaging** - Send Firebase Cloud Messaging notifications to multiple devices
  - `sendBulkMessages` action accepts array of registration tokens
  - API: `POST /api/plugin` with `plugin: "firebasecloudmessagingfcm", action: "sendBulkMessages"`

- **Email Batch Processing** - Efficient bulk email operations
  - `batchProcessEmails` for bulk status updates (markAsRead, markAsProcessed)
  - Conversation caching with 10-minute TTL

- **Integromatnowmake Version Control** - Scenario versioning capabilities
  - `listScenarioVersions` - List all versions of a Make scenario
  - `rollbackScenario` - Rollback to a previous version
  - API: `POST /api/plugin` with `plugin: "integromatnowmake"`

- **Database Health Check** - New diagnostic function
  - `databaseHealthCheck()` returns connection status, state, and reconnect attempts
  - Import from `src/utils/database.js`

#### New Plugin Examples:
```bash
# FCM Bulk Messaging
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "firebasecloudmessagingfcm", "action": "sendBulkMessages", "registrationTokens": ["token1", "token2"], "title": "Alert", "body": "Message"}'

# List scenario versions (Make/Integromat)
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "integromatnowmake", "action": "listScenarioVersions", "scenarioId": "12345"}'

# Rollback scenario to previous version
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "integromatnowmake", "action": "rollbackScenario", "scenarioId": "12345", "versionId": "v1"}'

# Batch process emails
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "email", "action": "batchProcess", "emailIds": ["id1", "id2"], "markAsRead": true}'
```

## Recent Updates (January 16, 2026)

### New API Plugins (v2.8.84)

- **Mediastack Plugin** - Real-time news API integration
  - `getLatestNews` - Fetch latest news articles by country/language
  - `searchNews` - Search news by keyword
  - `getNewsByCategory` - Get news by category (business, sports, etc.)
  - **NEW**: Date filtering support (`date`, `dateFrom`, `dateTo` parameters)
  - API: `POST /api/plugin` with `plugin: "mediastack"`
  - Requires: `MEDIASTACK_API_KEY` environment variable

- **Currencylayer Plugin** - Exchange rates and currency conversion
  - `getLiveRates` - Get real-time exchange rates
  - `getHistoricalRates` - Get rates for a specific date
  - `convertCurrency` - Convert between currencies
  - API: `POST /api/plugin` with `plugin: "currencylayer"`
  - Requires: `CURRENCYLAYER_API_KEY` environment variable

- **Aviationstack Plugin** - Flight status and aviation data (with response caching)
  - `getFlightStatus` - Check flight status by flight number
  - `getAirlineInfo` - Get airline information by IATA code (cached 5 min)
  - `getAirportInfo` - Get airport information by IATA code (cached 5 min)
  - `getHistoricalFlightData` - Retrieve historical flight data by date range
  - API: `POST /api/plugin` with `plugin: "aviationstack"`
  - Requires: `AVIATIONSTACK_API_KEY` environment variable

- **StatusCake Plugin** - Uptime monitoring with scheduled tests
  - `getUptimeTests` - List all uptime tests
  - `getTestDetails` - Get details of a specific test
  - `createTest` - Create a new uptime test
  - `deleteTest` - Delete an existing test
  - `updateTest` - Update an existing test
  - `scheduleTest` - Schedule recurring test checks via cron expression
  - API: `POST /api/plugin` with `plugin: "statuscake"`
  - Requires: `STATUSCAKE_API_KEY` environment variable

- **Plugin Count**: 69 modular plugins available

#### New Plugin Examples:
```bash
# Get latest US news
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "mediastack", "action": "getLatestNews", "countries": "us", "limit": 5}'

# Get news with date range (dateFrom and dateTo)
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "mediastack", "action": "searchNews", "query": "technology", "dateFrom": "2026-01-01", "dateTo": "2026-01-22"}'

# Get live currency rates
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "currencylayer", "action": "getLiveRates", "currencies": "EUR,GBP", "source": "USD"}'

# Check flight status
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "aviationstack", "action": "getFlightStatus", "flightNumber": "BA2490"}'
```

### Model Enhancements (v2.8.84)

- **ContractEvent Batch Save** - Efficient bulk event storage
  - New `ContractEvent.batchSaveWithRetry()` static method
  - Uses `insertMany` with `ordered: false` for performance
  - Includes retry logic for transient database failures

- **PluginDevelopment Index Optimization**
  - Added compound index `{status: 1, completedAt: -1}`
  - Improves query performance for status-based filtering

## Recent Updates (January 11, 2026)

### New Plugins & Enhancements (v2.8.65)

- **Fixer API Plugin** - Foreign exchange rates and currency conversion
  - `getLatestRates` - Fetch current exchange rates for all supported currencies
  - `getHistoricalRates` - Fetch historical rates for a specific date
  - `convertCurrency` - Convert amounts between currencies
  - `getFluctuation` - Calculate percentage change between two historical dates
  - API: `POST /api/plugin` with `plugin: "fixer"`

- **Hardhat Multi-Network Deployment** (v2.8.64)
  - Deploy contracts to multiple networks in parallel
  - Supports both `network` (string) and `networks` (array) parameters
  - Automatic retry with exponential backoff
  - New health check endpoint: `GET /api/hardhat/health`

- **Plugin Count**: 57 modular plugins available

#### Fixer Plugin Examples:
```bash
# Get latest exchange rates
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "fixer", "action": "getLatestRates", "base": "USD"}'

# Get historical rates
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "fixer", "action": "getHistoricalRates", "date": "2023-05-24", "base": "USD"}'

# Convert currency
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "fixer", "action": "convertCurrency", "amount": 100, "from": "USD", "to": "EUR"}'

# Get fluctuation (percentage change between dates)
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "fixer", "action": "getFluctuation", "params": {"startDate": "2026-01-01", "endDate": "2026-02-01", "base": "USD", "symbols": "EUR,GBP"}}'
```

## Recent Updates (January 9, 2026)

### Enhanced Security with Smart Rate Limiting (v2.8.61)
- **Intelligent Rate Limiting** - Advanced rate limiting for API endpoints
  - IP-based rate limiting for unauthenticated requests only
  - API key authenticated requests bypass IP limits (use their own rate limits)
  - Automatic detection of proxy/load balancer IPs via X-Forwarded-For headers
  - Health check endpoints exempt from rate limiting for monitoring systems
  - Configurable via `DEVICE_ALIAS_RATE_LIMIT` environment variable
  - Returns `RateLimit-*` headers with limit information
  - 429 responses include `retryAfter` timestamp

### Major Govee Plugin Enhancements (v2.8.60)
- **Enhanced Natural Language Control** - Improved AI understanding and parameter extraction
  - Fixed AI parameter extraction to capture full device names ("master toilet light" not just "light")
  - Added support for compound colors ("bright white", "warm white", "dark blue")
  - Enhanced brightness control accepting both "brightness" and "level" parameters
  - Improved vector intent matching for better command recognition
  
- **Schedule Management** - Automated device control with flexible scheduling
  - `GET /api/govee/schedules` - List all device schedules
  - `POST /api/govee/schedules` - Create a new schedule
  - `PATCH /api/govee/schedules/:scheduleId` - Update schedule (enable/disable)
  - `DELETE /api/govee/schedules/:scheduleId` - Delete a schedule
  - Fixed schedule display to show device names instead of MAC addresses
  
- **Advanced Features** - Groups, themes, and backup/restore
  - `POST /api/plugin` with `plugin: "govee", action: "group"` - Manage device groups
  - `POST /api/plugin` with `plugin: "govee", action: "theme"` - Apply predefined themes
  - `POST /api/govee/backup` - Backup all device settings
  - `POST /api/govee/restore` - Restore device settings from backup
  
#### Schedule Features:
- **Time-based automation**: Turn devices on/off at specific times
- **Flexible actions**: Power, brightness, color (with RGB values), and scene control
- **Repeat options**: Once, daily, weekdays, weekends, or custom days
- **Visual management**: Web UI with easy schedule creation and management
- **Reliable execution**: Powered by Agenda job scheduler
- **Natural language support**: Create schedules via AI commands

#### Enhanced AI Examples:
```bash
# Color control with compound colors
"Turn my master toilet light bright white"
"Set bedroom lights to warm white"
"Make the kitchen light dark blue"

# Brightness with percentage
"Set the master toilet light brightness to 100%"
"Dim living room to 50 percent"
"Make bedroom lights brighter"

# Schedule creation
"Set the master toilet light to be at 100% brightness and white at 5:50am"
"Turn on bedroom lights every weekday at 7am"
"Schedule kitchen lights to turn off at 11pm daily"
```

#### Schedule API Example:
```json
{
  "device": "Master Toilet",
  "action": "color",
  "value": {"r": 255, "g": 255, "b": 255},
  "time": "05:50",
  "repeat": "daily",
  "brightness": 100,
  "fromAI": true
}
```

## Recent Updates (January 7, 2026)

### Vector Intent Detection System (v2.8.59)
- **Vector Intent Detection** - Lightning-fast embedding-based intent matching
  - `POST /api/vector-intent/index` - Index all intents for vector search
  - `GET /api/vector-intent/stats` - Get indexing statistics

### Device Alias Management (v2.8.59)
- **Device Aliases** - Custom names for smart home devices
  - `GET /api/device-aliases` - List all device aliases
  - `GET /api/device-aliases/:alias` - Get specific alias details
  - `POST /api/device-aliases` - Create or update device alias
  - `DELETE /api/device-aliases/:alias` - Delete device alias
  - `POST /api/device-aliases/bulk` - Bulk import aliases

### Enhanced Email Integration (v2.8.59)
- **Email Plugin Updates** - Advanced AI email composition
  - `sendWithAI` action now includes automatic web search for current information
  - Formal business email composition with multi-paragraph structure
  - Parameters: `enableWebSearch` (default: true), `searchQuery` (optional)

## Previous Updates (January 6, 2026)

### Govee Smart Home Plugin (v2.8.57)
- **GoveePlugin** - Complete smart home device control with AI integration
  - `POST /api/plugin` with `plugin: "govee", action: "list"` - List all Govee devices
  - `POST /api/plugin` with `plugin: "govee", action: "status", device: "device-id"` - Get device status
  - `POST /api/plugin` with `plugin: "govee", action: "power", device: "device-id", state: "on/off"` - Control power
  - `POST /api/plugin` with `plugin: "govee", action: "brightness", device: "device-id", level: 1-100` - Set brightness (also accepts "brightness" param)
  - `POST /api/plugin` with `plugin: "govee", action: "color", device: "device-id", r: 0-255, g: 0-255, b: 0-255` - Set RGB color
  - `POST /api/plugin` with `plugin: "govee", action: "color", device: "device-id", color: "red"` - Set color by name (25+ colors)
  - `POST /api/plugin` with `plugin: "govee", action: "temperature", device: "device-id", kelvin: 2000-9000` - Set color temperature
  - `POST /api/plugin` with `plugin: "govee", action: "scene", device: "device-id", scene: "scene-name"` - Apply scene
  - `POST /api/plugin` with `plugin: "govee", action: "scenes", device: "device-id", sku: "device-sku"` - Get available scenes
  - `POST /api/plugin` with `plugin: "govee", action: "settings", aiControlEnabled: true/false` - Manage AI control
  - `POST /api/plugin` with `plugin: "govee", action: "schedules", operation: "list|create|delete|update"` - Manage device schedules
  - `POST /api/plugin` with `plugin: "govee", action: "group", operation: "create|list|delete", name: "group-name"` - Device groups
  - `POST /api/plugin` with `plugin: "govee", action: "theme", device: "device-id", theme: "relax|party|movie|romance"` - Apply themes
  - `POST /api/plugin` with `plugin: "govee", action: "subscribe", devices: ["device-id"]` - Subscribe to device events
  - `POST /api/plugin` with `plugin: "govee", action: "unsubscribe"` - Unsubscribe from events

#### Key Features:
- **AI Control by Device Name**: Natural language commands like "turn on Living Room Light"
- **Bulk Operations**: Control all devices with "turn off all lights"
- **Color Name Support**: 25+ named colors including compound colors ("bright white", "warm white")
- **Flexible Brightness**: Accepts both "level" and "brightness" parameters with percentage support
- **Device Groups**: Create groups to control multiple devices simultaneously
- **Predefined Themes**: Quick ambiance settings (relax, party, movie, romance, etc.)
- **Schedule Management**: Time-based automation with color/brightness/power control
- **Backup/Restore**: Save and restore all device settings
- **MQTT Events**: Real-time device state updates via MQTT subscriptions
- **Persistent Settings**: AI control toggle persists across restarts
- **Real-time Status**: Live device status with color indicators (green=on, red=off, grey=offline)
- **Web UI Integration**: Full dashboard with visual controls and schedule management
- **Dynamic AI Capabilities**: AI learns device names automatically with vector intent matching
- **Partial Name Matching**: "kitchen" matches "Kitchen Light", "toilet" matches "Master Toilet"

#### AI Intent Examples:
- "Turn on the living room light"
- "Turn off all lights"
- "Turn my master toilet light green"
- "Set bedroom light to bright white"
- "Dim the bedroom light to 50%"
- "Set brightness to 100 percent"
- "Make kitchen lights warm white"
- "Set the TV backlight to blue"
- "Apply sunrise scene to kitchen"
- "Create a group called bedtime lights"
- "Set movie theme for the living room"
- "Schedule bathroom light to turn on at 6am daily"
- "Turn on bathroom lights at 100% brightness and white at 5:50am"

## Previous Updates (January 5, 2026)

### Autonomous PR Review System (v2.8.56)
- **PRReviewerPlugin** - AI-powered autonomous PR review and deployment system
  - `POST /api/plugin` with `plugin: "prReviewer", action: "review"` - Review all open PRs
  - `POST /api/plugin` with `plugin: "prReviewer", action: "getSettings"` - Get current settings
  - `POST /api/plugin` with `plugin: "prReviewer", action: "updateSettings", enabled: true/false, aiProvider: "anthropic", aiModel: "claude-3-5-opus-20241022"` - Update configuration
  - `POST /api/plugin` with `plugin: "prReviewer", action: "getStats"` - Get review statistics
  - `POST /api/plugin` with `plugin: "prReviewer", action: "testReview", prNumber: 123` - Test review without merging

#### Key Features:
- **Configurable AI Model**: Choose any AI provider/model (defaults to Claude 3.5 Opus)
- **Smart Review Actions**: Automatically merge, reject, or reimplement PRs
- **Safe Deployment**: Auto-deploy merged code with health monitoring and rollback
- **Detailed Comments**: AI provides comprehensive analysis on each PR
- **Reimplementation**: Creates better PRs when ideas are good but code is poor
- **Schedule Control**: Run twice daily (default: disabled)
- **Statistics Tracking**: Monitor merge/reject/reimplement rates and deployment success

#### Configuration Example:
```json
{
  "plugin": "prReviewer",
  "action": "updateSettings",
  "enabled": true,
  "schedule": "0 9,21 * * *",
  "aiProvider": "anthropic",
  "aiModel": "claude-3-5-opus-20241022",
  "autoMerge": true,
  "autoImplement": true,
  "deployAfterMerge": true,
  "rollbackOnFailure": true,
  "commentOnPRs": true,
  "maxPRsPerRun": 10
}
```

## Previous Updates (January 3, 2026)

### 9 New Integration Plugins (v2.8.52)
- **WhoisPlugin** - Domain WHOIS lookups and availability checking
  - `POST /api/plugin` with `plugin: "whois", action: "lookup", domain: "example.com"`
  - `POST /api/plugin` with `plugin: "whois", action: "availability", domain: "newdomain.com"`
  - `POST /api/plugin` with `plugin: "whois", action: "bulkLookup", domains: ["example.com", "test.org"]` (max 20)
- **ImageUpscalerPlugin** - AI-powered image enhancement (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "imageUpscaler", action: "upscale", imagePath: "/path/to/image.jpg", scale: 4`
  - `POST /api/plugin` with `plugin: "imageUpscaler", action: "enhance", imagePath: "/path/to/image.jpg"`
- **LinkedInPlugin** - Professional networking data (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "linkedin", action: "companyByDomain", domain: "apple.com"`
  - `POST /api/plugin` with `plugin: "linkedin", action: "companyProfile", linkedinUrl: "https://linkedin.com/company/..."`
- **JSearchPlugin** - Job search and salary data (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "jsearch", action: "search", query: "software engineer", location: "San Francisco"`
  - `POST /api/plugin` with `plugin: "jsearch", action: "salary", jobTitle: "data scientist", location: "New York"`
- **AmazonDataPlugin** - E-commerce product data (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "amazonData", action: "search", query: "laptop"`
  - `POST /api/plugin` with `plugin: "amazonData", action: "reviews", asin: "B08N5WRWNW"`
- **NinjaScraperPlugin** - Advanced web scraping (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "ninjaScraper", action: "scrape", url: "https://example.com", javascript: true`
  - `POST /api/plugin` with `plugin: "ninjaScraper", action: "screenshot", url: "https://example.com", fullPage: true`
- **QuotesPlugin** - Inspirational quotes (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "quotes", action: "random", category: "motivation"`
  - `POST /api/plugin` with `plugin: "quotes", action: "byAuthor", author: "Einstein"`
- **FlightDataPlugin** - Aviation information (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "flightData", action: "search", origin: "JFK", destination: "LAX", date: "2026-01-15"`
  - `POST /api/plugin` with `plugin: "flightData", action: "flightStatus", flightNumber: "AA100"`
- **HotelsPlugin** - Accommodation search (requires RAPIDAPI_KEY)
  - `POST /api/plugin` with `plugin: "hotels", action: "search", location: "Paris", checkin: "2026-02-01", checkout: "2026-02-05"`
  - `POST /api/plugin` with `plugin: "hotels", action: "reviews", hotelId: "12345"`

### NASA ADS Research Search (v2.8.75)
- **NASA Plugin v1.3.0** - Added Astrophysics Data System (ADS) search
  - `POST /api/plugin` with `plugin: "nasa", action: "adsSearch", query: "exoplanets"`
  - `POST /api/plugin` with `plugin: "nasa", action: "adsSearch", query: "author:Hawking"`
  - Returns title, author, and abstract for top 10 matching research papers
  - Results cached for 1 hour like other NASA endpoints
  - Requires `ADS_API_KEY` environment variable

### Provider Monitoring & NASA Caching (v2.8.51)
- **Real-Time Provider Alerts** - BaseProvider enhanced with monitoring
  - Response time threshold monitoring (configurable, default 1000ms)
  - Error rate alerts when exceeding 10% threshold
  - Alert events emitted via EventEmitter for integration
  - Seamless addition to existing metrics system
- **NASA Plugin v1.1.0** - Added intelligent caching
  - 1-hour cache for all endpoints (APOD, Mars Rover, NEO, Earth imagery, ADS search)
  - Significantly reduces API calls to NASA services
  - Uses node-cache for efficient in-memory storage
  - Backward compatible implementation

### NASA Batch Sols & Retry (v2.10.45)
- **Mars Rover Batch Sols** - `marsRoverPhotos` accepts an array of sols for batch fetching
  - `POST /api/plugin` with `plugin: "nasa", action: "marsRoverPhotos", roverName: "curiosity", sols: [100, 200, 300]`
  - Results aggregated across all requested sols
- **Retry on All API Calls** - `retryOperation` (3 retries) added to APOD, Mars Rover, NEO, Earth imagery, EPIC, and ADS endpoints

### Enhanced Diagnostics System Fixes (v2.8.50)
- **All Critical Issues Resolved** - Diagnostics now fully operational
  - Fixed memory status endpoint method calls (getMemoryStats, getRecentConversations, getSettings)
  - Fixed Telegram false positives - bot with valid token shows as operational
  - Fixed service registration - all services properly tracked in services Map
  - Fixed startup crashes by checking for start/stop method existence
  - API key usage tracking now working correctly for agent's diagnostic key
  - Added duplicate prevention for runs (1 min) and notifications (5 min)
  - Enhanced warning logs with full details in diagnostics.log
  - System consistently reports "All systems operational"
- **Task Scheduler Fix** - Resolved null reference error
  - Fixed calculateNextReportTime null time parameter handling
  - Report settings default to 9:00 AM and 7-day frequency

### New API Plugin Integrations (v2.8.48)
- **Amazon CloudWatch Plugin** - AWS monitoring and metrics management
- **New Relic Plugin** - Application performance monitoring
- **Trello Plugin** - Project management with boards and cards
- **Microsoft Graph Plugin** - Microsoft 365 integration

### Conversation Enhancement Features
- **AI Interpretation** - Technical outputs are now interpreted conversationally
- **Context-Aware Queries** - Query intent now includes conversation history
- **Smart Memory Storage** - Full plugin results stored instead of truncated summaries

### Bug Detection Improvements
- **Fingerprint-Based Deduplication** - Database-level duplicate prevention
- **Status Change Notifications** - Automatic alerts when bug report status changes
- **Critical Bug Notifications** - New critical-severity bug reports trigger immediate agent notification with bug details (ID, title, file, pattern, description excerpt)
- **Enhanced Async Handling** - All async operations properly awaited

### Memory System Enhancements
- **GET** `/api/memory/learned` - Enhanced with new sorting options
  - Added `sort=accessed` to sort by most frequently accessed memories
  - 17 new categories for better memory organization
  - Returns access count and last accessed timestamp for each memory

### Memory Management Endpoints
- **POST** `/api/memory/settings` - Update memory settings including auto-add toggle
- **GET** `/api/memory/settings` - Retrieve current memory settings

### Bug Detection Status
- **GET** `/api/plugins/bugDetector/status` - Get real-time bug detection scan status
  - Returns: `isRunning`, `lastScanTime`, `currentFile`, `progress`, `filesScanned`, `totalFiles`

## Base URL

**Development/Local:**
```
http://localhost:80
```

**Production Server:**
```
http://localhost:3000:80
```

**Note**: Default port is 80, configurable via `WEB_PORT` or `AGENT_PORT` environment variables.

## 🔐 Production Server Access

**Production SSH Access:**

Configure your production server in `scripts/deployment/deploy.config` or via environment variables. Instance-specific credentials belong in `CLAUDE.local.md` (gitignored).

```bash
export PRODUCTION_SERVER="your-server-ip"
export PRODUCTION_USER="your-user"
export PRODUCTION_PASS="your-password"
```

Use the deployment scripts (`scripts/deployment/`) which source these variables automatically.

## Authentication

LANAgent supports two authentication methods: JWT tokens (for web UI) and API keys (for external applications).

### Quick Start with API Keys

1. **Create an API key via Web UI**:
   - Navigate to http://localhost:3000
   - Login with password: `lanagent`
   - Go to Settings → API Keys
   - Click "Create API Key"
   - Save the generated key (starts with `la_`)

2. **Use the API key**:
   ```bash
   curl -H "X-API-Key: la_your_key_here" http://localhost:3000/api/system/status
   ```

3. **For development/testing**:
   - Debug API key: `your-api-key`
   - **Note**: Create your own key for production use

### JWT Token Authentication

**Endpoint**: `POST /api/auth/login`

**Request Body**:
```json
{
  "password": "your_password"
}
```

**Response**:
```json
{
  "success": true,
  "token": "jwt_token_here"
}
```

**Headers for Subsequent Requests**:
```
Authorization: Bearer <jwt_token>
```

### API Key Authentication

API keys provide a more convenient authentication method for external applications, scripts, and continuous integrations. All API keys start with the prefix `la_` for easy identification.

**Using API Keys**:

API keys can be used with either the `X-API-Key` header or the `Authorization` header:

```bash
# Option 1: X-API-Key header (Recommended)
curl -H "X-API-Key: la_your_api_key_here" http://localhost:3000/api/system/status

# Option 2: Authorization header with ApiKey prefix
curl -H "Authorization: ApiKey la_your_api_key_here" http://localhost:3000/api/system/status
```

**Examples with Different Endpoints**:
```bash
# Get list of plugins
curl -H "X-API-Key: la_your_api_key_here" http://localhost:3000/api/plugins

# Execute a plugin command
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "system", "action": "status"}'

# Get system diagnostics
curl -H "X-API-Key: la_your_api_key_here" http://localhost:3000/api/diagnostics/latest
```

**Python Example**:
```python
import requests

api_key = "la_your_api_key_here"
base_url = "http://localhost:3000"

# Using X-API-Key header
response = requests.get(
    f"{base_url}/api/system/status",
    headers={"X-API-Key": api_key}
)

if response.status_code == 200:
    data = response.json()
    print(data)
```

**JavaScript/Node.js Example**:
```javascript
const apiKey = 'la_your_api_key_here';
const baseUrl = 'http://localhost:3000';

// Using fetch with X-API-Key
fetch(`${baseUrl}/api/system/status`, {
    headers: {
        'X-API-Key': apiKey
    }
})
.then(response => response.json())
.then(data => console.log(data));
```

### API Key Management

API keys are managed through the web interface or API endpoints. Each key has the following properties:
- **Name**: A descriptive name for the key
- **Description**: Optional description of the key's purpose
- **Rate Limit**: Requests per minute (default: 100, can be customized)
- **Expiration**: Optional expiration date (keys don't expire by default)
- **Status**: active, suspended, or revoked

### API Key Management Endpoints

#### Create API Key
- **POST** `/api/keys`
  ```json
  {
    "name": "My Application",
    "description": "Production API key for monitoring",
    "expiresAt": "2025-12-31T23:59:59Z",  // Optional, null = no expiration
    "rateLimit": 1000  // Optional, default is 100 requests/minute
  }
  ```
  
  **Response**:
  ```json
  {
    "success": true,
    "key": {
      "id": "key_id",
      "key": "la_abcdefghijklmnopqrstuvwxyz123456",  // Full key shown only once!
      "keyPrefix": "la_abcdefgh...",
      "name": "My Application",
      "createdAt": "2024-01-01T00:00:00Z",
      "expiresAt": null,
      "rateLimit": 1000,
      "status": "active"
    }
  }
  ```
  
  **⚠️ IMPORTANT**: Save the full API key immediately! It won't be shown again.

#### List API Keys
- **GET** `/api/keys`
  Returns all API keys with metadata (key values are masked).

#### Update API Key
- **PUT** `/api/keys/:id`
  ```json
  {
    "name": "Updated Name",
    "description": "Updated description",
    "status": "active"  // active, suspended, or revoked
  }
  ```

#### Delete API Key
- **DELETE** `/api/keys/:id`
  Permanently deletes an API key.

#### Revoke API Key
- **POST** `/api/keys/:id/revoke`
  Revokes a key (cannot be reactivated).

#### Suspend/Reactivate API Key
- **POST** `/api/keys/:id/suspend`
- **POST** `/api/keys/:id/reactivate`
  Temporarily disable/enable a key.

#### Get API Key Statistics
- **GET** `/api/keys/stats`
  Returns usage statistics for all API keys.

### Rate Limiting

API keys are rate limited to prevent abuse. The default limit is 100 requests per minute, but this can be customized per key.

**Rate Limit Headers**:
When using an API key, the response includes rate limit information:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1704123600
```

**Rate Limit Exceeded**:
When the rate limit is exceeded, you'll receive:
```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "status": 429
}
```

### Best Practices

1. **Security**:
   - Never expose API keys in client-side code
   - Store API keys in environment variables
   - Use HTTPS in production environments
   - Rotate API keys regularly

2. **Key Management**:
   - Use descriptive names for your API keys
   - Create separate keys for different applications/environments
   - Monitor key usage through the statistics endpoint
   - Set appropriate rate limits based on your needs

3. **Error Handling**:
   - Always check for authentication errors (401/403)
   - Handle rate limit errors with exponential backoff
   - Log API errors for debugging

4. **Performance**:
   - Reuse API key connections when possible
   - Implement caching for frequently accessed data
   - Use appropriate timeouts for API calls

### Common Issues and Solutions

**API Key Not Working**:
- Verify the key starts with `la_`
- Check if the key is active (not suspended/revoked)
- Ensure no expiration date has passed
- Confirm the server is running (may take up to 1 minute after restart)

**Connection Refused**:
- The server may be restarting after a deployment
- Wait 30-60 seconds and retry
- Check server status with: `./scripts/deployment/deploy-check.sh`

**Authentication Failed**:
- Verify the correct header format (`X-API-Key` or `Authorization: ApiKey`)
- Ensure no extra spaces or characters in the key
- Check if the key exists in the database

## Core API Endpoints

### Vector Intent Detection

#### Index Intents
- **POST** `/api/vector-intent/index` - Index all intents for vector search
  ```bash
  curl -X POST http://localhost:3000/api/vector-intent/index \
    -H "X-API-Key: la_your_api_key_here"
  ```
  Response shows the number of intents indexed and any errors.

#### Get Statistics
- **GET** `/api/vector-intent/stats` - Get vector intent detection statistics
  ```bash
  curl -X GET http://localhost:3000/api/vector-intent/stats \
    -H "X-API-Key: la_your_api_key_here"
  ```
  Response includes detector status, intent count, and configuration.

### Device Alias Management

#### Health Check
- **GET** `/api/device-aliases/health` - Health check endpoint (no auth required, exempt from rate limiting)
  ```bash
  curl -X GET http://localhost:3000/api/device-aliases/health
  ```

#### List Aliases
- **GET** `/api/device-aliases` - List all device aliases
  ```bash
  # Get all aliases
  curl -X GET http://localhost:3000/api/device-aliases \
    -H "X-API-Key: la_your_api_key_here"
  
  # Filter by plugin
  curl -X GET "http://localhost:3000/api/device-aliases?plugin=govee" \
    -H "X-API-Key: la_your_api_key_here"
  ```
  
  **Rate Limiting**: 
  - IP-based: 100 requests per 15 minutes (configurable via `DEVICE_ALIAS_RATE_LIMIT`)
  - API key authenticated requests bypass IP rate limiting
  - Rate limit info returned in `RateLimit-*` headers

#### Get Specific Alias
- **GET** `/api/device-aliases/:alias` - Get details for a specific alias
  ```bash
  curl -X GET http://localhost:3000/api/device-aliases/bedroom \
    -H "X-API-Key: la_your_api_key_here"
  ```

#### Create/Update Alias
- **POST** `/api/device-aliases` - Create or update device alias
  ```bash
  curl -X POST http://localhost:3000/api/device-aliases \
    -H "X-API-Key: la_your_api_key_here" \
    -H "Content-Type: application/json" \
    -d '{
      "alias": "bedroom",
      "deviceName": "Bedroom Light",
      "plugin": "govee",
      "deviceId": "12:34:56:78:90:AB:CD:EF"
    }'
  ```

#### Delete Alias
- **DELETE** `/api/device-aliases/:alias` - Delete a device alias
  ```bash
  curl -X DELETE "http://localhost:3000/api/device-aliases/bedroom?plugin=govee" \
    -H "X-API-Key: la_your_api_key_here"
  ```

#### Bulk Import
- **POST** `/api/device-aliases/bulk` - Import multiple aliases at once
  ```bash
  curl -X POST http://localhost:3000/api/device-aliases/bulk \
    -H "X-API-Key: la_your_api_key_here" \
    -H "Content-Type: application/json" \
    -d '{
      "plugin": "govee",
      "aliases": [
        {"alias": "bedroom", "deviceName": "Bedroom Light"},
        {"alias": "living", "deviceName": "Living Room Light"},
        {"alias": "kitchen", "deviceName": "Kitchen Light"}
      ]
    }'
  ```

### Self-Diagnostics System

#### Run Diagnostics
- **POST** `/api/diagnostics/run` - Execute comprehensive system diagnostics
  ```bash
  # Using JWT token
  curl -X POST http://localhost:3000/api/diagnostics/run \
    -H "Authorization: Bearer YOUR_TOKEN"
  
  # Using API key
  curl -X POST http://localhost:3000/api/diagnostics/run \
    -H "X-API-Key: la_your_api_key_here"
  ```
  Response includes health status, test results, and identified issues.

#### Latest Report
- **GET** `/api/diagnostics/latest` - Get the most recent diagnostic report
  ```bash
  # Using JWT token
  curl http://localhost:3000/api/diagnostics/latest \
    -H "Authorization: Bearer YOUR_TOKEN"
  
  # Using API key
  curl http://localhost:3000/api/diagnostics/latest \
    -H "X-API-Key: la_your_api_key_here"
  ```

#### Historical Reports
- **GET** `/api/diagnostics/history?limit=10` - Browse past diagnostic reports
  ```bash
  curl http://localhost:3000/api/diagnostics/history?limit=10 \
    -H "Authorization: Bearer YOUR_TOKEN"
  ```

#### Health Trends
- **GET** `/api/diagnostics/trend/7` - Get health trends for the past N days
  ```bash
  curl http://localhost:3000/api/diagnostics/trend/7 \
    -H "Authorization: Bearer YOUR_TOKEN"
  ```

#### Configuration
- **GET** `/api/diagnostics/config` - View diagnostic configuration
- **PUT** `/api/diagnostics/config` - Update diagnostic settings
  ```bash
  curl -X PUT http://localhost:3000/api/diagnostics/config \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "enabled": true,
      "autoRunInterval": 21600000,
      "thresholds": {
        "memory": 90,
        "disk": 90,
        "cpu": 85
      }
    }'
  ```

#### Quick Health Check
- **GET** `/api/health` - Quick health status check (no auth required)
  ```bash
  curl http://localhost:3000/api/health
  ```

### System Management

#### System Status
- **GET** `/api/system/status` - Get comprehensive system status
- **GET** `/api/agent/info` - Get agent information and statistics
- **POST** `/api/command/execute` - Execute natural language commands

#### Agent Identity & Avatar
- **GET** `/api/agent/avatar` - Serve agent avatar image (no auth, public)
  - Returns image with correct Content-Type (png/jpg/gif/webp)
  - Cache-Control: public, max-age=3600
  - Returns 404 if no avatar configured
- **POST** `/api/agent/avatar` - Upload new avatar or update description (auth required)
  - Body: `{ "image": "base64data", "filename": "avatar.png", "description": "..." }`
  - Image optional if only updating description
  - Max 5MB, supports PNG, JPG, GIF, WebP
- **GET** `/api/agent/identity` - Get agent identity card (auth required)
  - Returns: name, version, avatar URL, avatarDescription, personality, pluginCount, capabilities, interfaces
- **POST** `/api/agent/avatar/sync` - Sync avatar to external services (Gravatar) (auth required)
  - Auto-crops non-square images to square before uploading
  - Uses OAuth token if connected, falls back to API key

#### ERC-8004 Agent Identity
- **GET** `/api/agent/erc8004/status` - Identity status, chain, agentId, staleness detection, gas estimate
- **POST** `/api/agent/erc8004/registration` - Generate and preview registration file JSON
- **POST** `/api/agent/erc8004/mint` - Upload to IPFS and mint identity NFT on-chain
  - Body: `{ "chain": "bsc" }` (optional, defaults to BSC)
  - Returns: agentId, txHash, agentURI, registrationCID, avatarCID, explorerUrl
- **PUT** `/api/agent/erc8004/update` - Re-upload registration to IPFS and update on-chain URI
- **POST** `/api/agent/erc8004/pinata-key` - Save Pinata IPFS API keys (encrypted)
  - Body: `{ "apiKey": "...", "secretKey": "..." }`
- **GET** `/api/agent/erc8004/pinata-key` - Check if Pinata keys are configured
- **POST** `/api/agent/erc8004/link-wallet` - Link wallet via EIP-712 signed setAgentWallet()
  - Body: `{ "walletAddress": "0x..." }` (optional, defaults to configured signer)
  - Returns: agentId, linkedWallet, txHash, chain, explorerUrl

#### Gravatar OAuth2
- **GET** `/api/gravatar/oauth/authorize` - Start OAuth flow (auth required)
  - Returns: `{ success, authorizeUrl }` — open URL in browser to authorize
  - Uses CSRF state token (5-min TTL)
- **GET** `/api/gravatar/oauth/callback` - OAuth callback (no auth, browser redirect)
  - Exchanges authorization code for access token
  - Stores encrypted token in database
  - Redirects to `/#settings?gravatar=connected`
- **GET** `/api/gravatar/oauth/status` - Check connection status (auth required)
  - Returns: `{ connected, source, hasClientId }`
- **POST** `/api/gravatar/oauth/disconnect` - Remove OAuth token (auth required)

#### System Configuration
- **GET** `/api/system/prompt` - Get current system prompt
- **POST** `/api/system/prompt` - Update system prompt
- **POST** `/api/agent/config` - Update agent configuration
- **GET** `/api/system/report-settings` - Get report settings
- **POST** `/api/system/report-settings` - Update report settings

#### System Reports
- **GET** `/api/system/reports` - Get report history
  - Query params: 
    - `type`: Filter by report type (`daily`, `weekly`, `monthly`, `custom`)
    - `limit`: Number of reports to return (default 10)
    - `offset`: Skip number for pagination
    - `startDate`: Filter reports after this date (ISO format)
    - `endDate`: Filter reports before this date (ISO format)
    - `summary`: Return only summary data (true/false)
  - Example: `/api/system/reports?type=daily&limit=7&summary=true`
  
- **GET** `/api/system/reports/:id` - Get specific report by ID
  - Returns full report including raw content and structured data
  
- **GET** `/api/system/reports/latest/:type?` - Get latest report
  - Optional `type` parameter to get latest of specific type
  - Examples: `/api/system/reports/latest/daily`, `/api/system/reports/latest`
  
- **GET** `/api/system/reports/trends` - Get performance trends
  - Query params: 
    - `days`: Number of days to look back (default 30)
  - Returns time series data for response times, memory usage, errors, success rates
  
- **DELETE** `/api/system/reports/cleanup` - Delete old reports
  - Body params: 
    - `olderThan`: Delete reports older than X days (default 90)
    - `keepLatest`: Number of latest reports to keep regardless of age (default 10)
  - Requires authentication

### AI Provider Management

Available providers: OpenAI, Anthropic, Gab, HuggingFace, Ollama, BitNet

#### Provider Operations
- **GET** `/api/ai/providers` - List all AI providers with current models
- **POST** `/api/ai/switch` - Switch active AI provider (body: `{"provider": "bitnet"}`)
- **POST** `/api/ai/update-models` - Update available models for providers
- **GET** `/api/ai/models/:provider` - Get available models for specific provider
- **POST** `/api/ai/update-model` - Update model for specific provider

#### Provider Metrics
- **GET** `/api/ai/metrics` - Get comprehensive AI usage metrics

#### HuggingFace Configuration
- **GET** `/api/ai/huggingface/config` - Get HuggingFace configuration
- **POST** `/api/ai/huggingface/config` - Update HuggingFace configuration

### Memory Management

#### Memory Operations
- **GET** `/api/memory/recent` - Get recent conversations (last 20)
- **GET** `/api/memory/current-context` - Get current conversation context
- **GET** `/api/memory/conversation-history` - Get conversation history with optional date filter
- **GET** `/api/memory/learned` - Get learned memories with search and filtering

#### Memory Modification
- **POST** `/api/memory/:id/edit` - Edit specific memory
- **POST** `/api/memory/:id/delete` - Delete specific memory
- **POST** `/api/memory/add` - Add new memory

### Plugin Management

#### Plugin Operations
- **GET** `/api/plugins` - List all plugins with status
- **POST** `/api/plugins/:name/toggle` - Enable/disable plugin
- **GET** `/api/plugins/:name/config` - Get plugin configuration
- **POST** `/api/plugins/:name/config` - Update plugin configuration

#### Generic Plugin Execution
- **POST** `/api/plugin` - Execute any plugin action
```json
{
  "plugin": "pluginName",
  "action": "actionName",
  "parameter1": "value1",
  "parameter2": "value2"
}
```

### Cryptocurrency Wallet

LANAgent includes a built-in multi-chain cryptocurrency wallet for autonomous financial operations. The wallet supports Bitcoin, Ethereum, BSC, Polygon, Base, and Nano (XNO) networks with full smart contract interaction, DeFi operations, and testnet support.

**Recent Updates (January 2, 2026):**
- ✅ Fixed wallet service import issues for proper functionality
- ✅ Enhanced agent self-awareness of crypto capabilities
- ✅ Improved system prompt to advertise actual wallet features

#### Wallet Status
- **GET** `/api/crypto/status` - Get wallet information and addresses

```bash
curl http://localhost:3000/api/crypto/status \
  -H "Authorization: Bearer <token>"
```

Response:
```json
{
  "initialized": true,
  "addresses": [
    {
      "chain": "btc",
      "name": "Bitcoin",
      "address": "YOUR_BTC_ADDRESS",
      "path": "m/44'/0'/0'/0/0"
    },
    {
      "chain": "eth",
      "name": "Ethereum",
      "address": "YOUR_ETH_ADDRESS",
      "path": "m/44'/60'/0'/0/0"
    }
  ],
  "balances": {
    "btc": "0",
    "eth": "0",
    "bsc": "0",
    "polygon": "0",
    "nano": "0"
  }
}
```

#### Initialize Wallet
- **POST** `/api/crypto/initialize` - Initialize wallet (auto-initializes on first use anyway)

#### Refresh Balances
- **POST** `/api/crypto/refresh-balances` - Update balance information

#### Transaction History
- **GET** `/api/crypto/transactions` - View transaction history

#### Send Transaction (Placeholder)
- **POST** `/api/crypto/send` - Send transaction (currently a placeholder for phase 2)

Request:
```json
{
  "chain": "eth",
  "toAddress": "0x...",
  "amount": "0.1"
}
```

#### Web3 Authentication
- **GET** `/api/crypto/siwe-message` - Generate Sign-In With Ethereum message
- **POST** `/api/crypto/sign-message` - Sign any message with wallet

Request:
```json
{
  "message": "Hello, Web3!",
  "chain": "eth"
}
```

Response:
```json
{
  "signature": "0xa67da153f6999f22fab7b5b32a66e53c1989a6e3bcb38bc5c4c1c83a4a8e533834c0a25c09a0f2a053c47de357e5d1915b81227c443b4f16e25c5b5dd7411fb71c"
}
```

#### Export Encrypted Seed
- **GET** `/api/crypto/export-seed` - Export encrypted seed phrase for backup

Response:
```json
{
  "success": true,
  "encryptedSeed": "encrypted_seed_data_here"
}
```

#### Nano (XNO) Wallet

Nano is a feeless, instant-settlement cryptocurrency using a block-lattice DAG architecture. All Nano endpoints are mainnet-only.

- **GET** `/api/crypto/nano/balance` - Get Nano balance and address

```bash
curl http://localhost:3000/api/crypto/nano/balance \
  -H "Authorization: Bearer <token>"
```

Response:
```json
{
  "address": "nano_3tapbs5faoktmcdo4uxfdqm7e48bumpbw5ymoebcs4sgja8wqtrur6zphg5q",
  "balance": "0",
  "symbol": "XNO"
}
```

- **GET** `/api/crypto/nano/account-info` - Full account info (frontier, representative, block count)

Response:
```json
{
  "address": "nano_...",
  "opened": true,
  "balance": "1.5",
  "balanceRaw": "1500000000000000000000000000000",
  "representative": "nano_1banexkcfuieufzxksfrxqf6xy8e57ry1zdtq9yn7jntzhpwu4pg4hajojmq",
  "blockCount": "5"
}
```

- **POST** `/api/crypto/nano/send` - Send XNO

Request:
```json
{
  "toAddress": "nano_1abc...",
  "amount": 0.1
}
```

Response:
```json
{
  "success": true,
  "hash": "ABC123...",
  "amount": 0.1,
  "to": "nano_1abc...",
  "from": "nano_3tap..."
}
```

- **POST** `/api/crypto/nano/receive` - Pocket all receivable (pending) blocks

Response:
```json
{
  "success": true,
  "received": 2,
  "blocks": [
    { "hash": "...", "amount": "0.001", "sourceHash": "..." }
  ]
}
```

- **GET** `/api/crypto/nano/receivable` - List pending receivable blocks with amounts

Response:
```json
{
  "address": "nano_...",
  "blocks": [
    { "hash": "...", "amountRaw": "...", "amount": "0.001", "source": "nano_..." }
  ],
  "count": 1
}
```

- **GET** `/api/crypto/nano/status` - Service status (monitor running, RPC endpoints)

Response:
```json
{
  "rpcEndpoints": ["https://rainstorm.city/api", "https://node.somenano.com/proxy", "https://rpc.nano.to"],
  "currentRpc": "https://rainstorm.city/api",
  "monitorRunning": true,
  "monitorAddress": "nano_...",
  "representative": "nano_1banexkcfuieufzxksfrxqf6xy8e57ry1zdtq9yn7jntzhpwu4pg4hajojmq",
  "address": "nano_..."
}
```

### Contract Interaction API

#### Get Supported Networks
- **GET** `/api/contracts/networks`
  ```json
  [
    {
      "id": "ethereum",
      "chainId": 1,
      "rpc": "https://eth.llamarpc.com",
      "explorer": "https://etherscan.io"
    },
    ...
  ]
  ```

#### Get Testnet Tokens
- **GET** `/api/contracts/networks/:network/tokens`
  ```json
  {
    "USDC": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    "LINK": "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    "WETH": "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"
  }
  ```

#### Read Contract Function
- **POST** `/api/contracts/read`
  ```json
  {
    "address": "0x...",
    "network": "ethereum",
    "functionName": "balanceOf",
    "params": ["0x..."]
  }
  ```
  Response includes the function result.

#### Get Token Info
- **GET** `/api/contracts/token/:address?network=ethereum`
  ```json
  {
    "address": "0x...",
    "name": "USD Coin",
    "symbol": "USDC",
    "decimals": 6,
    "totalSupply": "1000000000000",
    "network": "ethereum"
  }
  ```

#### Get Token Balance
- **GET** `/api/contracts/token/:address/balance/:holder?network=ethereum`
  ```json
  {
    "raw": "1000000",
    "formatted": "1.0",
    "decimals": 6
  }
  ```

#### Get Native Balance
- **GET** `/api/contracts/balance/:address?network=ethereum`
  ```json
  {
    "raw": "1000000000000000000",
    "formatted": "1.0",
    "symbol": "ETH",
    "network": "ethereum"
  }
  ```

#### ABI Management
- **GET** `/api/contracts/abi?network=ethereum` - List saved ABIs
- **POST** `/api/contracts/abi` - Save ABI
  ```json
  {
    "address": "0x...",
    "network": "ethereum",
    "abi": [...],
    "name": "My Contract"
  }
  ```
- **GET** `/api/contracts/abi/:address?network=ethereum` - Get specific ABI
- **DELETE** `/api/contracts/abi/:address?network=ethereum` - Delete ABI

### Hardhat Development API

LANAgent provides a complete Hardhat development environment API for creating, compiling, and deploying smart contracts.

#### Service Management
- **POST** `/api/hardhat/init` - Initialize Hardhat service
- **GET** `/api/hardhat/health` - Health check endpoint
  ```json
  {
    "success": true,
    "service": "hardhat",
    "status": "healthy",
    "timestamp": "2026-01-11T12:00:00.000Z"
  }
  ```

#### Project Management
- **GET** `/api/hardhat/projects` - List all Hardhat projects
- **POST** `/api/hardhat/projects` - Create a new project
  ```json
  {
    "name": "my-token",
    "template": "basic"  // Options: basic, erc20, erc721, etc.
  }
  ```
- **GET** `/api/hardhat/projects/:name` - Get project details

#### Contract Development
- **POST** `/api/hardhat/projects/:name/contracts` - Create a contract
  ```json
  {
    "contractName": "MyToken",
    "template": "erc20"
  }
  ```
- **POST** `/api/hardhat/projects/:name/compile` - Compile project

#### Contract Deployment
- **POST** `/api/hardhat/projects/:name/deploy` - Deploy contract

  **Single Network (backward compatible):**
  ```json
  {
    "contractName": "MyToken",
    "constructorArgs": ["My Token", "MTK", 1000000],
    "network": "sepolia"
  }
  ```
  Response:
  ```json
  {
    "success": true,
    "deployment": {
      "network": "sepolia",
      "address": "0x...",
      "transactionHash": "0x..."
    }
  }
  ```

  **Multi-Network Deployment:**
  ```json
  {
    "contractName": "MyToken",
    "constructorArgs": ["My Token", "MTK", 1000000],
    "networks": ["sepolia", "mumbai", "arbitrum-goerli"]
  }
  ```
  Response:
  ```json
  {
    "success": true,
    "deployments": [
      { "network": "sepolia", "success": true, "address": "0x..." },
      { "network": "mumbai", "success": true, "address": "0x..." },
      { "network": "arbitrum-goerli", "success": true, "address": "0x..." }
    ]
  }
  ```

  Features:
  - Automatic retry (3 attempts) with exponential backoff for each network
  - Parallel deployment to multiple networks
  - Individual success/failure tracking per network

#### Testing
- **POST** `/api/hardhat/projects/:name/test` - Run tests
  ```json
  {
    "testFile": "test/MyToken.test.js"  // Optional: specific test file
  }
  ```

#### Templates
- **GET** `/api/hardhat/templates` - Get available contract templates

#### AI Content Detector
- **POST** `/api/plugin` `{plugin:"aiDetector", action:"detectText", text:"..."}` - Detect AI-generated text
- **POST** `/api/plugin` `{plugin:"aiDetector", action:"detectImage", url:"..."}` - Detect AI-generated image (URL, base64, or file path)
- **POST** `/api/plugin` `{plugin:"aiDetector", action:"detectVideo", url:"..."}` - Detect AI-generated video (frame analysis)
- **POST** `/api/plugin` `{plugin:"aiDetector", action:"detectAudio", url:"..."}` - Detect AI-generated audio (transcription + text analysis)
- **POST** `/api/plugin` `{plugin:"aiDetector", action:"detect", ...}` - Auto-detect content type and analyze
- **POST** `/api/plugin` `{plugin:"aiDetector", action:"status"}` - Check detector service health

**Telegram:** `/aidetect` — enter detection mode, then send text/photo/voice/audio/video

**Python microservice:** Runs on port 5100, managed by PM2 as `ai-detector`. Direct endpoints:
- **GET** `http://localhost:5100/health` - Service health and loaded models
- **POST** `http://localhost:5100/detect/text` - `{text: "..."}` - Text detection
- **POST** `http://localhost:5100/detect/image` - Multipart file upload - Image detection
- **POST** `http://localhost:5100/detect/audio` - Multipart file upload - Audio detection

### Background Services

#### Self-Modification Service (Capability Upgrades)
- **GET** `/api/selfmod/status` - Get capability upgrade service status
- **POST** `/api/selfmod/config` - Update capability upgrade configuration
- **POST** `/api/selfmod/toggle` - Enable/disable capability upgrade service
- **POST** `/api/selfmod/analysis-toggle` - Toggle analysis-only mode
- **POST** `/api/selfmod/check` - Manually trigger capability upgrade check
- **GET** `/api/self-modification/upgrade-plans` - Get capability upgrade plans

**Focus:** Upgrades existing capabilities, enhances plugins, improves core functionality
**NOT:** Bug detection (handled by bugDetector), new plugin creation (handled by pluginDevelopment)

#### Plugin Development Service
- **GET** `/api/plugin-dev/status` - Get plugin development status
- **POST** `/api/plugin-dev/config` - Update plugin development configuration
- **POST** `/api/plugin-dev/toggle` - Enable/disable plugin development
- **POST** `/api/plugin-dev/check` - Manually trigger development check

#### Bug Fixing Service
- **GET** `/api/bug-fixing/status` - Get bug fixing service status
- **POST** `/api/bug-fixing/toggle` - Enable/disable bug fixing
- **POST** `/api/bug-fixing/config` - Update bug fixing configuration
- **POST** `/api/bug-fixing/run` - Manually run bug fixing session

### Background Tasks Management

#### Task Monitoring
- **GET** `/api/background/pm2-status` - Get PM2 process status
- **GET** `/api/background/agenda-jobs` - Get scheduled job status
- **GET** `/api/background/recent-logs` - Get recent background task logs
- **POST** `/api/background/trigger-weekly-report` - Manually trigger weekly report

#### Feature Discovery Service
- **Scheduled Job**: Runs twice daily at 9 AM and 9 PM via Agenda scheduler
- **Purpose**: Autonomous feature discovery from similar AI agent projects
- **Key Features**:
  - Analyzes 25+ known AI agent projects (AutoGPT, MetaGPT, Microsoft Autogen, LangChain, etc.)
  - Extracts features from README files, commit messages, and repository structures
  - Searches git repositories for specific implementation patterns
  - Stores discovered features with full repository context and code snippets
  - Automatically filters out already-implemented features
  - Prioritizes discoveries by confidence level (high/medium/low)
- **Database Schema**:
  - Feature requests stored with `submittedBy: "github_discovery_scheduler"`
  - Each feature includes `githubReferences[]` with repository, URL, code snippets
  - Implementation examples stored in `implementationExamples[]`
- **Manual Trigger**: 
  ```bash
  node scripts/trigger-github-discovery.js  # For testing
  ```
- **Cleanup**: Old completed discovery jobs cleaned up after 30 minutes by `cleanup-completed-jobs`
- **Web UI Integration**: 
  - Visible in Background Tasks > Scheduled Jobs
  - Last run timestamp shown in dashboard
  - Discovered features appear in Feature Requests with "Auto-discovered from GitHub" tag

### Email Management

#### Email Operations
- **GET** `/api/emails` - List emails with filtering options
- **POST** `/api/emails/:id/process` - Mark email as processed
- **POST** `/api/emails/refresh` - Check for new emails

#### Email Settings
- **GET** `/api/email/notification-settings` - Get email notification settings
- **POST** `/api/email/notification-settings` - Update email notification settings

### Project Management

#### Project Operations
- **GET** `/api/projects` - List all projects
- **GET** `/api/projects/:id` - Get specific project
- **POST** `/api/projects` - Create new project
- **PUT** `/api/projects/:id` - Update project
- **DELETE** `/api/projects/:id` - Delete project

### Feature Requests

#### Feature Request Management
- **GET** `/api/feature-requests` - List feature requests
- **POST** `/api/feature-requests` - Create new feature request
- **GET** `/api/feature-requests/:id` - Get specific feature request
- **PUT** `/api/feature-requests/:id/status` - Update feature request status
- **DELETE** `/api/feature-requests/:id` - Delete feature request
- **POST** `/api/feature-requests/:id/vote` - Vote on feature request
- **POST** `/api/feature-requests/analyze` - Analyze feature requests
- **GET** `/api/feature-requests/stats` - Get feature request statistics
- **DELETE** `/api/feature-requests/auto-generated` - Clear all auto-generated feature requests
- **POST** `/api/feature-requests/deduplicate` - Remove duplicate feature requests

#### Auto-Approve Settings
- **GET** `/api/feature-requests/settings/auto-approve` - Get auto-approve setting
- **PUT** `/api/feature-requests/settings/auto-approve` - Set auto-approve setting (persists in MongoDB)

When auto-approve is enabled:
- All new feature requests are automatically set to "approved" status
- Existing pending requests are bulk-approved when enabling
- Setting persists across restarts (stored in SystemSettings)

### Voice & TTS

#### Voice Operations
- **GET** `/api/voice/voices` - Get available voices
- **GET** `/api/voice/settings` - Get voice settings
- **POST** `/api/voice/settings` - Update voice settings
- **POST** `/api/voice/test` - Test voice synthesis
- **GET** `/api/voice/audio/:filename` - Serve generated audio files

#### Wake Word Training
- **GET** `/api/voice/wakeword/status` - Get wake word training status and model info
- **POST** `/api/voice/wakeword/start` - Get instructions to start wake word training via Telegram

**Wake Word Training Flow:**
1. Send `/train_wakeword` command in Telegram
2. Record 25 voice messages saying just the wake word (e.g., "Alice")
3. Record 15 voice messages with phrases that DON'T contain the wake word
4. Training runs automatically (~40 epochs, uses your real voice samples)
5. Model is deployed and voice interaction restarts with new model

**Telegram Commands:**
- `/train_wakeword` - Start wake word training sample collection
- `/cancel_training` - Cancel in-progress training
- `/training_status` - Check training status and model info

**Privacy:** Local wake word detection using OpenWakeWord. Audio is only sent to cloud APIs after the wake word is confirmed locally.

#### Voice Interaction (Wake Word Listening)
- **GET** `/api/voice/interaction/status` - Get voice interaction status
- **POST** `/api/voice/interaction/start` - Start wake word listening
- **POST** `/api/voice/interaction/stop` - Stop wake word listening

**Voice Interaction Response:**
```json
{
  "success": true,
  "enabled": true,
  "isListening": true,
  "wakeWord": "alice",
  "audioDevice": "0",
  "config": {
    "wakeWord": "alice",
    "sampleRate": 16000,
    "recordDuration": 5,
    "localWakeWordModel": "/path/to/alice_v0.1.onnx",
    "localWakeWordThreshold": 0.5
  }
}
```

**Features:**
- State persists across server restarts (saved to database)
- Web UI toggle available on Voice settings page
- Automatic audio device detection (prefers eMeet/USB devices)
- Sentence continuation handling for split voice commands
- Incomplete sentence detection with timeout-based completion

### Logs & Monitoring

#### Log Access
- **GET** `/api/logs` - Get application logs
- **GET** `/api/logs/raw` - Get raw PM2 logs or any application log
- **GET** `/api/logs/available` - Get list of all available log files (dynamic)

**📁 Production Log Structure** (`/root/lanagent-deploy/logs/`):
- **`all-activity.log`** - Complete timeline view (human-readable)
- **`errors.log`** - Critical issues only
- **`self-modification.log`** - Self-modification service debugging
- **`bug-detection.log`** - Bug detection and security scanning
- **`diagnostics.log`** - System health checks and API endpoint testing
- **`api-web.log`** - Web interface and API calls
- **`structured.json`** - Machine-readable format for automated analysis

**Note:** The Logs page dynamically displays all available logs (excluding archived/rotated files)

**📖 See [docs/LOGGING.md](../LOGGING.md) for complete debugging guide**

### Tasks

#### Task Management
- **GET** `/api/tasks` - List all tasks
- **POST** `/api/tasks` - Create new task

### Multi-User Support

#### Guest Conversations
- **GET** `/api/conversations/guests` - Get guest conversation statistics

## Specialized Service Routes

### VPN Management (v2.0 — Dual Provider)
**Base**: `/vpn/api/*`

Dual-provider VPN plugin (v2.0): WireGuard for inbound tunnel (api.lanagent.net reverse proxy) + ExpressVPN for outbound privacy (IP hopping, scrape protection). Both run simultaneously; wg0.conf PostUp hooks manage coexistence.

**ExpressVPN (outbound):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/vpn/api/status` | Combined status of both VPN providers (legacy flat fields preserved for backward compat) |
| POST | `/vpn/api/connect` | Connect ExpressVPN (body: `{ "location": "us-den", "protocol": "lightway_udp" }`) |
| POST | `/vpn/api/disconnect` | Disconnect ExpressVPN |
| POST | `/vpn/api/smart-connect` | Smart connect by purpose: `security`, `streaming`, `speed` |
| GET | `/vpn/api/locations` | List available ExpressVPN locations (cached 10 min) |
| POST | `/vpn/api/test` | Test connectivity and speed |
| POST | `/vpn/api/troubleshoot` | Run diagnostics (checks both ExpressVPN + WireGuard) |
| POST | `/vpn/api/auto-connect` | Set auto-connect (body: `{ "enabled": true, "location": "smart" }`) |
| GET | `/vpn/api/public-ip` | Get current public IP |

**WireGuard (inbound tunnel):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/vpn/api/wireguard/status` | Tunnel status: interface up/down, handshake age, transfer, peer ping, healthy flag |
| POST | `/vpn/api/wireguard/bounce` | Restart tunnel (`wg-quick down/up wg0`). PostUp hooks re-add ExpressVPN coexistence rules. |
| POST | `/vpn/api/wireguard/health` | Health check with auto-recovery. Bounces if handshake stale (>180s) or peer unreachable. (body: `{ "maxHandshakeAge": 180 }`) |

**Automated monitoring:**
- `vpn-wireguard-watchdog` Agenda job — every 2 min, checks handshake age + peer ping, auto-bounces if stale. Silent no-op when healthy.
- `netcheck.service` (systemd) — every 30s, monitors ExpressVPN connection state + DNS, auto-recovers via disconnect/reconnect, locks `/etc/resolv.conf` with `chattr +i` to prevent DNS hijacking.

### Firewall Management
**Base**: `/firewall/api/*`
- Firewall status and rule management
- Security preset configuration
- Traffic monitoring
- Scheduled rule changes (`POST /firewall/api/schedule-rule`) — schedule allow/deny/delete rules for a future time via Agenda
- Retry logic on all UFW commands (3 retries) with structured logging

### SSH Management
**Base**: `/ssh/api/*`
- SSH connection management with tagging support
- Key management and authentication
- Session tracking (start/end times, duration, errors)
- Tag filtering: `GET /ssh/api/connections?tags=production`

### Network Shares (Samba)
**Base**: `/samba/api/*`
- Mount and unmount network shares
- Browse available shares
- Connection status monitoring

### Network Security
**Base**: `/network/api/*`
- Network scanning and device discovery
- Security monitoring and alerts
- Connectivity testing

### Development Environment
**Base**: `/devenv/api/*`
- Development environment automation
- Project template management
- Build and deployment workflows

## Plugin System Architecture

LANAgent uses a comprehensive plugin system with 77+ available plugins:

### System & Administration
- **system** - System restart, status, and basic operations
- **systemAdmin** - Advanced system administration and maintenance
- **monitoring** - System monitoring and health checks
- **diagnostics** - Enhanced system diagnostics and API endpoint testing
- **software** - Package management across multiple systems

### Development & DevOps
- **development** - Development planning and feature management
- **devenv** - Development environment automation
- **projects** - Project management and tracking
- **git** - Git operations and GitHub integration
- **docker** - Docker container management
- **bugDetector** - Code analysis and bug detection

### Network & Infrastructure
- **network** - Network utilities and monitoring
- **vpn** - VPN management and automation
- **samba** - Network file sharing

### Communication & Data
- **email** - Email integration and management
- **sinch** - SMS, voice, and verification APIs (send_sms, make_voice_call, verify_number, schedule_sms, schedule_voice_call, list_scheduled, cancel_scheduled)
- **signalwire** - Communication APIs with SMS, multimedia messaging, and templates (sendmessage, sendmultimediamessage, getmessages, schedulemessage, trackmessagestatus, sendtemplatemessage, managetemplates)
- **messagebird** - Global communication API for SMS, MMS, and chat (sendSMS, sendMMS, getBalance)
- **websearch** - Real web search via Anthropic/OpenAI web search, Yahoo Finance stocks, CoinGecko crypto, wttr.in weather, NewsAPI news
- **scraper** - Web scraping and data extraction
- **coingecko** - Cryptocurrency market data and prices
- **chainlink** - Decentralized oracle price feeds and blockchain data
- **news** - News articles and headlines from various sources
- **alphavantage** - Stock market data, forex rates, and financial information
- **ipstack** - IP geolocation and address lookup (getLocation with single IP or ipRange, getOwnLocation, getTimezone, getOwnTimezone, getTimezones batch)
- **weatherstack** - Real-time weather data (getCurrentWeather, getWeatherDescription, getTemperature)
- **numverify** - Phone number validation and carrier lookup (validatePhoneNumber, getCarrierInfo, batchValidatePhoneNumbers, convertPhoneNumberFormat)

### Media & Content
- **ffmpeg** - Audio/video processing
- **ytdlp** - YouTube and media downloading
- **twitter** - Twitter/X integration — read via FxTwitter, post/interact via X API v2
  - `download` - Download tweet media (photos/videos) by URL, returns file for Telegram delivery
  - `extract` - Extract text and metadata from a tweet without downloading media
  - `downloadThread` - Download a full Twitter/X thread starting from a given tweet URL
  - `post` - Post a new tweet (requires X API credentials)
  - `reply` - Reply to a tweet by ID or URL
  - `deleteTweet` - Delete a tweet by ID
  - `like` - Like a tweet by ID or URL
  - `getMe` - Get authenticated user profile
- **voice** - Text-to-speech and voice synthesis
  - `test` - Test voice synthesis with sample text
  - `configureTelegramVoice` - Configure Telegram voice settings (enabled, autoConvert, respondWithVoice)
  - `createVoiceProfile` - Create custom voice profile with name and settings
  - `listVoiceProfiles` - List all available voice profiles

### Hardware & IoT
- **microcontroller** - Arduino and IoT device management
- **deviceInfo** - Comprehensive device detection (USB, network, serial, storage)
- **thingspeak** - IoT platform for data collection, analysis, and visualization
- **eufy** - Eufy security camera integration (setup, devices, snapshot, alerts, status)

### AI & Machine Learning
- **huggingface** - HuggingFace AI inference (13 NLP/vision tasks)
  - `textClassification` - Classify text using a model (supports `customModel` override)
  - `sentimentAnalysis` - Sentiment analysis (positive/negative/neutral)
  - `textSummarization` - Summarize long text
  - `questionAnswering` - Answer questions given a context
  - `translation` - Translate text between languages
  - `fillMask` - Fill in masked words in text
  - `zeroShotClassification` - Classify text into custom categories
  - `featureExtraction` - Get text embeddings/vectors
  - `imageCaption` - Generate captions for images (BLIP model)
  - `namedEntityRecognition` - Extract people, places, organizations from text (BERT NER)
  - `languageDetection` - Detect language of text (XLM-RoBERTa)
  - `textSimilarity` - Compare two texts for semantic similarity (sentence-transformers)
  - `spamDetection` - Classify text as spam or not spam

### Security & Analysis
- **tokenProfiler** - ERC20 token scam/safety analysis via GoPlus Security API
  - `audit` - Full token audit (honeypot, tax, ownership, liquidity, holders, mintable)
  - `honeypotCheck` - Quick honeypot and sell restriction detection
  - `holderAnalysis` - Top holder concentration and distribution
  - `score` - 0-100 safety score with weighted breakdown
- **walletProfiler** - Crypto wallet profiling and risk assessment
  - `profile` - Balance, age, tx count, contract detection, risk flags
  - `tokens` - ERC20 token holdings with on-chain balances
  - `riskScore` - 0-100 risk score (new wallet, scam interaction, high-value flags)
- **contractAudit** - Static Solidity smart contract security analysis
  - `audit` - Full vulnerability scan (critical/high/medium/low/info findings with line numbers)
  - `quickCheck` - Fast critical/high severity check only
  - `explain` - Plain-English contract description (type detection, key functions, modifiers)
- **challengeQuestions** - Bot-filtering challenge questions for registration forms
  - `generateWithAnswers` - Single-shot: returns questions + answers (client verifies)
  - `generate` - Server-side: returns questions + token (answers held server-side)
  - `verify` - Verify answers against a token (70% pass threshold, 3 max attempts)
  - `types` - List available question types and configuration

### Image Processing
- **imageTools** - Sharp-powered image processing pipeline
  - `optimize` - Compress with optional format conversion (webp, avif, jpeg, png) and metadata stripping
  - `resize` - Resize to target dimensions with fit modes (cover, contain, fill, inside, outside)
  - `crop` - Region crop by coordinates, or smart crop (attention/entropy-based center detection)
  - `convert` - Format conversion between png, jpeg, webp, avif, tiff
  - `watermark` - Text watermark with configurable position, opacity, font size, color
  - `metadata` - Get image info (dimensions, format, color space, channels, EXIF, file size)
  - `transform` - Chain up to 10 operations in one call (resize, crop, rotate, flip, flop, sharpen, blur, grayscale, negate, tint, trim, flatten, format, stripMetadata)

### Utilities & Automation
- **tasks** - Task and reminder management
- **backup** - Backup strategy management
- **checkly** - Browser and API monitoring service (get_checks, get_check_details)
- **googlecloudfunctions** - Serverless cloud automation (listFunctions, getFunction, deployFunction)
- **virustotal** - Security scanning integration
- **documentIntelligence** - Document processing and analysis

### ThingSpeak Plugin - IoT Data Platform

Send and retrieve data from ThingSpeak channels for IoT applications.

#### Send Data to Channel
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "thingspeak",
    "action": "sendData",
    "params": {
      "field1": "25.5",
      "field2": "60"
    }
  }'
```

#### Read Channel Data
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "thingspeak",
    "action": "readChannel",
    "params": {
      "channelId": "123456"
    }
  }'
```

#### Bulk Send Data (v2.8.54+)
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "thingspeak",
    "action": "sendBulkData",
    "params": {
      "dataArray": [
        {"field1": "25.5", "field2": "60"},
        {"field1": "25.6", "field2": "61"},
        {"field1": "25.7", "field2": "62"}
      ],
      "options": {
        "accountType": "free",
        "progressCallback": true
      }
    }
  }'
```

#### Bulk Read Channels (v2.8.54+)
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "thingspeak",
    "action": "readBulkChannels",
    "params": {
      "channelIds": ["123456", "789012", "345678"]
    }
  }'
```

#### Get Channel Status
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "thingspeak",
    "action": "getChannelStatus",
    "params": {
      "channelId": "123456"
    }
  }'
```

**Configuration**: Requires `THINGSPEAK_API_KEY` environment variable.

**Features**:
- Rate limiting support (15s for free, 1s for paid accounts)
- Bulk operations with progress tracking
- Input validation and sanitization
- Parallel processing for bulk reads
- Maximum 100 items per bulk operation

## Testing API Routes

Comprehensive testing endpoints are available at `/api/test/*`:

### Complex Feature Testing
- **POST** `/api/test/ai-intent` - Test AI intent detection
- **POST** `/api/test/memory` - Test memory system operations
- **POST** `/api/test/self-modification` - Test self-modification system
- **POST** `/api/test/providers` - Test AI provider management

### Plugin Testing
- **GET** `/api/test/plugins` - List all plugins
- **POST** `/api/test/plugin/:name` - Test specific plugin
- **POST** `/api/test/plugin/:name/toggle` - Enable/disable plugin for testing

### Service Testing
- **POST** `/api/test/email` - Test email functionality
- **POST** `/api/test/tasks` - Test task management
- **POST** `/api/test/git` - Test git operations
- **POST** `/api/test/websearch` - Test web search
- **POST** `/api/test/workflow` - Test complete workflows

### Background Service Testing
- **GET** `/api/test/scheduler` - Test scheduler status
- **POST** `/api/test/bug-fixing` - Test bug fixing service
- **POST** `/api/test/plugin-development` - Test plugin development

### Health Monitoring
- **GET** `/api/test/health` - Comprehensive system health check

## Plugin Route Pattern

Most plugins support direct HTTP routes following the pattern:
```
/api/:pluginName/*
```

For example:
- `/api/email/contacts` - Email plugin contact management
- `/api/git/repositories` - Git plugin repository operations
- `/api/network/scan` - Network plugin scanning operations

## WebSocket Support

Real-time communication is available via WebSocket connection:

### Connection
```javascript
const socket = io('http://localhost:80', {
  auth: { token: 'your_jwt_token' }
});
```

### Events
- **execute** - Execute commands in real-time
- **approve** - Approve system operations
- **status** - Receive periodic status updates


### Music Library

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/music-library/config` | GET | Token/Key | Get configured music source path |
| `/api/music-library/config` | PUT | Token/Key | Set music source path (local, SMB URL, HTTP URL) |
| `/api/music-library/browse` | GET | Token/Key | Browse music directory (paginated, folder navigation) |
| `/api/music-library/browse?subdir=Rock&limit=200&offset=0` | GET | Token/Key | Browse subdirectory with pagination |
| `/api/music-library/search?q=dubstep` | GET | Token/Key | Search music library by filename |
| `/api/music-library/save` | POST | Token/Key | Download audio (via yt-dlp) to music library |
| `/api/music-library/stream/*` | GET | Token/Query | Stream audio file with Range support |
| `/api/music-library/browse-local?path=/mnt` | GET | Token/Key | Browse agent filesystem for directory selection |
| `/api/music-library/samba-mounts` | GET | Token/Key | List saved Samba connections |
| `/api/music-library/ssh-connections` | GET | Token/Key | List saved SSH connections |
| `/api/music-library/browse-ssh` | POST | Token/Key | Browse directory on remote SSH server |
| `/api/music-library/mount-smb` | POST | Token/Key | Mount an SMB share and return mount point |

#### Music Library Config
```json
PUT /api/music-library/config
{
  "sourcePath": "/mnt/nas/music"  // or "smb://server/share/path"
}
// Response: { "success": true, "sourcePath": "/mnt/music-server-share/path" }
```

#### Music Library Search
```json
GET /api/music-library/search?q=daft+punk&limit=50
// Response: { "success": true, "results": [{ "name": "Daft Punk - Around The World.mp3", "path": "Electronic/Daft Punk - Around The World.mp3" }], "total": 3 }
```

#### Save to Music Library
```json
POST /api/music-library/save
{
  "query": "Never Gonna Give You Up"  // or "url": "https://youtube.com/..."
}
// Response: { "success": true, "message": "Saved to music library: Never_Gonna_Give_You_Up.mp3", "path": "/mnt/nas/music/Never_Gonna_Give_You_Up.mp3" }
```


## Error Handling

All API responses follow a consistent format:

### Success Response
```json
{
  "success": true,
  "data": "response_data"
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error description"
}
```

## Rate Limiting & Security

- JWT authentication required for all endpoints
- CORS enabled for development
- Request rate limiting via express-rate-limit
- Helmet security headers
- Input validation and sanitization

## Environment Configuration

Key environment variables:
- `WEB_PORT` / `AGENT_PORT` - API server port (default: 80)
- `WEB_PASSWORD` - Login password (default: "lanagent")
- `TELEGRAM_USER_ID` - Master Telegram user ID
- `EMAIL_OF_MASTER` - Master email address
- `GMAIL_USER` - Gmail integration

## API Response Formats

### Pagination
Some endpoints support pagination via query parameters:
```
?limit=50&offset=100&sort=newest
```

### Filtering
Many endpoints support filtering:
```
?category=all&search=query&type=specific_type
```

### Date Ranges
Date filtering available on relevant endpoints:
```
?date=2024-01-01&startDate=2024-01-01&endDate=2024-01-31
```

## 🤖 AI-Powered Bug Detection

LANAgent includes an advanced AI-powered bug detection system that automatically scans your codebase to identify security vulnerabilities, code quality issues, and potential bugs.

### Features

- **🧠 AI-Powered Analysis**: Uses large language models for intelligent code analysis
- **🔍 Provider Agnostic**: Works with any configured AI provider (OpenAI, Anthropic, HuggingFace, Gab)
- **📊 Incremental Scanning**: Intelligent chunking and progressive file processing
- **🎯 Smart Categorization**: Automatically categorizes bugs by severity and type
- **🔗 Git Hosting Integration**: Automatically creates issues on GitHub or GitLab
- **💾 MongoDB Tracking**: Persistent scan progress and results storage

### Bug Detection Actions

#### Start Incremental Scan
Performs AI-powered analysis of your codebase with intelligent chunking and automatic GitHub issue creation:

```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "bugDetector",
    "action": "scanIncremental",
    "limit": 5,
    "autoCreateGitHubIssues": true,
    "autoStoreBugs": true
  }'
```

**Parameters:**
- `limit` (optional): Maximum number of bugs to return (default: 5)
- `autoCreateGitHubIssues` (optional): Automatically create GitHub issues (default: true)
- `autoStoreBugs` (optional): Store bugs in database (default: true)
- `scanPath` (optional): Specific path to scan (default: uses settings)
- `exclude` (optional): Paths to exclude from scan

**Response:**
```json
{
  "success": true,
  "scanId": "scan_1766557110880_3f101e7b",
  "totalFiles": 5,
  "bugsFound": 3,
  "scannedFiles": 7,
  "originalBugCount": 21,
  "summary": {
    "totalBugs": 21,
    "critical": 0,
    "high": 8,
    "medium": 13,
    "low": 0
  }
}
```

**Features:**
- 🧠 **AI-Powered Analysis**: Uses advanced LLMs to detect security vulnerabilities and code quality issues
- 🔄 **Incremental Processing**: Intelligently chunks large files and tracks progress in MongoDB
- 🚀 **Automatic Issue Creation**: Creates detailed issues on GitHub/GitLab with fix suggestions
- 🛡️ **Anti-Spam Protection**: Limits bugs per scan to prevent database spam
- 📊 **Progress Tracking**: Full scan history and file processing status
- 🎯 **Smart Prioritization**: Returns most critical bugs first

#### Test AI Analysis
Test AI bug detection on code snippets:

```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "bugDetector",
    "action": "testAI",
    "testCode": "function test() {\n  console.log(\"debug\");\n  let password = \"hardcoded123\";\n}"
  }'
```

#### List Detected Bugs
Retrieve all bugs found by the AI system:

```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "bugDetector",
    "action": "listBugs"
  }'
```

#### Create GitHub Issue
Automatically create GitHub issues from detected bugs:

```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "bugDetector",
    "action": "createGitHubIssue",
    "bugId": "bug_1766557110880_abc123"
  }'
```

#### Get Scan Progress
Monitor the real-time progress of an active bug scan:

```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "bugDetector",
    "action": "getScanProgress"
  }'
```

**Response:**
```json
{
  "success": true,
  "result": {
    "isScanning": true,
    "currentScanId": "scan_1766557110880_3f101e7b",
    "progress": {
      "filesScanned": 12,
      "totalFiles": 45,
      "percentage": 26.67,
      "currentFile": "/src/api/plugins/bugDetector.js",
      "bugsFoundSoFar": 3
    },
    "startTime": "2026-01-02T12:30:00Z",
    "estimatedTimeRemaining": "2 minutes"
  }
}
```

When no scan is active:
```json
{
  "success": true,
  "result": {
    "isScanning": false,
    "lastScan": {
      "scanId": "scan_1766557110880_3f101e7b",
      "completedAt": "2026-01-02T12:00:00Z",
      "filesScanned": 45,
      "bugsFound": 8
    }
  }
}
```

### Bug Categories

The AI system automatically categorizes bugs into these types:

- **🚨 Security Vulnerabilities** (Critical): Hardcoded credentials, SQL injection, XSS
- **⚠️ Error Handling Issues** (High): Missing try-catch, unhandled promises
- **💾 Resource Management** (High): Memory leaks, unclosed connections
- **📝 Code Quality Issues** (Medium): Deprecated APIs, inefficient patterns
- **🐛 Logic Errors** (Medium-High): Null/undefined access, incorrect comparisons
- **📊 Logging Issues** (Low): Console.log in production, missing logging

### Configuration

The system scans the following directories by default:
- `/root/lanagent-repo/src` - Source code files
- `/root/lanagent-repo/docs` - Documentation files

**Supported File Types:** `.js`, `.ts`, `.jsx`, `.tsx`, `.mjs`

### Intelligent Features

- **Code-Aware Chunking**: Splits large files at logical boundaries (functions, classes)
- **Context Limit Handling**: Automatically adapts to AI provider context limits
- **Duplicate Detection**: Prevents duplicate bug reports
- **Progress Tracking**: MongoDB-based scan progress persistence
- **Error Recovery**: Graceful handling of timeouts and failures

### MongoDB Data Models

#### ScanProgress Collection
Tracks incremental scan progress for each file/chunk:

```javascript
{
  scanId: "scan_1766557110880_3f101e7b_file_chunk_1",
  sessionScanId: "scan_1766557110880_3f101e7b",
  filePath: "/root/lanagent-repo/src/api/core/apiManager.js",
  relativePath: "../lanagent-repo/src/api/core/apiManager.js",
  isChunked: true,
  chunkIndex: 1,
  totalChunks: 2,
  chunkStartLine: 1,
  chunkEndLine: 392,
  fileSize: 10364,
  lineCount: 397,
  status: "completed",
  aiProvider: "huggingface",
  aiModel: "default",
  contextLimit: 8000,
  bugsFound: 4,
  bugIds: ["bug_1766557110880_abc123", ...],
  processingTime: 4112,
  startedAt: "2025-12-24T16:10:48.182Z",
  completedAt: "2025-12-24T16:10:52.295Z"
}
```

#### Benefits
- **Resumable Scans**: Can resume interrupted scans from last checkpoint
- **Performance Metrics**: Track processing times and AI provider performance
- **Audit Trail**: Complete history of what was scanned when
- **Debugging**: Detailed logs of chunk processing and bug detection

### Example GitHub Issue Output

The AI generates detailed GitHub issues with:
- **Severity Assessment**: Critical, High, Medium, Low
- **Code Context**: Exact file, line number, and surrounding code
- **Fix Recommendations**: Specific suggestions for resolution
- **Risk Analysis**: Impact and likelihood assessment
- **Example Fixes**: Before/after code examples

This AI-powered system transforms manual code review into an automated, intelligent process that identifies real issues while avoiding false positives.

### deviceInfo Plugin - Comprehensive Device Detection

The deviceInfo plugin provides complete visibility into all connected devices and peripherals.

#### List All Connected Devices
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "deviceInfo",
    "action": "list"
  }'
```

**Response includes:**
- **Network Devices**: All devices on local network with IP, MAC address, and status
- **USB Devices**: Connected USB peripherals with manufacturer information
- **Serial Devices**: Arduino, ESP32, ESP8266 and other microcontrollers
- **Storage Devices**: All mounted and unmounted storage devices
- **Android Devices**: Connected Android devices (when ADB is installed)

#### Detect Arduino/ESP Devices
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "deviceInfo",
    "action": "detectArduino"
  }'
```

#### Natural Language Support
The agent understands device queries naturally:
- "Which devices are connected to you?"
- "Can you tell what devices are connected?"
- "Show me all connected devices"
- "List USB devices"

All these queries are automatically routed to the deviceInfo plugin via intent 43.

### Diagnostics Plugin - Enhanced System Health Monitoring

The diagnostics plugin provides comprehensive health monitoring with API endpoint testing, system resource checks, and service status verification.

#### Run Full System Diagnostics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "run"
  }'
```

#### Get Current Health Status
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "status"
  }'
```

#### View Diagnostic History
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "history",
    "limit": 10
  }'
```

#### Get Specific Report
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "report",
    "reportId": "REPORT_ID_HERE"
  }'
```

#### Test Specific Component
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "test",
    "component": "api"
  }'
```

#### Schedule Automatic Diagnostics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "schedule",
    "interval": "1 hour"
  }'
```

#### View Scheduled Diagnostics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "view-schedule"
  }'
```

#### Cancel Scheduled Diagnostics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "diagnostics",
    "action": "cancel-schedule"
  }'
```

#### Available Actions:
- **run** - Execute full system diagnostics
- **status** - Get latest health status summary
- **history** - View diagnostic run history
- **report** - Get detailed report by ID
- **test** - Test specific component (api, database, telegram, web, plugins, resources, process, services)
- **schedule** - Schedule automatic diagnostics at specified interval (e.g., "1 hour", "30 minutes")
- **view-schedule** - View all scheduled diagnostic jobs
- **cancel-schedule** - Cancel all scheduled diagnostic jobs

#### Features:
- **Scheduled Execution**: Runs automatically every 6 hours via Agenda, plus on-demand scheduling via plugin commands
- **API Endpoint Testing**: Tests critical API endpoints with response validation
- **System Resource Monitoring**: CPU, memory, disk usage with thresholds
- **Service Health Checks**: Database, interfaces, background services
- **Auto-Generated API Key**: Creates secure key for self-testing
- **Startup Delay**: 10-minute delay prevents false alerts during initialization
- **Persistent History**: All reports stored in MongoDB for trend analysis
- **Critical Alerts**: Telegram notifications for critical issues

#### Natural Language Examples:
- "Run system diagnostics"
- "Check system health"
- "Test the API endpoints"
- "Show diagnostic history"
- "What's the system status?"
- "Schedule diagnostics every 2 hours"
- "View scheduled diagnostics"
- "Cancel scheduled diagnostics"

### Agent Stats Plugin - System Statistics and Error Monitoring

The Agent Stats plugin provides comprehensive statistics about the agent's operation, including improvement tracking, runtime error monitoring, and system health metrics.

#### Get Overall Statistics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "agentstats",
    "action": "stats",
    "type": "all"
  }'
```

#### Get Runtime Error Statistics
Monitor errors detected by the automated log scanner:
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "agentstats",
    "action": "errors",
    "type": "recent"
  }'
```

**Response includes:**
- Scanner status (active/stopped)
- Total errors detected across all logs
- Errors by severity (critical/high/medium/low)
- Recent errors with context
- Top error-producing files
- Error trends over time

#### Compare Statistics (Current vs Previous Period)
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "agentstats",
    "action": "compare",
    "days": 14
  }'
```

**Response includes:**
- Current vs previous period improvement totals with percentage change
- Merged count comparison
- Average improvements per day
- Trend direction (improving/declining/stable)
- Current error counts (since startup, last 24h, last hour)

#### Natural Language Examples:
- "Show me runtime errors"
- "Get error statistics"
- "Check error scanner status"
- "Show recent errors"
- "Compare stats for the last 7 days"
- "How are improvements trending?"
- "What errors have been detected?"

### Chainlink Plugin - Decentralized Oracle Price Feeds

The Chainlink plugin provides access to decentralized price feeds across 7 networks (Ethereum, BSC, Arbitrum, Polygon, Optimism, Base + testnets) with ~97 verified oracle feeds. Tokens without Chainlink feeds fall back to CoinGecko (centralized API) — fallback responses are clearly labeled and **free** (credits auto-refunded).

#### External API (via generic plugin proxy)
```bash
# Chainlink price (1 credit)
curl -X POST https://api.lanagent.net/service/chainlink/price \
  -H "X-API-Key: gsk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"pair": "ETH", "network": "ethereum"}'
# → { "success": true, "data": { "pair": "ETH/USD", "price": 1998.13,
#      "network": "ethereum", "feedAddress": "0x5f4eC3...", "roundId": "...",
#      "timestamp": "2026-03-29T16:30:45Z", "age": "7 seconds", "decimals": 8 },
#    "creditsCharged": 1, "creditsRefunded": 0 }

# CoinGecko fallback (free — auto-refunded)
curl -X POST https://api.lanagent.net/service/chainlink/price \
  -H "X-API-Key: gsk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"pair": "FLOKI"}'
# → { "success": true, "data": { "pair": "FLOKI/USD", "price": 0.00002728,
#      "source": "coingecko",
#      "sourceNote": "Fallback — no Chainlink decentralized oracle feed exists...",
#      "coinGeckoId": "floki", "marketCap": 263436859, "volume24h": 15032678,
#      "change24h": -3.62, "network": null, "feedAddress": null },
#    "creditsCharged": 0, "creditsRefunded": 1 }

# List all feeds
curl -X POST https://api.lanagent.net/service/chainlink/feeds \
  -H "X-API-Key: gsk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"network": "all"}'
# → { "feeds": { "ethereum": ["ETH/USD","BTC/USD",...], "bsc": [...], ... }, "totalFeeds": 97 }

# Historical price by round ID
curl -X POST https://api.lanagent.net/service/chainlink/historical \
  -H "X-API-Key: gsk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"pair": "BTC", "roundId": "55340232221129480559"}'

# Compare Chainlink vs CoinGecko
curl -X POST https://api.lanagent.net/service/chainlink/compare \
  -H "X-API-Key: gsk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"pair": "ETH"}'

# Feed info (contract, version, decimals)
curl -X POST https://api.lanagent.net/service/chainlink/info \
  -H "X-API-Key: gsk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"pair": "BTC", "network": "bsc"}'
```

#### Dedicated Gateway Price Routes (alternative)
```bash
GET /price/BTC                         # Current price
GET /price/ETH?network=ethereum        # Specific network
GET /price/feeds                       # List feeds (default BSC)
GET /price/feeds?network=all           # All networks
GET /price/BTC/info                    # Feed metadata
GET /price/ETH/history?roundId=...     # Historical
POST /price/compare  {"pair":"ETH"}    # Compare sources
```

#### Available Actions:
- **price** - Get current price (Chainlink primary, CoinGecko fallback). Accepts: `pair` (required), `network` (optional). Pair can be `BTC`, `btc`, `BTC/USD`, etc.
- **feeds** - List available price feeds. Accepts: `network` (optional, default BSC, use `all` for all networks)
- **historical** - Historical price by round ID. Accepts: `pair`, `roundId` (both required), `network` (optional)
- **compare** - Compare Chainlink oracle price with CoinGecko. Accepts: `pair` (required), `network` (optional)
- **info** - Feed metadata (contract address, version, decimals, latest price). Accepts: `pair` (required), `network` (optional)
- **faucet** - LINK token faucet info (testnets only, not offered as service)
- **balance** - LINK token balance check (not offered as service)

#### Pricing:
- **Chainlink feeds:** 1 credit per request
- **CoinGecko fallback:** Free (auto-refunded). Check `data.source` field — `"chainlink"` = oracle, `"coingecko"` = centralized fallback

#### Response Fields:
| Field | Type | Description |
|-------|------|-------------|
| `data.pair` | string | Normalized pair (e.g., `"BTC/USD"`) |
| `data.price` | number | Current price in USD |
| `data.source` | string | `"chainlink"` or `"coingecko"` (only present on fallback) |
| `data.sourceNote` | string | Explanation when using fallback |
| `data.network` | string | Blockchain network (null for CoinGecko) |
| `data.feedAddress` | string | Oracle contract address (null for CoinGecko) |
| `data.roundId` | string | Chainlink round ID (for historical lookups) |
| `data.timestamp` | string | Last update time (ISO 8601) |
| `data.age` | string | Human-readable age (e.g., "7 seconds") |
| `data.ageSeconds` | number | Price age in seconds (for programmatic staleness checks) |
| `data.stale` | boolean | `true` if price is >10 minutes old or ≤ 0 — consumers should treat stale prices with caution |
| `data.decimals` | number | Oracle precision (null for CoinGecko) |
| `data.marketCap` | number | Market cap (CoinGecko fallback only) |
| `data.volume24h` | number | 24h volume (CoinGecko fallback only) |
| `data.change24h` | number | 24h price change % (CoinGecko fallback only) |

#### Auto-Discovery:
If a pair is not available on the requested network, the plugin automatically searches across all mainnet networks (Ethereum → BSC → Arbitrum → Polygon → Optimism → Base). If no Chainlink feed exists anywhere, it falls back to CoinGecko.

#### Natural Language Examples:
- "Get ETH price from chainlink"
- "List chainlink price feeds on polygon"
- "Compare chainlink and coingecko prices for bitcoin"
- "Check chainlink oracle info for ETH/USD on ethereum"

### WebSearch Plugin - Real Web Search (v2.0)

The WebSearch plugin provides real web search using AI providers with built-in search capabilities (Anthropic Claude, OpenAI), plus direct API integrations for stocks, crypto, weather, and news. **No additional API keys required** for the core search — it uses the agent's existing AI providers.

**Endpoint:** `POST /service/websearch/:action`

#### Available Actions (2 credits each):

| Action | Description | Required Params | Data Source |
|--------|-------------|-----------------|-------------|
| `search` | Web search with real results | `query`, optional `provider` | Anthropic or OpenAI web search |
| `stock` | Current stock price | `symbol` | Yahoo Finance |
| `crypto` | Cryptocurrency price | `symbol` | CoinGecko |
| `weather` | Current weather | `location` | wttr.in |
| `news` | News articles | `query` | NewsAPI |

#### Examples:

```bash
# Web Search (uses Anthropic by default, or specify provider)
curl -X POST https://api.lanagent.net/service/websearch/search \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"query": "latest SpaceX launch 2026"}'
# → { "success": true, "result": "As of March 29, 2026...", "source": "anthropic_web_search" }

# Specify OpenAI as the search provider
curl -X POST https://api.lanagent.net/service/websearch/search \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"query": "AI news today", "provider": "openai"}'
# → { "success": true, "result": "...", "source": "openai_web_search" }

# Stock Price (Yahoo Finance — no API key needed)
curl -X POST https://api.lanagent.net/service/websearch/stock \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"symbol": "AAPL"}'
# → { "success": true, "result": "AAPL (Apple Inc.)\nPrice: $178.52\nChange: +1.23 (+0.69%)" }

# Crypto Price (CoinGecko)
curl -X POST https://api.lanagent.net/service/websearch/crypto \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"symbol": "ETH"}'
# → { "success": true, "result": "ETH Price: $1,998.13\n24h Change: -2.15%" }

# Weather (wttr.in — real weather data)
curl -X POST https://api.lanagent.net/service/websearch/weather \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"location": "Tokyo"}'
# → { "success": true, "result": "Weather for Tokyo, Japan:\nSunny, 18°C / 64°F...",
#      "data": { "temperature": {...}, "condition": "Sunny", "humidity": 45 }, "source": "wttr.in" }

# News (requires NEWS_API_KEY on agent)
curl -X POST https://api.lanagent.net/service/websearch/news \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"query": "artificial intelligence"}'
```

#### Provider Selection:
- `"provider": "anthropic"` — Uses Claude's built-in web search (default, best quality)
- `"provider": "openai"` — Uses OpenAI's web search tool
- If the preferred provider is not available, automatically falls back to the other

### HuggingFace Plugin - AI Inference (v2.0)

The HuggingFace plugin provides access to AI inference models for NLP tasks via the HuggingFace Inference API. 8 actions available as paid services at 10 credits each ($0.10).

**Endpoint:** `POST /service/huggingface/:action`

#### Available Actions (all offered as service, 10 credits):

| Action | Description | Required Params | Default Model |
|--------|-------------|-----------------|---------------|
| `textClassification` | Classify text into categories | `inputs` | distilbert-base-uncased-finetuned-sst-2-english |
| `sentimentAnalysis` | Positive/negative sentiment | `inputs` | (same as textClassification) |
| `textSummarization` | Summarize long text | `inputs` | facebook/bart-large-cnn |
| `questionAnswering` | Answer question from context | `question`, `context` | deepset/roberta-base-squad2 |
| `translation` | Translate text (default EN→FR) | `inputs` | Helsinki-NLP/opus-mt-en-fr |
| `fillMask` | Predict masked words | `inputs` (with `[MASK]`) | google-bert/bert-base-uncased |
| `zeroShotClassification` | Classify into custom labels | `inputs`, `candidate_labels` | facebook/bart-large-mnli |
| `featureExtraction` | Text similarity/embeddings | `inputs` | thenlper/gte-small |

**Not available:** `textGeneration` (requires HuggingFace Pro — free tier no longer supports text generation models). `listModels` (search Hub, not offered as service).

#### Examples:

```bash
# Sentiment Analysis
curl -X POST https://api.lanagent.net/service/huggingface/sentimentAnalysis \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "I absolutely love this product!"}'
# → { "success": true, "result": "POSITIVE: 100.0%",
#      "data": [[{"label":"POSITIVE","score":0.9999},...]], "model": "distilbert/...",
#      "creditsCharged": 10 }

# Text Summarization
curl -X POST https://api.lanagent.net/service/huggingface/textSummarization \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "Long article text here..."}'
# → { "success": true, "result": "Summarized text...", "model": "facebook/bart-large-cnn" }

# Question Answering
curl -X POST https://api.lanagent.net/service/huggingface/questionAnswering \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"question": "When was it built?", "context": "The Eiffel Tower was built from 1887 to 1889."}'
# → { "success": true, "result": "Answer: 1887 to 1889 (confidence: 67.4%)" }

# Translation (EN→FR default, specify model for other languages)
curl -X POST https://api.lanagent.net/service/huggingface/translation \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "Good morning, how are you?"}'
# → { "success": true, "result": "Bonjour, comment allez-vous ?" }
# Other language models: Helsinki-NLP/opus-mt-en-de, Helsinki-NLP/opus-mt-en-es,
# Helsinki-NLP/opus-mt-en-zh, Helsinki-NLP/opus-mt-fr-en, etc.

# Fill Mask
curl -X POST https://api.lanagent.net/service/huggingface/fillMask \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "Paris is the [MASK] of France."}'
# → { "success": true, "result": "capital: 99.7%, heart: 0.1%, center: 0.0%..." }

# Zero-Shot Classification (custom categories, no training needed)
curl -X POST https://api.lanagent.net/service/huggingface/zeroShotClassification \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "I need a new phone", "candidate_labels": ["shopping", "travel", "food"]}'
# → { "success": true, "result": "Classification: shopping (71.8%)" }

# Feature Extraction / Similarity
curl -X POST https://api.lanagent.net/service/huggingface/featureExtraction \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "Hello world"}'
# → { "success": true, "result": "Similarity scores: 1.0000" }
```

#### Custom Models:

All actions accept an optional `model` parameter to use any compatible model from the HuggingFace Hub:
```bash
# Use a specific model for classification
curl -X POST https://api.lanagent.net/service/huggingface/textClassification \
  -H 'X-API-Key: gsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"inputs": "Great movie!", "model": "cardiffnlp/twitter-roberta-base-sentiment-latest"}'
```

#### Response Format:

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the inference succeeded |
| `result` | string | Human-readable result summary |
| `data` | object/array | Raw model output |
| `model` | string | Model used for inference |
| `task` | string | Task type (e.g., "textClassification") |
| `creditsCharged` | number | Credits charged (10) |

#### Notes:
- Models may take 10-30 seconds to cold-start (first request). Subsequent requests are faster.
- If a model is loading, the API automatically waits and retries once.
- Default models are chosen for reliability on the free HuggingFace inference tier.

### CoinGecko Plugin - Cryptocurrency Market Data

The CoinGecko plugin provides comprehensive cryptocurrency market data, prices, and analytics.

#### Get Cryptocurrency Price
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "coingecko",
    "action": "price",
    "params": {
      "coinId": "bitcoin",
      "vs_currency": "usd"
    }
  }'
```

#### Available Actions:
- **price** - Get current price with market cap and 24h change
- **marketData** - Get detailed market data including ATH/ATL
- **trending** - Get trending cryptocurrencies
- **search** - Search for cryptocurrency by name
- **exchanges** - List top exchanges by volume
- **global** - Get global cryptocurrency market data

#### Natural Language Examples:
- "What's the bitcoin price?"
- "Show me trending cryptocurrencies"
- "Get ethereum market data"
- "Search for dogecoin"

**Note**: Set `COINGECKO_API_KEY` environment variable for higher rate limits (optional).

### News API Plugin - News Articles and Headlines

The News API plugin provides access to news articles from thousands of sources worldwide.

#### Get Top Headlines
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "news",
    "action": "headlines",
    "params": {
      "category": "technology",
      "country": "us"
    }
  }'
```

#### Set User Preferences
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "news",
    "action": "setPreferences",
    "params": {
      "categories": ["technology", "science", "business"],
      "userId": "user123"
    }
  }'
```

#### Get Personalized News
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "news",
    "action": "getPersonalizedNews",
    "params": {
      "userId": "user123",
      "country": "us"
    }
  }'
```

#### Available Actions:
- **headlines** - Get top headlines by category/country
- **everything** - Search all articles with advanced filtering
- **sources** - Get available news sources
- **setPreferences** - Set user's preferred news categories
- **getPreferences** - Get current user preferences
- **getPersonalizedNews** - Get news based on user preferences

#### Categories:
- business, entertainment, general, health, science, sports, technology

#### Natural Language Examples:
- "Show me the latest technology news"
- "Get headlines from the US"
- "Search for news about AI"
- "What are the top news sources?"
- "Set my news preferences to technology and science"
- "Show me personalized news based on my preferences"

**Required**: Set `NEWS_API_KEY` or `NEWSAPI_KEY` environment variable.

### Alpha Vantage Plugin - Stock Market Data

The Alpha Vantage plugin provides real-time and historical stock market data, forex rates, and company information.

#### Get Stock Quote
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "alphavantage",
    "action": "quote",
    "params": {
      "symbol": "AAPL"
    }
  }'
```

#### Available Actions:
- **quote** - Get real-time stock quote
- **daily** - Get daily time series data
- **search** - Search for stock symbols
- **overview** - Get company overview and fundamentals
- **forex** - Get foreign exchange rates
- **crypto** - Get cryptocurrency exchange rates

#### Natural Language Examples:
- "What's the AAPL stock price?"
- "Get Microsoft company overview"
- "Show EUR to USD exchange rate"
- "Search for Tesla stock"
- "Get daily data for Amazon"

**Required**: Set `ALPHA_VANTAGE_API_KEY` or `ALPHAVANTAGE_API_KEY` environment variable.

### API Keys Plugin - Programmatic Key Management

The apikeys plugin allows the agent to create and manage API keys programmatically.

#### Create API Key
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "apikeys",
    "action": "create",
    "params": {
      "name": "My Application",
      "description": "External app integration"
    }
  }'
```

#### List API Keys
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "apikeys",
    "action": "list"
  }'
```

#### Revoke API Key
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "apikeys",
    "action": "revoke",
    "params": {
      "id": "key_id_here"
    }
  }'
```

#### Set Usage Alert
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "apikeys",
    "action": "setAlert",
    "params": {
      "id": "key_id_here",
      "limit": 5000,
      "email": "admin@example.com"
    }
  }'
```

#### Available Actions:
- **create** - Generate a new API key
- **list** - List all API keys with metadata
- **revoke** - Revoke an API key (permanent)
- **suspend** - Temporarily disable a key
- **setAlert** - Configure usage alerts for a key
- **reactivate** - Re-enable a suspended key
- **delete** - Permanently delete a key

#### Using Generated API Keys:
Once you create an API key using this plugin, you can use it in your requests:

```bash
# Option 1: X-API-Key header (recommended)
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: la_your_generated_key_here" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "system", "action": "status"}'

# Option 2: Authorization header with ApiKey prefix
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: ApiKey la_your_generated_key_here" \
  -H "Content-Type: application/json" \
  -d '{"plugin": "system", "action": "status"}'
```

**Important**: Save the API key when created - it's only shown once! All keys start with `la_` prefix.

#### Natural Language Examples:
- "Create a new API key for my app"
- "Show me all API keys"
- "Revoke the API key with ID xyz"
- "Suspend the debug key temporarily"

### Email Plugin - Complete Email Management with Scheduling

The email plugin provides comprehensive email integration with Gmail, including scheduling and recurring email capabilities.

#### Send Email
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "send",
    "params": {
      "to": "user@example.com",
      "subject": "Hello",
      "html": "<p>Message content</p>",
      "attachments": []
    }
  }'
```

#### Send Email with AI (Enhanced in v2.8.59)
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "sendWithAI",
    "params": {
      "to": "user@example.com",
      "prompt": "Write an email about the latest cryptocurrency prices",
      "subject": "Crypto Market Update",
      "enableWebSearch": true,
      "searchQuery": "bitcoin ethereum price today"
    }
  }'
```

**New Features:**
- Automatic web search for current information when keywords detected
- Formal business email composition with multiple paragraphs
- Keywords that trigger search: latest, current, news, weather, stock, etc.
- Optional `enableWebSearch` (default: true) and `searchQuery` parameters

#### Schedule Email for Future Delivery
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "schedule",
    "params": {
      "to": "user@example.com",
      "subject": "Meeting Reminder",
      "html": "<p>Don't forget our meeting tomorrow!</p>",
      "sendAt": "2025-01-15T10:00:00"
    }
  }'
```

#### List Scheduled Emails
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "listScheduled"
  }'
```

#### Cancel Scheduled Email
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "cancelScheduled",
    "params": {
      "jobId": "job_id_from_list"
    }
  }'
```

#### Schedule Recurring Email
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "scheduleRecurring",
    "params": {
      "to": "team@example.com",
      "subject": "Weekly Status Report",
      "html": "<p>This is your weekly reminder to submit status reports.</p>",
      "recurrence": "weekly"
    }
  }'
```

#### Recurrence Options:
- **Human-readable**: `"daily"`, `"weekly"`, `"monthly"`, `"yearly"`
- **Time intervals**: `"5 minutes"`, `"2 hours"`, `"3 days"`, `"1 week"`
- **Cron expressions**: `"0 9 * * 1"` (every Monday at 9 AM)
- **Custom patterns**: Any valid cron expression for complex schedules

#### List Recurring Emails
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "listRecurring"
  }'
```

#### Cancel Recurring Email
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "email",
    "action": "cancelRecurring",
    "params": {
      "jobId": "recurring_job_id"
    }
  }'
```

#### Other Email Actions:
- **check** - Check for new emails in inbox
- **search** - Search emails with advanced queries
- **reply** - Reply to an email
- **forward** - Forward an email
- **delete** - Delete an email
- **getFolder** - Get emails from specific folder
- **addContact** - Add email contact with nickname
- **listContacts** - List all saved contacts

#### Natural Language Examples:
- "Send an email to John about the meeting"
- "Schedule an email for tomorrow at 10 AM"
- "Set up a weekly reminder email"
- "Show me my scheduled emails"
- "Cancel the recurring status report email"
- "Check my inbox for new emails"

**Configuration**: Requires Gmail OAuth setup with `GMAIL_USER` and Gmail API credentials.

### Amazon CloudWatch Plugin - AWS Monitoring

Monitor your AWS infrastructure with CloudWatch metrics, logs, and alarms.

#### Get Metrics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "getmetrics",
    "params": {
      "metricName": "CPUUtilization",
      "instanceId": "i-1234567890abcdef0"
    }
  }'
```

#### Put Custom Metric Data
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "putmetricdata",
    "params": {
      "metricName": "MyCustomMetric",
      "value": 42,
      "unit": "Count"
    }
  }'
```

#### List Available Metrics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "listmetrics",
    "params": {
      "namespace": "AWS/EC2"
    }
  }'
```

#### Create Anomaly Detector
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "createanomalydetector",
    "params": {
      "namespace": "AWS/EC2",
      "metricName": "CPUUtilization",
      "dimensions": [{ "Name": "InstanceId", "Value": "i-1234567890abcdef0" }],
      "stat": "Average"
    }
  }'
```

#### Describe Anomaly Detectors
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "describeanomalydetectors",
    "params": {
      "namespace": "AWS/EC2",
      "metricName": "CPUUtilization"
    }
  }'
```

#### Create Alarm
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "createalarm",
    "params": {
      "AlarmName": "HighCPUAlarm",
      "MetricName": "CPUUtilization",
      "Threshold": 80,
      "Namespace": "AWS/EC2",
      "ComparisonOperator": "GreaterThanThreshold",
      "EvaluationPeriods": 1,
      "Statistic": "Average"
    }
  }'
```

#### Delete Alarm
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "deletealarm",
    "params": {
      "AlarmName": "HighCPUAlarm"
    }
  }'
```

#### Describe Alarms
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "amazoncloudwatch",
    "action": "describealarms",
    "params": {
      "AlarmNames": ["HighCPUAlarm", "DiskSpaceAlarm"]
    }
  }'
```

**Configuration**: Requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_REGION`.

**Note**: All CloudWatch commands now use the real AWS SDK v3 (`@aws-sdk/client-cloudwatch`). Ensure credentials are configured for actual AWS API calls.

### Vonage Plugin - SMS, MMS, Voice & 2FA

Send SMS/MMS messages, verify phone numbers, and send 2FA OTP codes.

#### Send SMS
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "vonage",
    "action": "sendsms",
    "params": {
      "to": "+1234567890",
      "text": "Hello from LANAgent"
    }
  }'
```

#### Send MMS
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "vonage",
    "action": "sendmms",
    "params": {
      "to": "+1234567890",
      "text": "Check this image",
      "mediaUrl": "https://example.com/image.jpg"
    }
  }'
```

#### Get Account Balance
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "vonage",
    "action": "getbalance"
  }'
```

#### Verify Phone Number
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "vonage",
    "action": "verify",
    "params": {
      "number": "+1234567890",
      "brand": "LANAgent"
    }
  }'
```

#### Send 2FA OTP
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "vonage",
    "action": "send2fa",
    "params": {
      "to": "+1234567890",
      "brand": "LANAgent"
    }
  }'
```

**Configuration**: Requires `VONAGE_API_KEY` and `VONAGE_API_SECRET`.

**Note**: The 2FA OTP is sent only to the phone number. For security, the OTP is never returned in the API response.

### New Relic Plugin - Application Performance Monitoring

Monitor application performance, track errors, and analyze metrics.

#### Get Applications
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "newrelic",
    "action": "getApplications"
  }'
```

#### Get Application Details
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "newrelic",
    "action": "getApplicationDetails",
    "params": {
      "applicationId": "123456"
    }
  }'
```

#### Get Alerts
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "newrelic",
    "action": "getAlerts"
  }'
```

#### Get Application Metrics
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "newrelic",
    "action": "getMetrics",
    "params": {
      "applicationId": "123456",
      "metric": "apdex"
    }
  }'
```

**Configuration**: Requires `NEW_RELIC_API_KEY`.

### Trello Plugin - Project Management

Manage Trello boards, lists, and cards programmatically.

#### Get All Boards
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "trello",
    "action": "getboards"
  }'
```

#### Create Board
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "trello",
    "action": "createboard",
    "params": {
      "name": "New Project Board",
      "defaultLists": true
    }
  }'
```

#### Create Card
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "trello",
    "action": "createcard",
    "params": {
      "listId": "LIST_ID",
      "name": "New Task",
      "desc": "Task description here"
    }
  }'
```

#### Update Card
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "trello",
    "action": "updatecard",
    "params": {
      "cardId": "CARD_ID",
      "name": "Updated Task Name",
      "desc": "Updated description"
    }
  }'
```

**Configuration**: Requires `TRELLO_API_KEY` and `TRELLO_OAUTH_TOKEN`.

### Microsoft Graph Plugin - Microsoft 365 Integration

Access Microsoft 365 services including Outlook, OneDrive, Teams, and more.

#### Get User Profile
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "microsoftgraph",
    "action": "getprofile"
  }'
```

#### List Emails
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "microsoftgraph",
    "action": "listmails",
    "params": {
      "limit": 10,
      "folder": "inbox"
    }
  }'
```

#### Send Email via Outlook
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "microsoftgraph",
    "action": "sendmail",
    "params": {
      "to": "recipient@example.com",
      "subject": "Meeting Request",
      "body": "Please join our meeting tomorrow at 3 PM"
    }
  }'
```

#### Create Calendar Event
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "microsoftgraph",
    "action": "createevent",
    "params": {
      "subject": "Team Meeting",
      "start": "2024-01-15T14:00:00",
      "end": "2024-01-15T15:00:00",
      "location": "Conference Room A",
      "attendees": ["user1@company.com", "user2@company.com"]
    }
  }'
```

#### List OneDrive Files
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "microsoftgraph",
    "action": "listfiles",
    "params": {
      "path": "/Documents",
      "limit": 20
    }
  }'
```

**Configuration**: Requires `MICROSOFT_GRAPH_ACCESS_TOKEN` (OAuth2 bearer token).

---

### Digest Plugin - News Research and Scheduled Briefings

The digest plugin provides AI-powered web research, content summarization, and scheduled news briefings delivered via Telegram.

#### Research a Topic (with optional delivery)
```bash
# Research only - returns results in API response
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "research",
    "topic": "AI technology news January 2026",
    "depth": "quick"
  }'

# Research and deliver to Telegram
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "research",
    "topic": "latest tech news",
    "deliveryMethod": "telegram"
  }'
```

**Parameters:**
- `topic` (required): The topic to research
- `depth`: "quick" (default) or "deep" for multi-angle research
- `deliveryMethod`: "telegram", "email", or "both" to auto-deliver results

#### Schedule a Recurring Digest
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "scheduleDigest",
    "name": "Morning Tech News",
    "topic": "technology and AI news",
    "cron": "0 8 * * *"
  }'
```

**Parameters:**
- `name` (required): Human-readable schedule name
- `topic` (required): Topic to research
- `cron` (required): Cron expression (e.g., "0 8 * * *" for daily at 8 AM)

#### List Scheduled Digests
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "getSchedules"
  }'
```

#### Remove a Scheduled Digest
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "removeSchedule",
    "id": "schedule_id_here"
  }'
```

#### Manually Run a Scheduled Digest
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "runScheduledDigest",
    "id": "schedule_id_here"
  }'
```

#### Digest a URL (extract + summarize + research)
```bash
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "digest",
    "url": "https://example.com/article",
    "deliveryMethod": "telegram"
  }'
```

#### Manage Preferred Sources
```bash
# Add preferred source
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "addSource",
    "name": "Reuters",
    "url": "https://reuters.com"
  }'

# List preferred sources
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "getSources"
  }'

# Remove preferred source
curl -X POST http://localhost:3000/api/plugin \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "digest",
    "action": "removeSource",
    "name": "Reuters"
  }'
```

#### Natural Language Examples:
- "Research the latest AI news and send it to Telegram"
- "Set up a daily news digest for technology at 8am"
- "Give me a summary of this article: [URL]"
- "What's the latest news on cryptocurrency?"
- "Cancel my morning news schedule"

**Features:**
- Uses Anthropic web search for real-time news (auto-switches provider)
- Executive briefing format for Telegram delivery
- Smart message splitting for long content (4000 char limit)
- Preferred sources guide research (via prompt, not domain restrictions)
- Cron-based scheduling via Agenda
- No link previews in Telegram messages

---

This API provides comprehensive control over your LANAgent instance, enabling automation, monitoring, and integration with external services through a robust, secure, and well-documented interface.