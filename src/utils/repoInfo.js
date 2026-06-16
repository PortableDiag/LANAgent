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
 * Legacy — internally delegates to parseGitUrl and returns the github.com case.
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGitHubUrl(url) {
  if (!url) return null;
  const parsed = parseGitUrl(url);
  return (parsed && parsed.host === 'github.com')
    ? { owner: parsed.owner, repo: parsed.repo }
    : null;
}

/**
 * Cross-host git URL/slug parser. Accepts:
 *   git@host:owner/repo(.git)?
 *   https://host/owner/repo(.git)?(trailing slash optional)
 *   owner/repo            (host defaults to github.com)
 * @returns {{host:string, owner:string, repo:string} | null}
 */
export function parseGitUrl(urlOrSlug) {
  if (!urlOrSlug || typeof urlOrSlug !== 'string') return null;
  const input = urlOrSlug.trim();

  const ssh = input.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };

  const https = input.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (https) return { host: https[1], owner: https[2], repo: https[3] };

  const slug = input.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slug) return { host: 'github.com', owner: slug[1], repo: slug[2] };

  return null;
}

/**
 * Accept either a URL or a `owner/repo` slug and return a normalized identity.
 */
export function normalizeRepoInput(input) {
  return input ? parseGitUrl(input) : null;
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
  } catch (error) {
    logger.debug(`repoInfo: git remote lookup failed, falling back: ${error.message}`);
  }

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
  _identityCache.clear();
}

// ========== Cross-host identity API ==========
//
// Returns { host, owner, repo, slug, source } where source is one of
//   'git'      — read from `git remote get-url <name>`
//   'env'      — read from environment variable
//   'fallback' — genesis defaults (PortableDiag/LANAgent on github.com)
// Suitable for sites that need to know WHERE the repo lives (gitlab vs github)
// or HOW the identity was resolved (for audit / debug output).

const _identityCache = new Map(); // key -> identity object

function _toIdentity(base, source) {
  return { host: base.host, owner: base.owner, repo: base.repo, slug: `${base.owner}/${base.repo}`, source };
}

function _resolveFromEnv(type) {
  const vars = type === 'origin'
    ? [process.env.GITHUB_REPOSITORY, process.env.AGENT_REPO_SLUG, process.env.GITHUB_REPO]
    : [process.env.UPSTREAM_REPOSITORY, process.env.UPSTREAM_REPO];
  for (const v of vars) {
    const parsed = normalizeRepoInput(v);
    if (parsed) return parsed;
  }
  return null;
}

function _readGitRemoteUrl(remoteName, cwd) {
  try {
    return execSync(`git remote get-url ${remoteName}`, { cwd, encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch (err) {
    logger.debug(`repoInfo: git remote "${remoteName}" lookup failed in ${cwd}: ${err.message}`);
    return null;
  }
}

export function getOriginIdentity(repoPath) {
  const cacheKey = `origin:${repoPath || ''}`;
  if (_identityCache.has(cacheKey)) return _identityCache.get(cacheKey);

  const cwd = repoPath || process.env.AGENT_REPO_PATH || process.cwd();
  const gitUrl = _readGitRemoteUrl('origin', cwd);
  if (gitUrl) {
    const parsed = parseGitUrl(gitUrl);
    if (parsed) {
      const ident = _toIdentity(parsed, 'git');
      _identityCache.set(cacheKey, ident);
      _cachedOrigin = { owner: ident.owner, repo: ident.repo };
      return ident;
    }
  }

  const envIdent = _resolveFromEnv('origin');
  if (envIdent) {
    const ident = _toIdentity(envIdent, 'env');
    _identityCache.set(cacheKey, ident);
    _cachedOrigin = { owner: ident.owner, repo: ident.repo };
    return ident;
  }

  const fallback = _toIdentity({ host: 'github.com', owner: 'PortableDiag', repo: 'LANAgent' }, 'fallback');
  _identityCache.set(cacheKey, fallback);
  _cachedOrigin = { owner: fallback.owner, repo: fallback.repo };
  return fallback;
}

export function getUpstreamIdentity() {
  if (_identityCache.has('upstream')) return _identityCache.get('upstream');

  const envIdent = _resolveFromEnv('upstream');
  if (envIdent) {
    const ident = _toIdentity(envIdent, 'env');
    _identityCache.set('upstream', ident);
    _cachedUpstream = { owner: ident.owner, repo: ident.repo };
    return ident;
  }

  const fallback = _toIdentity({ host: 'github.com', owner: 'PortableDiag', repo: 'LANAgent' }, 'fallback');
  _identityCache.set('upstream', fallback);
  _cachedUpstream = { owner: fallback.owner, repo: fallback.repo };
  return fallback;
}
