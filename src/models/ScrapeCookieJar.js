import mongoose from 'mongoose';

/**
 * Persistent cookie jar for scraping, keyed by hostname.
 *
 * Many anti-bot systems (DataDome, Cloudflare, Akamai) issue a long-lived
 * "I've seen this client before, skip the challenge" cookie after a
 * successful first interaction:
 *
 *   - DataDome: `datadome` cookie, ~1y TTL
 *   - Cloudflare: `cf_clearance`, ~30d
 *   - Akamai: `_abck`, varies
 *
 * Without persistence, every Puppeteer launch is a fresh "first visit" and
 * we re-trigger the challenge. With persistence, once a host's jar has a
 * datadome/cf_clearance cookie (from a successful manual solve, or from
 * a real-browser P2P agent), subsequent scrapes against that host replay
 * those cookies and the WAF lets us through without challenging.
 *
 * Stored at hostname granularity (not URL) because anti-bot cookies are
 * almost always scoped to the eTLD+1.
 */
const cookieSchema = new mongoose.Schema({
  name: { type: String, required: true },
  value: { type: String, required: true },
  domain: String,
  path: { type: String, default: '/' },
  expires: Number,   // unix seconds; -1 = session cookie
  size: Number,
  httpOnly: Boolean,
  secure: Boolean,
  session: Boolean,
  sameSite: { type: String, enum: ['Strict', 'Lax', 'None', 'no_restriction', 'lax', 'strict', 'unspecified'], default: 'Lax' },
  priority: String,
  sameParty: Boolean,
  sourceScheme: String
}, { _id: false });

const scrapeCookieJarSchema = new mongoose.Schema({
  hostname: { type: String, required: true, unique: true, index: true },
  cookies: { type: [cookieSchema], default: [] },
  // Track how often this jar has been used so we can rotate stale jars
  // and prioritize "trusted" hosts during cookie sync.
  hitCount: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: Date.now },
  // Last time we observed a successful (non-challenge) page from this host
  // while these cookies were active. Lets us detect cookie-stale-out and
  // re-trigger a manual solve if successRate plummets.
  lastSuccessAt: { type: Date }
}, {
  timestamps: true,
  collection: 'scrape_cookie_jars'
});

// Cookie names worth persisting. Everything else is noise (analytics, etc.)
// that would just bloat the jar and risk cross-session tracking artifacts.
const PERSIST_COOKIE_PATTERNS = [
  /^datadome$/i,
  /^cf_clearance$/i,
  /^cf_chl/i,
  /^_abck$/i,
  /^ak_bmsc$/i,
  /^bm_sv$/i,
  /^bm_mi$/i,
  /^px_/i,
  /^_px[0-9]?$/i,
  /^px-cookie$/i,
  /^reese84$/i,           // Imperva
  /^incap_ses_/i,         // Incapsula
  /^visid_incap_/i
];

scrapeCookieJarSchema.statics.shouldPersist = function (cookieName) {
  return PERSIST_COOKIE_PATTERNS.some(re => re.test(cookieName));
};

// Get the jar's cookies in Puppeteer's setCookie() shape, filtered to those
// that are still valid (not expired). Returns [] if no jar exists.
scrapeCookieJarSchema.statics.getCookiesForHostname = async function (hostname) {
  if (!hostname) return [];
  const jar = await this.findOne({ hostname });
  if (!jar || !jar.cookies?.length) return [];
  const now = Math.floor(Date.now() / 1000);
  const live = jar.cookies.filter(c => !c.expires || c.expires < 0 || c.expires > now);
  if (live.length !== jar.cookies.length) {
    // Lazy GC — strip expired cookies on read so the jar self-cleans
    jar.cookies = live;
    await jar.save().catch(() => {});
  }
  jar.hitCount = (jar.hitCount || 0) + 1;
  jar.lastUsedAt = new Date();
  await jar.save().catch(() => {});
  return live.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expires === 'number' ? c.expires : undefined,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || 'Lax'
  }));
};

// Save cookies returned from a Puppeteer page.cookies() call, but only the
// anti-bot-relevant ones. Merges with the existing jar (replaces same-name
// cookies). Skips entirely if no persistable cookie is present.
scrapeCookieJarSchema.statics.saveCookiesForHostname = async function (hostname, cookies) {
  if (!hostname || !Array.isArray(cookies) || cookies.length === 0) return false;
  const persistable = cookies.filter(c => c?.name && this.shouldPersist(c.name));
  if (persistable.length === 0) return false;

  const jar = await this.findOneAndUpdate(
    { hostname },
    { $setOnInsert: { hostname } },
    { upsert: true, new: true }
  );

  // Merge: replace any cookie with the same (name, domain, path) tuple
  const byKey = new Map();
  for (const c of (jar.cookies || [])) byKey.set(`${c.name}|${c.domain || ''}|${c.path || '/'}`, c);
  for (const c of persistable) byKey.set(`${c.name}|${c.domain || ''}|${c.path || '/'}`, c);
  jar.cookies = Array.from(byKey.values());
  jar.lastSuccessAt = new Date();
  await jar.save();
  return true;
};

// How quickly confidence in a jar decays with age, expressed as a half-life.
//
// The original scoring decayed 1 point per hour and stopped at 50, so anything
// older than ~2 days scored identically. Measured against production that made
// the term inert: of 500 stored jars, ZERO are under 3 days old, 11 are under
// 30 days and 421 sit between 60 and 120 days. hoursSinceSuccess therefore
// exceeded the 50-hour cap for every single row, so the term contributed a flat
// 50 to all of them. A one-week-old jar and a three-month-old jar came out four
// points apart. That is not a staleness detector.
//
// THIRTY DAYS IS AN ESTIMATE, NOT A MEASUREMENT. Deliberately conservative:
// primePageWithSavedCookies() records the observed behaviour as "the datadome
// cookie persists for ~1y and subsequent visits sail through", and nothing here
// contradicts that with evidence. A shorter half-life scores better on paper —
// 7 days separates the buckets more sharply — but it would declare 492 of 500
// live jars dead on the strength of a guess. Calibrating this properly needs
// data we do not collect yet: whether an old jar still clears the challenge.
// The score is logged on every prime so that data starts accumulating.
const FRESHNESS_HALF_LIFE_DAYS = 30;

// Weights. Expiry and age are near-equal because either one alone is sufficient
// to make a jar useless: an expired cookie is definitively dead, and a
// long-unused clearance is dead in practice whatever its expiry claims.
const W_EXPIRY = 0.45;
const W_AGE = 0.45;
const W_HITS = 0.10;

/**
 * Score a jar's freshness from a plain object — no database, no mongoose.
 *
 * Split out from the model static so the scoring can be tested and audited
 * directly, and so it can be run over a dump of real jars to check that it
 * actually discriminates. Exported for that reason.
 *
 * @param {{cookies?: Array, lastSuccessAt?: Date|string|number, hitCount?: number}} jar
 * @param {number} [now] - epoch ms, injectable so tests are not time-dependent
 * @returns {number} 0 (stale) to 100 (fresh)
 */
export function computeFreshnessScore(jar, now = Date.now()) {
  if (!jar || !Array.isArray(jar.cookies) || jar.cookies.length === 0) return 0;

  const nowSeconds = Math.floor(now / 1000);
  // Off the schema, not the model: the model const is declared below this
  // function, so reaching for it here would rely on call-time hoisting.
  const relevant = jar.cookies.filter(c => c?.name && scrapeCookieJarSchema.statics.shouldPersist(c.name));
  if (relevant.length === 0) return 0;

  // --- Expiry ---
  let expirySum = 0;
  let anyLive = false;
  for (const cookie of relevant) {
    // A session cookie (no expiry, or a negative one) is genuinely usable, just
    // not durable. Matches how getCookiesForHostname's live-filter treats it.
    //
    // Number.isFinite also catches a corrupt `expires`: a NaN would otherwise
    // survive every comparison below (NaN < 0 and NaN <= 0 are both false),
    // reach Math.min(100, NaN) and turn the entire jar's score into NaN. One bad
    // row poisoning a whole figure is the failure this guard exists to stop.
    if (!Number.isFinite(cookie.expires) || cookie.expires < 0) {
      expirySum += 80;
      anyLive = true;
      continue;
    }
    const secondsLeft = cookie.expires - nowSeconds;
    if (secondsLeft <= 0) continue; // expired: contributes 0
    anyLive = true;
    const daysLeft = secondsLeft / 86400;
    expirySum += Math.min(100, (daysLeft / 30) * 100);
  }
  // Every persistable cookie has expired. No weighting can rescue that.
  if (!anyLive) return 0;
  const expiryScore = expirySum / relevant.length;

  // --- Age since last confirmed success ---
  let ageScore = 100;
  const last = jar.lastSuccessAt ? new Date(jar.lastSuccessAt).getTime() : NaN;
  if (Number.isFinite(last)) {
    const daysSince = Math.max(0, (now - last) / 86400000);
    ageScore = 100 * Math.pow(0.5, daysSince / FRESHNESS_HALF_LIFE_DAYS);
  }
  // No lastSuccessAt at all leaves ageScore at 100 rather than 0: absence of a
  // record is not evidence of staleness, and every jar written by
  // saveCookiesForHostname has one.

  // --- Usage, as a tiebreaker only ---
  const hits = Number.isFinite(jar.hitCount) ? jar.hitCount : 0;
  const hitScore = hits > 100 ? Math.max(80, 100 - hits / 100) : 100;

  const score = (expiryScore * W_EXPIRY) + (ageScore * W_AGE) + (hitScore * W_HITS);
  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Calculate a freshness score (0-100) for a stored jar.
 *
 * @param {string} hostname - The hostname to analyze
 * @returns {Promise<number>} Freshness score from 0 (stale) to 100 (fresh)
 */
scrapeCookieJarSchema.statics.getCookieFreshnessScore = async function (hostname) {
  if (!hostname) return 0;
  const jar = await this.findOne({ hostname }).lean();
  return computeFreshnessScore(jar);
};

/**
 * Determine if a cookie jar is stale based on its freshness score.
 *
 * @param {string} hostname - The hostname to check
 * @param {number} threshold - Score below which the jar is considered stale (default: 70)
 * @returns {Promise<boolean>} True if the jar is stale
 */
scrapeCookieJarSchema.statics.isJarStale = async function (hostname, threshold = 70) {
  if (!hostname) return true;
  const score = await this.getCookieFreshnessScore(hostname);
  return score < threshold;
};

const ScrapeCookieJar = mongoose.model('ScrapeCookieJar', scrapeCookieJarSchema);
export default ScrapeCookieJar;
