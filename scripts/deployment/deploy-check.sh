#!/bin/bash
# LANAgent Deployment Health Check Script
# Comprehensive checks for deployment status and health

# Get script directory and source configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deploy.config"

# Check options
VERBOSE=false
MONITOR_MODE=false
FIX_ISSUES=false
CHECK_INTERVAL=30

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --monitor|-m)
            MONITOR_MODE=true
            shift
            if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
                CHECK_INTERVAL=$1
                shift
            fi
            ;;
        --fix)
            FIX_ISSUES=true
            shift
            ;;
        --help|-h)
            echo "LANAgent Deployment Health Check"
            echo ""
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --verbose, -v       Show detailed information"
            echo "  --monitor, -m [sec] Continuous monitoring mode (default: 30s)"
            echo "  --fix              Attempt to fix common issues"
            echo "  --help             Show this help message"
            echo ""
            echo "Checks performed:"
            echo "  • SSH connectivity"
            echo "  • PM2 process status"
            echo "  • MongoDB connection"
            echo "  • Disk space"
            echo "  • Memory usage"
            echo "  • Recent errors in logs"
            echo "  • Web interface availability"
            echo "  • File permissions"
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

# Health check results
declare -A CHECK_RESULTS
declare -A CHECK_DETAILS

# Function to perform a check
perform_check() {
    local check_name="$1"
    local check_command="$2"
    local check_description="$3"
    
    if [ "$VERBOSE" = true ]; then
        echo -ne "${BLUE}→${NC} Checking ${check_description}... "
    fi
    
    if eval "$check_command" > /tmp/check_output 2>&1; then
        CHECK_RESULTS["$check_name"]="PASS"
        CHECK_DETAILS["$check_name"]=$(cat /tmp/check_output)
        [ "$VERBOSE" = true ] && echo -e "${GREEN}✓${NC}"
    else
        CHECK_RESULTS["$check_name"]="FAIL"
        CHECK_DETAILS["$check_name"]=$(cat /tmp/check_output)
        [ "$VERBOSE" = true ] && echo -e "${RED}✗${NC}"
    fi
    
    rm -f /tmp/check_output
}

# Function to run all checks
run_health_checks() {
    local start_time=$(date +%s)
    
    if [ "$MONITOR_MODE" = false ]; then
        echo -e "${CYAN}═══════════════════════════════════════${NC}"
        echo -e "${CYAN}   LANAgent Deployment Health Check    ${NC}"
        echo -e "${CYAN}═══════════════════════════════════════${NC}"
        echo -e "Server: ${BLUE}${PRODUCTION_SERVER}${NC}"
        echo -e "Time:   ${BLUE}$(date)${NC}"
        echo ""
    fi
    
    # 1. SSH Connectivity
    perform_check "ssh_connectivity" \
        "sshpass -p '$PRODUCTION_PASS' ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no '$PRODUCTION_USER@$PRODUCTION_SERVER' 'echo OK'" \
        "SSH connectivity"
    
    # Continue only if SSH works
    if [ "${CHECK_RESULTS[ssh_connectivity]}" != "PASS" ]; then
        echo -e "${RED}Cannot connect to server. Aborting other checks.${NC}"
        return 1
    fi
    
    # 2. PM2 Process Status
    perform_check "pm2_status" \
        "remote_exec 'pm2 show $PM2_PROCESS > /dev/null 2>&1 && echo \"Process running\"' 'PM2 process'" \
        "PM2 process status"
    
    # 3. Process Details (memory, CPU, uptime)
    if [ "${CHECK_RESULTS[pm2_status]}" = "PASS" ]; then
        PROCESS_INFO=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "pm2 jlist" 2>/dev/null | jq -r ".[] | select(.name==\"$PM2_PROCESS\")")
        
        if [ -n "$PROCESS_INFO" ]; then
            PROCESS_STATUS=$(echo "$PROCESS_INFO" | jq -r '.pm2_env.status')
            PROCESS_MEMORY=$(echo "$PROCESS_INFO" | jq -r '.monit.memory // 0' | awk '{printf "%.1f", $1/1024/1024}')
            PROCESS_CPU=$(echo "$PROCESS_INFO" | jq -r '.monit.cpu // 0')
            PROCESS_UPTIME=$(echo "$PROCESS_INFO" | jq -r '.pm2_env.pm_uptime // 0')
            
            if [ "$PROCESS_UPTIME" -gt 0 ]; then
                UPTIME_SECONDS=$(( ($(date +%s) - $PROCESS_UPTIME / 1000) ))
                UPTIME_STRING=$(printf '%dd %dh %dm' $(($UPTIME_SECONDS/86400)) $(($UPTIME_SECONDS%86400/3600)) $(($UPTIME_SECONDS%3600/60)))
            else
                UPTIME_STRING="N/A"
            fi
            
            CHECK_DETAILS["process_info"]="Status: $PROCESS_STATUS | Memory: ${PROCESS_MEMORY}MB | CPU: ${PROCESS_CPU}% | Uptime: $UPTIME_STRING"
        fi
    fi
    
    # 4. MongoDB Connection
    perform_check "mongodb" \
        "remote_exec 'systemctl is-active mongod' 'MongoDB status'" \
        "MongoDB service"
    
    # 5. Disk Space
    DISK_INFO=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "df -h $PRODUCTION_PATH | tail -1")
    DISK_USAGE=$(echo "$DISK_INFO" | awk '{print $5}' | sed 's/%//')
    DISK_AVAIL=$(echo "$DISK_INFO" | awk '{print $4}')
    
    if [ "$DISK_USAGE" -lt 90 ]; then
        CHECK_RESULTS["disk_space"]="PASS"
        CHECK_DETAILS["disk_space"]="Usage: ${DISK_USAGE}% | Available: ${DISK_AVAIL}"
    else
        CHECK_RESULTS["disk_space"]="FAIL"
        CHECK_DETAILS["disk_space"]="Usage: ${DISK_USAGE}% (HIGH!) | Available: ${DISK_AVAIL}"
    fi
    
    # 6. Memory Usage
    MEM_INFO=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "free -m | grep Mem")
    MEM_TOTAL=$(echo "$MEM_INFO" | awk '{print $2}')
    MEM_USED=$(echo "$MEM_INFO" | awk '{print $3}')
    MEM_PERCENT=$(( $MEM_USED * 100 / $MEM_TOTAL ))
    
    if [ "$MEM_PERCENT" -lt 90 ]; then
        CHECK_RESULTS["memory"]="PASS"
        CHECK_DETAILS["memory"]="Usage: ${MEM_PERCENT}% (${MEM_USED}MB / ${MEM_TOTAL}MB)"
    else
        CHECK_RESULTS["memory"]="FAIL"
        CHECK_DETAILS["memory"]="Usage: ${MEM_PERCENT}% (${MEM_USED}MB / ${MEM_TOTAL}MB) - HIGH!"
    fi
    
    # 7. Recent Errors in Logs
    ERROR_COUNT=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "pm2 logs $PM2_PROCESS --lines 100 --nostream --err 2>/dev/null | grep -i error | wc -l" 2>/dev/null || echo "0")
    
    if [ "$ERROR_COUNT" -eq 0 ]; then
        CHECK_RESULTS["recent_errors"]="PASS"
        CHECK_DETAILS["recent_errors"]="No recent errors"
    else
        CHECK_RESULTS["recent_errors"]="WARN"
        CHECK_DETAILS["recent_errors"]="${ERROR_COUNT} errors in last 100 lines"
        
        if [ "$VERBOSE" = true ]; then
            RECENT_ERRORS=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "pm2 logs $PM2_PROCESS --lines 100 --nostream --err 2>/dev/null | grep -i error | tail -3")
            CHECK_DETAILS["recent_errors_sample"]="$RECENT_ERRORS"
        fi
    fi
    
    # 8. Web Interface Check
    perform_check "web_interface" \
        "curl -s -o /dev/null -w '%{http_code}' http://${PRODUCTION_SERVER}:80 | grep -q '200'" \
        "Web interface (port 80)"
    
    # 9. File Permissions
    perform_check "file_permissions" \
        "remote_exec 'test -w $PRODUCTION_PATH/logs && test -w $PRODUCTION_PATH/data && echo \"Writable\"' 'Directory permissions'" \
        "File permissions"
    
    # 10. Environment File
    perform_check "env_file" \
        "remote_exec 'test -f $PRODUCTION_PATH/.env && echo \"Exists\"' 'Environment file'" \
        ".env file"
    
    # Calculate total time
    local end_time=$(date +%s)
    local check_duration=$(( end_time - start_time ))
    
    # Display results
    if [ "$MONITOR_MODE" = false ]; then
        echo ""
        echo -e "${CYAN}Check Results:${NC}"
        echo -e "${CYAN}─────────────${NC}"
        
        local total_checks=0
        local passed_checks=0
        local failed_checks=0
        local warning_checks=0
        
        for check in ssh_connectivity pm2_status mongodb disk_space memory recent_errors web_interface file_permissions env_file; do
            total_checks=$((total_checks + 1))
            
            case "${CHECK_RESULTS[$check]}" in
                "PASS")
                    echo -e "${GREEN}✓${NC} ${check//_/ }: ${CHECK_DETAILS[$check]}"
                    passed_checks=$((passed_checks + 1))
                    ;;
                "FAIL")
                    echo -e "${RED}✗${NC} ${check//_/ }: ${CHECK_DETAILS[$check]}"
                    failed_checks=$((failed_checks + 1))
                    ;;
                "WARN")
                    echo -e "${YELLOW}⚠${NC} ${check//_/ }: ${CHECK_DETAILS[$check]}"
                    warning_checks=$((warning_checks + 1))
                    ;;
            esac
        done
        
        # Process info if available
        if [ -n "${CHECK_DETAILS[process_info]}" ]; then
            echo ""
            echo -e "${CYAN}Process Info:${NC} ${CHECK_DETAILS[process_info]}"
        fi
        
        # Recent error samples if available
        if [ -n "${CHECK_DETAILS[recent_errors_sample]}" ]; then
            echo ""
            echo -e "${YELLOW}Recent Errors:${NC}"
            echo "${CHECK_DETAILS[recent_errors_sample]}"
        fi
        
        # Summary
        echo ""
        echo -e "${CYAN}Summary:${NC}"
        echo -e "  Total checks: $total_checks"
        echo -e "  ${GREEN}Passed: $passed_checks${NC}"
        if [ $warning_checks -gt 0 ]; then
            echo -e "  ${YELLOW}Warnings: $warning_checks${NC}"
        fi
        if [ $failed_checks -gt 0 ]; then
            echo -e "  ${RED}Failed: $failed_checks${NC}"
        fi
        echo -e "  Check duration: ${check_duration}s"
        
        # Overall status
        echo ""
        if [ $failed_checks -eq 0 ]; then
            if [ $warning_checks -eq 0 ]; then
                echo -e "${GREEN}✅ Deployment is healthy${NC}"
            else
                echo -e "${YELLOW}⚠️  Deployment is operational with warnings${NC}"
            fi
        else
            echo -e "${RED}❌ Deployment has issues${NC}"
            
            # Offer fixes if enabled
            if [ "$FIX_ISSUES" = true ]; then
                echo ""
                echo -e "${BLUE}Attempting to fix issues...${NC}"
                
                # Fix PM2 if not running
                if [ "${CHECK_RESULTS[pm2_status]}" = "FAIL" ]; then
                    echo -e "${BLUE}→${NC} Starting PM2 process..."
                    if remote_exec "cd $PRODUCTION_PATH && pm2 start ecosystem.config.js" "Starting process"; then
                        echo -e "${GREEN}✓${NC} Process started"
                    fi
                fi
                
                # Fix MongoDB if not running
                if [ "${CHECK_RESULTS[mongodb]}" = "FAIL" ]; then
                    echo -e "${BLUE}→${NC} Starting MongoDB..."
                    if remote_exec "sudo systemctl start mongod" "Starting MongoDB"; then
                        echo -e "${GREEN}✓${NC} MongoDB started"
                    fi
                fi
            fi
        fi
    else
        # Monitor mode - compact display
        printf "\r[%s] " "$(date +%H:%M:%S)"
        printf "PM2: %s " "${CHECK_RESULTS[pm2_status]/PASS/✓}"
        printf "| Mem: %s " "${CHECK_DETAILS[memory]%% *}"
        printf "| Disk: %s " "${CHECK_DETAILS[disk_space]%% *}"
        printf "| Errors: %s " "${CHECK_DETAILS[recent_errors]}"
    fi
}

# Main execution
if [ "$MONITOR_MODE" = true ]; then
    echo -e "${CYAN}Starting health monitoring (interval: ${CHECK_INTERVAL}s)${NC}"
    echo "Press Ctrl+C to stop"
    echo ""
    
    # Clear line for compact display
    tput civis  # Hide cursor
    
    trap 'tput cnorm; echo; exit' INT TERM
    
    while true; do
        run_health_checks
        sleep "$CHECK_INTERVAL"
    done
else
    run_health_checks
fi