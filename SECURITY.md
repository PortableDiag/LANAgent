# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Contact the maintainers via the repository's security advisory feature
3. Include steps to reproduce the vulnerability
4. Allow reasonable time for a fix before public disclosure

## Credential Management

### For Instance Operators

- All credentials are stored in `.env` (gitignored)
- Plugin API keys are stored encrypted (AES-256-GCM) in MongoDB
- The install script (`./scripts/setup/install.sh`) generates unique security keys
- **Never** commit `.env`, `CLAUDE.local.md`, or `deploy.config` to git
- Rotate credentials if you suspect exposure

### Environment Variables

| Variable | Purpose | Sensitive |
|----------|---------|-----------|
| `ANTHROPIC_API_KEY` | AI provider | Yes |
| `OPENAI_API_KEY` | AI provider | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram bot | Yes |
| `GIT_PERSONAL_ACCESS_TOKEN` | GitHub access | Yes |
| `JWT_SECRET` | Session signing | Yes |
| `ENCRYPTION_KEY` | Data encryption | Yes |
| `SSH_PASSWORD` | SSH interface | Yes |
| `MONGODB_URI` | Database | Moderate |
| `AGENT_NAME` | Instance identity | No |
| `AGENT_PORT` | Web port | No |

### For Contributors

- **Never** include credentials in PRs (automated checks will reject them)
- Use `process.env.VARIABLE_NAME` for all sensitive values
- Use `src/utils/paths.js` for file paths (no hardcoded `/root/...` paths)
- Test with your own credentials, not someone else's

## Instance Isolation

Each LANAgent instance is fully isolated:

- **Separate database** — Named after your agent (`mongodb://localhost:27017/youragent`)
- **Separate wallet** — Generated during setup, encrypted in your DB
- **Separate API keys** — Auto-generated, stored in your DB
- **Separate Telegram bot** — One bot per instance
- **Separate GitHub account** — PRs go to your fork first

## Smart Contract Ownership

The genesis agent (ALICE) has special on-chain authority:
- Owner of ScammerRegistry and SKYNET token contracts
- Other instances can interact with these contracts but are not owners
- Instances can deploy their own contract instances if desired

## Pre-commit Protection

The repository includes credential leak detection:
- `.gitleaks.toml` defines patterns for common credential formats
- CI workflows scan PRs for accidentally committed secrets
- Use `gitleaks protect --staged` before committing if you have it installed
