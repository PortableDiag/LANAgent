# LANAgent Development Instructions

## Project Overview
LANAgent is an AI-powered autonomous agent framework for personal server management. Each instance can be given a unique name and identity via the `AGENT_NAME` environment variable.

## Quick Start

```bash
# New installation
./scripts/setup/install.sh

# Start the agent
npm start

# Or with PM2
pm2 start ecosystem.config.cjs
```

## Production Server Access

Configure your production server in `scripts/deployment/deploy.config` or via environment variables:

```bash
export PRODUCTION_SERVER="your-server-ip"
export PRODUCTION_USER="your-user"
export PRODUCTION_PASSWORD="your-password"  # Or use SSH keys
```

See `CLAUDE.local.md` (gitignored) for instance-specific credentials and configuration.

## Directory Structure

| Location | Purpose |
|----------|---------|
| Project root | Development (make changes here) |
| `$PRODUCTION_SERVER:$PRODUCTION_PATH` | Production deployment |
| `$AGENT_REPO_PATH` | Production repo (for self-analysis) |

## Key Documentation

| Doc | Path |
|-----|------|
| API Reference | `docs/api/API_README.md` |
| Logging Guide | `docs/LOGGING.md` |
| Deployment Scripts | `scripts/README.md` |
| Tests | `tests/README.md` |
| Session Reports | `docs/sessions/` |
| Feature Status | `docs/feature-progress.json` |
| Adding Paid Services | `docs/ADDING_PAID_SERVICES.md` |

## Authentication

| Service | Credentials |
|---------|-------------|
| Web UI | Password configured in `.env` or defaults to `lanagent` |
| API Key | Auto-generated on first run, stored in MongoDB |
| NL Endpoint | `POST /api/command/execute` |

Get JWT token:
```bash
curl -X POST http://localhost:$AGENT_PORT/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "your-web-password"}'
```

## PM2 Process Management

**Config file:** `ecosystem.config.cjs`

```bash
pm2 start ecosystem.config.cjs
pm2 restart ecosystem.config.cjs
pm2 stop lan-agent
pm2 logs lan-agent
```

**Log locations:**
- PM2 logs: `~/.pm2/logs/`
- App logs: `$DEPLOY_PATH/logs/`

**Note:** Web UI takes ~3 minutes to fully launch after restart.

## Deployment

| Script | Use Case |
|--------|----------|
| `./scripts/deployment/deploy-quick.sh` | Fast iteration |
| `./scripts/deployment/deploy.sh` | Full sync |
| `./scripts/deployment/deploy-files.sh src/path/file.js` | Single file |
| `./scripts/deployment/deploy-check.sh` | Health check |
| `./scripts/deployment/deploy-rollback.sh` | Rollback |

**Always run syntax check before deploying:**
```bash
node --check src/path/to/file.js
```

## Debugging

```bash
# Quick error check (configure deploy.config first)
./scripts/deployment/deploy-check.sh

# Or manually:
ssh your-server "tail -20 /path/to/deploy/logs/errors.log"
```

## Development Guidelines

### DO
- Break big tasks into smaller tasks
- Update documentation after changes
- Commit and push after completing tasks
- Check existing docs before creating new ones
- Reference `docs/api/API_README.md` for endpoints
- Use existing dependencies (Agenda, node-cache) over new ones
- Create session reports in `docs/sessions/`

### DON'T
- Recreate existing documentation
- Make up API endpoints
- Add your name to commits or docs
- Hardcode credentials (use `.env`)
- Hardcode paths (use `src/utils/paths.js`)
- Use manual scp (use deployment scripts)

## PR Review Guidelines

When reviewing AI-generated PRs:
1. Check for unused imports
2. Verify cache invalidation is implemented
3. Check global vs per-instance state
4. Prefer existing dependencies over new ones
5. Leave comments explaining decisions
6. Close PRs with bad implementation but salvage good ideas

## Documentation to Update After Changes

1. `CHANGELOG.md` - Version history
2. `docs/feature-progress.json` - Feature status
3. `docs/api/API_README.md` - API changes
4. `docs/api/LANAgent_API_Collection.postman_collection.json` - Version bump
5. `docs/sessions/SESSION-SUMMARY-YYYY-MM-DD.md` - Session report

## Environment Configuration

All instance-specific values are in `.env`. See `.env.example` for the full list.

Key variables:
- `AGENT_NAME` — Your agent's name (default: LANAgent)
- `AGENT_PORT` — Web UI port (default: 80)
- `MONGODB_URI` — Database connection string
- `ANTHROPIC_API_KEY` — Required for AI functionality
- `TELEGRAM_BOT_TOKEN` — For Telegram interface (optional)
- `DEPLOY_PATH` — Production deployment path
- `AGENT_REPO_PATH` — Git repo path for self-modification

## Node.js Environment

Requires Node.js 20+:
```bash
source ~/.nvm/nvm.sh
nvm use 20
```
