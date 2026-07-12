import { execSync } from 'child_process';
import { logger } from './logger.js';

const DEFAULT_REMOTE = 'origin';
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
  } catch {
    return DEFAULT_REMOTE; // not a repo / git unavailable — let the caller fail normally
  }

  if (remotes.length) {
    let upstream = null;
    try {
      // e.g. "upstream/main" -> "upstream"
      const ref = git('git rev-parse --abbrev-ref --symbolic-full-name @{u}', cwd);
      const name = ref.split('/')[0];
      if (name && remotes.includes(name)) upstream = name;
    } catch {
      // branch has no configured upstream — fall through
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
