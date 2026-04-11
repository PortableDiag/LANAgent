#!/bin/bash
# LANAgent Deployment Rollback Script
# Emergency recovery from failed deployments

# Get script directory and source configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deploy.config"

# Rollback options
LIST_ONLY=false
BACKUP_NAME=""
FORCE_ROLLBACK=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --list|-l)
            LIST_ONLY=true
            shift
            ;;
        --backup|-b)
            shift
            BACKUP_NAME="$1"
            shift
            ;;
        --force)
            FORCE_ROLLBACK=true
            shift
            ;;
        --help|-h)
            echo "LANAgent Deployment Rollback Script"
            echo ""
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --list, -l         List available backups"
            echo "  --backup name      Specify backup to restore"
            echo "  --force            Skip confirmation"
            echo "  --help             Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0 --list                    # Show all backups"
            echo "  $0                           # Restore latest backup"
            echo "  $0 --backup backup-20231215  # Restore specific backup"
            echo ""
            echo "Emergency recovery procedure:"
            echo "  1. Lists or restores from available backups"
            echo "  2. Stops current deployment"
            echo "  3. Restores files from backup"
            echo "  4. Restarts services"
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

# Check prerequisites
check_sshpass

echo -e "${RED}═══════════════════════════════════════${NC}"
echo -e "${RED}   LANAgent Emergency Rollback${NC}"
echo -e "${RED}═══════════════════════════════════════${NC}"

# Connect and get backup list
echo -e "${BLUE}→${NC} Connecting to production server..."

# Get list of backups from correct directory
BACKUPS=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "ls -dt /root/lanagent-backups/lanagent-backup-* 2>/dev/null || true")

if [ -z "$BACKUPS" ]; then
    echo -e "${RED}✗ No backups found on server${NC}"
    echo ""
    echo "To create a backup manually:"
    echo "  ssh $PRODUCTION_USER@$PRODUCTION_SERVER"
    echo "  mkdir -p /root/lanagent-backups"
    echo "  cd /root && cp -r lanagent-deploy lanagent-backups/lanagent-backup-manual-$(date +%Y%m%d-%H%M%S)"
    exit 1
fi

# Convert to array
IFS=$'\n' read -rd '' -a BACKUP_ARRAY <<<"$BACKUPS"

# List mode
if [ "$LIST_ONLY" = true ]; then
    echo ""
    echo -e "${CYAN}Available backups:${NC}"
    echo -e "${CYAN}─────────────────${NC}"
    
    for i in "${!BACKUP_ARRAY[@]}"; do
        backup="${BACKUP_ARRAY[$i]}"
        backup_name=$(basename "$backup")
        
        # Get backup info
        BACKUP_INFO=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "
            if [ -d '$backup' ]; then
                size=\$(du -sh '$backup' | cut -f1)
                date=\$(stat -c '%y' '$backup' 2>/dev/null | cut -d' ' -f1,2 | cut -d'.' -f1)
                echo \"\$size|\$date\"
            fi
        ")
        
        IFS='|' read -r size date <<< "$BACKUP_INFO"
        
        if [ $i -eq 0 ]; then
            echo -e "  ${GREEN}$((i+1)).${NC} $backup_name ${CYAN}[LATEST]${NC}"
        else
            echo -e "  $((i+1)). $backup_name"
        fi
        echo -e "      Size: $size | Created: $date"
        echo ""
    done
    
    exit 0
fi

# Select backup
if [ -z "$BACKUP_NAME" ]; then
    # Use latest backup
    SELECTED_BACKUP="${BACKUP_ARRAY[0]}"
    echo -e "${BLUE}→${NC} Using latest backup: $(basename "$SELECTED_BACKUP")"
else
    # Find specified backup
    SELECTED_BACKUP=""
    for backup in "${BACKUP_ARRAY[@]}"; do
        if [[ "$backup" == *"$BACKUP_NAME"* ]]; then
            SELECTED_BACKUP="$backup"
            break
        fi
    done
    
    if [ -z "$SELECTED_BACKUP" ]; then
        echo -e "${RED}✗ Backup not found: $BACKUP_NAME${NC}"
        echo "Use --list to see available backups"
        exit 1
    fi
fi

# Get current deployment status
echo -e "${BLUE}→${NC} Checking current deployment status..."

CURRENT_STATUS=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "
    if pm2 show $PM2_PROCESS > /dev/null 2>&1; then
        echo 'PM2_RUNNING'
    else
        echo 'PM2_STOPPED'
    fi
")

# Show rollback plan
echo ""
echo -e "${YELLOW}Rollback Plan:${NC}"
echo -e "  From: ${BLUE}$PRODUCTION_PATH${NC} (current)"
echo -e "  To:   ${BLUE}$SELECTED_BACKUP${NC} (backup)"
echo -e "  Status: $CURRENT_STATUS"
echo ""

# Confirmation
if [ "$FORCE_ROLLBACK" = false ]; then
    echo -e "${RED}⚠️  WARNING: This will replace the current deployment!${NC}"
    read -p "Continue with rollback? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Rollback cancelled."
        exit 1
    fi
fi

# Create rollback script
ROLLBACK_SCRIPT=$(cat << 'ROLLBACK_SCRIPT_END'
#!/bin/bash
set -e

echo "Starting emergency rollback..."

# Stop PM2 process if running
if pm2 show PM2_PROCESS > /dev/null 2>&1; then
    echo "→ Stopping current process..."
    pm2 stop PM2_PROCESS
fi

# Create a safety backup of current deployment
echo "→ Creating safety backup of current state..."
mkdir -p /root/lanagent-backups
SAFETY_BACKUP="/root/lanagent-backups/lanagent-rollback-safety-$(date +%Y%m%d-%H%M%S)"
cp -r "PRODUCTION_PATH" "$SAFETY_BACKUP"

# Remove current deployment
echo "→ Removing current deployment..."
rm -rf "PRODUCTION_PATH"

# Restore from backup
echo "→ Restoring from backup..."
cp -r "SELECTED_BACKUP" "PRODUCTION_PATH"

# Ensure proper permissions
chown -R $(whoami):$(whoami) "PRODUCTION_PATH"
chmod -R 755 "PRODUCTION_PATH"

# Check for .env file
if [ ! -f "PRODUCTION_PATH/.env" ]; then
    if [ -f "$SAFETY_BACKUP/.env" ]; then
        echo "→ Restoring .env from current deployment..."
        cp "$SAFETY_BACKUP/.env" "PRODUCTION_PATH/.env"
    else
        echo "⚠️  Warning: No .env file found!"
    fi
fi

# Install dependencies (in case package.json is different)
cd "PRODUCTION_PATH"
echo "→ Installing dependencies..."
npm install --legacy-peer-deps || echo "⚠️  npm install had issues (continuing)"

# Restart PM2 process
echo "→ Starting process..."
pm2 start ecosystem.config.cjs || pm2 restart ecosystem.config.cjs

# Save PM2 state
pm2 save

echo ""
echo "✅ Rollback completed!"
echo "Safety backup saved at: $SAFETY_BACKUP"
ROLLBACK_SCRIPT_END
)

# Replace placeholders
ROLLBACK_SCRIPT="${ROLLBACK_SCRIPT//PM2_PROCESS/$PM2_PROCESS}"
ROLLBACK_SCRIPT="${ROLLBACK_SCRIPT//PRODUCTION_PATH/$PRODUCTION_PATH}"
ROLLBACK_SCRIPT="${ROLLBACK_SCRIPT//SELECTED_BACKUP/$SELECTED_BACKUP}"

# Execute rollback
echo -e "${BLUE}→${NC} Executing rollback..."

if ! remote_exec "$ROLLBACK_SCRIPT" "Rollback process"; then
    echo -e "${RED}✗ Rollback failed!${NC}"
    echo ""
    echo "Manual recovery steps:"
    echo "  1. SSH to server: ssh $PRODUCTION_USER@$PRODUCTION_SERVER"
    echo "  2. Check /root/lanagent_backups for backups"
    echo "  3. Manually copy files and restart"
    exit 1
fi

# Verify rollback
echo ""
echo -e "${BLUE}→${NC} Verifying rollback..."

# Wait for startup
sleep 5

# Check PM2 status
remote_exec "pm2 status $PM2_PROCESS" "Checking process status"

# Show recent logs
echo ""
echo -e "${BLUE}→${NC} Recent logs after rollback:"
remote_exec "pm2 logs $PM2_PROCESS --lines 20 --nostream" "Fetching logs" || true

# Final status
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Rollback completed successfully!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo -e "Restored from: ${BLUE}$(basename "$SELECTED_BACKUP")${NC}"
echo ""
echo "Next steps:"
echo "  1. Verify application functionality"
echo "  2. Check logs: pm2 logs $PM2_PROCESS"
echo "  3. Monitor: ./deploy-check.sh --monitor"
echo ""
echo -e "${YELLOW}Note: A safety backup was created on the server${NC}"