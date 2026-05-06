# Gateway: Structured Extract + Recursive Crawl Services

**Status:** Proposed (2026-05-05) · not on roadmap yet
**Source:** Surfaced from competitive review of ScrapeGraphAI vs LANAgent's scraping gateway — see `/media/veracrypt2/AICodeLogs/2026-05-03-lanagent-vs-scraperapi-comparison.md`
**Owner:** TBD

## Motivation

Two product-shaped gaps vs ScrapeGraphAI's gateway:

1. **Turnkey LLM extraction.** Their `Extract` op takes URL + schema (or NL prompt) and returns structured JSON in one call. Customers love it because they don't have to chain `/scrape` → `/oracle` themselves.
2. **Recursive crawl.** Their `Crawl` op takes a start URL + depth/limit and returns a multi-page result set, optionally with per-page extraction.

We already have all the primitives — `webScraper` (4 tiers, VPN rotation, FlareSolverr), Anthropic SDK, Agenda for async jobs, MongoDB for state. What's missing is the turnkey wrapper. This proposal adds two endpoints — `/extract` and `/crawl` — that close the UX gap and let us beat ScrapeGraphAI on price *and* DX rather than just price.

Cost-comparison context: at the stealth tier we are 30–80x cheaper than ScrapeGraphAI per call. The only thing keeping a customer with them is the one-call extract / one-call crawl ergonomics. These two endpoints take that away.

## Service 1 — `/extract`

Single call: URL + schema (or NL prompt) → structured result.

**Request:**

```json
POST /extract
X-API-Key: gsk_...

{
  "url": "https://example.com/product",
  "schema": {
    "title": "string",
    "price": "number",
    "in_stock": "boolean"
  },
  "tier": "stealth",          // optional, default 'stealth'
  "prompt": "..."             // optional, used instead of schema
}
```

**Response:**

```json
{
  "success": true,
  "data": { "title": "...", "price": 49.99, "in_stock": true },
  "scraperTier": "stealth",
  "billing": "credits",
  "creditsCharged": 7,
  "creditsRemaining": 393,
  "url": "https://example.com/product",
  "extractModel": "claude-haiku-4-5"
}
```

**Internal flow:**

1. Tier-appropriate `webScraper` call (uses existing route logic incl. VPN rotation).
2. Pass scraped text/HTML through Anthropic SDK with cached system prompt and the user-supplied schema/prompt.
3. Validate output against schema (ajv/zod). On validation failure, retry once with a corrective prompt; if still fails, return partial + warning, refund 50% (configurable).
4. Return structured JSON.

**Pricing (per-call, no sub):**

| Tier | Total credits | $/call |
|---|---:|---:|
| `extract` (basic scrape + Haiku) | 5 | $0.05 |
| `extract-stealth` | 7 | $0.07 |
| `extract-render` | 8 | $0.08 |

Math: 1/2/3 cr for the scrape tier (basic/stealth/render — render dropped from 5cr to 3cr in v2.25.25, matching `full`) + 5 cr base for the LLM call (covers Haiku 4.5 with cache hit on system prompt; Sonnet/Opus would be a higher-tier version). Stealth and render now both add up the same way for an LLM-extract call: the difference is whether FlareSolverr is in the chain.

**Subscription:** counts as 3 basic-bucket calls per extract (rationale: scrape + LLM + validation overhead). On Scraper Pro ($25/mo), that's ~166K extracts/month included.

**Comparison:** ScrapeGraphAI charges 10 credits per stealth-extract on Pro = $0.057/call. Ours per-call is roughly comparable; our subscription absorbs them at near-zero marginal cost.

## Service 2 — `/crawl`

Multi-page recursive scrape with optional per-page extraction. Async by default.

**Request:**

```json
POST /crawl
X-API-Key: gsk_...

{
  "url": "https://example.com",
  "depth": 2,                       // max link depth (default 1, cap 5)
  "maxPages": 50,                   // hard cap (default 25, max 1000)
  "tier": "stealth",                // applied to every page
  "include": ["/blog/*"],           // optional glob filters
  "exclude": ["/login/*", "/admin/*"],
  "respectRobots": true,            // default true
  "extract": {                      // optional per-page extraction
    "schema": { "title": "string", "body": "string" }
  },
  "webhook": "https://your-app/cb"  // optional; otherwise poll
}
```

**Synchronous response (job created):**

```json
{
  "success": true,
  "jobId": "crawl_01HXYZ...",
  "status": "queued",
  "estimatedCredits": { "min": 2, "max": 252 },
  "pollUrl": "/crawl/crawl_01HXYZ...",
  "creditsHeld": 252
}
```

**Polling response (`GET /crawl/:id`):**

```json
{
  "jobId": "crawl_01HXYZ...",
  "status": "running",          // queued | running | completed | failed | partial
  "pagesScraped": 17,
  "pagesQueued": 32,
  "creditsUsed": 51,
  "results": [
    { "url": "...", "tier": "stealth", "data": {...}, "scrapedAt": "..." }
  ]
}
```

**Internal flow:**

1. Validate budget — hold `maxPages × tier-credit` upfront. Refund unused on completion.
2. Enqueue an Agenda `crawl-job` document with the request params.
3. Worker:
   - Fetch start URL through `webScraper` (counts as 1 tier-priced call).
   - Parse outbound links, dedupe by canonical URL, filter by include/exclude globs and `robots.txt`.
   - Enqueue children up to `depth` and `maxPages`.
   - For each fetched page, optionally run `/extract` if `extract` was provided.
   - Stream results into the job document.
4. On completion: settle credit hold (refund unused), fire webhook if configured, set TTL on the job doc (default 7 days).

**Pricing:**

- 2 credits "startup" (job overhead — queue, dedupe, robots.txt fetch, webhook delivery)
- Each page = its tier credit cost (basic 1 / stealth 2 / full 3 / render 3 — render matched to full in v2.25.25)
- Each page-extract = +5 credits if `extract` is provided
- Cap enforced server-side at `maxPages × per-page-cost + 2`

Example: `depth=2, maxPages=50, tier=stealth, extract` → max budget = 2 + 50×(2+5) = 352 cr ≈ $3.52.

**Subscription:** per-page draws from basic-bucket per page (1 call per page regardless of tier). Extract still counts as 3 basic-calls. Renderer-tier pages draw from render bucket as today.

**Comparison:** ScrapeGraphAI publishes "2 startup + page costs" without specifying per-page tiering. Our model is transparent: customer can compute exact max upfront.

## Why now / why not

**Why:**
- We already beat ScrapeGraphAI on raw scraping by 30–80x at the stealth tier (see comparison doc). Their only product moat is one-call ergonomics.
- Both endpoints build on existing infrastructure — no new services, no new dependencies beyond what's already in the tree.
- Cleanly closes the competitive analysis. Our pitch becomes "everything they offer, an order of magnitude cheaper."
- We can dogfood `/extract` internally for ALICE plugins that currently hand-roll scrape→LLM chains.

**Why not / risks:**
- **LLM token-cost variance.** Schema complexity changes I/O token counts. Fixed-credit pricing means we eat the variance. Mitigation: cap output tokens (8K default), require schema if input doc is large, return partial on overflow.
- **Crawl is stateful.** Job records, partial results, retries, TTL cleanup. Adds operational surface — need to monitor stuck jobs.
- **robots.txt + legal.** A naive crawler can scrape past `robots.txt` and create exposure for us. Mitigation: `respectRobots: true` default, server-side enforced, with a feature-flagged override for paying tiers that sign a separate ToS.
- **Abuse vector.** A `depth=5, maxPages=1000` crawl on a single domain looks like a DOS to the target. Mitigation: per-domain rate limit inside the worker (max N concurrent fetches per origin), polite delay between requests.

## Implementation sketch

**Phase 1 — `/extract` (ship first, smaller):**

- New route: `src/api/external/routes/extract.js`
- Reuses `webScraper` directly (don't go through HTTP); reuses Anthropic SDK with prompt caching on system prompt + schema
- Schema validation: prefer `ajv` if already in tree, else `zod` (already a dep on the gateway side likely)
- Add to subscription bucket counter (3 basic-calls per extract)
- Postman collection update + API_README section
- Audit log entry per call (existing `auditLog` middleware)
- **ETA:** 1–2 days dev + tests

**Phase 2 — `/crawl` (bigger):**

- New model: `src/models/CrawlJob.js` (URL list, status, results, TTL index)
- New route: `src/api/external/routes/crawl.js`
- Worker: extend Agenda with `crawl-job` type
- `robots-parser` for robots.txt, `globby`/minimatch for include/exclude
- Webhook delivery uses the existing pattern from social-download (v2.25.17)
- Per-domain concurrency limiter inside the worker
- Postman + API_README + session report
- **ETA:** 4–7 days dev + tests

Both phases ship behind feature flags so we can preview-launch to a subset of API keys before enabling for all.

## Open questions

- Do we charge for malformed-LLM-output retries on `/extract`, or eat them? Lean: eat the first retry, charge if user supplied a contradictory schema.
- Should `/crawl` per-page calls draw from a third "crawl" bucket, or fold into basic-bucket? Lean: basic-bucket — fewer SKUs to explain.
- Preview mode for `/crawl`? Probably yes — `dryRun: true` returns first-page parse + estimated link count before committing.
- Default LLM model for `/extract`: Haiku 4.5 (fast/cheap) or Sonnet 4.6 (higher quality)? Lean: Haiku default, `model: "sonnet"` for +5cr.
- Streaming responses for `/crawl` results vs. polling-only? Polling is simpler; streaming is nicer DX but adds WS infra. Defer streaming to phase 3.

## Decision needed

1. Confirm both services are wanted (vs. just `/extract`, the smaller bet).
2. Confirm pricing model — 5/7/10 cr for extract; 2cr + per-page-tier-cost for crawl.
3. Slot on roadmap. Natural fit: extract in v2.26.x, crawl in v2.27.x or behind feature flag earlier.
4. Decide on `/extract` model default (Haiku vs Sonnet).
