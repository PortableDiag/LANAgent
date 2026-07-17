import jwt from 'jsonwebtoken';
import NodeCache from 'node-cache';
import { logger } from '../../../utils/logger.js';

// Track download counts per token
const downloadCounters = new NodeCache({ stdTTL: 7200, checkperiod: 300 });

// Per-token metadata for admin analytics — a parallel cache so the hot
// verify/consume path keeps its existing shape
const tokenMetadata = new NodeCache({ stdTTL: 7200, checkperiod: 300 });

// node-cache getTtl() returns the expiry as a ms epoch timestamp, NOT
// remaining seconds — convert before passing back into set()
function remainingTtlSeconds(cache, key) {
  const expiry = cache.getTtl(key);
  if (!expiry) return 60;
  return Math.max(1, Math.ceil((expiry - Date.now()) / 1000));
}

function getSecret() {
  return process.env.JWT_SECRET + '-download-tokens';
}

export function generateDownloadToken({ filePath, filename, agentId, maxDownloads = 3, expiresInMinutes = 60 }) {
  const token = jwt.sign(
    {
      type: 'download',
      filePath,
      filename,
      agentId,
      maxDownloads
    },
    getSecret(),
    { expiresIn: `${expiresInMinutes}m` }
  );

  // Initialize download counter
  downloadCounters.set(token, maxDownloads, expiresInMinutes * 60);

  tokenMetadata.set(token, {
    agentId,
    filename,
    maxDownloads,
    createdAt: Date.now(),
    consumedCount: 0,
    revoked: false
  }, expiresInMinutes * 60);

  logger.info(`Download token generated for ${filename} (agent: ${agentId}, max: ${maxDownloads})`);
  return token;
}

export function verifyDownloadToken(token) {
  try {
    const decoded = jwt.verify(token, getSecret());
    if (decoded.type !== 'download') {
      return null;
    }
    return decoded;
  } catch (error) {
    return null;
  }
}

export function consumeDownload(token) {
  const remaining = downloadCounters.get(token);

  if (remaining === undefined || remaining <= 0) {
    return false;
  }

  downloadCounters.set(token, remaining - 1, remainingTtlSeconds(downloadCounters, token));

  const meta = tokenMetadata.get(token);
  if (meta) {
    meta.consumedCount++;
    tokenMetadata.set(token, meta, remainingTtlSeconds(tokenMetadata, token));
  }
  return true;
}

/**
 * Revoke a download token, preventing further use.
 * @param {string} token - The token to revoke.
 */
export function revokeDownloadToken(token) {
  if (downloadCounters.del(token)) {
    logger.info(`Download token revoked: ${token}`);
    const meta = tokenMetadata.get(token);
    if (meta) {
      meta.revoked = true;
      tokenMetadata.set(token, meta, remainingTtlSeconds(tokenMetadata, token));
    }
  } else {
    logger.warn(`Attempted to revoke non-existent or already revoked token: ${token}`);
  }
}

/**
 * Live snapshot of download-token usage for the admin API. In-memory only —
 * covers tokens still within their TTL window; resets on restart.
 */
export function getTokenAnalytics() {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const totals = { generated: 0, consumed: 0, revoked: 0, active: 0 };
  const timeBased = { generatedLastHour: 0, generatedLast24Hours: 0 };
  const byAgent = {};

  for (const token of tokenMetadata.keys()) {
    const meta = tokenMetadata.get(token);
    if (!meta) continue;

    totals.generated++;
    totals.consumed += meta.consumedCount;
    if (meta.revoked) totals.revoked++;

    const remaining = downloadCounters.get(token);
    const active = !meta.revoked && typeof remaining === 'number' && remaining > 0;
    if (active) totals.active++;

    const agent = byAgent[meta.agentId] || (byAgent[meta.agentId] = { generated: 0, consumed: 0, revoked: 0, active: 0 });
    agent.generated++;
    agent.consumed += meta.consumedCount;
    if (meta.revoked) agent.revoked++;
    if (active) agent.active++;

    if (now - meta.createdAt <= HOUR) timeBased.generatedLastHour++;
    if (now - meta.createdAt <= 24 * HOUR) timeBased.generatedLast24Hours++;
  }

  return { totals, byAgent, timeBased, timestamp: new Date(now).toISOString() };
}
