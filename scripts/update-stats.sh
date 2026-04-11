#!/bin/bash
#
# Updates stats.json with current project metrics.
# Run before a release or as part of CI.
#
# Usage: bash scripts/update-stats.sh
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
PLUGINS=$(ls src/api/plugins/*.js 2>/dev/null | wc -l)
STRATEGIES=$(ls src/services/crypto/strategies/*.js 2>/dev/null | grep -v Base | grep -v Registry | grep -v index | wc -l)
COMMITS=$(git rev-list --count HEAD 2>/dev/null || echo 0)

cat > "$PROJECT_ROOT/stats.json" << EOF
{
  "version": "${VERSION}",
  "plugins": ${PLUGINS},
  "strategies": ${STRATEGIES},
  "commits": ${COMMITS},
  "updated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "stats.json updated: v${VERSION}, ${PLUGINS} plugins, ${STRATEGIES} strategies, ${COMMITS} commits"
