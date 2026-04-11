#!/bin/bash

# Prepare LAN Agent for deployment to production server
# Creates a deployment package with all necessary files

echo "📦 Preparing LAN Agent for deployment..."

# Configuration
SOURCE_DIR="/media/veracrypt1/NodeJS/LANAgent"
DEPLOY_DIR="/tmp/lanagent-deploy"
DEPLOY_ARCHIVE="lanagent-deploy-$(date +%Y%m%d-%H%M%S).tar.gz"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Clean previous deployment
echo -e "${BLUE}→${NC} Cleaning previous deployment..."
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# Copy source files
echo -e "${BLUE}→${NC} Copying source files..."
rsync -av --exclude='node_modules' \
          --exclude='.git' \
          --exclude='logs/*' \
          --exclude='data/*' \
          --exclude='*.log' \
          --exclude='.env' \
          "$SOURCE_DIR/" "$DEPLOY_DIR/"

# Create deployment-specific files
echo -e "${BLUE}→${NC} Creating deployment files..."

# Create setup script for new server
cat > "$DEPLOY_DIR/setup-server.sh" << 'EOF'
#!/bin/bash

echo "🚀 Setting up LAN Agent on server..."

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check if running as user (not root)
if [ "$EUID" -eq 0 ]; then 
    echo -e "${RED}✗${NC} Please run as regular user, not root"
    exit 1
fi

# Create directories
echo -e "${BLUE}→${NC} Creating directories..."
mkdir -p logs data uploads quarantine workspace

# Install dependencies
echo -e "${BLUE}→${NC} Installing Node.js dependencies..."
npm install --legacy-peer-deps

# Set up environment file
if [ ! -f .env ]; then
    echo -e "${BLUE}→${NC} Creating .env file..."
    cp .env.example .env
    echo -e "${YELLOW}⚠${NC} Please edit .env with your API keys and configuration"
else
    echo -e "${GREEN}✓${NC} .env file already exists"
fi

# Set up PM2
echo -e "${BLUE}→${NC} Setting up PM2..."
pm2 delete lan-agent 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# MongoDB indexes
echo -e "${BLUE}→${NC} Creating MongoDB indexes..."
node scripts/create-indexes.js 2>/dev/null || echo "Indexes will be created on first run"

echo ""
echo -e "${GREEN}✅ Server setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Edit .env with your configuration"
echo "2. Verify MongoDB is running: sudo systemctl status mongod"
echo "3. Check agent status: pm2 status"
echo "4. View logs: pm2 logs lan-agent"
echo "5. Monitor: pm2 monit"
echo ""
echo "To start agent: pm2 start ecosystem.config.cjs"
echo "To stop agent: pm2 stop lan-agent"
echo "To restart: pm2 restart ecosystem.config.cjs"
EOF

chmod +x "$DEPLOY_DIR/setup-server.sh"

# Create index creation script
mkdir -p "$DEPLOY_DIR/scripts"
cat > "$DEPLOY_DIR/scripts/create-indexes.js" << 'EOF'
import { connectDatabase } from '../src/utils/database.js';
import { Memory, Task, Agent, SystemLog } from '../src/models/index.js';

async function createIndexes() {
    try {
        console.log('Creating MongoDB indexes...');
        await connectDatabase();
        
        // Indexes are defined in schemas, but we ensure they're created
        await Memory.createIndexes();
        await Task.createIndexes();
        await Agent.createIndexes();
        await SystemLog.createIndexes();
        
        console.log('✅ Indexes created successfully');
        process.exit(0);
    } catch (error) {
        console.error('Failed to create indexes:', error);
        process.exit(1);
    }
}

createIndexes();
EOF

# Copy deployment helper scripts
cp "/media/veracrypt1/NodeJS/Brainstormer/check-environment.sh" "$DEPLOY_DIR/"
cp "/media/veracrypt1/NodeJS/Brainstormer/get-telegram-id.sh" "$DEPLOY_DIR/"

# Create quick command reference
cat > "$DEPLOY_DIR/COMMANDS.md" << 'EOF'
# LAN Agent Quick Commands

## Environment Check
```bash
./check-environment.sh
```

## Initial Setup
```bash
./setup-server.sh
```

## PM2 Commands
```bash
pm2 status              # Check status
pm2 logs lan-agent      # View logs
pm2 restart ecosystem.config.cjs   # Restart agent
pm2 monit              # Monitor resources
```

## MongoDB Commands
```bash
sudo systemctl status mongod   # Check MongoDB status
mongosh                        # MongoDB shell
```

## Update Agent
```bash
git pull               # If using git
pm2 restart ecosystem.config.cjs  # Restart after update
```

## Telegram Setup
```bash
./get-telegram-id.sh   # Instructions to get your Telegram ID
```
EOF

# Create a deployment info file
cat > "$DEPLOY_DIR/DEPLOYMENT_INFO.txt" << EOF
LAN Agent Deployment Package
============================
Created: $(date)
Source: $SOURCE_DIR
Node Version Required: >= 20.0.0

Files included:
- All source code (src/)
- Configuration files
- Setup scripts
- PM2 ecosystem config
- Helper scripts

Not included (will be created/installed):
- node_modules/
- .env (copy from .env.example)
- logs/
- data/
EOF

# Create archive
echo -e "${BLUE}→${NC} Creating deployment archive..."
cd /tmp
tar -czf "$DEPLOY_ARCHIVE" "lanagent-deploy/"

# Calculate size
SIZE=$(du -h "$DEPLOY_ARCHIVE" | cut -f1)

echo ""
echo -e "${GREEN}✅ Deployment package ready!${NC}"
echo ""
echo "Archive: /tmp/$DEPLOY_ARCHIVE"
echo "Size: $SIZE"
echo ""
echo "To deploy to your server:"
echo "1. Copy archive: scp /tmp/$DEPLOY_ARCHIVE user@server:~/"
echo "2. SSH to server: ssh user@server"
echo "3. Extract: tar -xzf $DEPLOY_ARCHIVE"
echo "4. Enter directory: cd lanagent-deploy"
echo "5. Run setup: ./setup-server.sh"
echo ""
echo "Remember to run ./check-environment.sh first on the new server!"