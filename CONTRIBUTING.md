# Contributing to LANAgent

## How to Contribute

LANAgent is an autonomous agent framework. Contributions come from both humans and agent instances themselves via the self-modification service.

### For Humans

1. **Fork** the repository
2. **Install** your own instance: `./scripts/setup/install.sh --quick`
3. Create a **feature branch**: `git checkout -b feature/your-feature`
4. Make your changes
5. **Test** locally
6. Submit a **PR** against `main`

### For Agent Instances (Self-Modification PRs)

Agent instances can submit improvements via the self-modification service:

1. Your agent analyzes its own code for bugs, improvements, or new features
2. It creates a PR on **your fork** (using your GitHub token)
3. **You review** the PR on your fork
4. If it's good, create a PR from your fork to `PortableDiag/LANAgent`
5. The genesis agent (ALICE) reviews community PRs before merge

This fork-based workflow ensures:
- No agent can directly modify the upstream repo
- All changes go through human review
- Good improvements propagate to all instances

## PR Guidelines

### Security Rules (CRITICAL)

- **NEVER** include API keys, passwords, private keys, or tokens in PRs
- **NEVER** include hardcoded server IPs, email addresses, or personal identifiers
- Use `.env` variables for all instance-specific values
- Use `src/utils/paths.js` for all file paths
- The CI pipeline will automatically reject PRs containing credential patterns

### Code Quality

- Check for unused imports
- Verify import paths are correct relative to the file location
- Don't add stub methods that return `true` — they silently make all conditions pass
- Use existing dependencies (`node-cache`, `retryOperation`) over adding new ones
- Replace `console.error` with `logger.error`
- Test your changes before submitting

### Common Issues in AI-Generated PRs

These are patterns we frequently see in self-modification PRs:

1. **Unused imports** — Code adds an import but never uses it
2. **Wrong relative paths** — `../utils/` when it should be `../../utils/`
3. **Placeholder implementations** — Methods that return `true` or `{}` instead of real logic
4. **Hardcoded values** — Using specific IPs, emails, or paths instead of env vars
5. **Missing error handling** — Async functions without try/catch

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USER/LANAgent.git
cd LANAgent

# Install with dev mode
./scripts/setup/install.sh

# Run in development mode (auto-restart on changes)
npm run dev
```

## Project Structure

```
src/
├── core/           # Agent core (agent.js, intent detection, memory)
├── api/            # REST API and plugins
│   ├── core/       # API framework (apiManager, basePlugin)
│   └── plugins/    # Feature plugins (email, git, crypto, etc.)
├── interfaces/     # User interfaces (web, telegram, ssh)
├── services/       # Background services (self-mod, trading, diagnostics)
├── models/         # MongoDB models
└── utils/          # Shared utilities (logger, database, paths, retry)
```

## License

By contributing, you agree that your contributions will be licensed under the project's license.
