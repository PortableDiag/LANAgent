#!/bin/bash
# LANAgent Quick Deployment Script
# Fast deployment for development iterations - skips confirmations and backups

# Get script directory and source configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deploy.config"

# Quick deploy specific settings
DEPLOY_MODE="auto"  # auto, git, or files
GIT_BRANCH=""
FILES_PATTERN=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --git)
            DEPLOY_MODE="git"
            shift
            if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
                GIT_BRANCH="$1"
                shift
            fi
            ;;
        --files)
            DEPLOY_MODE="files"
            shift
            if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
                FILES_PATTERN="$1"
                shift
            fi
            ;;
        --help|-h)
            echo "LANAgent Quick Deployment Script"
            echo ""
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --git [branch]   Deploy latest changes from git"
            echo "  --files pattern  Deploy files matching pattern"
            echo "  --help           Show this help message"
            echo ""
            echo "Default mode (auto):"
            echo "  - Detects modified files since last deployment"
            echo "  - Deploys only changed files"
            echo "  - Skips backups and confirmations"
            echo ""
            echo "Examples:"
            echo "  $0                    # Auto-detect and deploy changes"
            echo "  $0 --git              # Deploy latest from current branch"
            echo "  $0 --git feature/x    # Deploy specific branch"
            echo "  $0 --files 'src/*.js' # Deploy matching files"
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
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   LANAgent Quick Deploy (${DEPLOY_MODE})${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Check prerequisites
check_sshpass

# Change to local path
cd "$LOCAL_PATH"

# Quick connectivity check
if ! sshpass -p "$PRODUCTION_PASS" ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "echo 'OK' > /dev/null 2>&1"; then
    echo -e "${RED}✗${NC} Cannot connect to server"
    exit 1
fi

# Track deployment time
DEPLOY_START=$(date +%s)

# Handle different deployment modes
case $DEPLOY_MODE in
    "git")
        echo -e "${BLUE}→${NC} Git deployment mode"
        
        # Check for uncommitted changes
        if [[ -n $(git status --porcelain) ]]; then
            echo -e "${YELLOW}⚠${NC} You have uncommitted changes:"
            git status --short
            echo ""
            read -p "Commit these changes first? (y/N) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                read -p "Commit message: " COMMIT_MSG
                git add -A
                git commit -m "$COMMIT_MSG"
            fi
        fi
        
        # Push to git
        echo -e "${BLUE}→${NC} Pushing to git..."
        git push origin ${GIT_BRANCH:-HEAD}
        
        # Deploy from git on server
        echo -e "${BLUE}→${NC} Pulling latest on production..."
        remote_exec "cd $PRODUCTION_PATH && git pull origin ${GIT_BRANCH:-main}" "Git pull"
        ;;
        
    "files")
        echo -e "${BLUE}→${NC} Pattern deployment mode"
        
        if [ -z "$FILES_PATTERN" ]; then
            # Common quick patterns
            echo "Quick deploy patterns:"
            echo "  1) API plugins (src/api/plugins/*.js)"
            echo "  2) Web interface (src/interfaces/web/public/*)"
            echo "  3) Services (src/services/*.js)"
            echo "  4) All JS files (src/**/*.js)"
            read -p "Select pattern (1-4) or enter custom: " PATTERN_CHOICE
            
            case $PATTERN_CHOICE in
                1) FILES_PATTERN="src/api/plugins/*.js" ;;
                2) FILES_PATTERN="src/interfaces/web/public/*" ;;
                3) FILES_PATTERN="src/services/*.js" ;;
                4) FILES_PATTERN="src/**/*.js" ;;
                *) FILES_PATTERN="$PATTERN_CHOICE" ;;
            esac
        fi
        
        # Deploy matching files
        echo -e "${BLUE}→${NC} Deploying files: $FILES_PATTERN"
        exec "$SCRIPT_DIR/deploy-files.sh" --no-restart $FILES_PATTERN
        ;;
        
    "auto")
        echo -e "${BLUE}→${NC} Auto-detecting changes..."
        
        # Create a marker file to track last deployment
        MARKER_FILE="$HOME/.lanagent_last_deploy"
        
        if [ -f "$MARKER_FILE" ]; then
            # Find files modified since last deployment
            LAST_DEPLOY=$(stat -c %Y "$MARKER_FILE" 2>/dev/null || stat -f %m "$MARKER_FILE" 2>/dev/null)
            CURRENT_TIME=$(date +%s)
            TIME_DIFF=$((CURRENT_TIME - LAST_DEPLOY))
            
            echo -e "${CYAN}Last deployment: $(date -d @$LAST_DEPLOY 2>/dev/null || date -r $LAST_DEPLOY) (${TIME_DIFF}s ago)${NC}"
            
            # Find modified files
            MODIFIED_FILES=()
            while IFS= read -r -d '' file; do
                # Skip excluded patterns
                skip=false
                for pattern in "${EXCLUDE_PATTERNS[@]}"; do
                    if [[ "$file" == *"$pattern"* ]]; then
                        skip=true
                        break
                    fi
                done
                
                if [ "$skip" = false ]; then
                    MODIFIED_FILES+=("$file")
                fi
            done < <(find . -type f -newer "$MARKER_FILE" -print0)
            
            if [ ${#MODIFIED_FILES[@]} -eq 0 ]; then
                echo -e "${YELLOW}No files modified since last deployment${NC}"
                exit 0
            fi
            
            echo -e "${GREEN}Found ${#MODIFIED_FILES[@]} modified files:${NC}"
            for file in "${MODIFIED_FILES[@]:0:10}"; do
                echo "  • $file"
            done
            if [ ${#MODIFIED_FILES[@]} -gt 10 ]; then
                echo "  • ... and $((${#MODIFIED_FILES[@]} - 10)) more"
            fi

            # Safety check: reject empty files and syntax-check JS files
            EMPTY_FILES=()
            SYNTAX_ERRORS=()
            for file in "${MODIFIED_FILES[@]}"; do
                if [ -f "$file" ] && [ ! -s "$file" ]; then
                    EMPTY_FILES+=("$file")
                fi
                if [ -f "$file" ] && [[ "$file" == *.js ]] && command -v node &>/dev/null; then
                    if ! node --check "$file" 2>/dev/null; then
                        SYNTAX_ERRORS+=("$file")
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

            # Create archive with modified files
            ARCHIVE_NAME="deploy-auto-$(date +%Y%m%d-%H%M%S).tar.gz"
            ARCHIVE_PATH="/tmp/$ARCHIVE_NAME"
            
            echo -e "${BLUE}→${NC} Creating archive..."
            tar -czf "$ARCHIVE_PATH" "${MODIFIED_FILES[@]}"
            
        else
            echo -e "${YELLOW}First quick deployment - deploying all files${NC}"
            
            # Full deployment for first run
            ARCHIVE_NAME="deploy-auto-full-$(date +%Y%m%d-%H%M%S).tar.gz"
            ARCHIVE_PATH="/tmp/$ARCHIVE_NAME"
            
            TAR_EXCLUDES=$(get_exclude_args "tar")
            eval "tar -czf '$ARCHIVE_PATH' $TAR_EXCLUDES ."
        fi
        
        # Deploy archive
        ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)
        echo -e "${BLUE}→${NC} Deploying ${ARCHIVE_SIZE}..."
        
        # Transfer
        sshpass -p "$PRODUCTION_PASS" scp -o StrictHostKeyChecking=no "$ARCHIVE_PATH" "$PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/"
        
        # Extract
        remote_exec "cd $PRODUCTION_PATH && tar -xzf $ARCHIVE_NAME && rm -f $ARCHIVE_NAME" "Extract"
        
        # Cleanup
        rm -f "$ARCHIVE_PATH"
        
        # Update marker
        touch "$MARKER_FILE"
        ;;
esac

# Quick restart with minimal output
echo -e "${BLUE}→${NC} Restarting..."
remote_exec "cd $PRODUCTION_PATH && pm2 restart ecosystem.config.cjs --update-env" "Restart" > /dev/null 2>&1

# Calculate deployment time
DEPLOY_END=$(date +%s)
DEPLOY_TIME=$((DEPLOY_END - DEPLOY_START))

# Quick status check
sleep 2
STATUS=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "pm2 jlist" 2>/dev/null | grep -o "\"name\":\"$PM2_PROCESS\".*\"status\":\"[^\"]*\"" | grep -o "\"status\":\"[^\"]*\"" | cut -d'"' -f4)

if [ "$STATUS" = "online" ]; then
    echo -e "${GREEN}✅ Deployed successfully in ${DEPLOY_TIME}s${NC}"
else
    echo -e "${RED}✗ Deployment issue - status: ${STATUS:-unknown}${NC}"
    echo ""
    echo "Check logs with:"
    echo "  ssh $PRODUCTION_USER@$PRODUCTION_SERVER 'pm2 logs $PM2_PROCESS'"
    exit 1
fi

# Show quick log tail
if [ -t 1 ]; then  # Only if running in terminal
    echo ""
    echo -e "${CYAN}Recent logs:${NC}"
    sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "pm2 logs $PM2_PROCESS --lines 5 --nostream" 2>/dev/null | tail -n 5
fi