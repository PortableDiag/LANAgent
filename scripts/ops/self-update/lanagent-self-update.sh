#!/bin/bash
# LANAgent self-update — pull framework updates from the canonical upstream.
#
# Ships in the LANAgent repo and is installed by scripts/setup/install.sh so that
# every instance — including a fork you deploy for your own agent — keeps itself
# current with the official project.
#
# Model:
#   official repo (upstream/main)  ──fetch──▶  this instance
#   Your own commits (a forked/edited instance) live on `origin`; updates always
#   come from `upstream` (the official repo), independent of what origin is.
#
# Strategy (env LANAGENT_AUTO_UPDATE_STRATEGY):
#   merge  (default) — fast-forward when possible, otherwise try a clean merge.
#                      If it does NOT merge cleanly (you've edited framework
#                      code), it ABORTS and leaves the instance running its
#                      current version — it never clobbers your changes. Resolve
#                      by hand, or set LANAGENT_AUTO_UPDATE=false to stop trying.
#   mirror           — hard-reset to upstream/branch. Drift-proof and never gets
#                      stuck, but DISCARDS any local commits/edits to tracked
#                      files. For pure "appliance" instances that customize only
#                      via .env (which is gitignored and always preserved).
#
# Safety rails (both strategies): npm install only on dependency change,
# `node --check` on key files, restart, adaptive /health poll, and auto-rollback
# to the previous commit if the new version fails to come up healthy.
#
# Instance-specific state belongs in gitignored files (.env, data/, logs/); those
# are never touched. No `git clean` is run, so any extra untracked files survive.

set -u

# --- resolve the repo root (this script lives at <repo>/scripts/ops/self-update/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO" || { echo "self-update: cannot cd to repo root"; exit 1; }

# --- load .env for toggles + port (without overriding already-set environment) ---
if [ -f "$REPO/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO/.env" 2>/dev/null || true
  set +a
fi

ENABLED="${LANAGENT_AUTO_UPDATE:-true}"
STRATEGY="${LANAGENT_AUTO_UPDATE_STRATEGY:-merge}"
BRANCH="${LANAGENT_AUTO_UPDATE_BRANCH:-main}"
REMOTE="${LANAGENT_AUTO_UPDATE_REMOTE:-upstream}"
UPSTREAM_URL="${LANAGENT_UPSTREAM_URL:-https://github.com/PortableDiag/LANAgent.git}"
PORT="${AGENT_PORT:-3000}"
PM2_APP="${PM2_APP_NAME:-lan-agent}"
LOG="$REPO/logs/self-update.log"
LOCK="/tmp/lanagent-self-update.lock"

mkdir -p "$REPO/logs" 2>/dev/null || true
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG" >/dev/null; }

if [ "$ENABLED" != "true" ] && [ "$ENABLED" != "1" ]; then
  log "auto-update disabled (LANAGENT_AUTO_UPDATE=$ENABLED)"
  exit 0
fi

exec 9>"$LOCK"
flock -n 9 || { log "skip: another self-update is running"; exit 0; }

# --- ensure the upstream remote exists (default to the official repo) ---
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  if git remote add "$REMOTE" "$UPSTREAM_URL" 2>>"$LOG"; then
    log "added '$REMOTE' remote -> $UPSTREAM_URL"
  else
    log "ERROR: '$REMOTE' remote missing and could not be added"
    exit 1
  fi
fi

if ! git fetch "$REMOTE" "$BRANCH" 2>>"$LOG"; then
  log "ERROR: git fetch $REMOTE $BRANCH failed"
  exit 1
fi

PRE="$(git rev-parse HEAD)"
UP="$(git rev-parse "$REMOTE/$BRANCH")"

if [ "$PRE" = "$UP" ]; then
  log "up to date at $(git rev-parse --short HEAD)"
  exit 0
fi
if git merge-base --is-ancestor "$UP" "$PRE" 2>/dev/null; then
  log "local is ahead of $REMOTE/$BRANCH; nothing to pull"
  exit 0
fi

# Detect dependency changes across the transition BEFORE moving HEAD.
DEPS_CHANGED=0
if git diff --name-only "$PRE" "$UP" | grep -qE '^package(-lock)?\.json$'; then
  DEPS_CHANGED=1
fi

rollback() {
  log "rolling back to $(git rev-parse --short "$PRE")"
  git reset --hard "$PRE" >>"$LOG" 2>&1
  [ "$DEPS_CHANGED" = "1" ] && npm install --legacy-peer-deps --no-audit --no-fund >>"$LOG" 2>&1
}

# --- apply the update per strategy ---
case "$STRATEGY" in
  mirror)
    log "mirror: reset --hard $REMOTE/$BRANCH ($(git rev-parse --short "$PRE") -> $(git rev-parse --short "$UP"))"
    if ! git reset --hard "$UP" >>"$LOG" 2>&1; then
      log "ERROR: reset --hard failed"; exit 1
    fi
    ;;
  *)
    # merge (default): fast-forward if we can, else a clean merge, else skip.
    if git merge-base --is-ancestor "$PRE" "$UP" 2>/dev/null; then
      log "fast-forward $(git rev-parse --short "$PRE") -> $(git rev-parse --short "$UP")"
      if ! git merge --ff-only "$REMOTE/$BRANCH" >>"$LOG" 2>&1; then
        log "SKIP: fast-forward blocked by local changes to tracked files. Commit/stash them, or set LANAGENT_AUTO_UPDATE=false."
        exit 0
      fi
    else
      log "diverged from $REMOTE/$BRANCH — attempting clean merge"
      if ! git merge --no-edit "$REMOTE/$BRANCH" >>"$LOG" 2>&1; then
        git merge --abort >>"$LOG" 2>&1 || true
        log "SKIP: update does not merge cleanly with your local changes. Nothing was changed — resolve by hand, or set LANAGENT_AUTO_UPDATE=false to stop auto-updating this edited fork."
        exit 0
      fi
    fi
    ;;
esac

# --- dependencies ---
if [ "$DEPS_CHANGED" = "1" ]; then
  log "package json changed — npm install"
  if ! npm install --legacy-peer-deps --no-audit --no-fund >>"$LOG" 2>&1; then
    log "ERROR: npm install failed"; rollback; exit 1
  fi
fi

# --- syntax check key boot files ---
for f in src/index.js src/core/agent.js; do
  [ -f "$f" ] || continue
  if ! node --check "$f" 2>>"$LOG"; then
    log "ERROR: syntax check failed for $f"; rollback; exit 1
  fi
done

# --- restart the agent (pm2 if managing it, else a systemd service, else npm start) ---
restart_agent() {
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    pm2 restart "$PM2_APP" >>"$LOG" 2>&1
  elif [ -n "${LANAGENT_SYSTEMD_SERVICE:-}" ]; then
    sudo systemctl restart "$LANAGENT_SYSTEMD_SERVICE" >>"$LOG" 2>&1
  else
    log "WARN: no pm2 app '$PM2_APP' and no LANAGENT_SYSTEMD_SERVICE — cannot auto-restart; new code applies on next manual restart"
    return 1
  fi
}
restart_agent || { log "SUCCESS (no auto-restart): now at $(git rev-parse --short HEAD)"; exit 0; }

# --- adaptive health poll: 30s grace, then every 10s up to ~4 min ---
sleep 30
HEALTH_OK=0
for i in $(seq 1 22); do
  if curl -sS -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    log "  /health up at attempt $i (~$((30 + (i-1)*10))s post-restart)"
    break
  fi
  sleep 10
done

if [ "$HEALTH_OK" = "1" ]; then
  log "SUCCESS: now at $(git rev-parse --short HEAD)"
else
  log "ERROR: post-restart /health failed after ~4min"
  rollback
  restart_agent || true
fi
