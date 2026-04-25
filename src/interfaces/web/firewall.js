import express from 'express';
import { authenticateToken } from './auth.js';
import { execSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

const router = express.Router();

/**
 * Firewall Management Web Interface
 * Provides full control over UFW firewall rules and configuration
 */

// Helper function to execute UFW commands safely with retry logic
async function executeUFW(command, params = {}) {
    let ufwCommand = '';
    try {
        // Build the UFW command
        ufwCommand = 'ufw ';
        
        switch (command) {
            case 'status':
                ufwCommand += 'status verbose';
                break;
            case 'enable':
                ufwCommand += '--force enable';
                break;
            case 'disable':
                ufwCommand += '--force disable';
                break;
            case 'allow':
                ufwCommand += `allow ${params.rule}`;
                break;
            case 'deny':
                ufwCommand += `deny ${params.rule}`;
                break;
            case 'delete':
                ufwCommand += `delete ${params.rule}`;
                break;
            case 'reset':
                ufwCommand += '--force reset';
                break;
            case 'logging':
                ufwCommand += `logging ${params.level}`;
                break;
            default:
                throw new Error('Unknown UFW command');
        }
        
        logger.info(`Executing UFW command: ${ufwCommand}`);
        
        const result = await retryOperation(() => execSync(ufwCommand, { encoding: 'utf-8', timeout: 10000 }), { retries: 3 });
        
        return {
            success: true,
            output: result,
            command: ufwCommand
        };
    } catch (error) {
        logger.error(`UFW command failed: ${error.message}`);
        return {
            success: false,
            error: error.message,
            command: ufwCommand || 'unknown'
        };
    }
}

// Parse UFW status output into structured data
function parseUFWStatus(statusOutput) {
    const lines = statusOutput.split('\n');
    const result = {
        status: 'unknown',
        defaultIncoming: 'unknown',
        defaultOutgoing: 'unknown',
        defaultRouted: 'unknown',
        logging: 'unknown',
        rules: []
    };
    
    for (const line of lines) {
        const cleanLine = line.trim();
        
        if (cleanLine.includes('Status:')) {
            result.status = cleanLine.split('Status:')[1].trim().toLowerCase();
        } else if (cleanLine.includes('Default:')) {
            // Parse the default policy line: "Default: deny (incoming), allow (outgoing), disabled (routed)"
            const defaultText = cleanLine.split('Default:')[1].trim();
            
            // Extract incoming policy
            const incomingMatch = defaultText.match(/(\w+)\s*\(incoming\)/);
            if (incomingMatch) {
                result.defaultIncoming = incomingMatch[1];
            }
            
            // Extract outgoing policy
            const outgoingMatch = defaultText.match(/(\w+)\s*\(outgoing\)/);
            if (outgoingMatch) {
                result.defaultOutgoing = outgoingMatch[1];
            }
            
            // Extract routed policy
            const routedMatch = defaultText.match(/(\w+)\s*\(routed\)/);
            if (routedMatch) {
                result.defaultRouted = routedMatch[1];
            }
        } else if (cleanLine.includes('Logging:')) {
            result.logging = cleanLine.split('Logging:')[1].trim().toLowerCase();
        } else if (cleanLine && 
                   !cleanLine.includes('To') && 
                   !cleanLine.includes('Action') &&
                   !cleanLine.includes('From') &&
                   !cleanLine.includes('--') && 
                   !cleanLine.includes('Default:') && 
                   !cleanLine.includes('Status:') && 
                   !cleanLine.includes('Logging:') && 
                   !cleanLine.includes('New profiles') && 
                   !cleanLine.includes('Skip') && 
                   !cleanLine.startsWith('[ ') &&
                   cleanLine.length > 5) {
            // Parse rule lines - improved parsing
            const parts = cleanLine.split(/\s+/);
            if (parts.length >= 3) {
                // Handle different UFW output formats
                let rule;
                if (parts[1].toUpperCase() === 'ALLOW' || parts[1].toUpperCase() === 'DENY' || parts[1].toUpperCase() === 'LIMIT') {
                    rule = {
                        to: parts[0],
                        action: parts[1].toUpperCase(),
                        from: parts[2],
                        comment: parts.slice(3).join(' ') || ''
                    };
                } else if (parts.length >= 6 && (parts[2].toUpperCase() === 'ALLOW' || parts[2].toUpperCase() === 'DENY' || parts[2].toUpperCase() === 'LIMIT')) {
                    // Format: port/protocol ALLOW IN from-ip
                    rule = {
                        to: `${parts[0]} ${parts[1] || ''}`.trim(),
                        action: parts[2].toUpperCase(),
                        from: parts.slice(4).join(' ') || 'Anywhere',
                        comment: ''
                    };
                }
                if (rule) {
                    result.rules.push(rule);
                }
            }
        }
    }
    
    return result;
}

// API Routes for Firewall Management

// Get UFW Status
router.get('/api/status', authenticateToken, async (req, res) => {
    try {
        const result = await executeUFW('status');
        
        if (result.success) {
            const parsedStatus = parseUFWStatus(result.output);
            res.json({
                success: true,
                data: parsedStatus,
                rawOutput: result.output
            });
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        logger.error('Firewall status API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get firewall status'
        });
    }
});

// Enable UFW
router.post('/api/enable', authenticateToken, async (req, res) => {
    try {
        const result = await executeUFW('enable');
        res.json(result);
    } catch (error) {
        logger.error('Firewall enable API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to enable firewall'
        });
    }
});

// Disable UFW
router.post('/api/disable', authenticateToken, async (req, res) => {
    try {
        const result = await executeUFW('disable');
        res.json(result);
    } catch (error) {
        logger.error('Firewall disable API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to disable firewall'
        });
    }
});

// Add Allow Rule
router.post('/api/allow', authenticateToken, async (req, res) => {
    try {
        const { rule } = req.body;
        if (!rule) {
            return res.status(400).json({
                success: false,
                error: 'Rule parameter is required'
            });
        }
        
        const result = await executeUFW('allow', { rule });
        res.json(result);
    } catch (error) {
        logger.error('Firewall allow API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add allow rule'
        });
    }
});

// Add Deny Rule
router.post('/api/deny', authenticateToken, async (req, res) => {
    try {
        const { rule } = req.body;
        if (!rule) {
            return res.status(400).json({
                success: false,
                error: 'Rule parameter is required'
            });
        }
        
        const result = await executeUFW('deny', { rule });
        res.json(result);
    } catch (error) {
        logger.error('Firewall deny API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add deny rule'
        });
    }
});

// Delete Rule
router.post('/api/delete', authenticateToken, async (req, res) => {
    try {
        const { rule } = req.body;
        if (!rule) {
            return res.status(400).json({
                success: false,
                error: 'Rule parameter is required'
            });
        }
        
        const result = await executeUFW('delete', { rule });
        res.json(result);
    } catch (error) {
        logger.error('Firewall delete API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete rule'
        });
    }
});

// Reset UFW (delete all rules)
router.post('/api/reset', authenticateToken, async (req, res) => {
    try {
        const result = await executeUFW('reset');
        res.json(result);
    } catch (error) {
        logger.error('Firewall reset API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset firewall'
        });
    }
});

// Set Logging Level
router.post('/api/logging', authenticateToken, async (req, res) => {
    try {
        const { level } = req.body;
        if (!level) {
            return res.status(400).json({
                success: false,
                error: 'Logging level parameter is required'
            });
        }
        
        const result = await executeUFW('logging', { level });
        res.json(result);
    } catch (error) {
        logger.error('Firewall logging API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to set logging level'
        });
    }
});

// Get common firewall presets
router.get('/api/presets', authenticateToken, async (req, res) => {
    try {
        const presets = {
            web: {
                name: 'Web Server',
                rules: ['80/tcp', '443/tcp'],
                description: 'Allow HTTP and HTTPS traffic'
            },
            ssh: {
                name: 'SSH Access',
                rules: ['22/tcp'],
                description: 'Allow SSH connections'
            },
            ftp: {
                name: 'FTP Server',
                rules: ['21/tcp', '20/tcp'],
                description: 'Allow FTP connections'
            },
            mail: {
                name: 'Mail Server',
                rules: ['25/tcp', '587/tcp', '993/tcp', '995/tcp'],
                description: 'Allow SMTP, SMTPS, IMAPS, and POP3S'
            },
            dns: {
                name: 'DNS Server',
                rules: ['53/tcp', '53/udp'],
                description: 'Allow DNS queries'
            },
            ntp: {
                name: 'NTP Server',
                rules: ['123/udp'],
                description: 'Allow time synchronization'
            },
            gaming: {
                name: 'Gaming',
                rules: ['25565/tcp', '7777/tcp', '27015/tcp'],
                description: 'Common gaming server ports'
            }
        };
        
        res.json({
            success: true,
            data: presets
        });
    } catch (error) {
        logger.error('Firewall presets API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get firewall presets'
        });
    }
});

// Apply preset rules
router.post('/api/apply-preset', authenticateToken, async (req, res) => {
    try {
        const { preset } = req.body;
        if (!preset) {
            return res.status(400).json({
                success: false,
                error: 'Preset parameter is required'
            });
        }
        
        // Get preset data
        const presetsResponse = await fetch(`${req.protocol}://${req.get('host')}/firewall/api/presets`);
        const presetsData = await presetsResponse.json();
        
        if (!presetsData.success || !presetsData.data[preset]) {
            return res.status(400).json({
                success: false,
                error: 'Invalid preset specified'
            });
        }
        
        const presetData = presetsData.data[preset];
        const results = [];
        
        // Apply each rule in the preset
        for (const rule of presetData.rules) {
            const result = await executeUFW('allow', { rule });
            results.push({
                rule,
                result
            });
        }
        
        res.json({
            success: true,
            preset: presetData.name,
            results
        });
    } catch (error) {
        logger.error('Firewall apply preset API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to apply preset'
        });
    }
});

// Schedule a firewall rule change for a future time
router.post('/api/schedule-rule', authenticateToken, async (req, res) => {
    try {
        const { action, rule, scheduleTime } = req.body;

        if (!action || !rule || !scheduleTime) {
            return res.status(400).json({
                success: false,
                error: 'action, rule, and scheduleTime are required'
            });
        }

        // Validate action
        const allowedActions = ['allow', 'deny', 'delete'];
        if (!allowedActions.includes(action)) {
            return res.status(400).json({
                success: false,
                error: `Invalid action. Must be one of: ${allowedActions.join(', ')}`
            });
        }

        // Sanitize rule: only allow port specs, IPs, CIDR, and proto keywords
        if (!/^[\w\d\s\/:.\-]+$/.test(rule) || rule.length > 100) {
            return res.status(400).json({
                success: false,
                error: 'Invalid rule format. Use port/protocol or IP-based rules (e.g., "80/tcp", "from 192.168.1.0/24")'
            });
        }

        const executeAt = new Date(scheduleTime);
        if (isNaN(executeAt.getTime()) || executeAt <= new Date()) {
            return res.status(400).json({
                success: false,
                error: 'scheduleTime must be a valid future date/time'
            });
        }

        // Use Agenda scheduler if available
        const agent = req.app?.locals?.agent;
        if (!agent?.scheduler?.agenda) {
            return res.status(503).json({
                success: false,
                error: 'Scheduler not available'
            });
        }

        // Define the job if not already defined
        const jobName = 'scheduled-firewall-rule';
        const agenda = agent.scheduler.agenda;

        // Define idempotently — Agenda ignores duplicate defines
        agenda.define(jobName, async (job) => {
            const { action: a, rule: r } = job.attrs.data;
            logger.info(`Executing scheduled firewall rule: ${a} ${r}`);
            const result = await executeUFW(a, { rule: r });
            if (result.success) {
                logger.info(`Scheduled firewall rule applied: ${a} ${r}`);
            } else {
                logger.error(`Scheduled firewall rule failed: ${a} ${r} — ${result.error}`);
            }
        });

        await agenda.schedule(executeAt, jobName, { action, rule });

        logger.info(`Firewall rule scheduled: ${action} ${rule} at ${executeAt.toISOString()}`);
        res.json({
            success: true,
            message: `Rule scheduled: ${action} ${rule}`,
            scheduledFor: executeAt.toISOString()
        });
    } catch (error) {
        logger.error('Firewall schedule-rule API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to schedule firewall rule'
        });
    }
});

export default router;