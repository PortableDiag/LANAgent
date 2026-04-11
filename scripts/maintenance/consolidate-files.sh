#!/bin/bash

# Script to consolidate all project files from Brainstormer to LANAgent

echo "📁 Consolidating LANAgent files..."
echo "================================"

# Source and destination directories
BRAINSTORMER="/media/veracrypt1/NodeJS/Brainstormer"
LANAGENT="/media/veracrypt1/NodeJS/LANAgent"

# Create necessary directories
mkdir -p "$LANAGENT/scripts/deployment"
mkdir -p "$LANAGENT/scripts/development"
mkdir -p "$LANAGENT/docs"

# Move deployment scripts
echo "→ Moving deployment scripts..."
mv "$BRAINSTORMER/check-environment.sh" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/check-environment.sh" "$LANAGENT/scripts/deployment/"
mv "$BRAINSTORMER/get-telegram-id.sh" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/get-telegram-id.sh" "$LANAGENT/scripts/deployment/"
mv "$BRAINSTORMER/automated-deploy.sh" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/automated-deploy.sh" "$LANAGENT/scripts/deployment/"
mv "$BRAINSTORMER/minimal-working-deployment.sh" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/minimal-working-deployment.sh" "$LANAGENT/scripts/deployment/"
mv "$BRAINSTORMER/deploy-to-server.sh" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/deploy-to-server.sh" "$LANAGENT/scripts/deployment/"
mv "$BRAINSTORMER/fix-deployment.sh" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/fix-deployment.sh" "$LANAGENT/scripts/deployment/"
mv "$BRAINSTORMER/complete-fix.sh" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/complete-fix.sh" "$LANAGENT/scripts/deployment/"
mv "$BRAINSTORMER/deploy-lanagent.py" "$LANAGENT/scripts/deployment/" 2>/dev/null || cp "$BRAINSTORMER/deploy-lanagent.py" "$LANAGENT/scripts/deployment/"

# Move development scripts
echo "→ Moving development scripts..."
mv "$BRAINSTORMER/dev-lanagent.sh" "$LANAGENT/scripts/development/" 2>/dev/null || cp "$BRAINSTORMER/dev-lanagent.sh" "$LANAGENT/scripts/development/"
mv "$BRAINSTORMER/setup-lanagent.sh" "$LANAGENT/scripts/development/" 2>/dev/null || cp "$BRAINSTORMER/setup-lanagent.sh" "$LANAGENT/scripts/development/"

# Move documentation
echo "→ Moving documentation..."
mv "$BRAINSTORMER/ai-network-agent-design.md" "$LANAGENT/docs/" 2>/dev/null || cp "$BRAINSTORMER/ai-network-agent-design.md" "$LANAGENT/docs/"
mv "$BRAINSTORMER/SESSION-3-REPORT.md" "$LANAGENT/docs/" 2>/dev/null || cp "$BRAINSTORMER/SESSION-3-REPORT.md" "$LANAGENT/docs/"
mv "$BRAINSTORMER/DEPLOY_COMMANDS.txt" "$LANAGENT/docs/" 2>/dev/null || cp "$BRAINSTORMER/DEPLOY_COMMANDS.txt" "$LANAGENT/docs/"

# Clean up simple-deploy.sh and full-deploy.sh (consolidated into others)
rm -f "$BRAINSTORMER/simple-deploy.sh"
rm -f "$BRAINSTORMER/full-deploy.sh"

# Update prepare-deployment.sh in LANAgent root (already there)
# Keep it in root as it's a main deployment script

echo ""
echo "✅ Files consolidated!"
echo ""
echo "New structure:"
echo "$LANAGENT/"
echo "├── scripts/"
echo "│   ├── deployment/"
echo "│   │   ├── check-environment.sh"
echo "│   │   ├── get-telegram-id.sh"
echo "│   │   ├── automated-deploy.sh"
echo "│   │   ├── minimal-working-deployment.sh"
echo "│   │   └── [other deployment scripts]"
echo "│   └── development/"
echo "│       ├── dev-lanagent.sh"
echo "│       └── setup-lanagent.sh"
echo "├── docs/"
echo "│   ├── ai-network-agent-design.md"
echo "│   ├── SESSION-3-REPORT.md"
echo "│   └── DEPLOY_COMMANDS.txt"
echo "├── prepare-deployment.sh (main deployment script)"
echo "└── [rest of project files]"