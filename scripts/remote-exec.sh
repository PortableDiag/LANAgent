#!/bin/bash
# LANAgent Remote Command Execution Script
# Allows AI agents to execute commands on production server without using sshpass directly

# Get script directory and source configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deployment/deploy.config"

# Default options
INTERACTIVE=false
SHOW_OUTPUT=true
TIMEOUT=30
COMMAND=""
DESCRIPTION=""

# Function to show usage
show_usage() {
    cat << EOF
LANAgent Remote Command Execution

Usage: $0 [options] <command>

Options:
  -i, --interactive    Run command interactively
  -q, --quiet         Hide command output
  -t, --timeout SEC   Set timeout in seconds (default: 30)
  -d, --desc TEXT     Description for the command
  -h, --help          Show this help

Examples:
  $0 "pm2 status"
  $0 -d "Check disk space" "df -h"
  $0 -t 60 "npm install"
  $0 -i "nano /etc/hosts"

Available shortcuts:
  status     - Show PM2 status
  logs       - Show recent logs
  restart    - Restart application
  backup     - Create backup
  disk       - Show disk usage
  processes  - Show running processes
  env        - Show environment info
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -i|--interactive)
            INTERACTIVE=true
            shift
            ;;
        -q|--quiet)
            SHOW_OUTPUT=false
            shift
            ;;
        -t|--timeout)
            shift
            if [[ $1 =~ ^[0-9]+$ ]]; then
                TIMEOUT=$1
            else
                echo -e "${RED}Error: Invalid timeout value${NC}"
                exit 1
            fi
            shift
            ;;
        -d|--desc)
            shift
            DESCRIPTION="$1"
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        -*)
            echo -e "${RED}Unknown option: $1${NC}"
            show_usage
            exit 1
            ;;
        *)
            COMMAND="$1"
            break
            ;;
    esac
done

# Check if command provided
if [ -z "$COMMAND" ]; then
    echo -e "${RED}Error: No command specified${NC}"
    show_usage
    exit 1
fi

# Handle shortcuts
case $COMMAND in
    "status")
        COMMAND="pm2 status $PM2_PROCESS"
        DESCRIPTION="Check PM2 process status"
        ;;
    "logs")
        COMMAND="pm2 logs $PM2_PROCESS --lines 50 --nostream"
        DESCRIPTION="Show recent application logs"
        ;;
    "restart")
        COMMAND="cd $PRODUCTION_PATH && pm2 restart ecosystem.config.cjs --update-env"
        DESCRIPTION="Restart application"
        ;;
    "backup")
        COMMAND="mkdir -p /root/lanagent-backups && cd /root && cp -r lanagent-deploy lanagent-backups/lanagent-manual-backup-\$(date +%Y%m%d-%H%M%S)"
        DESCRIPTION="Create manual backup"
        ;;
    "disk")
        COMMAND="df -h && echo '' && du -sh $PRODUCTION_PATH"
        DESCRIPTION="Show disk usage"
        ;;
    "processes")
        COMMAND="ps aux | grep -E '(node|npm|pm2)' | grep -v grep"
        DESCRIPTION="Show Node.js processes"
        ;;
    "env")
        COMMAND="echo 'System:' && uname -a && echo '' && echo 'Node:' && node -v && echo 'NPM:' && npm -v && echo 'PM2:' && pm2 -v"
        DESCRIPTION="Show environment information"
        ;;
esac

# Set default description if not provided
if [ -z "$DESCRIPTION" ]; then
    DESCRIPTION="Executing: $COMMAND"
fi

# Check prerequisites
check_sshpass

# Verify server connectivity
echo -e "${BLUE}→${NC} Connecting to $PRODUCTION_SERVER..."
if ! sshpass -p "$PRODUCTION_PASS" ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "echo 'Connected' > /dev/null 2>&1"; then
    echo -e "${RED}✗${NC} Cannot connect to production server"
    exit 1
fi

# Show what we're about to do
if [ "$SHOW_OUTPUT" = true ]; then
    echo -e "${CYAN}Server:${NC}  $PRODUCTION_USER@$PRODUCTION_SERVER"
    echo -e "${CYAN}Action:${NC}  $DESCRIPTION"
    if [ "$INTERACTIVE" = true ]; then
        echo -e "${CYAN}Mode:${NC}    Interactive"
    else
        echo -e "${CYAN}Mode:${NC}    Non-interactive (timeout: ${TIMEOUT}s)"
    fi
    echo ""
fi

# Execute command
if [ "$INTERACTIVE" = true ]; then
    # Interactive mode - pass through all input/output
    echo -e "${BLUE}→${NC} Starting interactive session..."
    echo -e "${YELLOW}Use Ctrl+D or 'exit' to end session${NC}"
    echo ""
    
    sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no -t "$PRODUCTION_USER@$PRODUCTION_SERVER" "$COMMAND"
    EXIT_CODE=$?
    
else
    # Non-interactive mode with timeout
    if [ "$SHOW_OUTPUT" = true ]; then
        echo -e "${BLUE}→${NC} $DESCRIPTION..."
        
        # Execute with timeout and show output
        timeout $TIMEOUT sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "$COMMAND"
        EXIT_CODE=$?
        
        # Handle timeout
        if [ $EXIT_CODE -eq 124 ]; then
            echo ""
            echo -e "${RED}✗${NC} Command timed out after ${TIMEOUT}s"
            exit 124
        fi
        
    else
        # Quiet mode - capture output
        OUTPUT=$(timeout $TIMEOUT sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "$COMMAND" 2>&1)
        EXIT_CODE=$?
        
        # Handle timeout
        if [ $EXIT_CODE -eq 124 ]; then
            echo -e "${RED}Command timed out after ${TIMEOUT}s${NC}" >&2
            exit 124
        fi
        
        # Only show output if there was an error
        if [ $EXIT_CODE -ne 0 ]; then
            echo "$OUTPUT"
        fi
    fi
fi

# Show result
if [ "$SHOW_OUTPUT" = true ]; then
    echo ""
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${GREEN}✓${NC} Command completed successfully"
    else
        echo -e "${RED}✗${NC} Command failed with exit code $EXIT_CODE"
    fi
fi

exit $EXIT_CODE