# LANAgent self-update

Keeps an instance current with the **official** LANAgent repo — even when you've
forked it for your own agent. Installed automatically by
`scripts/setup/install.sh`; this directory is the source of truth.

## How it works

```
official repo  (upstream/main)
   │  git fetch upstream main
   ▼
your instance  ──► fast-forward / clean-merge ──► npm install (if deps changed)
                                                 ──► node --check ──► restart
                                                 ──► /health poll ──► rollback on failure
```

- `origin` is **your fork** (where your instance's own commits / self-improvement
  PRs go). Updates always come from **`upstream`** (the official repo), so a fork
  doesn't stop you from getting updates.
- Instance-specific state lives in **gitignored** files (`.env`, `data/`, `logs/`).
  The updater never touches them, and it never runs `git clean`, so extra
  untracked files survive too.

## Strategies (`LANAGENT_AUTO_UPDATE_STRATEGY` in `.env`)

| value    | behavior |
|----------|----------|
| `merge` (default) | Fast-forward when possible, else a clean merge. If your local edits make it **not merge cleanly**, it **aborts and does nothing** — your instance keeps running its current version. Resolve by hand, or set `LANAGENT_AUTO_UPDATE=false`. Never clobbers your changes. |
| `mirror` | Hard-reset to `upstream/<branch>`. Drift-proof and never gets stuck, but **discards** any local commits/edits to tracked files. For appliance instances that customize only via `.env`. |

Master switch: `LANAGENT_AUTO_UPDATE=true|false`. Also configurable:
`LANAGENT_AUTO_UPDATE_BRANCH` (default `main`), `LANAGENT_AUTO_UPDATE_REMOTE`
(default `upstream`), `AGENT_PORT` (used for the health check), `PM2_APP_NAME`
(default `lan-agent`).

## Safety rails

npm install only when `package.json`/lock changed · `node --check` on key boot
files · restart via pm2 (or `LANAGENT_SYSTEMD_SERVICE`, or `npm start`) ·
adaptive `/health` poll (30s grace, then every 10s up to ~4 min) · **auto-rollback
to the previous commit** if npm/syntax/health fails.

## Install manually (if you skipped it during setup)

```bash
REPO=$(pwd)                 # your LANAgent checkout
USER=$(whoami)
sed -e "s#@USER@#$USER#g" -e "s#@REPO@#$REPO#g" \
  scripts/ops/self-update/lanagent-self-update.service | sudo tee /etc/systemd/system/lanagent-self-update.service >/dev/null
sudo cp scripts/ops/self-update/lanagent-self-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lanagent-self-update.timer
```

Add the upstream remote if it isn't set:

```bash
git remote add upstream https://github.com/PortableDiag/LANAgent.git 2>/dev/null || true
```

Run once by hand / watch the log:

```bash
scripts/ops/self-update/lanagent-self-update.sh
tail -f logs/self-update.log
```

## Verify / test

```bash
# force one behind + dirty, confirm merge SKIPS without clobbering:
echo x >> src/index.js
scripts/ops/self-update/lanagent-self-update.sh   # logs a SKIP; your edit survives
git checkout -- src/index.js
```
