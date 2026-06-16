# LANAgent Scripts

This directory contains automation scripts for deployment, development, maintenance, and setup tasks.

## Directory Structure

### `/deployment/`
Deployment and infrastructure scripts:
- `deploy.sh` - Main deployment script with full file sync
- `deploy-check.sh` - Deployment health verification and monitoring
- `deploy-files.sh` - Selective file deployment
- `deploy-quick.sh` - Fast deployment for development iterations  
- `deploy-rollback.sh` - Emergency rollback functionality
- `prepare-deployment.sh` - Pre-deployment preparation and setup
- `deploy.config` - Shared deployment configuration
- `get-telegram-id.sh` - Telegram ID retrieval utility
- `monitor-startup.sh` - Application startup monitoring

### `/development/`
Development environment scripts:
- `setup-lanagent.sh` - Initial LANAgent setup
- `dev-lanagent.sh` - Development server startup
- `install-deps.sh` - Dependency installation
- `continue-development.sh` - Resume development workflow

### `/maintenance/`
System maintenance and debugging:
- `clear-bug-7-state.js` - Bug tracking state cleanup
- `simple-bug-scan.sh` - Basic code bug scanning
- `consolidate-files.sh` - File organization utility
- `self-modification-safety.sh` - Self-modification safety checks

### `/setup/`
Installation and configuration:
- `install-media-tools.sh` - Media processing tool installation
- `setup-selfmod-env.sh` - Self-modification environment setup

## Root Level Scripts

### Deployment & Operations
- `deploy-autonomous-fix.sh` - Autonomous deployment fixes
- `remote-exec.sh` - Remote command execution wrapper

## Usage Examples

### Deployment
```bash
# Full deployment
./deployment/deploy.sh

# Quick development deploy
./deployment/deploy-quick.sh

# Deploy specific files
./deployment/deploy-files.sh src/api/plugins/*.js

# Health check
./deployment/deploy-check.sh --verbose

# Emergency rollback
./deployment/deploy-rollback.sh
```

### Development
```bash
# Initial setup
./development/setup-lanagent.sh

# Start development environment
./development/dev-lanagent.sh

# Install dependencies
./development/install-deps.sh
```

### Maintenance
```bash
# Bug scanning
./maintenance/simple-bug-scan.sh

# Clear bug state
node ./maintenance/clear-bug-7-state.js

# Safety checks
./maintenance/self-modification-safety.sh
```

### Setup
```bash
# Install media tools
./setup/install-media-tools.sh

# Setup self-modification
./setup/setup-selfmod-env.sh
```

### Remote Operations
```bash
# Execute remote commands
./remote-exec.sh "pm2 status"
./remote-exec.sh status  # Built-in shortcut
```

## Configuration

Most scripts use shared configuration files:
- `/deployment/deploy.config` - Deployment settings
- Environment variables for credentials and paths

### Production Server Credentials

Production server details are instance-specific. See `CLAUDE.local.md` for your host, user, and password configuration.

**Example Usage:**
```bash
ssh $PRODUCTION_USER@$PRODUCTION_HOST "pm2 status"
```

## Best Practices

1. **Test in development first** - Always test scripts locally before production use
2. **Use appropriate script** - Choose the right tool for the task
3. **Monitor after changes** - Use health check scripts after deployments
4. **Keep backups** - Use scripts with backup functionality for important changes
5. **Check permissions** - Ensure scripts are executable (`chmod +x script.sh`)

## Security Notes

- Deployment scripts contain sensitive server credentials
- Do not commit configuration files with passwords to version control
- Restrict access to production deployment scripts
- Consider using SSH keys instead of passwords for production

## Adding New Scripts

1. Place scripts in appropriate subdirectory by purpose
2. Make scripts executable with `chmod +x`
3. Add documentation to this README
4. Include error handling and help messages
5. Follow existing naming conventions