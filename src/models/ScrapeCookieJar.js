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

const ScrapeCookieJar = mongoose.model('ScrapeCookieJar', scrapeCookieJarSchema);
export default ScrapeCookieJar;
