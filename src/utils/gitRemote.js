import { execSync } from 'child_process';
import { logger } from './logger.js';

const DEFAULT_REMOTE = 'origin';
// Memoised per cwd. Deliberately not TTL'd: a repository's remote NAME is fixed
// for the life of the checkout, and the two places that can change it at runtime
// call clearGitRemoteCache() explicitly. Expiring it on a timer would re-run two
// git subprocesses per cwd, forever, to re-derive a value that did not change.
const cache = new Map(); // cwd -> remote name

function git(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

/**
 * Resolve which git remote this repo actually uses.
 *
 * Not every install names its remote "origin". An agent that mirror-pulls a
 * different fork may have had its original remote removed, leaving only e.g.
 * "upstream" — and every hardcoded `git pull origin main` then dies with
 * "No such remote 'origin'". That failure is silent in the worst way: the agent
 * keeps serving on old code and simply never updates again.
 *
 * SYNCHRONOUS ON PURPOSE. Eight call sites interpolate the return value straight
 * into a shell command — `git fetch ${resolveGitRemote(path)}`, `git reset --hard
 * ${resolveGitRemote(path)}/main`, `git remote get-url ${...}` — and two more
 * assign it to a field read later. Returning a promise from here does not throw;
 * it substitutes the string "[object Promise]" into those commands, which breaks
 * the self-update path and selfModification's own constructor while looking
 * superficially fine. If this ever needs async work, add a separate async
 * function and migrate callers deliberately.
 *
 * Resolution order:
 *   1. GIT_REMOTE_NAME (explicit operator override)
 *   2. the current branch's configured upstream (e.g. "upstream/main" -> upstream)
 *   3. "origin", when it exists
 *   4. the only/first remote defined
 *   5. "origin" as a last resort, so callers still get git's own error
 */
export function resolveGitRemote(cwd) {
  if (process.env.GIT_REMOTE_NAME) return process.env.GIT_REMOTE_NAME;
  if (cache.has(cwd)) return cache.get(cwd);

  let remote = DEFAULT_REMOTE;
  let remotes = [];
  try {
    remotes = git('git remote', cwd).split('\n').map(s => s.trim()).filter(Boolean);
  } catch (err) {
    // Not a repo / git unavailable — let the caller fail normally. Logged at debug
    // rather than error: this is an ordinary answer for a non-repo path, and the
    // caller still gets a usable default.
    logger.debug(`[git] No remotes readable for ${cwd}: ${err.message}`);
    return DEFAULT_REMOTE;
  }

  if (remotes.length) {
    let upstream = null;
    try {
      // e.g. "upstream/main" -> "upstream"
      const ref = git('git rev-parse --abbrev-ref --symbolic-full-name @{u}', cwd);
      const name = ref.split('/')[0];
      if (name && remotes.includes(name)) upstream = name;
    } catch (err) {
      // Branch has no configured upstream — fall through. A normal state for a
      // freshly created branch, so debug, not warn.
      logger.debug(`[git] No upstream configured for ${cwd}: ${err.message}`);
    }

    if (upstream) remote = upstream;
    else if (remotes.includes(DEFAULT_REMOTE)) remote = DEFAULT_REMOTE;
    else remote = remotes[0];

    if (remote !== DEFAULT_REMOTE) {
      logger.info(`[git] Using remote "${remote}" for ${cwd} (no "${DEFAULT_REMOTE}" remote configured)`);
    }
  }

  cache.set(cwd, remote);
  return remote;
}

/** Clear the memoised remote (call after adding/removing a remote at runtime). */
export function clearGitRemoteCache(cwd) {
  if (cwd) cache.delete(cwd);
  else cache.clear();
}

/**
 * Get detailed status information for a repository including remote resolution,
 * connectivity checks, and synchronization status.
 *
 * @param {string} cwd - Repository path
 * @returns {Object} Status information
 */
export function getRepositoryStatus(cwd) {
  const remoteName = resolveGitRemote(cwd);

  try {
    // Check if remote exists
    const remotes = git('git remote', cwd).split('\n').map(s => s.trim()).filter(Boolean);
    const remoteExists = remotes.includes(remoteName);

    if (!remoteExists) {
      return {
        path: cwd,
        remote: remoteName,
        exists: false,
        error: `Remote '${remoteName}' not found`
      };
    }

    // Get remote URL
    const remoteUrl = git(`git remote get-url ${remoteName}`, cwd);

    // Test connectivity
    let connected = false;
    try {
      git(`git ls-remote --heads ${remoteName}`, cwd);
      connected = true;
    } catch (err) {
      // Reported structurally as `connected: false` below; the reason used to be
      // discarded entirely, which made an auth failure and an offline host look
      // identical to a caller trying to diagnose one.
      logger.debug(`[git] Remote "${remoteName}" unreachable from ${cwd}: ${err.message}`);
    }

    // Get branch info
    let branchInfo = {};
    try {
      const branch = git('git rev-parse --abbrev-ref HEAD', cwd);
      if (branch && branch !== 'HEAD') {
        branchInfo.current = branch;

        // Try to get upstream tracking info
        try {
          const upstream = git('git rev-parse --abbrev-ref --symbolic-full-name @{u}', cwd);
          branchInfo.upstream = upstream;

          // Divergence from upstream, in one command.
          //
          // `git rev-list --count A..B` counts commits reachable from B but not A,
          // so `branch..upstream` is how far BEHIND we are, not ahead — computing
          // these as two separate ranges got the two labels the wrong way round,
          // which would tell a caller to pull when it needed to push. The
          // --left-right form reports both at once as "<behind>\t<ahead>" and
          // can't be transposed.
          try {
            const counts = git(`git rev-list --left-right --count ${upstream}...${branch}`, cwd);
            const [behind, ahead] = counts.split(/\s+/).map(n => Number.parseInt(n, 10));
            // Checked with Number.isInteger rather than `|| 0` so a genuine 0 —
            // the in-sync case, and by far the most common — is preserved instead
            // of being replaced by a fallback that happens to look identical.
            if (Number.isInteger(ahead)) branchInfo.ahead = ahead;
            if (Number.isInteger(behind)) branchInfo.behind = behind;
          } catch (err) {
            logger.debug(`[git] Could not count divergence for ${cwd}: ${err.message}`);
          }
        } catch (err) {
          logger.debug(`[git] No upstream tracking branch for ${cwd}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.debug(`[git] Could not determine branch for ${cwd}: ${err.message}`);
    }

    return {
      path: cwd,
      remote: remoteName,
      url: remoteUrl,
      exists: true,
      connected,
      branch: branchInfo
    };

  } catch (error) {
    // Unexpected: everything above is individually guarded, so reaching here means
    // the remote listing itself failed after resolveGitRemote had succeeded.
    logger.warn(`[git] Repository status failed for ${cwd}: ${error.message}`);
    return {
      path: cwd,
      remote: remoteName,
      exists: false,
      error: error.message
    };
  }
}

/**
 * Get status for multiple repositories in batch
 *
 * @param {string[]} paths - Array of repository paths
 * @returns {Object[]} Array of status objects
 */
export function getBulkRepositoryStatus(paths) {
  return paths.map(path => getRepositoryStatus(path));
}
