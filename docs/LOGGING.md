# LANAgent Logging Structure

## 📁 Log File Organization

### PM2 System Logs (`~/.pm2/logs/`)
**Purpose**: Basic PM2 process management
- `lan-agent-out.log` - PM2 stdout output
- `lan-agent-error.log` - PM2 stderr output
- **Usage**: Check if service is starting/stopping properly

### Project Logs (`{project}/logs/` - `/root/lanagent-deploy/logs/`)
**Purpose**: Organized, service-specific debugging

#### 🔍 **Primary Debug Files**
1. **`all-activity.log`** - Everything in human-readable format
   - **Best for**: General overview and timeline
   - **Format**: `2025-12-24 21:45:32 [INFO] [service] Message {metadata}`
   - **Size limit**: 30MB, rotated (3 files)

2. **`errors.log`** - Critical issues only
   - **Best for**: Finding problems quickly
   - **Level**: ERROR only
   - **Size limit**: 10MB, rotated (5 files)

#### 📋 **Service-Specific Debug Files**
3. **`self-modification.log`** - Self-modification service
   - **Contains**: Capability upgrades, PR creation, SystemExecutor calls
   - **Keywords**: self-modification, capability upgrade, pr created, analyzing
   - **Best for**: Debugging autonomous improvements

4. **`plugin-development.log`** - Plugin development service
   - **Contains**: New plugin creation, API discovery, capability upgrades
   - **Keywords**: plugin development, plugin capability, api discovery, new plugin
   - **Best for**: Debugging autonomous plugin creation

5. **`bug-detection.log`** - Bug detection and fixing
   - **Contains**: Security scans, vulnerability fixes, bug reports
   - **Keywords**: bug, security, vulnerability, fixing
   - **Best for**: Debugging security and quality issues

6. **`api-web.log`** - Web interface and API
   - **Contains**: HTTP requests, authentication, API calls
   - **Keywords**: api, request, response, web, auth
   - **Best for**: Debugging user interactions and API issues

7. **`plugins.log`** - Plugin activity and operations
   - **Contains**: Plugin loading, execution, errors, and specific plugin logs
   - **Keywords**: plugin, loaded api, executing api, calendar, monitoring, git, etc.
   - **Best for**: Debugging plugin-specific issues and tracking plugin operations

8. **`plugins/*.log`** - Individual plugin log files (NEW in v2.8.58)
   - **Contains**: Dedicated logs for each plugin stored in `logs/plugins/` directory
   - **Example Files**: `logs/plugins/govee.log`, `logs/plugins/email.log`, etc.
   - **Usage**: Use `createPluginLogger()` from logger.js to create plugin-specific loggers
   - **Best for**: Deep debugging of specific plugin behavior without noise from other plugins

#### 🤖 **Machine Analysis**
8. **`structured.json`** - Machine-readable JSON format
   - **Purpose**: Automated log analysis and monitoring
   - **Format**: One JSON object per line with full metadata
   - **Size limit**: 30MB, rotated (2 files)

## 🛠️ **Debugging Workflow for AI Agents**

### Quick Problem Diagnosis
```bash
# 1. Check if service is running
pm2 status

# 2. Quick error overview
tail -50 logs/errors.log

# 3. Service-specific debugging
tail -100 logs/self-modification.log    # For PR creation issues
tail -100 logs/bug-detection.log        # For security scan issues  
tail -100 logs/api-web.log              # For web UI issues

# 4. Live monitoring during testing
tail -f logs/all-activity.log | grep -E "(ERROR|SystemExecutor|PR created)"
```

### Deep Dive Analysis
```bash
# Search for specific issues
grep -n "failed" logs/all-activity.log | tail -10
grep -n "SystemExecutor" logs/self-modification.log
grep -n "authentication" logs/api-web.log

# Timeline analysis
grep "2025-12-24 22:" logs/all-activity.log    # Specific hour
```

## 📝 **Enhanced Logging Features**

### Service-Specific Loggers
```javascript
import { selfModLogger, bugDetectorLogger, apiLogger } from '../utils/logger.js';

// Use service-specific loggers for better filtering
selfModLogger.info('Creating PR for capability upgrade');
bugDetectorLogger.warn('Security vulnerability detected');
apiLogger.debug('API request received');
```

### Debug Utilities
```javascript
import { logDebugSeparator, logStep } from '../utils/logger.js';

logDebugSeparator('CREATING PULL REQUEST');
logStep(1, "Checking commit count");
logStep(2, "Pushing to remote");
logStep(3, "Creating GitHub PR");
```

### Readable Format
```
2025-12-24 21:45:32 [INFO] [self-modification] 🔹 STEP 1: Checking commit count
2025-12-24 21:45:32 [INFO] [self-modification] Found 1 commit(s) on branch auto-improve/enhance-features
2025-12-24 21:45:33 [INFO] [self-modification] 🔹 STEP 2: Pushing to remote repository
2025-12-24 21:45:34 [INFO] [self-modification] SystemExecutor result: {"success":true,"exitCode":0}
```

## ⚙️ **Log Configuration**

### Environment Variables
- `LOG_LEVEL` - Set to debug, info, warn, error (default: info)
- `NODE_ENV` - If not 'production', adds console output

### File Size Management
- **Automatic rotation** when files reach size limits
- **Historical files** kept with `.1`, `.2` suffixes
- **Total storage**: ~130MB for all logs combined

## 🔧 **Troubleshooting Common Issues**

### Self-Modification Problems
```bash
# Check the full PR creation workflow
grep -A 20 -B 5 "CREATING PULL REQUEST" logs/self-modification.log

# SystemExecutor command issues
grep -A 10 "SystemExecutor result" logs/self-modification.log
```

### Bug Detection Problems  
```bash
# Security scan workflow
grep -A 15 -B 5 "Starting.*scan" logs/bug-detection.log

# Vulnerability processing
grep "vulnerability\|security" logs/bug-detection.log
```

### API/Web Issues
```bash
# Authentication problems
grep "auth\|login\|token" logs/api-web.log

# Request/response debugging
grep -A 5 -B 2 "request.*POST\|response.*500" logs/api-web.log
```

## 📊 **Log Monitoring Guidelines**

### For AI Debugging Agents
1. **Start with** `errors.log` for critical issues
2. **Check service logs** based on the problem area
3. **Use timestamps** to correlate events across files
4. **Look for patterns** in SystemExecutor results
5. **Monitor file sizes** - large logs may indicate problems

### Performance Considerations
- Logs auto-rotate to prevent disk space issues
- JSON logs provide structured data for automated analysis
- Service-specific filters reduce noise during debugging
- Step-by-step logging makes workflow debugging easier

This structure provides clear, organized logging that's both human-readable for debugging and machine-parseable for automated analysis.