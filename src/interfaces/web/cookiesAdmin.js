/**
 * Admin endpoints for managing the per-host cookie jar that yt-dlp uses to
 * download from authenticated sites (Instagram, Facebook, etc.).
 *
 * Auth: JWT, same as the other web-admin routes. NOT exposed through the
 * public gateway — this is a single-operator surface.
 *
 * Storage: Netscape-format cookies file per host at
 * `STORED_COOKIES_DIR/<host>.txt`, mode 0600. The directory persists outside
 * the deploy dir so cookies survive deployments.
 */

import express from 'express';
import { authenticateToken } from './auth.js';
import { logger } from '../../utils/logger.js';
import {
  STORED_COOKIES_DIR,
  STORED_COOKIE_HOSTS,
  ensureCookiesDir
} from '../../utils/ytdlpCookieJar.js';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

// Accept text/plain (the cookies file) up to 256 KB. Real cookie files are
// a few KB at most.
router.use(express.text({ type: ['text/plain', 'application/octet-stream'], limit: '256kb' }));

function isAllowedHost(host) {
  if (typeof host !== 'string') return false;
  const norm = host.toLowerCase();
  return STORED_COOKIE_HOSTS.includes(norm);
}

// Identify who performed the action for audit trail in central logs.
// Web JWT payload is `{ user: 'admin' }`; API-key path populates `req.apiKey.name`.
// Falls back to a generic marker so the log line never crashes.
function actorOf(req) {
  if (req.user?.user) return `jwt:${req.user.user}`;
  if (req.apiKey?.name) return `apikey:${req.apiKey.name}`;
  return 'unknown';
}

function quickValidateNetscape(body) {
  if (typeof body !== 'string' || body.length < 20) return 'cookies file is empty or too short';
  // First non-blank, non-comment line must look like a tab-separated cookie row.
  // `#HttpOnly_` rows start with `#` but are cookies, not comments.
  const lines = body.split(/\r?\n/).filter(isCookieLine).map(stripHttpOnly);
  if (lines.length === 0) return 'no cookies found in file';
  for (const l of lines) {
    const fields = l.split('\t');
    if (fields.length < 7) return `malformed cookie line (expected 7 tab-separated fields): "${l.slice(0, 60)}…"`;
  }
  return null;
}

// yt-dlp writes the plain Netscape form (7 tab-separated fields). Browser
// extensions and Chrome-derived jars additionally prefix a line with
// `#HttpOnly_` — the cookie is a real entry, not a comment, and `#HttpOnly_`
// is part of the domain field. Treating it as a comment (it starts with `#`)
// silently drops the session cookies that matter most, so strip it first.
const HTTPONLY_PREFIX = '#HttpOnly_';

function isCookieLine(line) {
  if (line.trim() === '') return false;
  if (line.startsWith(HTTPONLY_PREFIX)) return true;
  return !line.startsWith('#');
}

function stripHttpOnly(line) {
  return line.startsWith(HTTPONLY_PREFIX) ? line.slice(HTTPONLY_PREFIX.length) : line;
}

// Chrome/WebKit store cookie expiry as microseconds since 1601-01-01, and the
// live youtube.com jar on the production host is in exactly that form
// (e.g. 13410638600000000). Read as POSIX seconds those land in the year
// 400000+, so every cookie reads as "expires in a very long time" and an
// expired jar reports as healthy. Anything past this cut-off is WebKit time —
// a genuine POSIX-seconds expiry can never reach it.
const WEBKIT_EPOCH_DELTA_SECONDS = 11644473600;
const WEBKIT_DETECT_THRESHOLD = 1e12; // POSIX seconds hits this in the year 33658

/**
 * Normalize a Netscape expiry field to POSIX seconds.
 * @param {string|number} raw - The raw expiration field
 * @returns {{ seconds: number|null, format: 'posix'|'webkit'|'invalid' }}
 */
export function normalizeExpiration(raw) {
  const text = String(raw ?? '').trim();
  // parseInt would accept "123abc"; a cookie file field is all-digits or broken.
  if (!/^-?\d+$/.test(text)) return { seconds: null, format: 'invalid' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { seconds: null, format: 'invalid' };
  if (n >= WEBKIT_DETECT_THRESHOLD) {
    return { seconds: Math.floor(n / 1e6) - WEBKIT_EPOCH_DELTA_SECONDS, format: 'webkit' };
  }
  return { seconds: n, format: 'posix' };
}

/**
 * Parse a Netscape-format cookie file and extract metadata.
 * Note: the Netscape 7-field format has no HttpOnly column, so no such
 * metric is derived here — the `#HttpOnly_` line prefix is a marker on the
 * domain field, which is stripped before parsing.
 * @param {string} content - The cookie file content
 * @returns {Object} Analytics data about the cookies
 */
export function parseCookieFile(content) {
  const lines = content.split(/\r?\n/).filter(isCookieLine).map(stripHttpOnly);

  const cookies = lines.map(line => {
    const fields = line.split('\t');
    return {
      domain: fields[0],
      flag: fields[1] === 'TRUE',
      path: fields[2],
      secure: fields[3] === 'TRUE',
      expiration: normalizeExpiration(fields[4]).seconds,
      name: fields[5],
      value: fields[6]
    };
  });

  const totalCookies = cookies.length;

  // Expiration distribution
  const now = Math.floor(Date.now() / 1000);
  const expirations = {
    expired: 0,
    soon: 0, // Within 30 days
    medium: 0, // 30 days to 1 year
    long: 0, // More than 1 year
    unknown: 0 // Expiry field absent or unparseable
  };

  // Secure flag usage
  let secureCookies = 0;

  // Domain coverage
  const domains = new Set();

  for (const cookie of cookies) {
    // Expiration analysis. A null expiry was never measured — it must not be
    // bucketed as "long", which would read as a healthy, far-future cookie.
    if (cookie.expiration === null) {
      expirations.unknown++;
    } else if (cookie.expiration === 0) {
      // 0 is the Netscape session-cookie marker, not 1970.
      expirations.unknown++;
    } else if (cookie.expiration < now) {
      expirations.expired++;
    } else {
      const daysUntilExpiration = (cookie.expiration - now) / (24 * 3600);
      if (daysUntilExpiration <= 30) {
        expirations.soon++;
      } else if (daysUntilExpiration <= 365) {
        expirations.medium++;
      } else {
        expirations.long++;
      }
    }

    // Security flags
    if (cookie.secure) {
      secureCookies++;
    }

    // Domain tracking
    if (cookie.domain) {
      domains.add(cookie.domain);
    }
  }

  return {
    totalCookies,
    expirations,
    security: {
      secureCookies,
      securePercentage: totalCookies > 0 ? (secureCookies / totalCookies) * 100 : 0
    },
    domainCount: domains.size,
    domains: Array.from(domains)
  };
}

/**
 * Validate a Netscape-format cookie file with detailed format checking.
 *
 * `valid` means "yt-dlp can use this jar": every entry is structurally sound
 * AND there is at least one entry. A file with no usable cookies is a failure,
 * not a warning — reporting `valid: true` for it hands back a clean bill of
 * health for something that will break every download for the host.
 *
 * @param {string} content - The cookie file content
 * @returns {Object} Detailed validation report with line-by-line errors
 */
export function validateCookieFile(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const report = {
    valid: true,
    errors: [],
    warnings: [],
    info: {
      totalLines: lines.length,
      cookieLines: 0,
      commentLines: 0,
      blankLines: 0,
      expiredCookies: 0,
      sessionCookies: 0,
      domains: []
    }
  };

  const fail = (line, message, raw) => {
    report.valid = false;
    report.errors.push({ line, message, ...(raw === undefined ? {} : { content: raw.substring(0, 100) }) });
  };
  const warn = (line, message, raw) => {
    report.warnings.push({ line, message, ...(raw === undefined ? {} : { content: raw.substring(0, 100) }) });
  };

  // The standard header is the first non-blank line. curl and some exporters
  // write "# HTTP Cookie File" instead, which yt-dlp also accepts.
  const firstMeaningful = lines.findIndex(l => l.trim() !== '');
  const headerLine = firstMeaningful >= 0 ? lines[firstMeaningful] : '';
  if (!/^#\s*(Netscape\s+)?HTTP Cookie File/i.test(headerLine)) {
    warn(firstMeaningful >= 0 ? firstMeaningful + 1 : 1, 'Missing standard Netscape cookie file header');
  }

  const now = Math.floor(Date.now() / 1000);
  const tenYears = 10 * 365 * 24 * 3600;
  const domains = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];

    if (raw.trim() === '') {
      report.info.blankLines++;
      continue;
    }

    if (!isCookieLine(raw)) {
      report.info.commentLines++;
      continue;
    }

    report.info.cookieLines++;
    const line = stripHttpOnly(raw);
    const fields = line.split('\t');

    // A cookie with an empty value still writes a trailing tab, so 7 fields
    // with an empty last one is legal.
    if (fields.length !== 7) {
      fail(lineNumber, `Expected 7 tab-separated fields, got ${fields.length}`, raw);
      continue;
    }

    const [domain, includeSubdomains, cookiePath, secure, expiration, name] = fields;

    if (!domain || domain.trim() === '') {
      fail(lineNumber, 'Domain field is empty', raw);
    } else {
      domains.add(domain);
    }

    if (includeSubdomains !== 'TRUE' && includeSubdomains !== 'FALSE') {
      fail(lineNumber, `Flag field must be TRUE or FALSE, got "${includeSubdomains}"`, raw);
    }

    if (!cookiePath || cookiePath.trim() === '') {
      fail(lineNumber, 'Path field is empty', raw);
    } else if (!cookiePath.startsWith('/')) {
      warn(lineNumber, `Path should start with "/", got "${cookiePath}"`, raw);
    }

    if (secure !== 'TRUE' && secure !== 'FALSE') {
      fail(lineNumber, `Secure field must be TRUE or FALSE, got "${secure}"`, raw);
    }

    const { seconds, format } = normalizeExpiration(expiration);
    if (format === 'invalid') {
      fail(lineNumber, `Expiration must be a number, got "${expiration}"`, raw);
    } else if (seconds === 0) {
      // Netscape session cookie — expires when the browser closes. Legal.
      report.info.sessionCookies++;
    } else if (seconds < 0) {
      warn(lineNumber, `Expiration time is negative: ${seconds}`, raw);
    } else if (seconds < now) {
      report.info.expiredCookies++;
    } else if (seconds > now + tenYears) {
      warn(lineNumber, 'Expiration date is more than 10 years in the future', raw);
    }

    if (!name || name.trim() === '') {
      fail(lineNumber, 'Cookie name is empty', raw);
    }
  }

  report.info.domains = Array.from(domains);

  if (report.info.cookieLines === 0) {
    report.valid = false;
    report.errors.push({ line: null, message: 'No cookie entries found in file' });
  } else if (report.info.expiredCookies === report.info.cookieLines) {
    warn(null, 'Every cookie in this file has already expired');
  }

  return report;
}

router.get('/cookies', authenticateToken, async (req, res) => {
  try {
    await ensureCookiesDir();
    const entries = await fs.readdir(STORED_COOKIES_DIR);
    const out = [];
    for (const f of entries) {
      if (!f.endsWith('.txt')) continue;
      const host = f.slice(0, -4);
      try {
        const stat = await fs.stat(path.join(STORED_COOKIES_DIR, f));
        out.push({ host, size: stat.size, modified: stat.mtime.toISOString() });
      } catch {}
    }
    res.json({ success: true, supportedHosts: STORED_COOKIE_HOSTS, cookies: out });
  } catch (e) {
    logger.error('[cookies-admin] list failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/cookies/:host', authenticateToken, async (req, res) => {
  const host = String(req.params.host || '').toLowerCase();
  if (!isAllowedHost(host)) {
    return res.status(400).json({
      success: false,
      error: `Host "${host}" is not in the allow-list. Allowed: ${STORED_COOKIE_HOSTS.join(', ')}`
    });
  }
  const body = req.body;
  const validationError = quickValidateNetscape(body);
  if (validationError) {
    return res.status(400).json({ success: false, error: validationError });
  }
  try {
    await ensureCookiesDir();
    const target = path.join(STORED_COOKIES_DIR, `${host}.txt`);
    await fs.writeFile(target, body, { mode: 0o600 });
    logger.info(`[cookies-admin] uploaded cookies for ${host} (${body.length} bytes) by=${actorOf(req)}`);
    res.json({ success: true, host, bytes: body.length, path: target });
  } catch (e) {
    logger.error(`[cookies-admin] upload ${host} failed:`, e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/cookies/:host', authenticateToken, async (req, res) => {
  const host = String(req.params.host || '').toLowerCase();
  if (!isAllowedHost(host)) {
    return res.status(400).json({ success: false, error: 'Host not in allow-list' });
  }
  try {
    const target = path.join(STORED_COOKIES_DIR, `${host}.txt`);
    await fs.unlink(target);
    logger.info(`[cookies-admin] deleted cookies for ${host} by=${actorOf(req)}`);
    res.json({ success: true, host });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ success: false, error: 'No cookies file for that host' });
    logger.error(`[cookies-admin] delete ${host} failed:`, e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Get analytics and metadata for cookies of a specific host
 */
router.get('/cookies/:host/analytics', authenticateToken, async (req, res) => {
  const host = String(req.params.host || '').toLowerCase();
  if (!isAllowedHost(host)) {
    return res.status(400).json({
      success: false,
      error: `Host "${host}" is not in the allow-list. Allowed: ${STORED_COOKIE_HOSTS.join(', ')}`
    });
  }

  try {
    await ensureCookiesDir();
    const filePath = path.join(STORED_COOKIES_DIR, `${host}.txt`);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res.status(404).json({
          success: false,
          error: `No cookies file found for host: ${host}`
        });
      }
      throw e;
    }

    // Read and parse the cookie file
    const content = await fs.readFile(filePath, 'utf8');
    const analytics = parseCookieFile(content);

    res.json({
      success: true,
      host,
      analytics
    });
  } catch (e) {
    logger.error(`[cookies-admin] analytics for ${host} failed:`, e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Validate a cookie file for a host — either the one currently stored, or a
 * candidate supplied in the request body (dry-run before uploading it).
 *
 * Body handling mirrors the upload route: the router mounts `express.text()`,
 * so a `text/plain` POST arrives as a string. The app also mounts a global
 * `express.json()` ahead of this router, so an `application/json` POST of
 * `{ "content": "..." }` arrives as an object — accept both rather than 400
 * on whichever the caller happened to pick. With no body, validate the file
 * on disk, which is the question the operator actually has.
 */
router.post('/cookies/:host/validate', authenticateToken, async (req, res) => {
  const host = String(req.params.host || '').toLowerCase();
  if (!isAllowedHost(host)) {
    return res.status(400).json({
      success: false,
      error: `Host "${host}" is not in the allow-list. Allowed: ${STORED_COOKIE_HOSTS.join(', ')}`
    });
  }

  let content = null;
  let source = null;
  const body = req.body;

  if (typeof body === 'string' && body.trim() !== '') {
    content = body;
    source = 'body';
  } else if (body && typeof body === 'object' && typeof body.content === 'string' && body.content.trim() !== '') {
    content = body.content;
    source = 'body';
  }

  try {
    if (content === null) {
      await ensureCookiesDir();
      const filePath = path.join(STORED_COOKIES_DIR, `${host}.txt`);
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') {
          return res.status(404).json({
            success: false,
            error: `No cookies file found for host: ${host}. POST the file content as text/plain to validate a candidate.`
          });
        }
        throw e;
      }
      source = 'stored';
    }

    const report = validateCookieFile(content);
    logger.info(`[cookies-admin] validated ${source} cookies for ${host}: valid=${report.valid} entries=${report.info.cookieLines} errors=${report.errors.length} by=${actorOf(req)}`);

    res.json({
      success: true,
      host,
      source,
      valid: report.valid,
      report
    });
  } catch (e) {
    logger.error(`[cookies-admin] validation for ${host} failed:`, e);
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
