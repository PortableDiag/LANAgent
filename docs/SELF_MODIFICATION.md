# Self-Modification System

## Overview

The Self-Modification Service autonomously analyzes the codebase, generates improvements via AI, and creates pull requests for review. It runs on a schedule and has safety mechanisms to prevent destructive changes.

## Architecture

```
Code Analysis → AI Improvement Generation → Code Validation → PR Creation → Manual Review
```

All work happens in `/root/lanagent-repo/` (dev repo). Changes are submitted as GitHub PRs, never applied directly to production.

## Key Files

| File | Purpose |
|------|---------|
| `src/services/selfModification.js` | Main service — analysis, upgrade, PR workflow |
| `src/services/bugFixing.js` | Bug detection and fix generation |
| `src/api/plugins/bugDetector.js` | Bug scanning plugin |
| `src/api/plugins/prReviewer.js` | Automated PR review |

## Safety Mechanisms

- **Analysis-only mode** (default) — must be explicitly enabled for modifications
- **Restricted files** — `.env`, `package-lock.json` cannot be modified
- **Change limits** — max 50 lines per session, max improvements per day (configurable)
- **Code validation** — blocks PRs with dead imports, removed indexes, trivial changes
- **Resource checks** — won't run if CPU >50% or memory >70%
- **Branch namespacing** — branches include agent name to prevent multi-instance collisions

## Allowed Improvement Types

`add_comments`, `fix_todos`, `optimize_imports`, `improve_error_handling`, `add_logging`, `refactor_small`, `update_docs`, `add_types`, `performance_optimization`, `security_enhancement`, `add_api_plugin`

## Workflow

1. **Scheduled scan** runs hourly (configurable via `self-mod-scan` agenda job)
2. **Discovers targets** — scans 20 random files from the repo
3. **AI analysis** — GPT-4o analyzes each file for upgrade opportunities
4. **Selects best** — picks the highest-value improvement
5. **Creates branch** — `ALICE/auto-improve/optimize_plugin_performance-filename`
6. **Applies changes** — AI generates the improved code
7. **Validates** — checks for dead imports, syntax errors, removed functionality
8. **Creates PR** — pushes branch and opens GitHub PR with description
9. **Records** — saves Improvement record to MongoDB with status `pr_created`

## Configuration

```bash
# Schedule: runs hourly by default (agenda job: self-mod-scan)
# Daily limit: configurable in web UI → Self-Modification page
# Enable/disable: web UI toggle or API
```

## Debugging

```bash
# Logs
tail -f logs/self-modification.log

# Recent PRs
gh pr list --state all --label "auto-improve" --limit 10

# Check service state
curl -s http://localhost/api/plugin -H "X-API-Key: key" \
  -d '{"plugin":"selfMod","action":"status"}'
```

## PR Review Guidelines

When reviewing AI-generated PRs:
1. Check for unused imports (common AI mistake)
2. Verify cache invalidation is implemented
3. Check global vs per-instance state
4. Prefer existing dependencies over new ones
5. Close PRs with bad implementation but salvage good ideas
