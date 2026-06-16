/**
 * Shared cookie-jar configuration for the ytdlp plugin and the admin
 * cookie-management endpoints.
 *
 * Cookies are stored as Netscape-format files (yt-dlp's `--cookies` format)
 * outside the deploy dir so they survive deployments.
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { retryOperation } from './retryUtils.js';
import { logger } from './logger.js';

export const STORED_COOKIES_DIR = process.env.LANAGENT_COOKIES_DIR
  || path.join(os.homedir(), '.config', 'lanagent', 'cookies');

// Hosts whose video extractors require an authenticated session cookie.
// `Host` here is the registrable domain — subdomain matching (m.facebook.com,
// www.instagram.com, etc.) is handled by the matcher below.
export const STORED_COOKIE_HOSTS = ['instagram.com', 'facebook.com', 'fb.watch'];

// Hosts that sit behind a Cloudflare wall — yt-dlp + curl-cffi alone can't
// fetch the page; we route through FlareSolverr for cf_clearance cookies.
export const FLARESOLVERR_HOSTS = ['rumble.com', 'bitchute.com', 'bitchute.tv'];

export function hostMatches(host, domains) {
  if (!host) return false;
  return domains.some(d => host === d || host.endsWith('.' + d));
}

export function extractHost(url) {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/**
 * Ensures that the cookies directory exists, creating it if necessary.
 * Includes robust error handling and retry logic for resilience.
 *
 * @returns {Promise<string>} The path to the cookies directory.
 */
export async function ensureCookiesDir() {
  try {
    await retryOperation(async () => {
      await fs.mkdir(STORED_COOKIES_DIR, { recursive: true, mode: 0o700 });
    }, { retries: 3 });
    logger.info(`Cookies directory ensured at: ${STORED_COOKIES_DIR}`);
  } catch (error) {
    logger.error(`Failed to ensure cookies directory: ${error.message}`, { error });
    throw error;
  }
  return STORED_COOKIES_DIR;
}
