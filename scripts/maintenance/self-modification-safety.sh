#!/bin/bash
# Self-Modification Safety and Rollback Script
# Usage: ./self-modification-safety.sh [command] [options]

set -e

REPO_PATH="/root/lanagent-repo"
DEPLOY_PATH="$PRODUCTION_PATH"
STAGING_PATH="/tmp/lanagent-staging"
BACKUP_PATH="/root/lanagent-backups"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Create backup directory
create_backup_dir() {
    mkdir -p "$BACKUP_PATH"
}

# Backup current state
backup_state() {
    create_backup_dir
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_PATH/backup_$timestamp.tar.gz"
    
    log_info "Creating backup: $backup_file"
    
    cd "$(dirname $DEPLOY_PATH)"
    tar -czf "$backup_file" "$(basename $DEPLOY_PATH)" || {
        log_error "Backup creation failed"
        return 1
    }
    
    log_success "Backup created successfully"
    return 0
}

# Verify Git status
verify_git_status() {
    local repo_path="$1"
    log_info "Verifying Git status in $repo_path"
    
    cd "$repo_path"
    
    # Check if it's a Git repository
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        log_error "Not a Git repository: $repo_path"
        return 1
    fi
    
    # Check current branch
    local current_branch=$(git branch --show-current)
    log_info "Current branch: $current_branch"
    
    # Check status
    local status=$(git status --porcelain)
    if [ -n "$status" ]; then
        log_warning "Repository has uncommitted changes"
        echo "$status"
    else
        log_success "Repository is clean"
    fi
    
    return 0
}

# Verify GitHub authentication
verify_github_auth() {
    log_info "Verifying GitHub authentication"
    
    if ! command -v gh &> /dev/null; then
        log_error "GitHub CLI not installed"
        return 1
    fi
    
    if ! gh auth status &> /dev/null; then
        log_error "GitHub CLI not authenticated"
        log_info "Run: echo \$GIT_PERSONAL_ACCESS_TOKEN | gh auth login --with-token"
        return 1
    fi
    
    log_success "GitHub CLI authenticated"
    return 0
}

# Verify self-modification service status
verify_service_status() {
    log_info "Verifying self-modification service status"
    
    cd "$DEPLOY_PATH"
    source ~/.nvm/nvm.sh
    
    # Test service initialization
    local status=$(node -e "
        import('./src/services/selfModification.js').then(async ({ SelfModificationService }) => {
            const mockAgent = { notify: () => {}, config: { name: 'LANAgent' } };
            const service = new SelfModificationService(mockAgent);
            console.log('enabled:', service.enabled);
            console.log('analysisOnly:', service.analysisOnly);
            console.log('gitToken:', Boolean(service.config.gitToken));
        }).catch(err => {
            console.error('ERROR:', err.message);
        });
    " 2>&1)
    
    echo "$status"
    
    if echo "$status" | grep -q "ERROR:"; then
        log_error "Service verification failed"
        return 1
    fi
    
    log_success "Service verification passed"
    return 0
}

# Emergency disable self-modification
emergency_disable() {
    log_warning "Initiating emergency disable of self-modification service"
    
    cd "$DEPLOY_PATH"
    source ~/.nvm/nvm.sh
    
    # Create disable script
    cat > /tmp/disable_selfmod.js << 'EOF'
import { SelfModificationService } from './src/services/selfModification.js';

const mockAgent = { 
    notify: (msg) => console.log('NOTIFICATION:', msg),
    config: { name: 'LANAgent' }
};

const service = new SelfModificationService(mockAgent);
service.disable();
console.log('Self-modification service disabled');
EOF

    if node /tmp/disable_selfmod.js; then
        log_success "Self-modification service disabled"
        rm -f /tmp/disable_selfmod.js
        return 0
    else
        log_error "Failed to disable service"
        return 1
    fi
}

# Clean up auto-improvement branches
cleanup_branches() {
    local repo_path="${1:-$REPO_PATH}"
    log_info "Cleaning up auto-improvement branches in $repo_path"
    
    cd "$repo_path"
    
    # List auto-improvement branches
    local branches=$(git branch | grep "auto-improve/" || true)
    
    if [ -z "$branches" ]; then
        log_info "No auto-improvement branches found"
        return 0
    fi
    
    echo "Found auto-improvement branches:"
    echo "$branches"
    
    # Switch to main branch first
    git checkout main || {
        log_error "Failed to checkout main branch"
        return 1
    }
    
    # Delete each auto-improvement branch
    echo "$branches" | sed 's/^[ *]*//' | while read -r branch; do
        if [ -n "$branch" ]; then
            log_info "Deleting branch: $branch"
            git branch -D "$branch" || log_warning "Failed to delete branch: $branch"
        fi
    done
    
    log_success "Branch cleanup completed"
    return 0
}

# Rollback to previous state
rollback() {
    local backup_file="$1"
    
    if [ -z "$backup_file" ]; then
        # Find latest backup
        backup_file=$(ls -t "$BACKUP_PATH"/backup_*.tar.gz 2>/dev/null | head -1)
        if [ -z "$backup_file" ]; then
            log_error "No backup file specified and no backups found"
            return 1
        fi
        log_info "Using latest backup: $backup_file"
    fi
    
    if [ ! -f "$backup_file" ]; then
        log_error "Backup file not found: $backup_file"
        return 1
    fi
    
    log_warning "Rolling back to: $backup_file"
    
    # Stop the service
    pm2 stop lan-agent || log_warning "Failed to stop lan-agent"
    
    # Backup current state before rollback
    backup_state
    
    # Extract backup
    cd "$(dirname $DEPLOY_PATH)"
    tar -xzf "$backup_file" || {
        log_error "Failed to extract backup"
        return 1
    }
    
    # Restart service
    cd $DEPLOY_PATH && pm2 start ecosystem.config.cjs || {
        log_error "Failed to restart lan-agent"
        return 1
    }
    
    log_success "Rollback completed successfully"
    return 0
}

# Test self-modification workflow (analysis only)
test_workflow() {
    log_info "Testing self-modification workflow (analysis only)"
    
    cd "$DEPLOY_PATH"
    source ~/.nvm/nvm.sh
    
    # Create test script
    cat > /tmp/test_selfmod.js << EOF
import { SelfModificationService } from '$DEPLOY_PATH/src/services/selfModification.js';

const mockAgent = { 
    notify: (msg) => console.log('NOTIFICATION:', msg),
    config: { name: 'LANAgent' }
};

const service = new SelfModificationService(mockAgent);

console.log('=== Self-Modification Workflow Test ===');

try {
    // Test file analysis
    const files = await service.getProjectFiles();
    console.log(`✓ Found ${files.length} project files`);
    
    // Test single file analysis
    const testFile = '$DEPLOY_PATH/src/core/agent.js';
    const fs = await import('fs/promises');
    const content = await fs.readFile(testFile, 'utf8');
    const improvements = await service.analyzeFile(testFile, content);
    console.log(`✓ Analyzed ${testFile}: ${improvements.length} improvements found`);
    
    // Test Git status
    const status = await service.git.status();
    console.log(`✓ Git status: ${status.current} branch, clean: ${status.isClean()}`);
    
    console.log('✓ All tests passed - workflow is functional');
    
} catch (error) {
    console.error('✗ Test failed:', error.message);
    process.exit(1);
}
EOF

    if node /tmp/test_selfmod.js; then
        log_success "Workflow test passed"
        rm -f /tmp/test_selfmod.js
        return 0
    else
        log_error "Workflow test failed"
        return 1
    fi
}

# System health check
health_check() {
    log_info "Performing system health check"
    
    local errors=0
    
    # Check disk space
    local disk_usage=$(df "$DEPLOY_PATH" | tail -1 | awk '{print $5}' | sed 's/%//')
    if [ "$disk_usage" -gt 90 ]; then
        log_error "Disk usage is ${disk_usage}% - too high"
        ((errors++))
    else
        log_success "Disk usage: ${disk_usage}%"
    fi
    
    # Check memory
    local mem_usage=$(free | grep Mem | awk '{printf "%.0f", $3/$2 * 100}')
    if [ "$mem_usage" -gt 85 ]; then
        log_warning "Memory usage is ${mem_usage}%"
    else
        log_success "Memory usage: ${mem_usage}%"
    fi
    
    # Check processes
    if ! pgrep -f "lan-agent" > /dev/null; then
        log_error "LANAgent process not running"
        ((errors++))
    else
        log_success "LANAgent process running"
    fi
    
    # Verify Git repositories
    verify_git_status "$REPO_PATH" || ((errors++))
    verify_git_status "$DEPLOY_PATH" || ((errors++))
    
    # Verify GitHub auth
    verify_github_auth || ((errors++))
    
    # Verify service
    verify_service_status || ((errors++))
    
    if [ $errors -eq 0 ]; then
        log_success "System health check passed"
        return 0
    else
        log_error "System health check failed with $errors errors"
        return 1
    fi
}

# Show usage
usage() {
    echo "Self-Modification Safety and Rollback Script"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  health-check          Perform comprehensive system health check"
    echo "  backup               Create backup of current state"
    echo "  emergency-disable    Emergency disable self-modification service"
    echo "  cleanup-branches     Clean up auto-improvement Git branches"
    echo "  rollback [file]      Rollback to backup (latest if file not specified)"
    echo "  test-workflow        Test self-modification workflow (analysis only)"
    echo "  verify-git           Verify Git repository status"
    echo "  verify-github        Verify GitHub authentication"
    echo "  verify-service       Verify self-modification service"
    echo ""
    echo "Examples:"
    echo "  $0 health-check"
    echo "  $0 backup"
    echo "  $0 emergency-disable"
    echo "  $0 rollback /root/lanagent-backups/backup_20251221_024500.tar.gz"
    echo ""
}

# Main command processing
case "${1:-}" in
    "health-check")
        health_check
        ;;
    "backup")
        backup_state
        ;;
    "emergency-disable")
        emergency_disable
        ;;
    "cleanup-branches")
        cleanup_branches
        ;;
    "rollback")
        rollback "$2"
        ;;
    "test-workflow")
        test_workflow
        ;;
    "verify-git")
        verify_git_status "$REPO_PATH"
        verify_git_status "$DEPLOY_PATH"
        ;;
    "verify-github")
        verify_github_auth
        ;;
    "verify-service")
        verify_service_status
        ;;
    "")
        usage
        exit 1
        ;;
    *)
        log_error "Unknown command: $1"
        usage
        exit 1
        ;;
esac