import net from 'node:net';
import { logger } from '../../../utils/logger.js';

/**
 * Parsed access windows, memoised against the raw env string so a change to
 * AGENT_ADMIN_KEY_WINDOWS takes effect immediately rather than after a TTL.
 * Parsing is a pure, deterministic string operation — it needs no retry and no
 * expiry, only invalidation when the input changes.
 */
let windowCache = { source: null, windows: null };

/**
 * Parse comma-separated `HH:MM-HH:MM` windows into minutes from midnight.
 *
 * THROWS on anything malformed. That is deliberate: returning [] on a parse
 * failure reads as "no restriction configured", which silently disables the
 * control that a typo in the env var was meant to configure. This file's
 * contract is fail-closed, so a bad window string must deny, never allow.
 *
 * Times are server-local (ALICE runs PDT), matching the log timestamps an
 * operator would compare them against.
 *
 * @param {string} windowsStr
 * @returns {Array<{start: number, end: number}>}
 * @throws {Error} when any window is not a valid HH:MM-HH:MM range
 */
function parseTimeWindows(windowsStr) {
  if (!windowsStr || !windowsStr.trim()) return [];

  return windowsStr.split(',').map(raw => {
    const window = raw.trim();
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window);
    if (!match) {
      throw new Error(`invalid window "${window}" (expected HH:MM-HH:MM)`);
    }
    const [startH, startM, endH, endM] = match.slice(1).map(Number);
    for (const [h, m] of [[startH, startM], [endH, endM]]) {
      if (h > 23 || m > 59) {
        throw new Error(`invalid time in window "${window}" (hours 0-23, minutes 0-59)`);
      }
    }
    return { start: startH * 60 + startM, end: endH * 60 + endM };
  });
}

/**
 * Resolve the configured windows, memoised on the raw string.
 * @throws {Error} propagated from parseTimeWindows
 */
function getTimeWindows(windowsStr) {
  const source = windowsStr ?? null;
  if (windowCache.source !== source || windowCache.windows === null) {
    windowCache = { source, windows: parseTimeWindows(windowsStr) };
  }
  return windowCache.windows;
}

/**
 * Current time as minutes since local midnight.
 * @returns {number}
 */
function getCurrentTimeInMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Is now inside any allowed window? An empty list means no restriction was
 * configured — callers must only reach here when the env var was absent.
 *
 * @param {Array<{start: number, end: number}>} windows
 * @returns {boolean}
 */
function isWithinTimeWindows(windows) {
  if (!windows || windows.length === 0) return true;

  const currentTime = getCurrentTimeInMinutes();

  return windows.some(window => {
    // Overnight windows (22:00-06:00) wrap past midnight.
    if (window.start > window.end) {
      return currentTime >= window.start || currentTime <= window.end;
    }
    return currentTime >= window.start && currentTime <= window.end;
  });
}

// ---------------------------------------------------------------------------
// IP allow/block lists (memoised, fail-closed)
//
// req.ip is the socket peer: the external app does not set `trust proxy`, so a
// forwarded header cannot spoof it. The flip side: a request relayed through the
// gateway arrives from the gateway's address, so list the relay, not the end client.
// ---------------------------------------------------------------------------

let ipListCache = new Map(); // env var name -> { source, list }

/**
 * Parse comma-separated IPs / CIDR ranges (IPv4 and IPv6) into a net.BlockList.
 * net.BlockList compares parsed addresses, so `2001:0db8::1` and `2001:db8::1` are
 * the same entry and an IPv4-mapped client (::ffff:10.0.0.1) matches an IPv4 rule.
 * A hand-rolled string compare would silently miss a non-canonical BLOCK entry.
 *
 * @param {string} listStr
 * @returns {net.BlockList|null} null when the string is empty (no restriction)
 * @throws {Error} on any invalid entry, so a typo denies instead of disabling the rule
 */
function parseIPList(listStr) {
  if (!listStr || !listStr.trim()) return null;
  const list = new net.BlockList();
  let count = 0;
  for (const raw of listStr.split(',')) {
    const str = raw.trim();
    if (!str) continue;
    const slash = str.indexOf('/');
    const base = slash === -1 ? str : str.slice(0, slash);
    const version = net.isIP(base);
    if (version === 0) throw new Error(`invalid IP address "${str}"`);
    const type = version === 4 ? 'ipv4' : 'ipv6';
    if (slash === -1) {
      list.addAddress(base, type);
    } else {
      const prefixStr = str.slice(slash + 1);
      const prefix = Number(prefixStr);
      const max = version === 4 ? 32 : 128;
      if (!/^\d{1,3}$/.test(prefixStr) || prefix > max) throw new Error(`invalid prefix length in CIDR "${str}"`);
      list.addSubnet(base, prefix, type);
    }
    count++;
  }
  // Set but holding no entry (",,") is a typo, not "no restriction": deny.
  if (!count) throw new Error('the list has no entries');
  return list;
}

/** Memoised on the raw env string, like the time windows. @throws from parseIPList */
function getIPList(envName, listStr) {
  const cached = ipListCache.get(envName);
  if (!cached || cached.source !== listStr) {
    ipListCache.set(envName, { source: listStr, list: parseIPList(listStr) });
  }
  return ipListCache.get(envName).list;
}

/** Does the client IP match the list? An unparseable client IP never matches. */
function ipMatches(list, clientIP) {
  const version = net.isIP(String(clientIP || ''));
  if (version === 0) return false;
  return list.check(clientIP, version === 4 ? 'ipv4' : 'ipv6');
}

// ---------------------------------------------------------------------------
// Operator-only middleware
// ---------------------------------------------------------------------------

/**
 * Operator-only gate for endpoints on the external gateway.
 *
 * Distinct from creditAuth/hybridAuth, which authenticate *customers* (portal
 * `lsk_` keys and customer-wallet JWTs). Anything that exposes how the service
 * behaves internally — failure rates, recovery outcomes, wallet listings —
 * must use this instead, or every paying customer can read it.
 *
 * Fails closed: with no AGENT_ADMIN_KEY configured the route reports 503 rather
 * than falling open.
 */
export function adminKeyAuth(req, res, next) {
  const expected = process.env.AGENT_ADMIN_KEY;
  if (!expected) {
    return res.status(503).json({ success: false, error: 'AGENT_ADMIN_KEY not configured on this agent' });
  }

  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== expected) {
    logger.warn('Invalid admin key provided', { hadKey: !!provided, ip: req.ip });
    return res.status(401).json({ success: false, error: 'Invalid admin key' });
  }

  // --- IP allow/block lists (fail-closed; block wins over allow) ---

  for (const [envName, mode] of [['AGENT_ADMIN_KEY_BLOCKED_IPS', 'block'], ['AGENT_ADMIN_KEY_ALLOWED_IPS', 'allow']]) {
    const listStr = process.env[envName];
    if (!listStr || !listStr.trim()) continue;
    let list;
    try {
      list = getIPList(envName, listStr);
    } catch (error) {
      logger.error(`${envName} is malformed, denying admin access: ${error.message}`);
      return res.status(503).json({ success: false, error: `${envName} is misconfigured on this agent` });
    }
    const hit = ipMatches(list, req.ip);
    if (mode === 'block' ? hit : !hit) {
      logger.warn(`Admin key access denied by ${envName}`, { ip: req.ip });
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
  }

  // --- Time-window restriction ---

  const timeWindowsStr = process.env.AGENT_ADMIN_KEY_WINDOWS;
  if (timeWindowsStr && timeWindowsStr.trim()) {
    let timeWindows;
    try {
      timeWindows = getTimeWindows(timeWindowsStr);
    } catch (error) {
      // Deny rather than fall through: an unparseable window string is a
      // misconfigured restriction, not an absent one.
      logger.error(`AGENT_ADMIN_KEY_WINDOWS is malformed, denying admin access: ${error.message}`);
      return res.status(503).json({ success: false, error: 'AGENT_ADMIN_KEY_WINDOWS is misconfigured on this agent' });
    }

    if (!isWithinTimeWindows(timeWindows)) {
      logger.warn('Admin key access attempt outside allowed time windows', {
        ip: req.ip,
        currentTime: new Date().toISOString()
      });
      return res.status(403).json({ success: false, error: 'Admin key access not allowed at this time' });
    }
  }

  next();
}

export { parseTimeWindows, isWithinTimeWindows };

export default adminKeyAuth;
