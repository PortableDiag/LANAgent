/**
 * Dynamic repository info resolution.
 *
 * Instead of hardcoding "PortableDiag/LANAgent" everywhere, all services
 * should use these functions to determine the fork owner/repo and upstream.
 * This makes multi-instance deployments work correctly — each fork resolves
 * its own identity from git remotes and env vars.
 */
import { execSync } from 'child_process';
import { logger } from './logger.js';

let _cachedOrigin = null;
let _cachedUpstream = null;

/**
 * Parse owner and repo from a GitHub URL.
 * Handles HTTPS, SSH, and .git suffix.
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGitHubUrl(url) {
  if (!url) return null;
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

/**
 * Get the fork's owner/repo from the origin remote.
 * Falls back to GITHUB_REPO env var, then to genesis defaults.
 * Cached after first call.
 */
export function getOriginRepo(repoPath) {
  if (_cachedOrigin) return _cachedOrigin;

  // Try git remote
  try {
    const cwd = repoPath || process.env.AGENT_REPO_PATH || process.cwd();
    const url = execSync('git remote get-url origin', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const parsed = parseGitHubUrl(url);
    if (parsed) {
      _cachedOrigin = parsed;
      return _cachedOrigin;
    }
  } catch {}

  // Try env var
  const envRepo = process.env.GITHUB_REPO;
  if (envRepo) {
    const parsed = parseGitHubUrl(envRepo);
    if (parsed) {
      _cachedOrigin = parsed;
      return _cachedOrigin;
    }
  }

  // Fallback to genesis
  _cachedOrigin = { owner: 'PortableDiag', repo: 'LANAgent' };
  logger.debug('repoInfo: using genesis fallback for origin (PortableDiag/LANAgent)');
  return _cachedOrigin;
}

/**
 * Get the upstream (genesis) owner/repo.
 * Reads from UPSTREAM_REPO env var, falls back to genesis defaults.
 * Cached after first call.
 */
export function getUpstreamRepo() {
  if (_cachedUpstream) return _cachedUpstream;

  const upstreamUrl = process.env.UPSTREAM_REPO;
  if (upstreamUrl) {
    const parsed = parseGitHubUrl(upstreamUrl);
    if (parsed) {
      _cachedUpstream = parsed;
      return _cachedUpstream;
    }
  }

  _cachedUpstream = { owner: 'PortableDiag', repo: 'LANAgent' };
  return _cachedUpstream;
}

/**
 * Get "owner/repo" string for the fork's origin.
 */
export function getOriginSlug(repoPath) {
  const { owner, repo } = getOriginRepo(repoPath);
  return `${owner}/${repo}`;
}

/**
 * Get "owner/repo" string for the upstream genesis repo.
 */
export function getUpstreamSlug() {
  const { owner, repo } = getUpstreamRepo();
  return `${owner}/${repo}`;
}

/**
 * Check if this instance IS the genesis (origin === upstream).
 */
export function isGenesisInstance(repoPath) {
  const origin = getOriginRepo(repoPath);
  const upstream = getUpstreamRepo();
  return origin.owner === upstream.owner && origin.repo === upstream.repo;
}

/**
 * Clear cached values (for testing or after remote changes).
 */
export function clearRepoInfoCache() {
  _cachedOrigin = null;
  _cachedUpstream = null;
}
