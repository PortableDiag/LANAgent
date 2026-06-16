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
  const lines = body.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (lines.length === 0) return 'no cookies found in file';
  for (const l of lines) {
    const fields = l.split('\t');
    if (fields.length < 7) return `malformed cookie line (expected 7 tab-separated fields): "${l.slice(0, 60)}…"`;
  }
  return null;
}

/**
 * Parse a Netscape-format cookie file and extract metadata.
 * Note: the Netscape 7-field format has no HttpOnly column, so no such
 * metric is derived here.
 * @param {string} content - The cookie file content
 * @returns {Object} Analytics data about the cookies
 */
export function parseCookieFile(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));

  const cookies = lines.map(line => {
    const fields = line.split('\t');
    return {
      domain: fields[0],
      flag: fields[1] === 'TRUE',
      path: fields[2],
      secure: fields[3] === 'TRUE',
      expiration: parseInt(fields[4]),
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
    long: 0 // More than 1 year
  };

  // Secure flag usage
  let secureCookies = 0;

  // Domain coverage
  const domains = new Set();

  for (const cookie of cookies) {
    // Expiration analysis
    if (cookie.expiration < now) {
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

export default router;
