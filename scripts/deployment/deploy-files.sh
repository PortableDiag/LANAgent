#!/bin/bash
# LANAgent Partial Deployment Script
# Deploy specific files or directories to production

# Get script directory and source configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deploy.config"

# Function to show usage
show_usage() {
    echo "LANAgent Partial Deployment Script"
    echo ""
    echo "Usage: $0 [options] <file1> [file2] ... [fileN]"
    echo ""
    echo "Options:"
    echo "  --no-restart     Don't restart PM2 after deployment"
    echo "  --backup         Create backup before deploying (default: no backup for partial)"
    echo "  --dry-run        Show what would be deployed without doing it"
    echo "  --help           Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 src/index.js"
    echo "  $0 src/api/plugins/*.js"
    echo "  $0 --no-restart src/interfaces/web/public/*"
    echo "  $0 src/services/ src/core/"
    echo ""
    echo "Common file groups:"
    echo "  API Plugins:     src/api/plugins/*.js"
    echo "  Web Interface:   src/interfaces/web/public/*"
    echo "  Telegram:        src/interfaces/telegram/*"
    echo "  Core Services:   src/services/*.js"
    echo "  Models:          src/models/*.js"
    echo "  Configuration:   src/config/*.js"
    echo ""
}

# Parse options
NO_RESTART=false
CREATE_BACKUP=false
DRY_RUN=false
FILES_TO_DEPLOY=()

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-restart)
            NO_RESTART=true
            shift
            ;;
        --backup)
            CREATE_BACKUP=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        -*)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
        *)
            FILES_TO_DEPLOY+=("$1")
            shift
            ;;
    esac
done

# Check if files were specified
if [ ${#FILES_TO_DEPLOY[@]} -eq 0 ]; then
    echo -e "${RED}Error: No files specified${NC}"
    echo ""
    show_usage
    exit 1
fi

# Show deployment mode
show_summary "Partial Deployment"

# Check prerequisites
if ! check_prerequisites; then
    exit 1
fi

# Change to local path for relative file resolution
cd "$LOCAL_PATH"

# Resolve and validate files
echo -e "${BLUE}→${NC} Validating files to deploy..."
VALID_FILES=()
MISSING_FILES=()

for pattern in "${FILES_TO_DEPLOY[@]}"; do
    # Check if it's a glob pattern or specific file
    if [[ "$pattern" == *"*"* ]]; then
        # It's a glob pattern
        files=($(ls $pattern 2>/dev/null))
        if [ ${#files[@]} -eq 0 ]; then
            MISSING_FILES+=("$pattern (no matches)")
        else
            VALID_FILES+=("${files[@]}")
        fi
    else
        # It's a specific file or directory
        if [ -e "$pattern" ]; then
            VALID_FILES+=("$pattern")
        else
            MISSING_FILES+=("$pattern")
        fi
    fi
done

# Report missing files
if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    echo -e "${RED}✗ Missing files:${NC}"
    for file in "${MISSING_FILES[@]}"; do
        echo "  - $file"
    done
    echo ""
fi

# Check if we have valid files
if [ ${#VALID_FILES[@]} -eq 0 ]; then
    echo -e "${RED}No valid files to deploy${NC}"
    exit 1
fi

# Safety check: reject empty files and syntax-check JS files
EMPTY_FILES=()
SYNTAX_ERRORS=()
for file in "${VALID_FILES[@]}"; do
    if [ -f "$file" ]; then
        # Reject 0-byte files
        if [ ! -s "$file" ]; then
            EMPTY_FILES+=("$file")
        fi
        # Syntax check JS files
        if [[ "$file" == *.js ]] && command -v node &>/dev/null; then
            if ! node --check "$file" 2>/dev/null; then
                SYNTAX_ERRORS+=("$file")
            fi
        fi
    fi
done

if [ ${#EMPTY_FILES[@]} -gt 0 ]; then
    echo -e "${RED}BLOCKED: Empty (0-byte) files detected — refusing to deploy:${NC}"
    for file in "${EMPTY_FILES[@]}"; do
        echo -e "  ${RED}✗${NC} $file"
    done
    echo -e "${RED}This would overwrite production files with empty content.${NC}"
    exit 1
fi

if [ ${#SYNTAX_ERRORS[@]} -gt 0 ]; then
    echo -e "${RED}BLOCKED: JavaScript syntax errors detected:${NC}"
    for file in "${SYNTAX_ERRORS[@]}"; do
        echo -e "  ${RED}✗${NC} $file"
        node --check "$file" 2>&1 | head -5
    done
    exit 1
fi

# Remove duplicates and sort
VALID_FILES=($(printf '%s\n' "${VALID_FILES[@]}" | sort -u))

# Show files to deploy
echo -e "${GREEN}✓ Files to deploy:${NC}"
for file in "${VALID_FILES[@]}"; do
    if [ -d "$file" ]; then
        echo -e "  ${BLUE}[DIR]${NC} $file"
    else
        echo -e "  ${CYAN}[FILE]${NC} $file"
    fi
done
echo ""

# Dry run mode
if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
    echo ""
    echo "Would deploy ${#VALID_FILES[@]} files/directories"
    [ "$CREATE_BACKUP" = true ] && echo "Would create backup before deploying"
    [ "$NO_RESTART" = false ] && echo "Would restart PM2 process after deployment"
    exit 0
fi

# Show confirmation message without prompting
echo -e "${GREEN}→ Deploying ${#VALID_FILES[@]} files to production...${NC}"

# Create backup if requested
if [ "$CREATE_BACKUP" = true ]; then
    create_backup
fi

# Create deployment archive with selected files
echo -e "${BLUE}→${NC} Creating deployment archive..."
ARCHIVE_NAME="deploy-partial-$(date +%Y%m%d-%H%M%S).tar.gz"
ARCHIVE_PATH="/tmp/$ARCHIVE_NAME"

# Build file list for tar
TAR_FILES=""
for file in "${VALID_FILES[@]}"; do
    TAR_FILES+=" '$file'"
done

# Create archive
eval "tar -czf '$ARCHIVE_PATH' $TAR_FILES"
ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)
echo -e "${GREEN}✓${NC} Archive created: $ARCHIVE_SIZE"

# Transfer to production
if ! remote_copy "$ARCHIVE_PATH" "$PRODUCTION_PATH/" "Transferring files"; then
    rm -f "$ARCHIVE_PATH"
    exit 1
fi

# Extract on production
echo -e "${BLUE}→${NC} Extracting files on production..."
remote_exec "cd $PRODUCTION_PATH && tar -xzf $ARCHIVE_NAME && rm -f $ARCHIVE_NAME" "Extracting files"

# Clean up local archive
rm -f "$ARCHIVE_PATH"

# Check if package.json was updated
NEEDS_NPM=false
for file in "${VALID_FILES[@]}"; do
    if [[ "$file" == "package.json" ]] || [[ "$file" == "package-lock.json" ]]; then
        NEEDS_NPM=true
        break
    fi
done

# Install dependencies if needed
if [ "$NEEDS_NPM" = true ]; then
    echo -e "${BLUE}→${NC} Package files updated, installing dependencies..."
    remote_exec "cd $PRODUCTION_PATH && npm install --legacy-peer-deps" "Installing dependencies"
fi

# Restart PM2 unless specified not to
if [ "$NO_RESTART" = false ]; then
    echo -e "${BLUE}→${NC} Restarting application..."
    remote_exec "cd $PRODUCTION_PATH && pm2 restart ecosystem.config.cjs" "Restarting PM2"
    
    # Wait a moment for restart
    sleep 3
    
    # Check status
    echo ""
    echo -e "${BLUE}→${NC} Application status:"
    remote_exec "pm2 status $PM2_PROCESS" "Checking status"
else
    echo -e "${YELLOW}⚠${NC} Skipping PM2 restart as requested"
    echo -e "${YELLOW}   Remember to restart manually when ready:${NC}"
    echo -e "${YELLOW}   ssh $PRODUCTION_USER@$PRODUCTION_SERVER 'cd $PRODUCTION_PATH && pm2 restart ecosystem.config.cjs'${NC}"
fi

# Summary
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Partial deployment completed!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo -e "Deployed ${#VALID_FILES[@]} files to production"

# Show specific component updates
if [[ "${VALID_FILES[*]}" =~ "src/api/plugins" ]]; then
    echo -e "  ${CYAN}→ API plugins updated${NC}"
fi
if [[ "${VALID_FILES[*]}" =~ "src/interfaces/web" ]]; then
    echo -e "  ${CYAN}→ Web interface updated${NC}"
fi
if [[ "${VALID_FILES[*]}" =~ "src/interfaces/telegram" ]]; then
    echo -e "  ${CYAN}→ Telegram interface updated${NC}"
fi
if [[ "${VALID_FILES[*]}" =~ "src/services" ]]; then
    echo -e "  ${CYAN}→ Core services updated${NC}"
fi

echo ""

# Show logs if restarted
if [ "$NO_RESTART" = false ]; then
    echo -e "${BLUE}Recent logs:${NC}"
    remote_exec "pm2 logs $PM2_PROCESS --lines 10 --nostream" "Fetching logs" || true
fi