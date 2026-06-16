import { Router } from 'express';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { creditAuth } from '../middleware/creditAuth.js';
import { logger } from '../../../utils/logger.js';
import { retryOperation, isRetryableError } from '../../../utils/retryUtils.js';
import { isFlareSolverrAvailable } from '../../../utils/flareSolverr.js';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import NodeCache from 'node-cache';

const router = Router();
const scrapeCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Metered paywalls that historically let declared crawlers through for SEO
// or social-preview rendering. On these hosts, a 200 response with a tiny
// body is almost certainly the paywall stub rather than the article — worth
// retrying with a Twitterbot UA before giving up. Twitter card previews tend
// to be more permissively whitelisted than Googlebot (which some sites now
// verify via reverse DNS).
const CRAWLER_FRIENDLY_PAYWALL_HOSTS = new Set([
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'ft.com',
  'theatlantic.com',
  'bloomberg.com',
  'nymag.com',
  'newyorker.com',
  'foreignpolicy.com',
  'foreignaffairs.com',
  'economist.com',
  'harpers.org',
  'thecut.com',
  'vulture.com'
]);

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// v2.25.86: After Puppeteer escalation, a DataDome / Cloudflare challenge page
// often surfaces as a small but non-empty "successful" result — the captcha JS
// payload itself gets extracted as the page's text. Length-only stub detection
// then incorrectly accepts it. Sniff for known challenge fingerprints so we can
// force the bypass chain to keep going.
//
// Patterns we look for (all case-insensitive):
//   - DataDome:      "datadome", "geo.captcha-delivery.com"
//   - Cloudflare:    "cf-challenge", "attention required", "checking your browser",
//                    "cf-mitigated", "ray id" + "challenge"
//   - Imperva/PX:    "incapsula", "_imperva_", "perimeterx"
//   - Generic:       extracted text is mostly captcha-ish JS variable names
const CHALLENGE_FINGERPRINTS = [
  /datadome/i,
  /geo\.captcha-delivery\.com/i,
  /cf-challenge|cf-mitigated/i,
  /attention required|checking your browser/i,
  /incapsula|_imperva_|perimeterx/i,
  // v2.25.87: catch Cloudflare's classic CAPTCHA challenge page (the one
  // archive.ph leans on). Pattern: "One more step / Please complete the
  // security check to access" + "Why do I have to complete a CAPTCHA?"
  /please complete the security check|completing the captcha proves you/i,
  // Generic human-verification wording used by several anti-bot vendors
  /human verification|verify (you are|that you('re| are) a human)/i,
  // federalregister.gov / eCFR.gov rolled out an explicit anti-scraping wall
  // ("Request Access — Due to aggressive automated scraping … programmatic
  // access to these sites …") that returns 200 with ~13KB of block text. It's
  // not a standard CAPTCHA, so treat the wording itself as the fingerprint so
  // the result is flagged unusable and the archive fallback kicks in.
  /due to aggressive automated scraping|programmatic access to these sites|request access[\s\S]{0,160}automated scraping/i
];
function looksLikeChallengePage(result) {
  if (!result?.content) return false;
  const haystack = `${result.content.title || ''}\n${result.content.text || ''}\n${result.content.description || ''}`;
  if (!haystack.trim()) return false;
  // Short text that's mostly captcha-shaped JS object literals (cid/hsh/host/cookie fields)
  const text = String(result.content.text || '');
  if (text.length < 1000 && /['"](cid|hsh|host|cookie)['"]\s*:/.test(text)) return true;
  return CHALLENGE_FINGERPRINTS.some(re => re.test(haystack));
}

// v2.25.87: removepaywalls.com serves a thin wrapper page whose body is
// the consent banner + four "Search Option N" buttons; the actual article
// loads in an iframe pointing at periscope.corsfix.com. Scrapers that
// don't drill into iframes see only the wrapper text, not the article.
// Detect that case so we don't surface a falsely-successful response.
function isRemovepaywallsWrapper(result) {
  if (!result?.content) return false;
  const title = String(result.content.title || '').toLowerCase();
  const text = String(result.content.text || '').toLowerCase();
  if (title.includes('removepaywall') || title === 'view this full article!') return true;
  // Telltale fragments of the wrapper's UI text
  if (/search\s+x\s+option\s+\d/i.test(text)) return true;
  if (text.includes('removepaywall asks for your consent')) return true;
  return false;
}

// A JavaScript app-shell: the server hands a non-JS client a chunk of HTML
// (script tags + an empty mount node) but almost no real text — the content only
// exists after a client-side render. This is the federalregister.gov failure mode:
// a 10.5KB shell that the old length gate (htmlLen < 8000) let through as a
// "successful full" snapshot. Signature: substantial _rawHtml but tiny extracted
// text, or explicit app-shell / "enable JavaScript" markers. (_rawHtml is only
// populated by the cheerio path; Puppeteer/FlareSolverr execute the JS, so their
// output is real content, not a shell — hence the html-present guard.)
const APP_SHELL_MARKERS = /<div id=["'](root|app|__next|__nuxt|svelte|gatsby-focus-wrapper)["'][^>]*>\s*<\/div>|you (need to )?enable javascript|please enable javascript|enable js to|<noscript>[^<]*(javascript|enable)/i;
function looksLikeJsShell(result) {
  const html = typeof result?._rawHtml === 'string' ? result._rawHtml : '';
  if (!html) return false;
  const text = String(result?.content?.text || '');
  // Lots of markup/scripts, almost no rendered text → an unrendered shell.
  if (html.length > 4000 && text.length < 600) return true;
  // Explicit shell / needs-JS markers with little real text.
  if (text.length < 1500 && APP_SHELL_MARKERS.test(html)) return true;
  return false;
}

// Single source of truth for "this result is unusable, try the next fallback".
// Used by the Puppeteer-escalation, Twitterbot, Wayback, and archive.ph gates.
function isUnusableResult(result) {
  if (!result?.success) return true;
  const htmlLen = typeof result._rawHtml === 'string' ? result._rawHtml.length : 0;
  const textLen = typeof result.content?.text === 'string' ? result.content.text.length : 0;
  // textLen is primary (Puppeteer doesn't surface _rawHtml). htmlLen is a
  // belt-and-suspenders gate when raw HTML IS available.
  const lengthLooksStub = textLen < 500 && (htmlLen === 0 || htmlLen < 8000);
  return lengthLooksStub || looksLikeChallengePage(result) || looksLikeJsShell(result);
}

// Whether to reach for an archive (Wayback / archive.ph). Two cases:
//   (a) a "successful" but stub/shell/challenge result, OR
//   (b) a hard BLOCK-like failure (403/Akamai/Cloudflare/etc.) — this is the
//       congress.gov case the old gates missed, because they required
//       success === true. Archives were captured when the page was openly
//       crawlable, so they bypass live bot-blocks. We do NOT chase archives for
//       dead hosts (nxdomain), connection resets, or plain timeouts — those
//       won't have a useful snapshot and shouldn't pay the lookup cost.
function shouldTryArchiveFallback(result) {
  if (result?.success) return isUnusableResult(result);
  const err = String(result?.error || '');
  return /\b(403|406|429|503)\b|forbidden|blocked|cloudflare|akamai|access denied|attention required|just a moment|challenge|rate limit|too many requests/i.test(err);
}

// Classify a scrape error so we can (a) skip pointless tier escalation when
// the URL is genuinely unreachable, (b) return a meaningful HTTP status to the
// client instead of generic 500, and (c) pick the right failure-cache TTL —
// DNS misses stay cached longer than transient timeouts.
function classifyScrapeError(errMsg) {
  const m = String(errMsg || '').toLowerCase();
  if (/err_name_not_resolved|enotfound|nxdomain|getaddrinfo/i.test(errMsg))
    return { kind: 'nxdomain', status: 400, message: 'Invalid host — DNS resolution failed', cacheTtl: 86400 };
  if (/err_connection_closed|econnreset|socket hang up|err_connection_refused|econnrefused/i.test(errMsg))
    return { kind: 'tcp_reset', status: 502, message: 'Target site refused the connection', cacheTtl: 300 };
  if (/err_connection_timed_out|err_timed_out|navigation timeout|etimedout|timeout of \d+ms exceeded/i.test(errMsg))
    return { kind: 'timeout', status: 504, message: 'Target took too long to respond', cacheTtl: 120 };
  if (/\b(403|406|429|503)\b|forbidden|blocked|cloudflare|just a moment|attention required|access denied|rate limit|too many requests|challenge/i.test(m))
    return { kind: 'blocked', status: 502, message: 'Target has anti-bot protection we could not bypass', cacheTtl: 60 };
  return { kind: 'other', status: 500, message: errMsg || 'Scraping failed', cacheTtl: 60 };
}

// Stash a failure result in the same cache the success path uses, with a TTL
// tuned to how recoverable that failure class is. Cached failures short-circuit
// the next identical request — that's how we stop a client retry loop from
// burning 7 × full 4-tier chains in 3 minutes on the same dead URL.
function cacheFailure(cacheKey, errMsg) {
  const cls = classifyScrapeError(errMsg);
  const failureRecord = {
    success: false,
    error: errMsg ? String(errMsg) : cls.message,
    errorKind: cls.kind,
    httpStatus: cls.status,
    cached: true,
    targetError: true
  };
  scrapeCache.set(cacheKey, failureRecord, cls.cacheTtl);
  return failureRecord;
}

// Credit costs per tier (v2.25.25: render dropped from 5 → 3 to match `full` —
// FlareSolverr cost-to-serve is ~$0.001/call, so the 5cr sticker was almost
// entirely margin and reading expensive next to ScraperAPI/ScrapeGraphAI per-call
// rates. New scheme keeps `render` distinct from `full` semantically (FS-backed)
// but aligned in price; opens 5cr slot for a future premium tier.)
const TIER_COSTS = {
  basic: 1,
  stealth: 2,
  full: 3,
  render: 3
};

// VPN rotation pool — broad geographic + ASN distribution used when a paid
// scrape is blocked by the upstream. Codes are ExpressVPN canonical region IDs
// from `expressvpnctl get regions`.
//
// Pool size + random selection (below) matter for Cloudflare-protected URLs:
// the old 10-region pool combined with `.find()` (which always returned the
// FIRST non-current entry) meant rotation only ever exercised 2-3 regions in
// practice — once those were Cloudflare-banned for a domain, recovery
// dropped to zero. 30 regions × random pick lets us survive much longer
// before saturating the available ASN diversity.
const VPN_ROTATION_POOL = [
  // US East
  'usa-new-york', 'usa-new-jersey-1', 'usa-new-jersey-2', 'usa-new-jersey-3',
  'usa-washington-dc', 'usa-boston', 'usa-miami',
  // US Central / South
  'usa-chicago', 'usa-dallas', 'usa-atlanta', 'usa-denver',
  // US West
  'usa-los-angeles-1', 'usa-los-angeles-3', 'usa-san-francisco', 'usa-seattle',
  // Canada
  'canada-toronto', 'canada-vancouver',
  // UK
  'uk-london', 'uk-docklands', 'uk-manchester',
  // Continental Europe
  'netherlands-amsterdam', 'netherlands-the-hague',
  'germany-frankfurt-1', 'germany-berlin',
  'france-paris-1', 'france-marseille',
  'switzerland', 'italy-milan', 'sweden',
  // Asia
  'japan-tokyo', 'japan-osaka',
  'singapore-marina-bay', 'singapore-jurong',
  'hong-kong-1'
];

const MAX_VPN_ROTATIONS = 2;

// Detect whether a failed scrape result looks like an IP-level block / rate limit
// vs an unrelated error (404, malformed URL, etc.). Only block-like failures justify
// the latency cost of a VPN rotation.
function isLikelyBlocked(result) {
  if (!result || result.success) return false;
  const err = String(result.error || '').toLowerCase();
  return /\b(403|406|429|503)\b|forbidden|blocked|cloudflare|just a moment|attention required|access denied|rate limit|too many requests|challenge/i.test(err);
}

/**
 * Health check endpoint to verify service availability.
 */
router.get('/health', (req, res) => {
  res.json({ success: true, message: 'Service is healthy' });
});

/**
 * Execute a single scrape operation.
 *
 * tier semantics for fallback chain:
 *   - basic / full / extract: cheerio → puppeteer (on block) → flaresolverr (on managed-challenge block, render tier only)
 *   - stealth: puppeteer
 *   - render: flaresolverr → puppeteer (if FS unreachable)
 *
 * Render-tier callers pass renderTier=true so a CF managed-challenge block
 * escalates to FlareSolverr instead of returning 500.
 */
async function executeScrape(req, { url, selectors, extractType = 'text', userAgent, usePuppeteer = false, renderTier = false, fullPage = false, viewport = null }) {
  const scraperEntry = req.app.locals.agent?.apiManager?.apis?.get('scraper');
  const scraper = scraperEntry?.instance || scraperEntry;
  if (!scraper?.execute) {
    return { success: false, error: 'Scraping service not available', targetError: true };
  }

  const action = extractType === 'structured' ? 'extract' : 'scrape';
  const options = { bypassCache: true };
  if (userAgent) options.userAgent = userAgent;
  if (selectors) options.selector = selectors;
  if (usePuppeteer) options.usePuppeteer = true;

  // Check cache
  const cacheKey = `${action}:${url}:${JSON.stringify(selectors || '')}:render=${renderTier}`;
  const cached = scrapeCache.get(cacheKey);
  if (cached) return cached;

  let result;
  try {
    let rawResult;
    let cheerioError = null;

    // Render tier: try FlareSolverr first (most likely to bypass Cloudflare).
    if (renderTier && await isFlareSolverrAvailable()) {
      try {
        logger.info(`[ExternalScrape] Render tier: trying FlareSolverr for ${url}`);
        rawResult = await scraper.execute({ action, url, options: { ...options, useFlareSolverr: true } });
        if (rawResult?.success) {
          logger.info(`[ExternalScrape] FlareSolverr succeeded for ${url}`);
        }
      } catch (fsErr) {
        logger.warn(`[ExternalScrape] FlareSolverr failed for ${url}: ${fsErr.message}, falling back`);
        rawResult = null;
      }
    }

    // Try cheerio first (fast) — only if FS path didn't already produce a result
    if (!rawResult || !rawResult.success) {
      try {
        const cheerioResult = await scraper.execute({ action, url, options });
        // Don't overwrite a successful FS result with a cheerio failure
        if (cheerioResult?.success || !rawResult) {
          rawResult = cheerioResult;
        }
      } catch (err) {
        cheerioError = err.message || String(err);
        if (!rawResult) rawResult = { success: false, error: cheerioError };
      }
    }

    // Detect Cloudflare/bot challenge pages that return 200 but aren't real content
    const challengeTitles = ['Just a moment', 'Checking your browser', 'Attention Required', 'Access denied', 'Please Wait'];
    const gotChallengePage = rawResult.success && rawResult.content?.title &&
      challengeTitles.some(t => rawResult.content.title.includes(t));

    // A cheerio result that's a JS app-shell or stub also warrants a render retry:
    // Puppeteer executes the page's JS, turning the shell into real content. This
    // is what rescues federalregister.gov (and any SPA) instead of storing the shell.
    const cheerioLooksUnusable = rawResult.success && rawResult.method !== 'flaresolverr' && isUnusableResult(rawResult);

    // If cheerio failed, got blocked, got a challenge page, or returned a shell/stub, auto-retry with Puppeteer
    const shouldRetryWithPuppeteer = !options.usePuppeteer && rawResult.method !== 'flaresolverr' && (
      !rawResult.success ||
      !rawResult.content?.title ||
      gotChallengePage ||
      cheerioLooksUnusable
    );

    if (shouldRetryWithPuppeteer) {
      const errMsg = rawResult.error || cheerioError || (gotChallengePage ? 'Cloudflare challenge page' : '');
      const isBlocked = gotChallengePage || cheerioLooksUnusable || errMsg.includes('403') || errMsg.includes('406') || errMsg.includes('503')
        || errMsg.includes('Forbidden') || errMsg.includes('blocked') || errMsg.includes('Failed to scrape');

      if (isBlocked) {
        logger.info(`[ExternalScrape] Cheerio failed for ${url} (${errMsg.slice(0, 60)}), retrying with Puppeteer...`);
        try {
          rawResult = await scraper.execute({ action, url, options: { ...options, usePuppeteer: true } });
          if (rawResult.success) {
            logger.info(`[ExternalScrape] Puppeteer succeeded for ${url}`);
          }
        } catch (puppeteerErr) {
          logger.warn(`[ExternalScrape] Puppeteer also failed for ${url}: ${puppeteerErr.message}`);
          // Keep the original cheerio error
          rawResult = { success: false, error: cheerioError || puppeteerErr.message };
        }
      }
    }

    // Bail before further tier escalation if the failure is intrinsically
    // unrecoverable. No upstream proxy or browser can make a non-existent
    // domain resolve (nxdomain), an actively-resetting server accept us
    // (tcp_reset), or a server that isn't responding wake up (timeout — if
    // Cheerio AND Puppeteer both hit ERR_TIMED_OUT, FlareSolverr will too).
    // Skipping the escalation saves 3-30s per dead URL and stops the gateway
    // axios from hitting its own 60s ceiling on these.
    if (!rawResult.success) {
      const cls = classifyScrapeError(rawResult.error);
      if (cls.kind === 'nxdomain' || cls.kind === 'tcp_reset' || cls.kind === 'timeout') {
        const failure = cacheFailure(cacheKey, rawResult.error);
        return failure;
      }
    }

    // Render tier final escalation: if Puppeteer was Cloudflare-blocked, try FlareSolverr.
    // This covers the case where renderTier=true but FS was unavailable initially, or
    // where the upstream tried puppeteer first and hit a managed challenge.
    if (renderTier && (!rawResult.success || rawResult.cloudflareBlocked) && rawResult.method !== 'flaresolverr') {
      if (await isFlareSolverrAvailable()) {
        logger.info(`[ExternalScrape] Render tier: escalating to FlareSolverr after Puppeteer block on ${url}`);
        try {
          const fsResult = await scraper.execute({ action, url, options: { ...options, useFlareSolverr: true } });
          if (fsResult?.success) {
            logger.info(`[ExternalScrape] FlareSolverr succeeded after Puppeteer fallback for ${url}`);
            rawResult = fsResult;
          }
        } catch (fsErr) {
          logger.warn(`[ExternalScrape] FlareSolverr escalation failed for ${url}: ${fsErr.message}`);
        }
      }
    }

    // Crawler-UA retry for known metered paywalls. NYT, WaPo and similar
    // typically return ~1-2KB of paywall stub when fetched as a normal user
    // (FlareSolverr or otherwise). If the host is on our crawler-friendly
    // list AND we got back a tiny body AND we haven't already retried with
    // a crawler UA, try once more with Twitterbot — many of these sites
    // allow Twitter card previews through where they'd block Googlebot
    // verification.
    if (rawResult.success && !options._crawlerUARetried) {
      const hostname = hostnameOf(url);
      if (hostname && CRAWLER_FRIENDLY_PAYWALL_HOSTS.has(hostname)) {
        const htmlLen = typeof rawResult._rawHtml === 'string' ? rawResult._rawHtml.length : 0;
        const textLen = typeof rawResult.content?.text === 'string' ? rawResult.content.text.length : 0;
        // v2.25.86: Mirror the v2.25.84 Wayback-gate fix here — Puppeteer
        // never populates _rawHtml (it surfaces extracted content only), so
        // the old `htmlLen > 0` requirement made this gate impossible to
        // satisfy after v2.25.83 routed Twitterbot retry through Puppeteer.
        // textLen is the primary signal; htmlLen is a belt-and-suspenders
        // gate when raw HTML IS available. Also short-circuits on captcha
        // pages even when they're longer than 500B of inert JS.
        const lengthLooksStub = textLen < 500 && (htmlLen === 0 || htmlLen < 8000);
        const challengeDetected = looksLikeChallengePage(rawResult);
        const looksLikePaywallStub = lengthLooksStub || challengeDetected;
        if (looksLikePaywallStub) {
          if (challengeDetected) {
            logger.info(`[ExternalScrape] Challenge page detected for ${url} — triggering Twitterbot retry regardless of length`);
          }
          logger.info(`[ExternalScrape] Paywall stub suspected for ${url} (html=${htmlLen}B, text=${textLen}B), retrying with Twitterbot UA`);
          try {
            const retryResult = await scraper.execute({
              action,
              url,
              // Puppeteer (not FlareSolverr): modern FS hardcodes the User-Agent
              // to match the embedded browser's fingerprint and silently ignores
              // any userAgent override. Puppeteer's page.setUserAgent does take
              // effect at the network layer.
              options: { ...options, useFlareSolverr: false, usePuppeteer: true, userAgent: 'twitterbot', _crawlerUARetried: true }
            });
            if (retryResult?.success) {
              const newHtmlLen = typeof retryResult._rawHtml === 'string' ? retryResult._rawHtml.length : 0;
              const newTextLen = typeof retryResult.content?.text === 'string' ? retryResult.content.text.length : 0;
              const retryIsChallenge = looksLikeChallengePage(retryResult);
              // Only adopt the retry result if it's *meaningfully* bigger
              // AND not itself a challenge page. Some paywall pages serve
              // the same stub regardless of UA; some DataDome challenges
              // even grow when re-fetched (more captcha JS).
              if (!retryIsChallenge && (newHtmlLen > htmlLen * 2 || newTextLen >= 500)) {
                logger.info(`[ExternalScrape] Twitterbot UA bypassed paywall for ${url} (html=${newHtmlLen}B, text=${newTextLen}B)`);
                rawResult = retryResult;
              } else {
                const why = retryIsChallenge ? 'still a challenge page' : `still html=${newHtmlLen}B text=${newTextLen}B`;
                logger.info(`[ExternalScrape] Twitterbot UA did not bypass paywall for ${url} (${why})`);
              }
            }
          } catch (err) {
            logger.warn(`[ExternalScrape] Twitterbot retry failed for ${url}: ${err.message}`);
          }
        }
      }
    }

    // Wayback Machine fallback: if we STILL have a paywall-stub-shaped
    // result (after Twitterbot retry OR for hosts not on the crawler-
    // friendly list — DataDome/PerimeterX bot blocks, hard paywalls,
    // dead pages), try the most recent archive.org snapshot. Snapshots
    // were captured when the page was openly crawlable, so they bypass
    // contemporary auth walls and bot blocks. Free, no auth, broad
    // coverage on major news sites. Cost: ~2s availability check plus
    // ~3s snapshot fetch when triggered.
    if (!options._waybackRetried && shouldTryArchiveFallback(rawResult)) {
      const htmlLen = typeof rawResult._rawHtml === 'string' ? rawResult._rawHtml.length : 0;
      const textLen = typeof rawResult.content?.text === 'string' ? rawResult.content.text.length : 0;
      logger.info(`[ExternalScrape] Still stub-shaped after retries for ${url} (html=${htmlLen}B, text=${textLen}B), trying Wayback Machine`);
      try {
        const axiosMod = (await import('axios')).default;
        const waybackInfo = await axiosMod.get(
          `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
          { timeout: 8000 }
        );
        const snapshot = waybackInfo.data?.archived_snapshots?.closest;
        if (snapshot?.available && snapshot.url) {
          logger.info(`[ExternalScrape] Wayback snapshot found for ${url}: ${snapshot.timestamp}`);
          try {
            const waybackResult = await scraper.execute({
              action,
              url: snapshot.url,
              options: { ...options, _waybackRetried: true, useFlareSolverr: false, usePuppeteer: false }
            });
            if (waybackResult?.success && !isUnusableResult(waybackResult)) {
              const wbHtmlLen = typeof waybackResult._rawHtml === 'string' ? waybackResult._rawHtml.length : 0;
              const wbTextLen = typeof waybackResult.content?.text === 'string' ? waybackResult.content.text.length : 0;
              logger.info(`[ExternalScrape] Wayback bypassed for ${url} (snapshot ${snapshot.timestamp}: html=${wbHtmlLen}B, text=${wbTextLen}B)`);
              rawResult = waybackResult;
              rawResult._waybackSnapshot = snapshot.timestamp;
              rawResult._waybackUrl = snapshot.url;
              // Keep the original URL in the response so the caller
              // sees what they asked for, not the archive.org URL.
              rawResult.url = url;
            } else {
              logger.info(`[ExternalScrape] Wayback snapshot was also stub-shaped or unusable for ${url} — keeping original`);
            }
          } catch (wbErr) {
            logger.warn(`[ExternalScrape] Wayback snapshot fetch failed for ${url}: ${wbErr.message}`);
          }
        } else {
          logger.info(`[ExternalScrape] No Wayback snapshot available for ${url}`);
        }
      } catch (apiErr) {
        logger.warn(`[ExternalScrape] Wayback availability check failed for ${url}: ${apiErr.message}`);
      }
    }

    // v2.25.86: archive.ph (a.k.a. archive.today) fallback. Aggregates manual
    // paywall saves and frequently has fresh content Wayback misses — Wayback's
    // automated crawler hits the same paywall walls our scraper does; archive.ph
    // accumulates URLs people submit by hand, so high-traffic recent paywalled
    // articles often land here before Wayback. Cost: ~6-8s (Cloudflare-protected,
    // needs Puppeteer). Only fires when we're still stub-shaped after Wayback.
    if (!options._archivePhRetried && shouldTryArchiveFallback(rawResult)) {
      const archivePhUrl = `https://archive.ph/newest/${url}`;
      logger.info(`[ExternalScrape] Still stub-shaped after Wayback for ${url}, trying archive.ph (${archivePhUrl})`);
      try {
        const archiveResult = await scraper.execute({
          action,
          url: archivePhUrl,
          // archive.ph is Cloudflare-protected → Puppeteer is the only one that
          // negotiates the challenge cleanly. Long timeout because the snapshot
          // page itself may include the original article's full-page JS.
          options: { ...options, _archivePhRetried: true, useFlareSolverr: false, usePuppeteer: true }
        });
        if (archiveResult?.success && !isUnusableResult(archiveResult)) {
          const apHtmlLen = typeof archiveResult._rawHtml === 'string' ? archiveResult._rawHtml.length : 0;
          const apTextLen = typeof archiveResult.content?.text === 'string' ? archiveResult.content.text.length : 0;
          logger.info(`[ExternalScrape] archive.ph bypassed for ${url} (html=${apHtmlLen}B, text=${apTextLen}B)`);
          rawResult = archiveResult;
          rawResult._archivePhUrl = archivePhUrl;
          rawResult.url = url;
        } else {
          logger.info(`[ExternalScrape] archive.ph also stub-shaped or unusable for ${url} — keeping original`);
        }
      } catch (apErr) {
        logger.warn(`[ExternalScrape] archive.ph fetch failed for ${url}: ${apErr.message}`);
      }
    }

    // v2.25.87: removepaywalls.com last-resort fallback. Third-party service
    // that wraps the target URL in an iframe pointing at periscope.corsfix.com
    // (a CORS-bypass proxy) which re-fetches NYT-style paywalled content from
    // its own pool. Works on metered paywalls Wayback/archive.ph miss, but
    // (a) it's a single third-party dep, (b) the content sits behind an iframe
    // and our scraper extracts the outer page text, so even when the proxy
    // succeeds we may only see the wrapper UI ("View this full article!" +
    // consent banner). For DataDome-heavy hosts like nytimes.com this rarely
    // returns the actual body — kept last in the chain as a long-tail bet.
    // Set REMOVEPAYWALL_ENABLED=false in env to disable.
    const removepaywallEnabled = process.env.REMOVEPAYWALL_ENABLED !== 'false';
    if (rawResult.success && removepaywallEnabled && !options._removepaywallRetried && isUnusableResult(rawResult)) {
      const rpwUrl = `https://removepaywalls.com/${url}`;
      logger.info(`[ExternalScrape] Still stub-shaped after archive.ph for ${url}, trying removepaywalls.com (${rpwUrl})`);
      try {
        const rpwResult = await scraper.execute({
          action,
          url: rpwUrl,
          // Long timeout — the wrapper page loads an iframe that pulls the
          // actual article from periscope.corsfix.com client-side.
          options: { ...options, _removepaywallRetried: true, useFlareSolverr: false, usePuppeteer: true }
        });
        if (rpwResult?.success && !isUnusableResult(rpwResult) && !isRemovepaywallsWrapper(rpwResult)) {
          const rpwHtmlLen = typeof rpwResult._rawHtml === 'string' ? rpwResult._rawHtml.length : 0;
          const rpwTextLen = typeof rpwResult.content?.text === 'string' ? rpwResult.content.text.length : 0;
          logger.info(`[ExternalScrape] removepaywalls.com bypassed for ${url} (html=${rpwHtmlLen}B, text=${rpwTextLen}B)`);
          rawResult = rpwResult;
          rawResult._removepaywallUrl = rpwUrl;
          rawResult.url = url;
        } else {
          const why = isRemovepaywallsWrapper(rpwResult) ? 'returned wrapper UI only (iframe content not extracted)' : 'stub-shaped or unusable';
          logger.info(`[ExternalScrape] removepaywalls.com ${why} for ${url} — keeping original`);
        }
      } catch (rpwErr) {
        logger.warn(`[ExternalScrape] removepaywalls.com fetch failed for ${url}: ${rpwErr.message}`);
      }
    }

    // v2.25.88: If we've exhausted every bypass layer and the result is STILL
    // unusable (DataDome / hard paywall / dead page), surface that as a real
    // failure instead of returning success with 400-byte captcha JS as the
    // article body. Without this, downstream auto-posters (Twitter, MindSwarm,
    // anything pulling data.text and publishing it) will happily post the
    // captcha payload as if it were the article — that's the failure mode the
    // user flagged with "embarrassingly failed miserably" on the NYT URL.
    if (rawResult.success && isUnusableResult(rawResult)) {
      const reason = looksLikeChallengePage(rawResult)
        ? 'all bypass layers blocked (challenge page after Twitterbot/Wayback/archive.ph/removepaywalls)'
        : 'all bypass layers returned stub-shaped content';
      logger.warn(`[ExternalScrape] Marking ${url} as failure — ${reason}`);
      return cacheFailure(cacheKey, `Scrape blocked: ${reason}`);
    }

    // Quality-based escalation: if result looks suspicious, retry with Puppeteer
    if (rawResult.success && !options.usePuppeteer && rawResult.content) {
      const title = rawResult.content.title || '';
      const ogImage = rawResult.content.ogImage || '';
      const images = rawResult.content.images || [];

      // Detect polluted title (contains repeated logo/brand text patterns)
      const titleLooksCorrupted = /(.{3,})\1{2,}/.test(title) || // same text repeated 3+ times
        (title.length > 200); // unreasonably long title

      // Detect tracking pixel as primary image
      const adPatterns = [/ads\.rmbl\.ws/i, /doubleclick\.net/i, /googlesyndication/i, /\/t\?a=/i, /\/pixel\?/i, /\/beacon\?/i];
      const ogImageIsTracker = ogImage && adPatterns.some(p => p.test(ogImage));
      const onlyAdImages = images.length > 0 && images.length <= 3 &&
        images.every(img => adPatterns.some(p => p.test(img.src)));

      const qualityIsSuspicious = titleLooksCorrupted || ogImageIsTracker || onlyAdImages;

      if (qualityIsSuspicious) {
        logger.info(`[ExternalScrape] Suspicious quality for ${url} (title_corrupted=${titleLooksCorrupted}, og_tracker=${ogImageIsTracker}, only_ads=${onlyAdImages}), retrying with Puppeteer...`);
        try {
          const retryResult = await scraper.execute({ action, url, options: { ...options, usePuppeteer: true } });
          if (retryResult.success) {
            logger.info(`[ExternalScrape] Quality escalation to Puppeteer succeeded for ${url}`);
            rawResult = retryResult;
          }
        } catch (err) {
          logger.warn(`[ExternalScrape] Quality escalation Puppeteer failed for ${url}: ${err.message}`);
          // Keep the original result — it's better than nothing
        }
      }
    }

    // Force-sanitize: rebuild result from scratch using only primitive/plain values
    result = {
      success: !!rawResult.success,
      url: rawResult.url || url,
      content: rawResult.content ? {
        title: String(rawResult.content.title || ''),
        description: String(rawResult.content.description || ''),
        ogImage: String(rawResult.content.ogImage || ''),
        text: String(rawResult.content.text || ''),
        links: (rawResult.content.links || []).map(l => ({ href: String(l.href || ''), text: String(l.text || '') })),
        images: (rawResult.content.images || []).map(i => ({ src: String(i.src || ''), alt: String(i.alt || '') })),
        jsonld: rawResult.content.jsonld || [],
        microdata: rawResult.content.microdata || []
      } : null,
      method: String(rawResult.method || 'unknown'),
      error: rawResult.error ? String(rawResult.error) : undefined,
      // Preserve raw HTML and cookies from FlareSolverr so we can attach
      // HTML to render-tier responses without a redundant fetch and so the
      // screenshot pass can navigate past Cloudflare with the same cookies.
      _rawHtml: typeof rawResult._rawHtml === 'string' ? rawResult._rawHtml : undefined,
      _cookies: Array.isArray(rawResult._cookies) ? rawResult._cookies : undefined,
      _userAgent: typeof rawResult._userAgent === 'string' ? rawResult._userAgent : undefined,
      _waybackSnapshot: typeof rawResult._waybackSnapshot === 'string' ? rawResult._waybackSnapshot : undefined,
      _waybackUrl: typeof rawResult._waybackUrl === 'string' ? rawResult._waybackUrl : undefined,
      _archivePhUrl: typeof rawResult._archivePhUrl === 'string' ? rawResult._archivePhUrl : undefined,
      _removepaywallUrl: typeof rawResult._removepaywallUrl === 'string' ? rawResult._removepaywallUrl : undefined
    };
  } catch (err) {
    const msg = typeof err?.message === 'string' ? err.message : 'Scraping failed';
    // Don't propagate circular error messages — clean them up
    const cleanMsg = msg.includes('circular') ? 'Scraping service internal error' : msg;
    return cacheFailure(cacheKey, cleanMsg);
  }

  if (!result || !result.success) {
    return cacheFailure(cacheKey, result?.error || 'Scraping failed');
  }

  // Filter images: remove ad/tracker pixels
  let filteredImages = result.content?.images || [];
  let ogImage = result.content?.ogImage || '';
  if (scraper.filterImages) {
    filteredImages = scraper.filterImages(filteredImages);
  }
  // Validate og:image and find best image
  let bestImage = '';
  if (scraper.getBestImage) {
    try {
      bestImage = await scraper.getBestImage(ogImage, result.content?.images || []);
    } catch { bestImage = ogImage; }
  } else {
    bestImage = ogImage;
  }

  // Return only serializable fields (avoid leaking axios internals)
  const response = {
    success: true,
    url: result.url || url,
    data: {
      title: result.content?.title || '',
      description: result.content?.description || '',
      ogImage: bestImage,
      text: result.content?.text || '',
      links: result.content?.links || [],
      images: filteredImages,
      structuredData: result.content?.jsonld || [],
      microdata: result.content?.microdata || []
    },
    method: result.method
  };

  // Surface Wayback Machine provenance when the response came from a
  // snapshot. Callers can check response.waybackSnapshot to know the
  // article body is from an archive rather than a live fetch.
  if (result._waybackSnapshot) {
    response.waybackSnapshot = result._waybackSnapshot;
    response.waybackUrl = result._waybackUrl;
  }
  // v2.25.86: Same for archive.ph fallback. archive.ph snapshots don't
  // expose a timestamp in the URL the way Wayback does, so we just surface
  // the archive URL itself.
  if (result._archivePhUrl) {
    response.archivePhUrl = result._archivePhUrl;
  }
  // v2.25.87: removepaywall.com provenance.
  if (result._removepaywallUrl) {
    response.removepaywallUrl = result._removepaywallUrl;
  }

  // Use raw HTML from FlareSolverr if available; otherwise do a direct fetch.
  if (typeof result._rawHtml === 'string' && result._rawHtml.length > 0) {
    response._rawHtml = result._rawHtml;
  } else {
    try {
      const axios = (await import('axios')).default;
      const htmlRes = await axios.get(url, { timeout: 15000, maxContentLength: 5 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      if (typeof htmlRes.data === 'string') {
        response._rawHtml = htmlRes.data;
      }
    } catch { /* HTML fetch optional, don't fail */ }
  }

  // Capture screenshot for render tier via separate screenshot action.
  // For FlareSolverr-solved pages, pass the CF-clearance cookies so puppeteer
  // can navigate past the challenge.
  const wantScreenshot = usePuppeteer || renderTier;
  if (wantScreenshot && scraper.execute) {
    try {
      // v2.25.88: Honor the caller's fullPage flag. Was hardcoded to false,
      // which silently swallowed render-tier customers who asked for
      // fullPage:true and got a viewport-sized PNG back. Default stays false
      // for backward compat with callers that don't set it.
      const ssOptions = { fullPage: !!fullPage };
      if (viewport && typeof viewport === 'object') ssOptions.viewport = viewport;
      if (Array.isArray(result._cookies) && result._cookies.length > 0) {
        ssOptions.cookies = result._cookies;
      }
      if (result._userAgent) ssOptions.userAgent = result._userAgent;
      // Pass the already-rendered HTML so the screenshot can be taken from it
      // (setContent) instead of re-navigating the live bot-block — this is what
      // gets thumbnails on the hardest CF/Akamai pages (e.g. congress.gov) where
      // re-navigating would re-trigger the challenge and skip the screenshot.
      if (typeof result._rawHtml === 'string' && result._rawHtml.length > 100) {
        ssOptions.html = result._rawHtml;
      }
      // Hard-cap the screenshot so it can NEVER hang the content response. The
      // page content is already captured above; the screenshot is a bonus. A
      // render that hits a slow navigation or an unresolved bot-check
      // interstitial used to block the whole request on its 30s+ internal waits
      // (federalregister/presidency/congress all timed the client out at 130s
      // even though FlareSolverr had already returned the content). Bound it and
      // return the content without a screenshot on overrun.
      const SCREENSHOT_BUDGET_MS = Number(process.env.RENDER_SCREENSHOT_BUDGET_MS) || 18000;
      const ssResult = await Promise.race([
        scraper.execute({ action: 'screenshot', url, options: ssOptions }),
        new Promise((resolve) => setTimeout(() => resolve({ success: false, _timedOut: true }), SCREENSHOT_BUDGET_MS))
      ]);
      if (ssResult?._timedOut) {
        logger.warn(`[ExternalScrape] Screenshot exceeded ${SCREENSHOT_BUDGET_MS}ms budget for ${url} — returning content without screenshot`);
      } else if (ssResult?.success && ssResult.screenshot) {
        response._screenshot = ssResult.screenshot;
      }
    } catch { /* screenshot optional, don't fail the scrape */ }
  }

  // Final safety: ensure response is serializable before returning
  try {
    JSON.stringify(response);
  } catch {
    // Strip any remaining circular refs
    const safe = {
      success: !!response.success,
      url: String(response.url || url),
      data: response.data || null,
      method: String(response.method || 'unknown'),
      _rawHtml: typeof response._rawHtml === 'string' ? response._rawHtml : undefined,
      _screenshot: typeof response._screenshot === 'string' ? response._screenshot : undefined
    };
    scrapeCache.set(cacheKey, safe);
    return safe;
  }

  scrapeCache.set(cacheKey, response);
  return response;
}

/**
 * POST /api/external/scrape
 * Single URL scrape — supports both credit and legacy payment
 * Tier: basic (1 credit), stealth (2 credits, forces Puppeteer), full (3 credits, +HTML), render (3 credits, +HTML+screenshot+FlareSolverr)
 */
/**
 * Wrap executeScrape with VPN rotation on block-like failures.
 *
 * Skipped for tier='basic' (cheerio fetches are fast and frequent — rotation
 * latency would dominate). For stealth/full/render, on a block-like failure we
 * switch the agent's ExpressVPN exit to a different region from the curated
 * pool and retry, up to MAX_VPN_ROTATIONS times.
 *
 * Test hook: { _testBlock: 'always' | 'once' } in the request body simulates a
 * block result on first attempt(s) so the rotation path is exercisable end-to-end
 * without needing a real blocked target.
 */
async function executeScrapeWithVpnRotation(req, params, tier) {
  let result = await executeScrape(req, params);

  // Test hook — simulate a block on the first call (always or once).
  const testBlock = req.body?._testBlock;
  if (testBlock && result.success) {
    logger.info(`[ExternalScrape] _testBlock=${testBlock}: simulating initial block for rotation test`);
    result = { success: false, error: '403 Forbidden (simulated block — _testBlock hook)', targetError: true };
  }

  if (tier === 'basic' || result.success || !isLikelyBlocked(result)) return result;

  const vpnEntry = req.app.locals.agent?.apiManager?.apis?.get('vpn');
  const vpn = vpnEntry?.instance || vpnEntry;
  if (!vpn?.connect || !vpn?.getVPNStatus) {
    logger.warn('[ExternalScrape] Block detected but VPN plugin not available — cannot rotate');
    return result;
  }

  let currentLocation = '';
  try {
    const status = await vpn.getVPNStatus();
    currentLocation = status?.location || status?.smartLocation || '';
  } catch { /* unknown — proceed with rotation */ }

  const tried = new Set();
  const cacheKey = `${params.extractType === 'structured' ? 'extract' : 'scrape'}:${params.url}:${JSON.stringify(params.selectors || '')}:render=${params.renderTier}`;

  for (let i = 0; i < MAX_VPN_ROTATIONS; i++) {
    // Random pick from the unused pool. `.find()` always picked the FIRST
    // non-current/non-tried entry, which meant we ping-ponged between the
    // first 2-3 regions and never exercised the rest — once Cloudflare burned
    // those, recovery dropped to zero even with a 30-region pool. Random
    // selection per request spreads load evenly across all entries.
    const candidates = VPN_ROTATION_POOL.filter(loc => loc !== currentLocation && !tried.has(loc));
    if (candidates.length === 0) break;
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    tried.add(next);

    logger.info(`[ExternalScrape] Block detected on tier=${tier} url=${params.url} — rotating VPN ${currentLocation || '?'} → ${next} (attempt ${i + 1}/${MAX_VPN_ROTATIONS})`);
    try {
      await vpn.connect({ location: next });
      // Brief stabilization
      await new Promise(r => setTimeout(r, 2500));
      currentLocation = next;
    } catch (e) {
      logger.warn(`[ExternalScrape] VPN switch to ${next} failed: ${e.message}`);
      continue;
    }

    scrapeCache.del(cacheKey);
    result = await executeScrape(req, params);

    // Test hook 'once' lets the second attempt succeed; 'always' keeps blocking.
    if (testBlock === 'always' && result.success) {
      result = { success: false, error: `403 Forbidden (simulated block — attempt ${i + 2})`, targetError: true };
    }

    if (result.success) {
      logger.info(`[ExternalScrape] Recovery via VPN ${next} succeeded for ${params.url} after ${i + 1} rotation(s)`);
      result._vpnRotated = true;
      result._vpnLocation = next;
      result._vpnRotations = i + 1;
      return result;
    }
    if (!isLikelyBlocked(result)) break; // Non-block error: stop rotating
  }

  // Exhausted rotations — return last result with rotation metadata for visibility
  result._vpnRotationsAttempted = tried.size;
  result._vpnRotationsExhausted = true;
  return result;
}

router.post('/',
  creditAuth(false), // Try credit auth but don't block legacy
  async (req, res) => {
    const { url, tier = 'basic', selectors, extractType = 'text', userAgent, fullPage = false, viewport = null } = req.body;
    const creditCost = TIER_COSTS[tier] || TIER_COSTS.basic;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'url required' });
    }
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'url must start with http:// or https://' });
    }

    // Credit-based payment
    if (req.wallet) {
      const account = await ExternalCreditBalance.findByWallet(req.wallet);
      if (!account || account.credits < creditCost) {
        return res.status(402).json({ success: false, error: 'Insufficient credits', required: creditCost, balance: account?.credits || 0, tier });
      }
      await ExternalCreditBalance.debitCredits(req.wallet, creditCost);

      try {
        const usePuppeteer = tier === 'stealth';
        const renderTier = tier === 'render';
        const result = await executeScrapeWithVpnRotation(req, { url, selectors, extractType, userAgent, usePuppeteer, renderTier, fullPage, viewport }, tier);

        if (!result.success) {
          // Refund on target failure
          await ExternalCreditBalance.refundCredits(req.wallet, creditCost);
          const acc = await ExternalCreditBalance.findByWallet(req.wallet);
          // Use the classified HTTP status (400 for NXDOMAIN, 502 for TCP-reset
          // or anti-bot, 504 for timeout) so clients can write smart retry
          // logic — e.g. don't retry 400s, exponential backoff for 502s.
          const status = result.httpStatus || 500;
          return res.status(status).json({ ...result, credited: true, creditsRefunded: creditCost, creditsRemaining: acc?.credits || 0 });
        }

        // Add HTML for full/render tiers
        if ((tier === 'full' || tier === 'render') && result._rawHtml) {
          result.data.html = result._rawHtml;
        }
        // Add screenshot for render tier
        if (tier === 'render' && result._screenshot) {
          result.data.screenshot = result._screenshot;
        }
        delete result._rawHtml;
        delete result._screenshot;

        const acc = await ExternalCreditBalance.findByWallet(req.wallet);
        result.creditsRemaining = acc?.credits || 0;
        result.tier = tier;
        result.creditsCharged = creditCost;
        // Surface rotation metadata for client visibility (and test verification)
        if (result._vpnRotated) {
          result.vpnRotation = { location: result._vpnLocation, rotations: result._vpnRotations };
        }
        delete result._vpnRotated;
        delete result._vpnLocation;
        delete result._vpnRotations;
        delete result._vpnRotationsAttempted;
        delete result._vpnRotationsExhausted;
        return res.json(result);
      } catch (error) {
        await ExternalCreditBalance.refundCredits(req.wallet, creditCost);
        const acc = await ExternalCreditBalance.findByWallet(req.wallet);
        logger.error('Scraping failed:', error.message);
        return res.status(500).json({ success: false, error: 'Scraping failed', targetError: true, credited: true, creditsRefunded: creditCost, creditsRemaining: acc?.credits || 0 });
      }
    }

    // Legacy payment fallback
    const { externalAuthMiddleware } = await import('../middleware/externalAuth.js');
    const { paymentMiddleware } = await import('../middleware/payment.js');
    externalAuthMiddleware(req, res, (err) => {
      if (err) return res.status(401).json({ success: false, error: err.message });
      paymentMiddleware('web-scraping')(req, res, async () => {
        try {
          const result = await executeScrape(req, { url, selectors, extractType, userAgent });
          if (!result.success) return res.status(500).json(result);
          res.json(result);
        } catch (error) {
          logger.error('Scraping failed:', error.message);
          res.status(500).json({ success: false, error: 'Scraping failed', targetError: true });
        }
      });
    });
  }
);

/**
 * POST /api/external/scrape/batch
 * Batch URL scrape — credit auth required (no legacy payment for batch)
 */
router.post('/batch',
  creditAuth(true),
  async (req, res) => {
    const { urls, tier = 'basic', selectors, extractType = 'text', userAgent } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ success: false, error: 'urls array is required' });
    }

    if (urls.length > 100) {
      return res.status(400).json({ success: false, error: 'Maximum 100 URLs per batch' });
    }

    const creditCost = TIER_COSTS[tier] || TIER_COSTS.basic;
    const totalCost = creditCost * urls.length;

    // Check and reserve all credits upfront
    const account = await ExternalCreditBalance.findByWallet(req.wallet);
    if (!account || account.credits < totalCost) {
      return res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        required: totalCost,
        balance: account?.credits || 0,
        perUrl: creditCost,
        urlCount: urls.length
      });
    }

    // Debit all credits upfront
    const debited = await ExternalCreditBalance.debitCredits(req.wallet, totalCost);
    if (!debited) {
      return res.status(402).json({
        success: false,
        error: 'Insufficient credits (race condition)',
        required: totalCost
      });
    }

    // Validate URLs
    const validUrls = urls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
    const invalidCount = urls.length - validUrls.length;

    // Execute scrapes
    const results = [];
    let successCount = 0;
    let failCount = 0;
    let refundTotal = 0;

    // Process in batches of 10 for controlled concurrency
    const CONCURRENCY = 10;
    for (let i = 0; i < validUrls.length; i += CONCURRENCY) {
      const batch = validUrls.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(url => executeScrape(req, { url, selectors, extractType, userAgent }))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const url = batch[j];
        const result = batchResults[j];

        if (result.status === 'fulfilled' && result.value.success) {
          successCount++;
          results.push({ url, success: true, data: result.value, credited: false });
        } else {
          failCount++;
          refundTotal += creditCost;
          const error = result.status === 'rejected'
            ? result.reason?.message || 'Scrape failed'
            : result.value?.error || 'Scrape failed';
          results.push({ url, success: false, error, credited: true });
        }
      }
    }

    // Refund credits for failed scrapes
    if (refundTotal > 0) {
      await ExternalCreditBalance.refundCredits(req.wallet, refundTotal);
    }

    // Also refund for invalid URLs (they were never attempted but credits were reserved)
    if (invalidCount > 0) {
      const invalidRefund = invalidCount * creditCost;
      await ExternalCreditBalance.refundCredits(req.wallet, invalidRefund);
      refundTotal += invalidRefund;
    }

    const updatedAccount = await ExternalCreditBalance.findByWallet(req.wallet);

    res.json({
      success: true,
      results,
      totalUrls: urls.length,
      successful: successCount,
      failed: failCount + invalidCount,
      creditsCharged: totalCost - refundTotal,
      creditsRefunded: refundTotal,
      remainingCredits: updatedAccount?.credits || 0
    });
  }
);

export default router;
