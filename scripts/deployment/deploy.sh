#!/bin/bash
# Main LANAgent Deployment Script
# Handles full deployments with all files, dependencies, and proper setup

# Get script directory and source configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deploy.config"

# Deployment mode flags
SKIP_BACKUP=false
SKIP_DEPS=false
FORCE_DEPLOY=false
DRY_RUN=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-backup)
            SKIP_BACKUP=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --force)
            FORCE_DEPLOY=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            echo "LANAgent Full Deployment Script"
            echo ""
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --skip-backup    Skip creating backup on production"
            echo "  --skip-deps      Skip npm install on production"
            echo "  --force          Skip confirmation prompts"
            echo "  --dry-run        Show what would be deployed without doing it"
            echo "  --help           Show this help message"
            echo ""
            echo "This script performs a full deployment including:"
            echo "  - All source files"
            echo "  - Configuration files"
            echo "  - Package files"
            echo "  - Scripts and utilities"
            echo ""
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Show deployment mode
show_summary "Full Deployment"

# Check prerequisites
if ! check_prerequisites; then
    exit 1
fi

# Get list of files that will be deployed (for dry-run or confirmation)
echo -e "${BLUE}→${NC} Analyzing files to deploy..."
cd "$LOCAL_PATH"

# Count files to be deployed
EXCLUDE_ARGS=$(get_exclude_args "find")
FILE_COUNT=$(eval "find . -type f $EXCLUDE_ARGS" | wc -l)
DIR_COUNT=$(eval "find . -type d $EXCLUDE_ARGS" | wc -l)

echo -e "${CYAN}Files to deploy:${NC} $FILE_COUNT files in $DIR_COUNT directories"

# Show what will be deployed in dry-run mode
if [ "$DRY_RUN" = true ]; then
    echo ""
    echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
    echo ""
    echo "Would deploy the following:"
    echo "- All files except: ${EXCLUDE_PATTERNS[*]}"
    echo "- Would create backup: lanagent-backup-$(date +%Y%m%d-%H%M%S)"
    echo "- Would install npm dependencies"
    echo "- Would restart PM2 process: $PM2_PROCESS"
    exit 0
fi

# Confirmation prompt (unless forced)
if [ "$FORCE_DEPLOY" = false ]; then
    echo ""
    echo -e "${YELLOW}⚠  This will deploy ALL files to production${NC}"
    echo -e "${YELLOW}   Server: ${PRODUCTION_SERVER}${NC}"
    echo -e "${YELLOW}   Path: ${PRODUCTION_PATH}${NC}"
    echo ""
    echo -e "${GREEN}→ Proceeding with deployment...${NC}"
fi

# Create backup (unless skipped)
if [ "$SKIP_BACKUP" = false ]; then
    create_backup
else
    echo -e "${YELLOW}⚠${NC} Skipping backup as requested"
fi

# Create deployment archive
echo -e "${BLUE}→${NC} Creating deployment archive..."
ARCHIVE_NAME="deploy-full-$(date +%Y%m%d-%H%M%S).tar.gz"
ARCHIVE_PATH="/tmp/$ARCHIVE_NAME"

# Build tar command with excludes
TAR_EXCLUDES=$(get_exclude_args "tar")
TAR_CMD="tar -czf '$ARCHIVE_PATH' $TAR_EXCLUDES ."

echo -e "${CYAN}Creating archive...${NC}"
eval $TAR_CMD

# Check archive size
ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)
echo -e "${GREEN}✓${NC} Archive created: $ARCHIVE_SIZE"

# Transfer to production
if ! remote_copy "$ARCHIVE_PATH" "$PRODUCTION_PATH/" "Transferring deployment archive"; then
    rm -f "$ARCHIVE_PATH"
    exit 1
fi

# Extract and set up on production
echo -e "${BLUE}→${NC} Deploying to production..."

# Create deployment script to run on server
DEPLOY_SCRIPT=$(cat << 'DEPLOY_SCRIPT_END'
#!/bin/bash
set -e

cd PRODUCTION_PATH

# Extract archive
echo "Extracting files..."
tar -xzf ARCHIVE_NAME

# Remove archive
rm -f ARCHIVE_NAME

# Ensure directories exist
for dir in ENSURE_DIRS; do
    mkdir -p "$dir"
done

# Install dependencies if not skipped
if [ "SKIP_DEPS" = "false" ]; then
    echo ""
    echo "Installing dependencies..."
    npm install --legacy-peer-deps
else
    echo "Skipping dependency installation as requested"
fi

# Set proper permissions
chmod +x scripts/*.sh scripts/deployment/*.sh 2>/dev/null || true

# Check if .env exists
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo ""
        echo "Creating .env from .env.example..."
        cp .env.example .env
        echo "⚠️  Please update .env with your configuration!"
    else
        echo "⚠️  Warning: No .env file found!"
    fi
fi

# Restart PM2 process
echo ""
echo "Restarting application..."
pm2 restart PM2_PROCESS || pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

echo ""
echo "✅ Deployment complete!"
DEPLOY_SCRIPT_END
)

# Replace placeholders in script
DEPLOY_SCRIPT="${DEPLOY_SCRIPT//PRODUCTION_PATH/$PRODUCTION_PATH}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT//ARCHIVE_NAME/$ARCHIVE_NAME}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT//SKIP_DEPS/$SKIP_DEPS}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT//PM2_PROCESS/$PM2_PROCESS}"

# Replace ENSURE_DIRS with actual directories
ENSURE_DIRS_STR="${ENSURE_DIRS[*]}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT//ENSURE_DIRS/$ENSURE_DIRS_STR}"

# Execute deployment script on server
if ! remote_exec "$DEPLOY_SCRIPT" "Setting up deployment"; then
    echo -e "${RED}✗${NC} Deployment failed"
    rm -f "$ARCHIVE_PATH"
    exit 1
fi

# Clean up local archive
rm -f "$ARCHIVE_PATH"

# Check deployment status
echo ""
echo -e "${BLUE}→${NC} Checking deployment status..."

# Get PM2 status
remote_exec "pm2 status $PM2_PROCESS" "Checking PM2 status"

# Show recent logs
echo ""
echo -e "${BLUE}→${NC} Recent application logs:"
remote_exec "pm2 logs $PM2_PROCESS --lines 20 --nostream" "Fetching logs" || true

# Final summary
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Full deployment completed!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo -e "Server:     ${BLUE}${PRODUCTION_SERVER}${NC}"
echo -e "Path:       ${BLUE}${PRODUCTION_PATH}${NC}"
echo -e "Process:    ${BLUE}${PM2_PROCESS}${NC}"

if [ "$SKIP_BACKUP" = false ] && [ -f /tmp/.last_deployment_backup ]; then
    BACKUP_NAME=$(cat /tmp/.last_deployment_backup)
    echo -e "Backup:     ${BLUE}/root/lanagent_backups/${BACKUP_NAME}${NC}"
fi

echo ""
echo "Next steps:"
echo "  1. Check application: http://${PRODUCTION_SERVER}:${AGENT_PORT:-80}"
echo "  2. Monitor logs: ssh $PRODUCTION_USER@$PRODUCTION_SERVER 'pm2 logs $PM2_PROCESS'"
echo "  3. Check status: ssh $PRODUCTION_USER@$PRODUCTION_SERVER 'pm2 status'"
echo ""

# Clean up temp files
rm -f /tmp/.last_deployment_backup