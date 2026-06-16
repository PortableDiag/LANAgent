#!/bin/bash
#
# LANAgent Docker Update
# Pulls latest code from upstream and rebuilds the container.
#
# Usage:
#   ./scripts/setup/docker-update.sh
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_DIR"

echo -e "${CYAN}${BOLD}LANAgent Update${NC}"
echo ""

# Check for git
if [ ! -d ".git" ]; then
    echo -e "${RED}No git repository found. Initialize with:${NC}"
    echo "  git init && git remote add upstream https://github.com/PortableDiag/LANAgent.git"
    exit 1
fi

# Save .env
cp .env .env.backup.$(date +%s) 2>/dev/null || true

# Pull latest
echo -e "${DIM}Pulling latest from upstream...${NC}"
git fetch upstream main 2>&1 | tail -3

BEHIND=$(git rev-list HEAD..upstream/main --count 2>/dev/null || echo "?")
if [ "$BEHIND" = "0" ]; then
    echo -e "${GREEN}Already up to date!${NC}"
    exit 0
fi

echo -e "${CYAN}$BEHIND new commits available${NC}"
git merge upstream/main --ff-only 2>&1 | tail -3

if [ $? -ne 0 ]; then
    echo -e "${RED}Merge failed — you may have local changes. Try:${NC}"
    echo "  git stash && git merge upstream/main && git stash pop"
    exit 1
fi

# Rebuild
echo ""
echo -e "${DIM}Rebuilding container...${NC}"
docker compose up -d --build 2>&1 | tail -5

echo ""
echo -e "${GREEN}${BOLD}Update complete!${NC}"
echo -e "${DIM}Web UI will be ready in ~3 minutes.${NC}"
docker compose ps
