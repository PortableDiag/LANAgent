/**
 * FlareSolverr client — bypasses Cloudflare Turnstile / managed challenges
 * by proxying the request through a local FlareSolverr Docker container.
 *
 * Production setup (run once on the host):
 *   docker run -d --name flaresolverr --restart unless-stopped \
 *     -p 127.0.0.1:8191:8191 -e LOG_LEVEL=info --shm-size=2g \
 *     ghcr.io/flaresolverr/flaresolverr:latest
 *
 * The render tier (highest paid scraping tier) uses this as its primary
 * fetch path. Other tiers can opt in via options.useFlareSolverr.
 */

import axios from 'axios';
import { logger } from './logger.js';

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1';
const DEFAULT_MAX_TIMEOUT_MS = 60000;

let availabilityCache = { available: null, checkedAt: 0 };
const AVAILABILITY_TTL_MS = 30000;

/**
 * Probe FlareSolverr. Result is cached for 30s so we don't probe on every
 * request — but recovers within 30s if FS comes back online.
 */
export async function isFlareSolverrAvailable() {
  const now = Date.now();
  if (availabilityCache.available !== null && now - availabilityCache.checkedAt < AVAILABILITY_TTL_MS) {
    return availabilityCache.available;
  }
  try {
    const res = await axios.post(
      FLARESOLVERR_URL,
      { cmd: 'sessions.list' },
      { timeout: 3000, headers: { 'Content-Type': 'application/json' } }
    );
    const ok = res.data?.status === 'ok';
    availabilityCache = { available: ok, checkedAt: now };
    return ok;
  } catch {
    availabilityCache = { available: false, checkedAt: now };
    return false;
  }
}

/**
 * Fetch a URL through FlareSolverr.
 * Returns the FlareSolverr `solution` object (url, status, response (HTML),
 * cookies, userAgent, headers) or throws on failure.
 */
export async function fsRequestGet(url, options = {}) {
  const maxTimeout = options.maxTimeout || DEFAULT_MAX_TIMEOUT_MS;
  const body = { cmd: 'request.get', url, maxTimeout };
  if (options.userAgent) body.userAgent = options.userAgent;
  if (options.cookies) body.cookies = options.cookies;
  if (options.session) body.session = options.session;

  const defaultHeaders = { 'Content-Type': 'application/json' };
  const headers = { ...defaultHeaders, ...options.headers };

  let res;
  try {
    res = await axios.post(FLARESOLVERR_URL, body, {
      timeout: maxTimeout + 15000,
      headers
    });
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
      availabilityCache = { available: false, checkedAt: Date.now() };
      throw new Error(`FlareSolverr unreachable at ${FLARESOLVERR_URL}: ${err.code}`);
    }
    throw new Error(`FlareSolverr request failed: ${err.message}`);
  }

  if (res.data?.status !== 'ok') {
    throw new Error(`FlareSolverr error: ${res.data?.message || 'unknown'}`);
  }

  const solution = res.data.solution;
  if (!solution) {
    throw new Error('FlareSolverr returned ok but no solution');
  }
  logger.info(`[FlareSolverr] ${solution.status} ${url} (${(solution.response || '').length} bytes, ${(solution.cookies || []).length} cookies)`);
  return solution;
}

/**
 * Create or reuse a long-lived FlareSolverr browser session. Once a session
 * has solved a Cloudflare challenge, it keeps the resulting cf_clearance
 * cookie for subsequent requests — avoiding re-challenges that escalate in
 * difficulty (and eventually time out) when the same IP solves repeatedly.
 *
 * Each session is keyed by an arbitrary `key` (e.g. host name). Once
 * created, the session ID is cached in-memory for the agent's lifetime.
 * Sessions auto-expire on the FlareSolverr side after ~10 min of inactivity;
 * we recreate transparently on cache miss.
 */
const sessionCache = new Map(); // key → sessionId

export async function fsEnsureSession(key) {
  if (sessionCache.has(key)) return sessionCache.get(key);
  try {
    const res = await axios.post(
      FLARESOLVERR_URL,
      { cmd: 'sessions.create' },
      { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
    );
    const sid = res.data?.session;
    if (!sid) throw new Error(`FlareSolverr did not return a session: ${JSON.stringify(res.data)}`);
    sessionCache.set(key, sid);
    logger.info(`[FlareSolverr] session created for ${key}: ${sid}`);
    return sid;
  } catch (err) {
    throw new Error(`FlareSolverr session create failed: ${err.message}`);
  }
}

export async function fsDestroySession(key) {
  const sid = sessionCache.get(key);
  if (!sid) return;
  sessionCache.delete(key);
  try {
    await axios.post(
      FLARESOLVERR_URL,
      { cmd: 'sessions.destroy', session: sid },
      { timeout: 5000, headers: { 'Content-Type': 'application/json' } }
    );
  } catch {}
}
