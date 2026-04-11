#!/bin/bash

# Database Consolidation Deployment Script
# This script should be run on the production server

echo "=== LANAgent Database Consolidation ==="
echo "This script will consolidate all databases into 'lanagent'"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're on production
if [ ! -d "$PRODUCTION_PATH" ]; then
    echo -e "${RED}Error: This script should be run on the production server${NC}"
    exit 1
fi

cd $PRODUCTION_PATH

# Step 1: Check current database status
echo -e "${YELLOW}Step 1: Checking current database status${NC}"
node scripts/check-all-databases.js

# Step 2: Backup databases
echo -e "${YELLOW}Step 2: Creating database backup${NC}"
BACKUP_DIR="/root/mongodb-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p $BACKUP_DIR
mongodump --out=$BACKUP_DIR
echo -e "${GREEN}Backup created at: $BACKUP_DIR${NC}"

# Step 3: Run consolidation
echo -e "${YELLOW}Step 3: Running database consolidation${NC}"
read -p "Continue with database consolidation? (yes/no): " -r
if [[ $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    node scripts/consolidate-databases.js
else
    echo "Consolidation aborted."
    exit 0
fi

# Step 4: Test the application
echo -e "${YELLOW}Step 4: Testing application${NC}"
echo "Please test the application to ensure everything works correctly."
echo "Check:"
echo "  - Telegram bot functionality"
echo "  - Web interface login and data"
echo "  - Background tasks and services"
echo ""
read -p "Is everything working correctly? (yes/no): " -r
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${RED}Please fix any issues before proceeding.${NC}"
    exit 1
fi

# Step 5: Remove old databases
echo -e "${YELLOW}Step 5: Removing old databases${NC}"
echo -e "${RED}WARNING: This step cannot be undone!${NC}"
read -p "Remove old databases? (yes/no): " -r
if [[ $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    node scripts/remove-old-databases.js
else
    echo "Skipping database removal. You can run this later with:"
    echo "  node scripts/remove-old-databases.js"
fi

echo -e "${GREEN}Database consolidation complete!${NC}"
echo ""
echo "Summary:"
echo "- All data consolidated into 'lanagent' database"
echo "- Backup saved at: $BACKUP_DIR"
echo "- Old databases have been removed (if confirmed)"
echo ""
echo "Next steps:"
echo "1. Monitor logs for any database-related errors"
echo "2. Delete backup after confirming everything works: rm -rf $BACKUP_DIR"