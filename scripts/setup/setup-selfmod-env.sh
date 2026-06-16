#!/bin/bash

# Setup script for self-modification environment on production
# This script installs GitHub CLI and configures the environment

set -e

echo "=== LANAgent Self-Modification Environment Setup ==="

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root" 
   exit 1
fi

# 1. Install GitHub CLI
echo "→ Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
    # Add GitHub CLI repository
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
    
    # Update and install
    apt-get update
    apt-get install -y gh
    echo "✓ GitHub CLI installed"
else
    echo "✓ GitHub CLI already installed"
fi

# 2. Setup development repository path
echo "→ Setting up development repository..."
REPO_PATH="${AGENT_REPO_PATH:-/root/lanagent-repo}"
AGENT_NAME="${AGENT_NAME:-LANAgent}"
GITHUB_REPO="${GITHUB_REPO:-https://github.com/PortableDiag/LANAgent}"

if [ ! -d "$REPO_PATH" ]; then
    echo "  Creating development repository at $REPO_PATH"
    git clone "$GITHUB_REPO" "$REPO_PATH"
    cd "$REPO_PATH"
    git config user.name "$AGENT_NAME Self-Mod"
    git config user.email "${AGENT_NAME,,}@lanagent.local"
    echo "✓ Development repository created"
else
    echo "✓ Development repository already exists"
    cd "$REPO_PATH"
    git pull origin main || echo "  Warning: Could not pull latest changes"
fi

# 3. Configure environment variables
echo "→ Configuring environment variables..."
ENV_FILE="$PRODUCTION_PATH/.env"

# Add to .bashrc for persistence
if ! grep -q "AGENT_REPO_PATH" /root/.bashrc; then
    echo "export AGENT_REPO_PATH=$REPO_PATH" >> /root/.bashrc
    echo "✓ Added AGENT_REPO_PATH to .bashrc"
fi

# Add to .env file if it exists
if [ -f "$ENV_FILE" ]; then
    if ! grep -q "AGENT_REPO_PATH" "$ENV_FILE"; then
        echo "" >> "$ENV_FILE"
        echo "# Self-modification configuration" >> "$ENV_FILE"
        echo "AGENT_REPO_PATH=$REPO_PATH" >> "$ENV_FILE"
        echo "AGENT_STAGING_PATH=/tmp/lanagent-staging" >> "$ENV_FILE"
        echo "✓ Added to .env file"
    else
        echo "✓ Environment already configured in .env"
    fi
else
    echo "  Warning: .env file not found at $ENV_FILE"
fi

# 4. Setup GitHub authentication
echo "→ Checking GitHub authentication..."
if ! gh auth status &> /dev/null; then
    echo ""
    echo "⚠️  GitHub CLI is not authenticated!"
    echo ""
    echo "To complete setup, you need to authenticate with GitHub:"
    echo "1. Run: gh auth login"
    echo "2. Choose 'GitHub.com'"
    echo "3. Choose 'HTTPS' for protocol"
    echo "4. Authenticate with a browser or paste your authentication token"
    echo ""
    echo "Your personal access token needs these permissions:"
    echo "- repo (Full control of private repositories)"
    echo "- workflow (Update GitHub Action workflows)"
    echo ""
    echo "Token is already in .env as GIT_PERSONAL_ACCESS_TOKEN"
else
    echo "✓ GitHub CLI is authenticated"
    gh auth status
fi

# 5. Create staging directory
echo "→ Creating staging directory..."
STAGING_PATH="/tmp/lanagent-staging"
mkdir -p "$STAGING_PATH"
echo "✓ Staging directory created at $STAGING_PATH"

# 6. Verify setup
echo ""
echo "=== Setup Summary ==="
echo "Development repo: $REPO_PATH"
echo "Staging path: $STAGING_PATH"
echo "GitHub CLI: $(gh --version | head -n1)"
echo ""

# Test git operations
cd "$REPO_PATH"
if git remote -v | grep -q "PortableDiag/LANAgent"; then
    echo "✓ Git repository configured correctly"
else
    echo "⚠️  Git repository may need configuration"
fi

# Final instructions
echo ""
echo "=== Next Steps ==="
echo "1. Restart LANAgent to load new environment variables:"
echo "   pm2 restart lan-agent"
echo ""
echo "2. If GitHub auth is needed, run:"
echo "   gh auth login"
echo ""
echo "3. Enable self-modification in the web UI:"
echo "   http://$PRODUCTION_SERVER:3000 → Self-Modification tab"
echo ""
echo "✅ Setup complete!"