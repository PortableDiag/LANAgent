import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync from 'fs';
import { logger } from '../../utils/logger.js';
import { authenticateToken, generateToken, verifyToken } from './auth.js';
import { setupTestingRoutes } from './testingRoutes.js';
import { setupFeatureRequestRoutes } from './featureRequests.js';
import { Memory } from '../../models/Memory.js';
import apiKeyService from '../../services/apiKeyService.js';
import { safeJsonParse, safeJsonStringify } from '../../utils/jsonUtils.js';
import { DATA_PATH } from '../../utils/paths.js';
import vpnRoutes from './vpn.js';
import firewallRoutes from './firewall.js';
import sshRoutes from './ssh.js';
// cookiesAdminRoutes import removed — supporting cookiesAdmin.js + ytdlpCookieJar.js
// utility files weren't synced from genesis; route was dead code in public.
// import sambaRoutes from './samba.js'; // Now handled by generic plugin router
import networkRoutes from './network.js';
import devenvRoutes from './devenv.js';
import cryptoRoutes from '../../api/crypto.js';
import contractsRoutes from '../../api/contracts.js';
import transactionsRoutes from '../../api/transactions.js';
import hardhatRoutes from '../../api/hardhat.js';
import faucetsRoutes from '../../api/faucets.js';
import donationsRoutes from '../../api/donations.js';
import signaturesRoutes from '../../api/signatures.js';
import revenueRoutes from '../../api/revenue.js';
import stakingRoutes from '../../api/staking.js';
import ensRoutes from '../../api/ens.js';
import identityRoutes from '../../api/identity.js';
import scammerRegistryRoutes from '../../api/scammerRegistry.js';
import lpMarketMakerRoutes from '../../api/lpMarketMaker.js';
import musicLibraryRoutes from '../../api/music-library.js';
import vectorIntentRoutes from './vectorIntentRoutes.js';
import deviceAliasRoutes from './deviceAliasRoutes.js';
import mqttRoutes from './mqtt.js';
import mcpRoutes from './mcp.js';
import subagentsRoutes from './subagents.js';
import p2pRoutes, { syncServicesFromPlugins } from './p2p.js';
import coordinationRoutes from '../../api/coordination.js';
import avatarRoutes from '../../api/avatar.js';
import externalGatewayRoutes from '../../api/external/externalGateway.js';
import { readFileSync } from 'fs';
import { PluginSettings } from '../../models/PluginSettings.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import NodeCache from 'node-cache';
import agentIdentityService from '../../services/crypto/agentIdentityService.js';

const __filename = fileURLToPath(import.meta.url);

// Cache for OAuth state tokens (5-minute TTL)
const oauthStateCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const __dirname = path.dirname(__filename);

// Read version from package.json
let packageVersion = '1.0.0';
try {
  const packageJsonPath = path.join(__dirname, '../../../package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageVersion = packageJson.version;
} catch (error) {
  logger.warn('Could not read package.json version:', error.message);
}

export class WebInterface {
  constructor(agent) {
    this.agent = agent;
    this.app = express();
    this.server = null;
    this.io = null;
    this.port = process.env.WEB_PORT || process.env.AGENT_PORT || 80;
    this.connectedClients = new Map();
    this.updateInterval = null;
  }

  async initialize() {
    logger.info('Initializing Web Interface...');
    
    // Middleware
    this.app.use(express.json({ limit: '10mb' }));
    // Serve VRM avatar models from data directory
    this.app.use('/vrm-models', express.static(path.join(DATA_PATH, 'vrm-models')));
    // Serve GLB avatar models from data directory
    this.app.use('/glb-models', express.static(path.join(DATA_PATH, 'glb-models'), {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.glb')) {
          res.setHeader('Content-Type', 'model/gltf-binary');
          res.setHeader('Cache-Control', 'no-cache'); // revalidate on each request
        }
      }
    }));

    this.app.use(express.static(path.join(__dirname, 'public'), {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        // Prevent stale caching of HTML/JS/CSS — revalidate on every request
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    }));

    // Serve downloads directory for LAN access to large files
    this.app.use('/downloads', express.static(path.join(process.cwd(), 'downloads')));
    
    // CORS configuration - allow all origins for API accessibility
    // LANAgent is designed as an API-first system for remote access
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // Setup routes
    this.setupRoutes();
    
    // Create HTTP server
    this.server = http.createServer(this.app);
    
    // Setup WebSocket
    this.setupWebSocket();
    
    // Hydrate Gravatar API key from DB if not already in env
    try {
      const gravatarCreds = await PluginSettings.getCached('gravatar', 'credentials');
      if (gravatarCreds?.apiKey && !process.env.GRAVATAR_API_KEY) {
        process.env.GRAVATAR_API_KEY = decrypt(gravatarCreds.apiKey);
        logger.info('Gravatar API key loaded from database');
      }
    } catch (e) {
      logger.debug('Could not load Gravatar key from DB:', e.message);
    }

    // Hydrate Gravatar OAuth token from DB
    try {
      const oauthData = await PluginSettings.getCached('gravatar', 'oauth_token');
      if (oauthData?.access_token) {
        process.env.GRAVATAR_OAUTH_TOKEN = decrypt(oauthData.access_token);
        logger.info('Gravatar OAuth token loaded from database');
      }
    } catch (e) {
      logger.debug('Could not load Gravatar OAuth token from DB:', e.message);
    }

    // Hydrate Pinata IPFS keys from DB (for ERC-8004)
    try {
      const pinataKeys = await PluginSettings.getCached('erc8004', 'pinata_keys');
      if (pinataKeys?.apiKey && !process.env.PINATA_API_KEY) {
        process.env.PINATA_API_KEY = decrypt(pinataKeys.apiKey);
        process.env.PINATA_SECRET_KEY = decrypt(pinataKeys.secretKey);
        logger.info('Pinata IPFS keys loaded from database');
      }
    } catch (e) {
      logger.debug('Could not load Pinata keys from DB:', e.message);
    }

    // Set agent reference for identity service
    agentIdentityService.setAgent(this.agent);

    logger.info('Web Interface initialized');
  }

  // Helper function to remove duplicate and nonsense memories
  removeDuplicateMemories(memories) {
    const seen = new Set();
    const validMemories = [];
    
    for (const memory of memories) {
      // Skip nonsense memories (too short or just whitespace)
      if (!memory.content || memory.content.trim().length < 2) {
        continue;
      }
      
      // Skip single character memories
      if (memory.content.trim().length === 1) {
        continue;
      }
      
      // Create a normalized key for duplicate detection
      const normalizedContent = memory.content.toLowerCase().trim().replace(/\s+/g, ' ');
      const key = normalizedContent.substring(0, 100); // First 100 chars for comparison
      
      // Skip if we've already seen this content
      if (seen.has(key)) {
        continue;
      }
      
      seen.add(key);
      validMemories.push(memory);
    }
    
    return validMemories;
  }

  setupRoutes() {
    // Setup testing routes first
    setupTestingRoutes(this.app, this.agent);
    
    // Setup feature request routes
    setupFeatureRequestRoutes(this.app, this.agent);
    
    // Setup system reports routes - dynamic import to avoid circular dependency
    import('../../api/services/systemReports.js').then(module => {
      this.app.use('/api/system', module.default);
    }).catch(error => {
      logger.error('Failed to load system reports routes:', error);
    });
    
    // Setup VPN management routes
    this.app.locals.agent = this.agent;
    this.app.use('/vpn', vpnRoutes);
    
    // Setup Firewall management routes
    this.app.use('/firewall', firewallRoutes);
    
    // Setup SSH management routes
    this.app.use('/ssh', sshRoutes);

    // Cookie-jar admin endpoints removed in public — see import comment above.


    // Samba routes now handled by generic plugin router
    
    // Setup Network security monitoring routes
    this.app.use('/network', networkRoutes);
    
    // Setup Development Environment automation routes
    this.app.use('/devenv', devenvRoutes);
    
    // Setup Crypto wallet management routes
    // lpMarketMakerRoutes must mount BEFORE the broader /api/crypto router —
    // cryptoRoutes applies router-level authMiddleware that 401s any request
    // hitting `/api/crypto/*` before it can fall through to deeper mounts. Mount
    // the LP MM router first so its public /health endpoint (defined above the
    // auth middleware in lpMarketMaker.js) is reachable without a JWT. The
    // remaining /api/crypto/lp/mm/* routes still gate on lpMarketMaker.js's
    // own router-level authMiddleware.
    this.app.use('/api/crypto/lp/mm', lpMarketMakerRoutes);
    this.app.use('/api/crypto', cryptoRoutes);
    this.app.use('/api/contracts', contractsRoutes);
    this.app.use('/api/transactions', transactionsRoutes);
    this.app.use('/api/hardhat', hardhatRoutes);
    this.app.use('/api/faucets', faucetsRoutes);
    this.app.use('/api/donations', donationsRoutes);
    this.app.use('/api/signatures', signaturesRoutes);
    this.app.use('/api/revenue', revenueRoutes);
    this.app.use('/api/staking', stakingRoutes);
    this.app.use('/api/ens', ensRoutes);
    this.app.use('/api/identity', identityRoutes);
    this.app.use('/api/scammer-registry', scammerRegistryRoutes);
    this.app.use('/api/coordination', coordinationRoutes);
    this.app.use('/api/avatar', avatarRoutes);
    this.app.use('/api/music-library', musicLibraryRoutes);

    // Setup Vector Intent routes
    this.app.use('/api/vector-intent', vectorIntentRoutes);
    
    // Setup Device Alias routes
    this.app.use('/api/device-aliases', deviceAliasRoutes);

    // Setup MQTT & Automation routes
    this.app.use('/mqtt', mqttRoutes);

    // Setup MCP (Model Context Protocol) routes
    this.app.use('/mcp', mcpRoutes);

    // Setup Sub-Agent Orchestrator routes
    this.app.use('/api/subagents', subagentsRoutes);

    // Setup P2P Federation routes
    this.app.use('/p2p', p2pRoutes);

    // Setup Autonomous account registration routes - dynamic import to avoid circular dependency
    // Use a placeholder middleware registered synchronously so the route exists before the SPA catch-all,
    // then populate it when the async import resolves.
    let accountsRouter = null;
    this.app.use('/api/accounts', (req, res, next) => {
      if (accountsRouter) return accountsRouter(req, res, next);
      res.status(503).json({ success: false, error: 'Accounts service still loading' });
    });
    import('../../api/accounts.js').then(module => {
      accountsRouter = module.default;
      logger.info('Accounts routes loaded successfully');
    }).catch(error => {
      logger.error('Failed to load accounts routes:', error);
    });

    // Setup External Service Gateway (ERC-8004 Phase 3)
    this.app.use('/api/external', externalGatewayRoutes);
    
    // Basic health check (no auth required)
    // Health check endpoint (both paths for compatibility)
    const healthHandler = async (req, res) => {
      try {
        const latest = await this.agent.selfDiagnosticsService.getReport();
        const isHealthy = !latest || latest.overallHealth !== 'critical';
        
        res.json({ 
          status: isHealthy ? 'ok' : 'unhealthy',
          health: latest?.overallHealth || 'unknown',
          timestamp: new Date().toISOString(),
          uptime: process.uptime()
        });
      } catch (error) {
        res.status(500).json({ 
          status: 'error',
          error: error.message 
        });
      }
    };
    
    this.app.get('/health', healthHandler);
    this.app.get('/api/health', healthHandler);
    
    // Authentication
    this.app.post('/api/auth/login', async (req, res) => {
      try {
        const { password } = req.body;
        const correctPassword = process.env.WEB_PASSWORD || 'lanagent';
        
        if (password === correctPassword) {
          const token = generateToken({ user: 'admin' });
          res.json({ success: true, token });
        } else {
          res.status(401).json({ success: false, error: 'Invalid password' });
        }
      } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // API Key Management Routes
    
    // List all API keys
    this.app.get('/api/keys', authenticateToken, async (req, res) => {
      try {
        const { status, createdBy } = req.query;
        const filter = {};
        if (status) filter.status = status;
        if (createdBy) filter.createdBy = createdBy;
        
        const keys = await apiKeyService.listApiKeys(filter);
        res.json({ success: true, keys });
      } catch (error) {
        logger.error('Failed to list API keys:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Create new API key
    this.app.post('/api/keys', authenticateToken, async (req, res) => {
      try {
        const { name, description, expiresAt, rateLimit } = req.body;
        
        if (!name) {
          return res.status(400).json({ success: false, error: 'Name is required' });
        }
        
        const keyInfo = await apiKeyService.createApiKey({
          name,
          description,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          rateLimit: rateLimit || 100,
          createdBy: req.user?.authenticated ? 'user' : 'system'
        });
        
        res.json({ success: true, key: keyInfo });
      } catch (error) {
        logger.error('Failed to create API key:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Revoke API key
    this.app.post('/api/keys/:keyId/revoke', authenticateToken, async (req, res) => {
      try {
        const { keyId } = req.params;
        const success = await apiKeyService.revokeApiKey(keyId);
        
        if (success) {
          res.json({ success: true, message: 'API key revoked' });
        } else {
          res.status(404).json({ success: false, error: 'API key not found' });
        }
      } catch (error) {
        logger.error('Failed to revoke API key:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Suspend API key
    this.app.post('/api/keys/:keyId/suspend', authenticateToken, async (req, res) => {
      try {
        const { keyId } = req.params;
        const success = await apiKeyService.suspendApiKey(keyId);
        
        if (success) {
          res.json({ success: true, message: 'API key suspended' });
        } else {
          res.status(404).json({ success: false, error: 'API key not found' });
        }
      } catch (error) {
        logger.error('Failed to suspend API key:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Reactivate API key
    this.app.post('/api/keys/:keyId/reactivate', authenticateToken, async (req, res) => {
      try {
        const { keyId } = req.params;
        const success = await apiKeyService.reactivateApiKey(keyId);
        
        if (success) {
          res.json({ success: true, message: 'API key reactivated' });
        } else {
          res.status(404).json({ success: false, error: 'API key not found or not suspended' });
        }
      } catch (error) {
        logger.error('Failed to reactivate API key:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Delete API key
    this.app.delete('/api/keys/:keyId', authenticateToken, async (req, res) => {
      try {
        const { keyId } = req.params;
        const success = await apiKeyService.deleteApiKey(keyId);
        
        if (success) {
          res.json({ success: true, message: 'API key deleted' });
        } else {
          res.status(404).json({ success: false, error: 'API key not found' });
        }
      } catch (error) {
        logger.error('Failed to delete API key:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Get API key statistics
    this.app.get('/api/keys/stats', authenticateToken, async (req, res) => {
      try {
        const stats = await apiKeyService.getApiKeyStats();
        res.json({ success: true, stats });
      } catch (error) {
        logger.error('Failed to get API key stats:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // System status
    this.app.get('/api/system/status', authenticateToken, async (req, res) => {
      try {
        const status = await this.agent.getSystemStatus();
        res.json({ success: true, data: status });
      } catch (error) {
        logger.error('Status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // System restart
    this.app.post('/api/system/restart', authenticateToken, async (req, res) => {
      try {
        const { reset = false } = req.body;
        
        logger.info(`System restart requested from web UI (reset: ${reset})`);
        
        // Send response before restarting
        res.json({ 
          success: true, 
          message: `Agent will restart${reset ? ' with log reset' : ''} in 2 seconds` 
        });
        
        // Schedule restart after response is sent
        setTimeout(async () => {
          try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            
            if (reset) {
              // Reset logs and restart
              await execAsync('pm2 reset lan-agent');
              logger.info('PM2 logs reset');
            }
            
            // Restart the agent
            await execAsync('pm2 restart lan-agent');
            logger.info('PM2 restart command executed');
          } catch (error) {
            logger.error('Failed to restart agent:', error);
            process.exit(1); // Force exit, PM2 will restart
          }
        }, 2000);
        
      } catch (error) {
        logger.error('Restart error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get autonomous deployment setting
    this.app.get('/api/settings/autonomous-deployment', authenticateToken, async (req, res) => {
      try {
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        const enabled = await SystemSettings.getSetting('autonomous-deployment', false);
        res.json({ success: true, enabled });
      } catch (error) {
        logger.error('Get autonomous deployment setting error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Set autonomous deployment setting
    this.app.post('/api/settings/autonomous-deployment', authenticateToken, async (req, res) => {
      try {
        const { enabled } = req.body;
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        
        await SystemSettings.setSetting(
          'autonomous-deployment',
          enabled,
          'Allow agent to automatically deploy critical updates',
          'deployment'
        );
        
        logger.info(`Autonomous deployment setting updated: ${enabled}`);
        res.json({ success: true, enabled });
      } catch (error) {
        logger.error('Set autonomous deployment setting error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // SKYNET token address setting
    this.app.get('/api/settings/skynet-token-address', authenticateToken, async (req, res) => {
      try {
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        const value = await SystemSettings.getSetting('skynet_token_address', '0x8Ef02e4a3203E845CC5FA08B81e4C109ceDCb04F');
        res.json({ success: true, value });
      } catch (error) {
        logger.error('Get SKYNET token address error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/settings/skynet-token-address', authenticateToken, async (req, res) => {
      try {
        const { value } = req.body;
        if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
          return res.status(400).json({ success: false, error: 'Invalid contract address format' });
        }
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        await SystemSettings.setSetting(
          'skynet_token_address',
          value,
          'SKYNET BEP-20 token contract address on BSC',
          'crypto'
        );
        logger.info(`SKYNET token address updated: ${value}`);
        res.json({ success: true, value });
      } catch (error) {
        logger.error('Set SKYNET token address error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // BitNet LLM start/stop/status
    this.app.get('/api/bitnet/status', authenticateToken, async (req, res) => {
      try {
        const { execSync } = await import('child_process');
        const running = (() => { try { execSync('pgrep -f llama-server', { timeout: 3000 }); return true; } catch { return false; } })();
        let ram = '--';
        if (running) {
          try { ram = execSync("ps aux | grep llama-server | grep -v grep | awk '{print $6}'", { encoding: 'utf8', timeout: 3000 }).trim();
            ram = Math.round(parseInt(ram) / 1024) + 'MB';
          } catch {}
        }
        res.json({ success: true, running, ram });
      } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    this.app.post('/api/bitnet/start', authenticateToken, async (req, res) => {
      try {
        const { exec } = await import('child_process');
        const cmd = '/root/BitNet/build/bin/llama-server -m /root/BitNet/models/BitNet-b1.58-2B-4T/ggml-model-i2_s.gguf -t 4 -c 2048 -n 4096 --host 0.0.0.0 --port 8080 -ngl 0';
        exec(`nohup ${cmd} > /dev/null 2>&1 &`);
        res.json({ success: true, message: 'BitNet server starting' });
      } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    this.app.post('/api/bitnet/stop', authenticateToken, async (req, res) => {
      try {
        const { execSync } = await import('child_process');
        try { execSync('pkill -f llama-server', { timeout: 5000 }); } catch {}
        res.json({ success: true, message: 'BitNet server stopped' });
      } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    this.app.get('/api/settings/skynet-staking-address', authenticateToken, async (req, res) => {
      try {
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        const value = await SystemSettings.getSetting('skynet_staking_address', '');
        res.json({ success: true, value });
      } catch (error) {
        logger.error('Get SKYNET staking address error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/settings/skynet-staking-address', authenticateToken, async (req, res) => {
      try {
        const { value } = req.body;
        if (value && !/^0x[0-9a-fA-F]{40}$/.test(value)) {
          return res.status(400).json({ success: false, error: 'Invalid contract address format' });
        }
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        await SystemSettings.setSetting(
          'skynet_staking_address',
          value || '',
          'SKYNET staking contract address on BSC',
          'crypto'
        );
        // Re-initialize staking service with new address
        try {
          const stakingService = (await import('../../services/crypto/skynetStakingService.js')).default;
          await stakingService.initialize();
        } catch (e) { /* non-critical */ }
        logger.info(`SKYNET staking address updated: ${value}`);
        res.json({ success: true, value });
      } catch (error) {
        logger.error('Set SKYNET staking address error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // System redeploy - pull latest from git and restart
    this.app.post('/api/system/redeploy', authenticateToken, async (req, res) => {
      try {
        logger.info('System redeploy requested from web UI');
        
        // Use the system plugin to handle redeploy
        const systemPlugin = this.agent.apiManager?.getPlugin('system');
        if (!systemPlugin) {
          return res.status(500).json({ success: false, error: 'System plugin not available' });
        }
        
        // Execute redeploy action
        const result = await systemPlugin.execute({
          action: 'redeploy',
          userId: process.env.TELEGRAM_USER_ID // Use master user ID for authorization
        });
        
        if (result.success) {
          res.json({ 
            success: true, 
            message: result.result
          });
        } else {
          res.status(400).json({ 
            success: false, 
            error: result.error 
          });
        }
        
      } catch (error) {
        logger.error('System redeploy error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Reset git repository - clean lanagent-repo and pull latest
    this.app.post('/api/system/reset-repo', authenticateToken, async (req, res) => {
      try {
        logger.info('Git repository reset requested from web UI');

        const { execSync } = await import('child_process');
        const repoPath = process.env.AGENT_REPO_PATH || process.cwd();

        // Execute git commands to reset the repo
        // Uses fetch + reset --hard to handle divergent branches (e.g. after history rewrite)
        const commands = [
          `cd ${repoPath} && git checkout main`,
          `cd ${repoPath} && git checkout -- .`,
          `cd ${repoPath} && git clean -fd`,
          `cd ${repoPath} && git fetch origin`,
          `cd ${repoPath} && git reset --hard origin/main`
        ];

        const results = [];
        for (const cmd of commands) {
          try {
            const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
            results.push({ command: cmd.split(' && ')[1], success: true, output: output.trim() });
          } catch (cmdError) {
            results.push({ command: cmd.split(' && ')[1], success: false, error: cmdError.message });
          }
        }

        // Check final status
        const statusOutput = execSync(`cd ${repoPath} && git status --porcelain`, { encoding: 'utf-8' });
        const isClean = statusOutput.trim() === '';

        res.json({
          success: isClean,
          message: isClean ? 'Repository reset successfully' : 'Repository may have issues',
          results,
          clean: isClean
        });

      } catch (error) {
        logger.error('Git repository reset error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Diagnostics endpoints
    this.app.get('/api/diagnostics/run', authenticateToken, async (req, res) => {
      try {
        const { triggeredBy = 'manual' } = req.query;
        const result = await this.agent.selfDiagnosticsService.runDiagnostics(triggeredBy, 'web-user');
        res.json(result);
      } catch (error) {
        logger.error('Diagnostics run error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/diagnostics/latest', authenticateToken, async (req, res) => {
      try {
        const report = await this.agent.selfDiagnosticsService.getReport();
        res.json({ 
          success: true, 
          report,
          formatted: report ? this.agent.selfDiagnosticsService.formatReport(report) : null
        });
      } catch (error) {
        logger.error('Diagnostics latest error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/diagnostics/history', authenticateToken, async (req, res) => {
      try {
        const { limit = 10 } = req.query;
        const history = await this.agent.selfDiagnosticsService.getHistory(parseInt(limit));
        res.json({ success: true, history });
      } catch (error) {
        logger.error('Diagnostics history error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/diagnostics/trend', authenticateToken, async (req, res) => {
      try {
        const { days = 7 } = req.query;
        const trend = await this.agent.selfDiagnosticsService.getHealthTrend(parseInt(days));
        res.json({ success: true, trend });
      } catch (error) {
        logger.error('Diagnostics trend error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/diagnostics/config', authenticateToken, async (req, res) => {
      try {
        const service = this.agent.selfDiagnosticsService;
        res.json({ 
          success: true, 
          config: service.config,
          lastRun: service.lastRun,
          isRunning: service.isRunning
        });
      } catch (error) {
        logger.error('Diagnostics config error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/diagnostics/config', authenticateToken, async (req, res) => {
      try {
        const { enabled, autoRunInterval, thresholds } = req.body;
        const service = this.agent.selfDiagnosticsService;
        
        if (enabled !== undefined) {
          service.config.enabled = enabled;
        }
        
        if (autoRunInterval !== undefined) {
          service.config.autoRunInterval = autoRunInterval;
        }
        
        if (thresholds) {
          Object.assign(service.config.thresholds, thresholds);
        }
        
        // Reinitialize if needed
        if (service.config.enabled) {
          await service.initialize();
        }
        
        res.json({ success: true, config: service.config });
      } catch (error) {
        logger.error('Diagnostics config update error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Command execution
    this.app.post('/api/command/execute', authenticateToken, async (req, res) => {
      try {
        const { command } = req.body;
        const result = await this.agent.processNaturalLanguage(command, {
          userId: 'web-user',
          interface: 'web'
        });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Command error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Voice transcription endpoint (base64 audio -> text)
    this.app.post('/api/voice/transcribe', authenticateToken, async (req, res) => {
      try {
        const { audio, mimeType } = req.body;

        if (!audio) {
          return res.status(400).json({ success: false, error: 'No audio data provided' });
        }

        // Convert base64 to buffer
        const audioBuffer = Buffer.from(audio, 'base64');
        logger.info(`Voice transcription request: ${audioBuffer.length} bytes, type: ${mimeType}`);

        // Transcribe using provider manager
        const transcription = await this.agent.providerManager.transcribeAudio(audioBuffer);

        if (!transcription) {
          throw new Error('Transcription returned empty result');
        }

        logger.info(`Voice transcribed: "${transcription.substring(0, 50)}..."`);
        res.json({ success: true, transcription });
      } catch (error) {
        logger.error('Voice transcription error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Text-to-speech endpoint (text -> audio URL)
    this.app.post('/api/voice/speak', authenticateToken, async (req, res) => {
      try {
        const { text } = req.body;

        if (!text) {
          return res.status(400).json({ success: false, error: 'No text provided' });
        }

        // Check if TTS service is available
        if (!this.agent.ttsService) {
          return res.status(503).json({ success: false, error: 'TTS service not available' });
        }

        // Generate speech
        const result = await this.agent.ttsService.generateSpeech(text);

        // Convert buffer to base64 data URL for direct playback
        const base64Audio = result.buffer.toString('base64');
        const audioUrl = `data:audio/mp3;base64,${base64Audio}`;

        res.json({
          success: true,
          audioUrl,
          size: result.size,
          cost: result.cost
        });
      } catch (error) {
        logger.error('TTS error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // AI Provider management
    this.app.get('/api/ai/providers', authenticateToken, async (req, res) => {
      try {
        const providers = this.agent.providerManager.getProviderList();
        const current = this.agent.getCurrentAIProvider();
        
        // Get config including autoModelUpdate setting
        const { Agent } = await import('../../models/Agent.js');
        const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
        const config = {
          autoModelUpdate: agentData?.config?.autoModelUpdate !== false
        };
        
        // Add current model info to each provider
        const providersWithModels = providers.map(p => {
          const providerInstance = this.agent.providerManager.providers.get(p.key);
          let currentModel = null;
          
          if (providerInstance) {
            if (providerInstance.models && providerInstance.models.chat) {
              currentModel = providerInstance.models.chat;
            } else if (providerInstance.model) {
              currentModel = providerInstance.model;
            }
            
            // Special handling for HuggingFace - make sure we don't send the whole models object
            if (p.name === 'HuggingFace' && typeof currentModel === 'object') {
              currentModel = currentModel.chat || 'meta-llama/Llama-3.2-1B-Instruct';
            }
          }
          
          return {
            ...p,
            currentModel,
            serverOnline: providerInstance?.serverOnline !== undefined ? providerInstance.serverOnline : true,
            local: providerInstance?.getCapabilities?.()?.local || false
          };
        });
        
        // Debug logging - DETAILED MODEL INFO
        for (const p of providersWithModels) {
          const providerInstance = this.agent.providerManager.providers.get(p.key);
          logger.info(`Provider ${p.key} debug:`, {
            name: p.name,
            currentModel: p.currentModel,
            providerModelsObject: providerInstance?.models,
            active: p.active
          });
        }
        logger.info('API /api/ai/providers - Provider list with models:', safeJsonStringify(providersWithModels, 2));
        logger.info('API /api/ai/providers - Current provider:', current);
        logger.info('API /api/ai/providers - Config:', config);
        
        res.json({ 
          success: true, 
          data: { providers: providersWithModels, current, config } 
        });
      } catch (error) {
        logger.error('AI providers error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/ai/switch', authenticateToken, async (req, res) => {
      try {
        const { provider } = req.body;
        logger.info(`🔄 API call to switch provider to: ${provider}`);
        await this.agent.switchAIProvider(provider);
        logger.info(`✅ Provider switched successfully to: ${provider}`);
        res.json({ success: true });
      } catch (error) {
        logger.error('AI switch error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update AI models endpoint
    this.app.post('/api/ai/update-models', authenticateToken, async (req, res) => {
      try {
        const { provider } = req.body;
        
        logger.info(`Manually updating models for: ${provider || 'all providers'}`);
        
        // Get or create model updater
        let modelUpdater = this.agent.apiManager?.getPlugin('aiModels');
        
        if (!modelUpdater) {
          const { ModelUpdaterService } = await import('../../services/modelUpdater.js');
          modelUpdater = new ModelUpdaterService(this.agent);
          await modelUpdater.initialize();
        }
        
        let results;
        if (provider) {
          // Update specific provider
          const updated = await modelUpdater.updateProviderModels(provider);
          results = updated ? { success: [provider], failed: [] } : { success: [], failed: [provider] };
          
          // Update provider configuration
          if (updated) {
            await modelUpdater.updateProviderConfiguration(provider);
          }
        } else {
          // Update all providers
          results = await modelUpdater.updateAllProviders();
          
          // Update configurations
          for (const prov of results.success) {
            await modelUpdater.updateProviderConfiguration(prov);
          }
        }
        
        res.json({ success: true, results });
      } catch (error) {
        logger.error('Model update error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Get available models for a provider
    this.app.get('/api/ai/models/:provider', authenticateToken, async (req, res) => {
      try {
        const { provider } = req.params;
        const providerInstance = this.agent.providerManager.providers.get(provider);
        
        if (!providerInstance) {
          return res.status(404).json({ success: false, error: 'Provider not found' });
        }
        
        const models = providerInstance.getAvailableModels ? 
          providerInstance.getAvailableModels() : 
          providerInstance.models || [];
        
        res.json({ success: true, models });
      } catch (error) {
        logger.error('Get models error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // HuggingFace configuration endpoints
    this.app.get('/api/ai/huggingface/config', authenticateToken, async (req, res) => {
      try {
        const hfProvider = this.agent.providerManager.providers.get('huggingface');
        if (!hfProvider) {
          return res.status(404).json({ success: false, error: 'HuggingFace provider not found' });
        }
        
        const config = hfProvider.getConfiguration();
        res.json({ success: true, config });
      } catch (error) {
        logger.error('HF config get error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/ai/huggingface/config', authenticateToken, async (req, res) => {
      try {
        const hfProvider = this.agent.providerManager.providers.get('huggingface');
        if (!hfProvider) {
          return res.status(404).json({ success: false, error: 'HuggingFace provider not found' });
        }
        
        hfProvider.updateConfiguration(req.body);
        res.json({ success: true, message: 'Configuration updated' });
      } catch (error) {
        logger.error('HF config update error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // AI Provider metrics endpoint
    this.app.get('/api/ai/metrics', authenticateToken, async (req, res) => {
      try {
        const { TokenUsage } = await import('../../models/TokenUsage.js');
        
        // Get metrics from database for all providers
        const providers = this.agent.providerManager.getProviderList();
        const formattedMetrics = {};
        
        // Get metrics for each provider
        for (const provider of providers) {
          const providerKey = provider.key;
          
          try {
            // Get daily metrics
            const dailyMetrics = await TokenUsage.getDailyMetrics(providerKey, 7);
            
            // Get model metrics
            const modelMetrics = await TokenUsage.getModelMetrics(providerKey);
            
            // Get total metrics
            const totalMetrics = await TokenUsage.getTotalMetrics(providerKey);
            
            // Also include in-memory metrics from provider instance
            const providerInstance = this.agent.providerManager.providers.get(providerKey);
            const inMemoryMetrics = providerInstance ? providerInstance.getMetrics() : {};
            
            // Merge database and in-memory metrics
            formattedMetrics[providerKey] = {
              totalRequests: totalMetrics.totalRequests || inMemoryMetrics.totalRequests || 0,
              totalTokens: totalMetrics.totalTokens || inMemoryMetrics.totalTokens || 0,
              inputTokens: totalMetrics.totalPromptTokens || inMemoryMetrics.inputTokens || 0,
              outputTokens: totalMetrics.totalCompletionTokens || inMemoryMetrics.outputTokens || 0,
              errors: totalMetrics.errors || inMemoryMetrics.errors || 0,
              averageResponseTime: totalMetrics.avgResponseTime || inMemoryMetrics.averageResponseTime || 0,
              costEstimate: totalMetrics.totalCost || inMemoryMetrics.costEstimate || 0,
              tokensByDay: dailyMetrics.reduce((acc, day) => {
                acc[day._id.date] = {
                  input: day.promptTokens,
                  output: day.completionTokens,
                  total: day.totalTokens
                };
                return acc;
              }, inMemoryMetrics.tokensByDay || {}),
              tokensByModel: modelMetrics.reduce((acc, model) => {
                acc[model._id] = {
                  input: model.promptTokens,
                  output: model.completionTokens,
                  total: model.totalTokens,
                  count: model.requests
                };
                return acc;
              }, inMemoryMetrics.tokensByModel || {})
            };
          } catch (error) {
            logger.debug(`No metrics found for provider ${providerKey}:`, error.message);
            // Use in-memory metrics if database query fails
            const providerInstance = this.agent.providerManager.providers.get(providerKey);
            if (providerInstance) {
              formattedMetrics[providerKey] = providerInstance.getMetrics();
            }
          }
        }
        
        // Get provider comparison data
        const providerComparison = await TokenUsage.getProviderComparison();
        
        res.json({ 
          success: true, 
          metrics: formattedMetrics,
          providers,
          currentProvider: this.agent.providerManager.activeProvider?.name || 'none',
          providerComparison
        });
      } catch (error) {
        logger.error('AI metrics error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Archive current stats and optionally clear them
    this.app.post('/api/ai/metrics/archive', authenticateToken, async (req, res) => {
      try {
        const { ProviderStatsArchive } = await import('../../models/ProviderStatsArchive.js');
        const { TokenUsage } = await import('../../models/TokenUsage.js');
        const { clearAfterArchive = true, notes = '' } = req.body;

        // Create the archive
        const archive = await ProviderStatsArchive.createArchive('manual', notes);

        // Clear current stats if requested
        if (clearAfterArchive) {
          await TokenUsage.deleteMany({});

          // Reset in-memory metrics for all providers
          const providers = this.agent.providerManager.providers;
          for (const [key, provider] of providers) {
            if (provider.resetMetrics) {
              provider.resetMetrics();
            }
          }
        }

        logger.info(`Provider stats archived for ${archive.year}-${String(archive.month).padStart(2, '0')}, clearAfterArchive: ${clearAfterArchive}`);

        res.json({
          success: true,
          message: `Stats archived for ${archive.year}-${String(archive.month).padStart(2, '0')}`,
          archive: {
            period: `${archive.year}-${String(archive.month).padStart(2, '0')}`,
            totals: archive.totals,
            providers: archive.providers.map(p => ({
              provider: p.provider,
              requests: p.totalRequests,
              tokens: p.totalTokens,
              cost: p.totalCost
            }))
          },
          cleared: clearAfterArchive
        });
      } catch (error) {
        logger.error('Archive stats error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get historical stats archives
    this.app.get('/api/ai/metrics/history', authenticateToken, async (req, res) => {
      try {
        const { ProviderStatsArchive } = await import('../../models/ProviderStatsArchive.js');
        const limit = parseInt(req.query.limit) || 12;

        const archives = await ProviderStatsArchive.getArchives(limit);
        const trends = await ProviderStatsArchive.getUsageTrends(limit);

        res.json({
          success: true,
          archives: archives.map(a => ({
            id: a._id,
            period: `${a.year}-${String(a.month).padStart(2, '0')}`,
            year: a.year,
            month: a.month,
            periodStart: a.periodStart,
            periodEnd: a.periodEnd,
            totals: a.totals,
            providers: a.providers,
            archiveType: a.archiveType,
            archivedAt: a.archivedAt,
            notes: a.notes
          })),
          trends
        });
      } catch (error) {
        logger.error('Get stats history error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get specific month's archive
    this.app.get('/api/ai/metrics/history/:year/:month', authenticateToken, async (req, res) => {
      try {
        const { ProviderStatsArchive } = await import('../../models/ProviderStatsArchive.js');
        const { year, month } = req.params;

        const archive = await ProviderStatsArchive.getArchiveByMonth(
          parseInt(year),
          parseInt(month)
        );

        if (!archive) {
          return res.status(404).json({
            success: false,
            error: `No archive found for ${year}-${month}`
          });
        }

        res.json({
          success: true,
          archive: {
            id: archive._id,
            period: `${archive.year}-${String(archive.month).padStart(2, '0')}`,
            year: archive.year,
            month: archive.month,
            periodStart: archive.periodStart,
            periodEnd: archive.periodEnd,
            totals: archive.totals,
            providers: archive.providers,
            archiveType: archive.archiveType,
            archivedAt: archive.archivedAt,
            notes: archive.notes
          }
        });
      } catch (error) {
        logger.error('Get archive by month error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Clear current stats (requires archiving first or explicit force)
    this.app.delete('/api/ai/metrics', authenticateToken, async (req, res) => {
      try {
        const { TokenUsage } = await import('../../models/TokenUsage.js');
        const { force = false } = req.query;

        if (!force) {
          return res.status(400).json({
            success: false,
            error: 'Use POST /api/ai/metrics/archive to archive before clearing, or pass ?force=true to clear without archiving'
          });
        }

        // Clear database
        const result = await TokenUsage.deleteMany({});

        // Reset in-memory metrics for all providers
        const providers = this.agent.providerManager.providers;
        for (const [key, provider] of providers) {
          if (provider.resetMetrics) {
            provider.resetMetrics();
          }
        }

        logger.info(`Provider stats cleared without archiving (force=true), deleted ${result.deletedCount} records`);

        res.json({
          success: true,
          message: 'Stats cleared without archiving',
          deletedCount: result.deletedCount
        });
      } catch (error) {
        logger.error('Clear stats error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Improvement statistics endpoint
    this.app.get('/api/ai/improvement-stats', authenticateToken, async (req, res) => {
      try {
        const days = parseInt(req.query.days) || 30;
        const stats = await this.agent.metricsUpdater.getImprovementStats(days);
        
        if (!stats) {
          res.json({ 
            success: true, 
            message: 'No improvement statistics available',
            stats: null
          });
        } else {
          res.json({ 
            success: true, 
            stats,
            period: days,
            lastUpdated: new Date()
          });
        }
      } catch (error) {
        logger.error('Improvement stats error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Runtime errors endpoint
    this.app.get('/api/ai/runtime-errors', authenticateToken, async (req, res) => {
      try {
        const stats = await this.agent.errorLogScanner.getStats();
        
        res.json({ 
          success: true, 
          stats,
          scannerActive: this.agent.errorLogScanner.isScanning
        });
      } catch (error) {
        logger.error('Runtime errors stats error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Combined agent statistics endpoint
    this.app.get('/api/ai/agent-stats', authenticateToken, async (req, res) => {
      try {
        // Get various statistics
        const [improvementStats, errorStats, selfModStats] = await Promise.all([
          this.agent.metricsUpdater.getImprovementStats(30),
          this.agent.errorLogScanner.getStats(),
          this.agent.selfModification ? this.agent.selfModification.getStats() : null
        ]);

        res.json({ 
          success: true,
          stats: {
            improvements: improvementStats,
            runtimeErrors: errorStats,
            selfModification: selfModStats,
            agentUptime: Date.now() - this.agent.startTime,
            version: this.agent.version || '2.8.52'
          },
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Agent stats error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Memory/conversations
    this.app.get('/api/memory/recent', authenticateToken, async (req, res) => {
      try {
        const memories = await this.agent.memoryManager.getRecentConversations(20);
        res.json({ success: true, data: memories });
      } catch (error) {
        logger.error('Memory error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Current conversation context
    this.app.get('/api/memory/current-context', authenticateToken, async (req, res) => {
      try {
        const userId = process.env.TELEGRAM_USER_ID;
        const context = await this.agent.memoryManager.getConversationContext(userId, 50);
        res.json({ success: true, data: context });
      } catch (error) {
        logger.error('Current context error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Conversation history
    this.app.get('/api/memory/conversation-history', authenticateToken, async (req, res) => {
      try {
        const { date } = req.query;
        let conversations;
        
        if (date) {
          const startDate = new Date(date);
          const endDate = new Date(date);
          endDate.setDate(endDate.getDate() + 1);
          
          conversations = await this.agent.memoryManager.searchByTimeRange(
            startDate,
            endDate,
            { type: 'conversation', limit: 100 }
          );
        } else {
          conversations = await this.agent.memoryManager.recall('', {
            type: 'conversation',
            limit: 100
          });
        }
        
        res.json({ success: true, data: conversations });
      } catch (error) {
        logger.error('Conversation history error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Learned memories with search, sort, and deduplication
    this.app.get('/api/memory/learned', authenticateToken, async (req, res) => {
      try {
        const { category, search, sort = 'newest', limit = 50 } = req.query;
        const { Memory } = await import('../../models/Memory.js');
        
        // Build query
        let query = { type: 'knowledge' };
        
        // Category filter
        if (category && category !== 'all') {
          query['metadata.category'] = category;
        }
        
        // Search filter
        if (search && search.trim()) {
          const searchRegex = new RegExp(search.trim(), 'i');
          query.$or = [
            { content: searchRegex },
            { 'metadata.title': searchRegex },
            { 'metadata.tags': { $in: [searchRegex] } }
          ];
        }
        
        // Build sort object
        let sortObj = {};
        switch (sort) {
          case 'newest':
            sortObj = { createdAt: -1 };
            break;
          case 'oldest':
            sortObj = { createdAt: 1 };
            break;
          case 'importance':
            sortObj = { 'metadata.importance': -1, createdAt: -1 };
            break;
          case 'accessed':
            sortObj = { accessCount: -1, lastAccessedAt: -1 };
            break;
          case 'alphabetical':
            sortObj = { content: 1 };
            break;
          default:
            sortObj = { createdAt: -1 };
        }
        
        // Get memories with filters
        let memories = await Memory.find(query)
          .sort(sortObj)
          .limit(parseInt(limit));
        
        // Duplicate detection and removal
        memories = this.removeDuplicateMemories(memories);
        
        res.json({ 
          success: true, 
          data: memories,
          totalFound: memories.length,
          filters: { category, search, sort, limit }
        });
      } catch (error) {
        logger.error('Learned memory error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Edit memory
    this.app.post('/api/memory/:id/edit', authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { content } = req.body;
        
        const memory = await Memory.findById(id);
        
        if (!memory) {
          return res.status(404).json({ success: false, error: 'Memory not found' });
        }
        
        memory.content = content;
        await memory.save();
        
        res.json({ success: true, data: memory });
      } catch (error) {
        logger.error('Edit memory error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Delete memory
    this.app.post('/api/memory/:id/delete', authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        
        logger.info(`Attempting to delete memory with ID: ${id}`);
        
        // Validate ObjectId format
        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
          logger.error(`Invalid memory ID format: ${id}`);
          return res.status(400).json({ success: false, error: 'Invalid memory ID format' });
        }
        
        const result = await Memory.findByIdAndDelete(id);
        
        if (!result) {
          logger.error(`Memory not found with ID: ${id}`);
          return res.status(404).json({ success: false, error: 'Memory not found' });
        }
        
        logger.info(`Successfully deleted memory with ID: ${id}`);
        res.json({ success: true, message: 'Memory deleted successfully' });
      } catch (error) {
        logger.error('Delete memory error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Add new memory
    this.app.post('/api/memory/add', authenticateToken, async (req, res) => {
      try {
        const { type, content, metadata } = req.body;
        
        const memory = await this.agent.memoryManager.store(
          type || 'knowledge',
          content,
          metadata || {}
        );
        
        res.json({ success: true, data: memory });
      } catch (error) {
        logger.error('Add memory error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Batch delete memories
    this.app.post('/api/memory/batch-delete', authenticateToken, async (req, res) => {
      try {
        const { ids } = req.body;
        
        logger.info(`Batch delete request received for ${Array.isArray(ids) ? ids.length : 0} memories`);
        
        if (!Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ success: false, error: 'No memory IDs provided' });
        }
        
        // Validate all IDs are valid ObjectIds
        const validIds = ids.filter(id => id && id.match(/^[0-9a-fA-F]{24}$/));
        if (validIds.length !== ids.length) {
          logger.warn(`Some invalid IDs filtered out. Valid: ${validIds.length}, Total: ${ids.length}`);
        }
        
        if (validIds.length === 0) {
          return res.status(400).json({ success: false, error: 'No valid memory IDs provided' });
        }
        
        const { Memory } = await import('../../models/Memory.js');
        const result = await Memory.deleteMany({ _id: { $in: validIds } });
        
        logger.info(`Batch delete completed. Deleted ${result.deletedCount} memories`);
        
        res.json({ 
          success: true, 
          deleted: result.deletedCount,
          requested: validIds.length,
          message: `Successfully deleted ${result.deletedCount} memories` 
        });
      } catch (error) {
        logger.error('Batch delete memory error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get memory settings
    this.app.get('/api/memory/settings', authenticateToken, async (req, res) => {
      try {
        const settings = this.agent.memoryManager.getSettings();
        res.json({ success: true, settings });
      } catch (error) {
        logger.error('Get memory settings error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Get memory status
    this.app.get('/api/memory/status', authenticateToken, async (req, res) => {
      try {
        // Get total memory count - use the method from memoryManager
        const stats = await this.agent.memoryManager.getMemoryStats();
        const recentMemories = await this.agent.memoryManager.getRecentConversations(5);
        const settings = this.agent.memoryManager.getSettings();

        res.json({
          success: true,
          status: {
            totalMemories: stats.total,
            recentCount: recentMemories.length,
            autoAddEnabled: settings.autoAddEnabled,
            lastMemoryTime: recentMemories[0]?.timestamp || null,
            vectorStore: {
              initialized: stats.vectorStore?.initialized || false,
              totalMemories: stats.vectorStore?.totalMemories || 0,
              tableName: stats.vectorStore?.tableName
            }
          }
        });
      } catch (error) {
        logger.error('Get memory status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update memory settings
    this.app.post('/api/memory/settings', authenticateToken, async (req, res) => {
      try {
        const { autoAddEnabled, deduplicationEnabled, deduplicationThreshold } = req.body;

        const updates = {};
        if (autoAddEnabled !== undefined) updates.autoAddEnabled = autoAddEnabled;
        if (deduplicationEnabled !== undefined) updates.deduplicationEnabled = deduplicationEnabled;
        if (deduplicationThreshold !== undefined) {
          // Validate threshold (0.5 to 1.0)
          const threshold = parseFloat(deduplicationThreshold);
          if (threshold >= 0.5 && threshold <= 1.0) {
            updates.deduplicationThreshold = threshold;
          }
        }

        await this.agent.memoryManager.updateSettings(updates);

        res.json({ success: true, message: 'Memory settings updated' });
      } catch (error) {
        logger.error('Update memory settings error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Clear all memories (with type filter option)
    this.app.post('/api/memory/clear-all', authenticateToken, async (req, res) => {
      try {
        const { type, confirmPhrase } = req.body;

        // Require confirmation phrase for safety
        if (confirmPhrase !== 'DELETE ALL MEMORIES') {
          return res.status(400).json({
            success: false,
            error: 'Confirmation phrase required. Send { confirmPhrase: "DELETE ALL MEMORIES" }'
          });
        }

        const query = { isPermanent: { $ne: true } }; // Never delete permanent memories
        if (type && type !== 'all') {
          query.type = type;
        }

        // Get memory IDs for vector store cleanup
        const memoriesToDelete = await Memory.find(query).select('_id');
        const memoryIds = memoriesToDelete.map(m => m._id.toString());

        // Delete from MongoDB
        const result = await Memory.deleteMany(query);

        // Delete from vector store
        if (this.agent.memoryManager.vectorStoreReady && memoryIds.length > 0) {
          try {
            const { memoryVectorStore } = await import('../../services/memoryVectorStore.js');
            await memoryVectorStore.deleteMemories(memoryIds);
          } catch (error) {
            logger.warn('Failed to clear memories from vector store:', error.message);
          }
        }

        // Clear cache
        this.agent.memoryManager.cache.clear();

        logger.info(`Cleared ${result.deletedCount} memories (type: ${type || 'all'})`);
        res.json({
          success: true,
          message: `Successfully deleted ${result.deletedCount} memories`,
          deletedCount: result.deletedCount
        });
      } catch (error) {
        logger.error('Clear all memories error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Rebuild vector index
    this.app.post('/api/memory/rebuild-index', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.memoryManager.vectorStoreReady) {
          return res.status(400).json({
            success: false,
            error: 'Vector store not initialized'
          });
        }

        const result = await this.agent.memoryManager.rebuildVectorIndex();
        res.json({
          success: true,
          message: `Vector index rebuilt with ${result.indexed} memories`,
          indexed: result.indexed
        });
      } catch (error) {
        logger.error('Rebuild vector index error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Tasks
    this.app.get('/api/tasks', authenticateToken, async (req, res) => {
      try {
        const tasks = await this.agent.getTasks();
        res.json({ success: true, data: tasks });
      } catch (error) {
        logger.error('Tasks error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/tasks/:id', authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          throw new Error('Tasks plugin not available');
        }
        const result = await tasksPlugin.execute({ action: 'get', taskId: id });
        res.json(result);
      } catch (error) {
        logger.error('Get task error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/tasks', authenticateToken, async (req, res) => {
      try {
        const { description, priority } = req.body;
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          throw new Error('Tasks plugin not available');
        }
        const result = await tasksPlugin.execute({
          action: 'create',
          title: description,
          priority: priority || 'medium'
        });
        res.json(result);
      } catch (error) {
        logger.error('Add task error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/tasks/complete', authenticateToken, async (req, res) => {
      try {
        const { id } = req.body;
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          throw new Error('Tasks plugin not available');
        }
        const result = await tasksPlugin.execute({ action: 'complete', taskId: id });
        res.json(result);
      } catch (error) {
        logger.error('Complete task error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.put('/api/tasks/:id', authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { description, priority, title } = req.body;
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          throw new Error('Tasks plugin not available');
        }
        const updateData = { action: 'update', taskId: id };
        // Include whatever fields were sent
        if (description !== undefined) updateData.description = description;
        if (title !== undefined) updateData.title = title;
        if (priority !== undefined) updateData.priority = priority;
        
        const result = await tasksPlugin.execute(updateData);
        res.json(result);
      } catch (error) {
        logger.error('Update task error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.delete('/api/tasks/:id', authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          throw new Error('Tasks plugin not available');
        }
        const result = await tasksPlugin.execute({ action: 'delete', taskId: id });
        res.json(result);
      } catch (error) {
        logger.error('Delete task error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get available log files
    this.app.get('/api/logs/available', authenticateToken, async (req, res) => {
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        
        const logs = [];
        
        // Application logs directory
        const logDir = path.join(process.cwd(), 'logs');
        try {
          const files = await fs.readdir(logDir);
          for (const file of files) {
            // Skip archived/rotated logs — Winston names them: file1.log, file2.log, etc.
            // Also skip .0, .1 suffixes and subdirectories
            if (!file.match(/\d+\.log$/) && !file.match(/\d+\.json$/) && !file.match(/\.\d+$/)) {
              const stats = await fs.stat(path.join(logDir, file));
              if (stats.isFile()) {
                // Create a user-friendly name
                let displayName = file.replace(/\.log$/, '').replace(/-/g, ' ');
                displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
                
                logs.push({
                  type: file.replace(/\.log$/, ''),
                  name: displayName,
                  file: file,
                  size: stats.size,
                  modified: stats.mtime,
                  category: 'application'
                });
              }
            }
          }
        } catch (error) {
          logger.warn('Could not read application logs directory:', error);
        }
        
        // PM2 logs
        const pm2LogDir = path.join(process.env.HOME, '.pm2', 'logs');
        try {
          const pm2Files = await fs.readdir(pm2LogDir);
          for (const file of pm2Files) {
            if (file.startsWith('lan-agent-') && !file.match(/\.\d+$/)) {
              const stats = await fs.stat(path.join(pm2LogDir, file));
              const type = file.includes('error') ? 'pm2-error' : 'pm2-out';
              const name = file.includes('error') ? 'PM2 Error' : 'PM2 Output';
              
              logs.push({
                type: type,
                name: name,
                file: file,
                size: stats.size,
                modified: stats.mtime,
                category: 'pm2'
              });
            }
          }
        } catch (error) {
          logger.warn('Could not read PM2 logs directory:', error);
        }
        
        // Add per-plugin logs from logs/plugins/
        const pluginLogDir = path.join(process.cwd(), 'logs', 'plugins');
        try {
          const pluginFiles = await fs.readdir(pluginLogDir);
          for (const file of pluginFiles) {
            if (file.endsWith('.log') && !file.match(/\d+\.log$/)) {
              const stats = await fs.stat(path.join(pluginLogDir, file));
              if (stats.isFile() && stats.size > 0) {
                const pluginName = file.replace(/\.log$/, '');
                logs.push({
                  type: 'plugins/' + pluginName,
                  name: 'Plugin: ' + pluginName,
                  file: 'plugins/' + file,
                  size: stats.size,
                  modified: stats.mtime,
                  category: 'plugin'
                });
              }
            }
          }
        } catch (e) { /* plugins dir may not exist */ }

        // Sort: primary logs first (by modified), then plugin logs alphabetically
        const primary = logs.filter(l => l.category !== 'plugin').sort((a, b) => b.modified - a.modified);
        const pluginLogs = logs.filter(l => l.category === 'plugin').sort((a, b) => a.name.localeCompare(b.name));
        logs.length = 0;
        logs.push(...primary, ...pluginLogs);
        
        res.json({
          success: true,
          logs: logs
        });
      } catch (error) {
        logger.error('Get available logs error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Raw PM2 Logs
    this.app.get('/api/logs/raw', authenticateToken, async (req, res) => {
      try {
        const { type = 'out' } = req.query;
        const fs = await import('fs/promises');
        const path = await import('path');
        
        let logFile;
        
        // Handle PM2 logs specially
        if (type === 'pm2-out' || type === 'out') {
          const pm2LogDir = path.join(process.env.HOME, '.pm2', 'logs');
          logFile = path.join(pm2LogDir, 'lan-agent-out.log');
        } else if (type === 'pm2-error' || type === 'error') {
          const pm2LogDir = path.join(process.env.HOME, '.pm2', 'logs');
          logFile = path.join(pm2LogDir, 'lan-agent-error.log');
        } else {
          // Application logs - build filename from type
          const logDir = path.join(process.cwd(), 'logs');
          const logFileName = type.endsWith('.log') || type.endsWith('.json') ? type : `${type}.log`;
          logFile = path.join(logDir, logFileName);
          
          // Security check - ensure the file is within the logs directory
          const resolvedPath = path.resolve(logFile);
          const resolvedLogDir = path.resolve(logDir);
          if (!resolvedPath.startsWith(resolvedLogDir)) {
            return res.status(400).json({ success: false, error: 'Invalid log file path' });
          }
        }
        
        // Read the log file
        try {
          const content = await fs.readFile(logFile, 'utf8');
          const stats = await fs.stat(logFile);
          
          // Limit content size for web display (last 100KB)
          let displayContent = content;
          if (content.length > 100000) {
            displayContent = '... [Earlier logs truncated] ...\n\n' + 
                           content.substring(content.length - 100000);
          }
          
          res.json({
            success: true,
            data: {
              content: displayContent,
              filePath: logFile,
              fileSize: this.formatFileSize(stats.size),
              lastModified: stats.mtime
            }
          });
        } catch (error) {
          if (error.code === 'ENOENT') {
            res.json({
              success: true,
              data: {
                content: 'Log file not found. Make sure the agent is running with PM2.',
                filePath: logFile,
                fileSize: '0 bytes'
              }
            });
          } else {
            throw error;
          }
        }
      } catch (error) {
        logger.error('Raw logs error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Log rotation endpoint
    this.app.post('/api/logs/rotate', authenticateToken, async (req, res) => {
      try {
        const { type = 'all-activity' } = req.body;
        const fs = await import('fs/promises');
        const path = await import('path');
        
        // Map log types to files
        let logFile;
        if (type === 'pm2-out' || type === 'out') {
          // PM2 logs
          const pm2LogDir = path.join(process.env.HOME, '.pm2', 'logs');
          logFile = path.join(pm2LogDir, 'lan-agent-out.log');
        } else if (type === 'pm2-error' || type === 'error') {
          const pm2LogDir = path.join(process.env.HOME, '.pm2', 'logs');
          logFile = path.join(pm2LogDir, 'lan-agent-error.log');
        } else {
          // Application logs - build filename from type
          const logDir = path.join(process.cwd(), 'logs');
          const logFileName = type.endsWith('.log') || type.endsWith('.json') ? type : `${type}.log`;
          logFile = path.join(logDir, logFileName);
          
          // Security check - ensure the file is within the logs directory
          const resolvedPath = path.resolve(logFile);
          const resolvedLogDir = path.resolve(logDir);
          if (!resolvedPath.startsWith(resolvedLogDir)) {
            throw new Error('Invalid log file path');
          }
        }
        
        // Check if file exists
        try {
          const stats = await fs.stat(logFile);
          
          // Rotate by renaming with timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const rotatedFile = logFile.replace(/\.log$/, `-${timestamp}.log`);
          
          await fs.rename(logFile, rotatedFile);
          
          // Create new empty log file
          await fs.writeFile(logFile, '');
          
          logger.info(`Log rotated: ${type} -> ${rotatedFile}`);
          
          res.json({ 
            success: true, 
            message: `Log rotated successfully`,
            rotatedTo: path.basename(rotatedFile)
          });
        } catch (error) {
          if (error.code === 'ENOENT') {
            res.json({ 
              success: false, 
              message: 'Log file not found or already empty'
            });
          } else {
            throw error;
          }
        }
      } catch (error) {
        logger.error('Log rotation error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Logs
    this.app.get('/api/logs', authenticateToken, async (req, res) => {
      try {
        const logs = await this.getLogs();
        res.json({ success: true, data: logs });
      } catch (error) {
        logger.error('Logs error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // System prompt
    this.app.get('/api/system/prompt', authenticateToken, async (req, res) => {
      try {
        const systemPrompt = this.agent.getSystemPrompt ? 
          this.agent.getSystemPrompt() : 
          "System prompt not available";
        res.json({ success: true, data: systemPrompt });
      } catch (error) {
        logger.error('System prompt error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/system/prompt', authenticateToken, async (req, res) => {
      try {
        const { prompt } = req.body;
        if (this.agent.setSystemPrompt) {
          this.agent.setSystemPrompt(prompt);
          res.json({ success: true, message: 'System prompt updated' });
        } else {
          res.status(501).json({ success: false, error: 'Feature not implemented' });
        }
      } catch (error) {
        logger.error('Update system prompt error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Agent info
    this.app.get('/api/agent/info', authenticateToken, async (req, res) => {
      try {
        // Get agent stats from database
        let agentStats = {};
        try {
          agentStats = this.agent.agentModel ? {
            totalStartups: this.agent.agentModel.stats.totalStartups,
            totalConversations: this.agent.agentModel.stats.totalConversations,
            totalCommands: this.agent.agentModel.stats.totalCommands,
            createdAt: this.agent.agentModel.createdAt,
            lastStartup: this.agent.agentModel.lastStartup
          } : {};
        } catch (dbError) {
          logger.warn('Could not load agent stats:', dbError.message);
        }

        // Get current AI provider
        const currentProvider = this.agent.getCurrentAIProvider();
        
        // Get plugin count
        const pluginCount = this.agent.apiManager ? this.agent.apiManager.apis.size : 0;
        
        // Get interface statuses
        const interfaces = {
          telegram: this.agent.interfaces.has('telegram'),
          web: this.agent.interfaces.has('web'),
          ssh: this.agent.interfaces.has('ssh')
        };

        const info = {
          // Basic info
          name: this.agent.config.name || 'LANAgent',
          version: packageVersion,
          startupTime: this.agent.startupTime,
          uptime: process.uptime(),
          
          // Master configuration
          masterTelegramId: process.env.TELEGRAM_USER_ID || 'Not set',
          masterEmail: process.env.EMAIL_OF_MASTER || 'Not set',
          agentEmail: process.env.EMAIL_USER || process.env.GMAIL_USER || 'Not configured',
          
          // System info
          nodeVersion: process.version,
          platform: process.platform,
          memoryUsage: process.memoryUsage(),
          
          // Agent specific
          aiProvider: currentProvider.name || 'Unknown',
          pluginCount: pluginCount,
          interfaces: interfaces,
          
          // Database stats
          ...agentStats
        };
        
        res.json({ success: true, data: info });
      } catch (error) {
        logger.error('Agent info error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update agent configuration
    this.app.post('/api/agent/config', authenticateToken, async (req, res) => {
      try {
        const { Agent } = await import('../../models/Agent.js');
        const updates = {};
        
        // Handle autoModelUpdate setting
        if (req.body.autoModelUpdate !== undefined) {
          updates['config.autoModelUpdate'] = req.body.autoModelUpdate;
        }
        
        // Update in database
        await Agent.updateOne({ name: process.env.AGENT_NAME || "LANAgent" }, { $set: updates });
        
        logger.info('Agent config updated:', updates);
        res.json({ success: true, message: 'Configuration updated' });
      } catch (error) {
        logger.error('Agent config update error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Serve agent avatar image (no auth - usable in external contexts)
    this.app.get('/api/agent/avatar', async (req, res) => {
      try {
        const avatarPath = this.agent.agentModel?.avatarPath;
        if (!avatarPath) {
          return res.status(404).json({ success: false, error: 'No avatar configured' });
        }

        const projectRoot = path.join(__dirname, '../../..');
        const fullPath = path.join(projectRoot, avatarPath);

        if (!fsSync.existsSync(fullPath)) {
          return res.status(404).json({ success: false, error: 'Avatar file not found' });
        }

        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const stream = fsSync.createReadStream(fullPath);
        stream.pipe(res);
      } catch (error) {
        logger.error('Serve avatar error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Upload agent avatar (base64 JSON)
    this.app.post('/api/agent/avatar', authenticateToken, async (req, res) => {
      try {
        const { image, filename, description } = req.body;

        // Allow description-only updates (no image required)
        if (!image && description !== undefined) {
          const { Agent } = await import('../../models/Agent.js');
          await Agent.updateOne({ name: process.env.AGENT_NAME || 'LANAgent' }, { $set: { avatarDescription: description } });
          if (this.agent.agentModel) {
            this.agent.agentModel.avatarDescription = description;
          }
          logger.info('Avatar description updated');
          return res.json({ success: true, url: '/api/agent/avatar', descriptionUpdated: true });
        }

        if (!image) {
          return res.status(400).json({ success: false, error: 'No image data provided' });
        }

        const ext = path.extname(filename || 'avatar.png').toLowerCase() || '.png';
        const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
        if (!allowed.includes(ext)) {
          return res.status(400).json({ success: false, error: `Unsupported format: ${ext}` });
        }

        const projectRoot = path.join(__dirname, '../../..');
        const destDir = path.join(projectRoot, 'data', 'agent');
        await fs.mkdir(destDir, { recursive: true });

        const destFilename = `avatar${ext}`;
        const destPath = path.join(destDir, destFilename);
        const buffer = Buffer.from(image, 'base64');

        // Basic size check (max 5MB)
        if (buffer.length > 5 * 1024 * 1024) {
          return res.status(400).json({ success: false, error: 'Image too large (max 5MB)' });
        }

        await fs.writeFile(destPath, buffer);

        // Update agent model
        const { Agent } = await import('../../models/Agent.js');
        await Agent.updateOne({ name: process.env.AGENT_NAME || 'LANAgent' }, {
          $set: {
            avatarPath: `data/agent/${destFilename}`,
            avatar: '/api/agent/avatar',
            ...(description !== undefined && { avatarDescription: description })
          }
        });

        // Update in-memory model
        if (this.agent.agentModel) {
          this.agent.agentModel.avatarPath = `data/agent/${destFilename}`;
          this.agent.agentModel.avatar = '/api/agent/avatar';
          if (description !== undefined) {
            this.agent.agentModel.avatarDescription = description;
          }
        }

        logger.info(`Avatar uploaded: ${destFilename}`);
        res.json({ success: true, url: '/api/agent/avatar', path: `data/agent/${destFilename}` });
      } catch (error) {
        logger.error('Upload avatar error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get active VRM model
    this.app.get('/api/agent/vrm', async (req, res) => {
      try {
        const { Agent } = await import('../../models/Agent.js');
        const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
        res.json({ success: true, activeVRMModel: agent?.activeVRMModel || null });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Set active VRM model
    this.app.put('/api/agent/vrm', authenticateToken, async (req, res) => {
      try {
        const { modelId } = req.body;
        if (!modelId || typeof modelId !== 'string') {
          return res.status(400).json({ success: false, error: 'modelId is required' });
        }
        const { Agent } = await import('../../models/Agent.js');
        await Agent.updateOne(
          { name: process.env.AGENT_NAME || 'LANAgent' },
          { $set: { activeVRMModel: modelId } }
        );
        if (this.agent.agentModel) {
          this.agent.agentModel.activeVRMModel = modelId;
        }
        logger.info(`Active VRM model set to: ${modelId}`);
        res.json({ success: true, activeVRMModel: modelId });
      } catch (error) {
        logger.error('Set active VRM error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get active GLB model
    this.app.get('/api/agent/glb', async (req, res) => {
      try {
        const { Agent } = await import('../../models/Agent.js');
        const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
        res.json({ success: true, activeGLBModel: agent?.activeGLBModel || null });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Set active GLB model
    this.app.put('/api/agent/glb', authenticateToken, async (req, res) => {
      try {
        const { modelId } = req.body;
        if (!modelId || typeof modelId !== 'string') {
          return res.status(400).json({ success: false, error: 'modelId is required' });
        }
        const { Agent } = await import('../../models/Agent.js');
        await Agent.updateOne(
          { name: process.env.AGENT_NAME || 'LANAgent' },
          { $set: { activeGLBModel: modelId } }
        );
        if (this.agent.agentModel) {
          this.agent.agentModel.activeGLBModel = modelId;
        }
        logger.info(`Active GLB model set to: ${modelId}`);
        res.json({ success: true, activeGLBModel: modelId });
      } catch (error) {
        logger.error('Set active GLB error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get Gravatar API key status
    this.app.get('/api/agent/gravatar-key', authenticateToken, async (req, res) => {
      try {
        const stored = await PluginSettings.getCached('gravatar', 'credentials');
        const hasDbKey = !!(stored && stored.apiKey);
        const hasEnvKey = !!process.env.GRAVATAR_API_KEY;
        const reveal = req.query.reveal === 'true';

        const result = {
          success: true,
          configured: hasDbKey || hasEnvKey,
          source: hasDbKey ? 'database' : (hasEnvKey ? 'environment' : 'none')
        };

        if (reveal && result.configured) {
          try {
            result.value = hasDbKey ? decrypt(stored.apiKey) : process.env.GRAVATAR_API_KEY;
          } catch (e) {
            result.value = null;
          }
        }

        res.json(result);
      } catch (error) {
        logger.error('Get Gravatar key status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Save Gravatar API key
    this.app.post('/api/agent/gravatar-key', authenticateToken, async (req, res) => {
      try {
        const { apiKey } = req.body;
        if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
          return res.status(400).json({ success: false, error: 'API key is required' });
        }

        const trimmed = apiKey.trim();
        await PluginSettings.setCached('gravatar', 'credentials', { apiKey: encrypt(trimmed) });

        // Update process.env so gravatarHelper picks it up immediately
        process.env.GRAVATAR_API_KEY = trimmed;

        logger.info('Gravatar API key updated via settings');
        res.json({ success: true });
      } catch (error) {
        logger.error('Save Gravatar key error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Gravatar OAuth2 — Start authorization flow
    this.app.get('/api/gravatar/oauth/authorize', authenticateToken, async (req, res) => {
      try {
        const clientId = process.env.GRAVATAR_CLIENT_ID;
        if (!clientId) {
          return res.status(400).json({ success: false, error: 'GRAVATAR_CLIENT_ID not configured in .env' });
        }

        // Generate random state token for CSRF protection
        const { randomBytes } = await import('crypto');
        const state = randomBytes(24).toString('hex');
        oauthStateCache.set(state, true);

        // Build redirect URI from request origin
        const protocol = req.get('x-forwarded-proto') || (String(process.env.AGENT_PORT) === '443' ? 'https' : req.protocol);
        const host = req.get('host');
        const redirectUri = `${protocol}://${host}/api/gravatar/oauth/callback`;

        const authorizeUrl = new URL('https://public-api.wordpress.com/oauth2/authorize');
        authorizeUrl.searchParams.set('client_id', clientId);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('scope', 'auth gravatar-profile:manage');
        authorizeUrl.searchParams.set('state', state);

        res.json({ success: true, authorizeUrl: authorizeUrl.toString() });
      } catch (error) {
        logger.error('Gravatar OAuth authorize error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Gravatar OAuth2 — Callback (browser redirect, no auth middleware)
    this.app.get('/api/gravatar/oauth/callback', async (req, res) => {
      try {
        const { code, state } = req.query;

        if (!state || !oauthStateCache.get(state)) {
          return res.status(400).send('Invalid or expired OAuth state. Please try connecting again from Settings.');
        }
        oauthStateCache.del(state);

        if (!code) {
          return res.status(400).send('No authorization code received. Please try again.');
        }

        const clientId = process.env.GRAVATAR_CLIENT_ID;
        const clientSecret = process.env.GRAVATAR_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return res.status(500).send('Gravatar OAuth not configured on server.');
        }

        // Build the same redirect URI used in the authorize step
        const protocol = req.get('x-forwarded-proto') || (String(process.env.AGENT_PORT) === '443' ? 'https' : req.protocol);
        const host = req.get('host');
        const redirectUri = `${protocol}://${host}/api/gravatar/oauth/callback`;

        // Exchange authorization code for access token
        const tokenResponse = await fetch('https://public-api.wordpress.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
          }).toString()
        });

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text();
          logger.error('Gravatar OAuth token exchange failed:', errorText);
          return res.status(500).send('Failed to exchange authorization code. Please try again.');
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        if (!accessToken) {
          return res.status(500).send('No access token received from WordPress.com.');
        }

        // Store encrypted token in database
        await PluginSettings.setCached('gravatar', 'oauth_token', {
          access_token: encrypt(accessToken)
        });

        // Make available immediately
        process.env.GRAVATAR_OAUTH_TOKEN = accessToken;
        logger.info('Gravatar OAuth token stored successfully');

        // Redirect back to settings with success indicator
        res.redirect('/#settings?gravatar=connected');
      } catch (error) {
        logger.error('Gravatar OAuth callback error:', error);
        res.status(500).send('OAuth callback failed: ' + error.message);
      }
    });

    // Gravatar OAuth2 — Connection status
    this.app.get('/api/gravatar/oauth/status', authenticateToken, async (req, res) => {
      try {
        const hasOAuthToken = !!process.env.GRAVATAR_OAUTH_TOKEN;
        let source = 'none';

        if (hasOAuthToken) {
          const stored = await PluginSettings.getCached('gravatar', 'oauth_token');
          source = stored?.access_token ? 'database' : 'environment';
        }

        res.json({
          success: true,
          connected: hasOAuthToken,
          source,
          hasClientId: !!process.env.GRAVATAR_CLIENT_ID
        });
      } catch (error) {
        logger.error('Gravatar OAuth status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Gravatar OAuth2 — Disconnect
    this.app.post('/api/gravatar/oauth/disconnect', authenticateToken, async (req, res) => {
      try {
        await PluginSettings.findOneAndDelete({ pluginName: 'gravatar', settingsKey: 'oauth_token' });
        await PluginSettings.clearCache('gravatar');
        delete process.env.GRAVATAR_OAUTH_TOKEN;

        logger.info('Gravatar OAuth token disconnected');
        res.json({ success: true });
      } catch (error) {
        logger.error('Gravatar OAuth disconnect error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Sync avatar to external services (Gravatar)
    this.app.post('/api/agent/avatar/sync', authenticateToken, async (req, res) => {
      try {
        const avatarPath = this.agent.agentModel?.avatarPath;
        if (!avatarPath) {
          return res.status(400).json({ success: false, error: 'No avatar configured. Upload an avatar first.' });
        }

        const projectRoot = path.join(__dirname, '../../..');
        const fullPath = path.join(projectRoot, avatarPath);

        if (!fsSync.existsSync(fullPath)) {
          return res.status(404).json({ success: false, error: 'Avatar file not found on disk' });
        }

        const results = {};

        // Sync to Gravatar (pass agent email for selected_email_hash)
        try {
          const { uploadAvatarToGravatar } = await import('../../utils/gravatarHelper.js');
          const agentEmail = process.env.EMAIL_USER || process.env.GMAIL_USER;
          results.gravatar = await uploadAvatarToGravatar(fullPath, agentEmail);
        } catch (error) {
          results.gravatar = { success: false, error: error.message };
        }

        // Sync to Telegram bot profile photo
        try {
          const telegramInterface = this.agent.interfaces?.get('telegram');
          if (telegramInterface?.isRunning) {
            results.telegram = await telegramInterface.syncBotPhoto(fullPath);
          } else {
            results.telegram = { success: false, error: 'Telegram bot not running' };
          }
        } catch (error) {
          results.telegram = { success: false, error: error.message };
        }

        const anySuccess = Object.values(results).some(r => r.success);
        logger.info('Avatar sync results:', results);
        res.json({ success: anySuccess, results });
      } catch (error) {
        logger.error('Avatar sync error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get agent identity info
    this.app.get('/api/agent/identity', authenticateToken, async (req, res) => {
      try {
        const pluginCount = this.agent.apiManager ? this.agent.apiManager.apis.size : 0;
        const capabilities = [];
        if (this.agent.apiManager?.apis) {
          for (const [name] of this.agent.apiManager.apis) {
            capabilities.push(name);
          }
        }

        // Get agent email — check leased email first, then env vars
        let agentEmail = process.env.EMAIL_USER || process.env.GMAIL_USER || null;
        if (!agentEmail) {
          try {
            const { SystemSettings } = await import('../../models/SystemSettings.js');
            const lease = await SystemSettings.getSetting('email.myLease', null);
            if (lease?.email) agentEmail = lease.email;
          } catch {}
        }

        res.json({
          success: true,
          data: {
            name: this.agent.config.name || 'LANAgent',
            version: packageVersion,
            avatar: '/api/agent/avatar',
            avatarDescription: this.agent.agentModel?.avatarDescription || null,
            personality: this.agent.agentModel?.personality || null,
            agentEmail,
            masterEmail: process.env.EMAIL_OF_MASTER || null,
            pluginCount,
            capabilities: capabilities.slice(0, 20),
            interfaces: Array.from(this.agent.interfaces.keys())
          }
        });
      } catch (error) {
        logger.error('Agent identity error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // === ERC-8004 Agent Identity Routes ===

    // Get ERC-8004 identity status
    this.app.get('/api/agent/erc8004/status', authenticateToken, async (req, res) => {
      try {
        const status = await agentIdentityService.getIdentityStatus();
        let gasEstimate = null;
        if (status.status === 'none' || status.status === 'local') {
          try {
            gasEstimate = await agentIdentityService.estimateMintGas(status.chain);
          } catch { /* non-critical */ }
        }
        res.json({ success: true, data: { ...status, gasEstimate } });
      } catch (error) {
        logger.error('ERC-8004 status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Generate & preview registration file
    this.app.post('/api/agent/erc8004/registration', authenticateToken, async (req, res) => {
      try {
        const registrationFile = await agentIdentityService.generateRegistrationFile();
        res.json({ success: true, data: registrationFile });
      } catch (error) {
        logger.error('ERC-8004 registration error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Mint identity NFT
    this.app.post('/api/agent/erc8004/mint', authenticateToken, async (req, res) => {
      try {
        const chain = req.body.chain || 'bsc';
        const result = await agentIdentityService.mintIdentity(chain);
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('ERC-8004 mint error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update on-chain registration
    this.app.put('/api/agent/erc8004/update', authenticateToken, async (req, res) => {
      try {
        const { forceAvatarReupload } = req.body || {};
        const result = await agentIdentityService.updateRegistration({ forceAvatarReupload: !!forceAvatarReupload });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('ERC-8004 update error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Link wallet via EIP-712 setAgentWallet
    this.app.post('/api/agent/erc8004/link-wallet', authenticateToken, async (req, res) => {
      try {
        const walletAddress = req.body.walletAddress || null;
        const result = await agentIdentityService.linkWallet(walletAddress);
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('ERC-8004 link-wallet error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Save Pinata API keys
    this.app.post('/api/agent/erc8004/pinata-key', authenticateToken, async (req, res) => {
      try {
        const { apiKey, secretKey } = req.body;
        if (!apiKey || !secretKey) {
          return res.status(400).json({ success: false, error: 'Both apiKey and secretKey are required' });
        }
        await PluginSettings.setCached('erc8004', 'pinata_keys', {
          apiKey: encrypt(apiKey.trim()),
          secretKey: encrypt(secretKey.trim())
        });
        process.env.PINATA_API_KEY = apiKey.trim();
        process.env.PINATA_SECRET_KEY = secretKey.trim();
        res.json({ success: true, message: 'Pinata keys saved' });
      } catch (error) {
        logger.error('ERC-8004 pinata key save error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Check if Pinata keys are configured
    this.app.get('/api/agent/erc8004/pinata-key', authenticateToken, async (req, res) => {
      try {
        const configured = !!(process.env.PINATA_API_KEY && process.env.PINATA_SECRET_KEY);
        let source = 'none';
        if (configured) {
          const dbKeys = await PluginSettings.getCached('erc8004', 'pinata_keys');
          source = dbKeys?.apiKey ? 'database' : 'environment';
        }
        res.json({ success: true, configured, source });
      } catch (error) {
        logger.error('ERC-8004 pinata key check error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get all plugins with their status
    this.app.get('/api/plugins', authenticateToken, async (req, res) => {
      try {
        const plugins = [];
        
        // Get all available plugins
        if (this.agent.apiManager && this.agent.apiManager.apis) {
          for (const [name, plugin] of this.agent.apiManager.apis) {
            if (plugin) {
              // Get plugin-specific information
              const pluginInfo = this.getPluginInfo(name, plugin);
              
              plugins.push({
                name: pluginInfo.name,
                version: pluginInfo.version,
                description: pluginInfo.description,
                enabled: plugin.enabled !== false,
                commandCount: pluginInfo.commandCount,
                commands: pluginInfo.commands || [],
                lastUsed: plugin.lastUsed || null,
                error: plugin.error || null
              });
            }
          }
          
          // Sort plugins by name
          plugins.sort((a, b) => {
            const nameA = a.name || 'unnamed';
            const nameB = b.name || 'unnamed';
            return nameA.localeCompare(nameB);
          });
        }
        
        res.json({ success: true, plugins });
      } catch (error) {
        logger.error('Failed to get plugins:', error);
        res.status(500).json({ success: false, error: error.message, plugins: [] });
      }
    });

    // Get plugin UI configurations for menu
    this.app.get('/api/plugins/ui-config', authenticateToken, async (req, res) => {
      try {
        const uiConfigs = [];
        
        if (this.agent.apiManager && this.agent.apiManager.apis) {
          for (const [name, pluginWrapper] of this.agent.apiManager.apis) {
            if (pluginWrapper && pluginWrapper.instance) {
              const plugin = pluginWrapper.instance;
              
              // Check if plugin is enabled
              if (pluginWrapper.enabled !== false && plugin.getUIConfig && typeof plugin.getUIConfig === 'function') {
                const uiConfig = plugin.getUIConfig();
                if (uiConfig && uiConfig.menuItem) {
                  uiConfigs.push({
                    pluginName: name,
                    ...uiConfig
                  });
                }
              }
            }
          }
        }
        
        // Sort by order value for proper menu positioning
        uiConfigs.sort((a, b) => {
          const orderA = a.menuItem.order || 999;
          const orderB = b.menuItem.order || 999;
          return orderA - orderB;
        });
        
        res.json({ success: true, uiConfigs });
      } catch (error) {
        logger.error('Failed to get plugin UI configs:', error);
        res.status(500).json({ success: false, error: error.message, uiConfigs: [] });
      }
    });

    // Get plugin UI content
    this.app.get('/api/plugins/:name/ui-content', authenticateToken, async (req, res) => {
      try {
        const { name } = req.params;
        const pluginWrapper = this.agent.apiManager?.apis.get(name);
        
        if (!pluginWrapper || !pluginWrapper.instance) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }

        const plugin = pluginWrapper.instance;
        
        // Check if plugin is enabled
        if (pluginWrapper.enabled === false) {
          return res.status(403).json({ success: false, error: 'Plugin is disabled' });
        }

        // Get UI content from plugin
        let content;
        if (plugin.getUIContent && typeof plugin.getUIContent === 'function') {
          content = await plugin.getUIContent();
        } else {
          content = `<div class="plugin-default"><h2>${name}</h2><p>This plugin does not provide a custom UI.</p></div>`;
        }

        res.json({ success: true, content });
      } catch (error) {
        logger.error(`Failed to get UI content for plugin ${req.params.name}:`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Toggle plugin enabled/disabled state
    this.app.post('/api/plugins/:name/toggle', authenticateToken, async (req, res) => {
      try {
        const pluginName = req.params.name;
        
        const pluginInfo = this.agent.apiManager.apis.get(pluginName);
        if (!pluginInfo) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }
        
        // Get current state and toggle it
        const currentlyEnabled = pluginInfo.enabled;
        const newState = !currentlyEnabled;
        
        // Update plugin state
        if (newState) {
          await this.agent.apiManager.enablePlugin(pluginName);
        } else {
          await this.agent.apiManager.disablePlugin(pluginName);
        }
        
        // Save plugin states to database
        await this.agent.savePluginStates();
        
        logger.info(`Plugin ${pluginName} ${newState ? 'enabled' : 'disabled'}`);
        res.json({ 
          success: true, 
          message: `Plugin ${pluginName} ${newState ? 'enabled' : 'disabled'}` 
        });
      } catch (error) {
        logger.error(`Failed to toggle plugin ${req.params.name}:`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get plugin configuration/settings
    this.app.get('/api/plugins/:name/config', authenticateToken, async (req, res) => {
      try {
        const pluginName = req.params.name;
        const plugin = this.agent.apiManager.getPlugin(pluginName);
        
        if (!plugin) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }
        
        const config = {
          name: plugin.name,
          version: plugin.version,
          description: plugin.description,
          settings: {},
          prompts: {},
          commands: plugin.commands || []
        };
        
        // Get plugin settings if available
        if (plugin.getState) {
          config.settings = plugin.getState('settings') || {};
        }
        
        // Try plugin-specific getSettings method if available
        if (plugin.getSettings && typeof plugin.getSettings === 'function') {
          try {
            const settingsResult = await plugin.getSettings();
            if (settingsResult.success && settingsResult.settings) {
              config.settings = { ...config.settings, ...settingsResult.settings };
            }
          } catch (error) {
            logger.warn(`Failed to get settings for plugin ${pluginName}:`, error.message);
          }
        }
        
        // Get plugin prompts if available
        if (plugin.prompts || plugin.getState) {
          config.prompts = plugin.prompts || plugin.getState('prompts') || {};
        }
        
        // Get additional configuration fields specific to each plugin
        if (plugin.getConfiguration) {
          const pluginConfig = plugin.getConfiguration();
          config.additionalConfig = pluginConfig;
        }
        
        res.json({ success: true, config });
      } catch (error) {
        logger.error(`Failed to get plugin config for ${req.params.name}:`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update plugin configuration/settings
    this.app.post('/api/plugins/:name/config', authenticateToken, async (req, res) => {
      try {
        const pluginName = req.params.name;
        const { settings, prompts, additionalConfig } = req.body;
        const plugin = this.agent.apiManager.getPlugin(pluginName);
        
        if (!plugin) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }
        
        // Update settings
        if (settings) {
          if (plugin.updateSettings && typeof plugin.updateSettings === 'function') {
            try {
              await plugin.updateSettings(settings);
            } catch (error) {
              logger.warn(`Failed to update settings via updateSettings for plugin ${pluginName}:`, error.message);
              if (plugin.setState) {
                plugin.setState('settings', settings);
              }
            }
          } else if (plugin.setState) {
            plugin.setState('settings', settings);
          }
        }
        
        // Update prompts
        if (prompts && plugin.setState) {
          plugin.setState('prompts', prompts);
          // Also update prompts directly if plugin has prompts property
          if (plugin.prompts) {
            Object.assign(plugin.prompts, prompts);
          }
        }
        
        // Update additional configuration if plugin supports it
        if (additionalConfig && plugin.updateConfiguration) {
          plugin.updateConfiguration(additionalConfig);
        }
        
        // Save plugin states to database
        await this.agent.savePluginStates();
        
        logger.info(`Plugin ${pluginName} configuration updated`);
        res.json({
          success: true,
          message: `Plugin ${pluginName} configuration updated successfully`
        });
      } catch (error) {
        logger.error(`Failed to update plugin config for ${req.params.name}:`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ============================================
    // Plugin Credentials Management (encrypted DB storage)
    // ============================================

    // Get plugin credentials status (optionally with decrypted values via ?reveal=true)
    this.app.get('/api/plugins/:name/credentials', authenticateToken, async (req, res) => {
      try {
        const pluginName = req.params.name;
        const revealValues = req.query.reveal === 'true';
        const plugin = this.agent.apiManager.getPlugin(pluginName);

        if (!plugin) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }

        // Get stored credentials metadata
        const credentials = await PluginSettings.getCached(pluginName, 'credentials');

        // Build list of required credentials for this plugin
        const requiredCredentials = this.getPluginRequiredCredentials(pluginName, plugin);

        // Check which credentials are configured - return as array for UI
        const credentialsList = requiredCredentials.map(cred => {
          const hasDbValue = credentials && credentials[cred.key];
          const hasEnvValue = cred.envVar ? process.env[cred.envVar] : null;

          const result = {
            key: cred.key,
            label: cred.label,
            envVar: cred.envVar,
            configured: !!(hasDbValue || hasEnvValue),
            source: hasDbValue ? 'database' : (hasEnvValue ? 'environment' : 'none'),
            required: cred.required !== false
          };

          // Include decrypted value if reveal=true and credential exists
          if (revealValues && result.configured) {
            try {
              if (hasDbValue) {
                result.value = decrypt(credentials[cred.key]);
              } else if (hasEnvValue) {
                result.value = hasEnvValue;
              }
            } catch (decryptError) {
              logger.warn(`Failed to decrypt credential ${cred.key} for ${pluginName}`);
              result.value = null;
            }
          }

          return result;
        });

        res.json({
          success: true,
          plugin: pluginName,
          credentials: credentialsList,
          hasCredentials: credentialsList.some(c => c.configured)
        });
      } catch (error) {
        logger.error(`Failed to get credentials status for ${req.params.name}:`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Save plugin credentials (encrypted)
    this.app.post('/api/plugins/:name/credentials', authenticateToken, async (req, res) => {
      try {
        const pluginName = req.params.name;
        const { credentials } = req.body;
        const plugin = this.agent.apiManager.getPlugin(pluginName);

        if (!plugin) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }

        if (!credentials || typeof credentials !== 'object') {
          return res.status(400).json({ success: false, error: 'Credentials object required' });
        }

        // Encrypt each credential value
        const encryptedCredentials = {};
        for (const [key, value] of Object.entries(credentials)) {
          if (value && typeof value === 'string' && value.trim()) {
            encryptedCredentials[key] = encrypt(value.trim());
          }
        }

        // Save to database
        await PluginSettings.setCached(pluginName, 'credentials', encryptedCredentials);

        // Reload plugin credentials if it has a method for it
        const pluginEntry = this.agent.apiManager.apis.get(pluginName);
        if (plugin.reloadCredentials && typeof plugin.reloadCredentials === 'function') {
          await plugin.reloadCredentials();
          if (pluginEntry) { pluginEntry.enabled = true; pluginEntry.error = null; pluginEntry.lastError = null; }
        } else if (plugin.initialize && typeof plugin.initialize === 'function') {
          // Re-initialize plugin to pick up new credentials
          try {
            await plugin.initialize();
            // Success — enable plugin and clear error (may have been disabled due to missing credentials)
            if (pluginEntry) { pluginEntry.enabled = true; pluginEntry.error = null; pluginEntry.lastError = null; }
          } catch (initError) {
            logger.warn(`Plugin ${pluginName} re-initialization after credential update:`, initError.message);
          }
        }

        logger.info(`Credentials saved for plugin ${pluginName}`);
        res.json({
          success: true,
          message: `Credentials saved for ${pluginName}`,
          keysUpdated: Object.keys(encryptedCredentials)
        });
      } catch (error) {
        logger.error(`Failed to save credentials for ${req.params.name}:`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Delete plugin credentials
    this.app.delete('/api/plugins/:name/credentials', authenticateToken, async (req, res) => {
      try {
        const pluginName = req.params.name;
        const plugin = this.agent.apiManager.getPlugin(pluginName);

        if (!plugin) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }

        // Remove credentials from database
        await PluginSettings.findOneAndDelete({ pluginName, settingsKey: 'credentials' });
        await PluginSettings.clearCache(pluginName);

        logger.info(`Credentials deleted for plugin ${pluginName}`);
        res.json({
          success: true,
          message: `Credentials removed for ${pluginName}`
        });
      } catch (error) {
        logger.error(`Failed to delete credentials for ${req.params.name}:`, error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Test plugin credentials
    this.app.post('/api/plugins/:name/credentials/test', authenticateToken, async (req, res) => {
      try {
        const pluginName = req.params.name;
        const plugin = this.agent.apiManager.getPlugin(pluginName);

        if (!plugin) {
          return res.status(404).json({ success: false, error: 'Plugin not found' });
        }

        // Check if plugin has a test method
        if (plugin.testConnection && typeof plugin.testConnection === 'function') {
          const result = await plugin.testConnection();
          res.json({
            success: true,
            connected: result.success !== false,
            message: result.message || (result.success !== false ? 'Connection successful' : 'Connection failed'),
            details: result
          });
        } else if (plugin.testCredentials && typeof plugin.testCredentials === 'function') {
          const result = await plugin.testCredentials();
          res.json({
            success: true,
            connected: result.success !== false,
            message: result.message || (result.success !== false ? 'Credentials valid' : 'Credentials invalid'),
            details: result
          });
        } else {
          // Try to check if plugin is initialized
          res.json({
            success: true,
            connected: plugin.initialized === true,
            message: plugin.initialized ? 'Plugin is initialized' : 'Plugin not initialized (credentials may be missing)',
            details: { initialized: plugin.initialized }
          });
        }
      } catch (error) {
        logger.error(`Failed to test credentials for ${req.params.name}:`, error);
        res.status(500).json({
          success: false,
          connected: false,
          message: error.message,
          error: error.message
        });
      }
    });

    // Self-modification upgrade plans
    this.app.get('/api/self-modification/upgrade-plans', authenticateToken, async (req, res) => {
      try {
        const upgradePlans = await this.generateUpgradePlans();
        res.json({ success: true, data: upgradePlans });
      } catch (error) {
        logger.error('Upgrade plans error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Guest conversations
    this.app.get('/api/conversations/guests', authenticateToken, async (req, res) => {
      try {
        const telegram = this.agent.interfaces?.get('telegram');
        if (telegram && telegram.multiUserSupport) {
          const stats = telegram.multiUserSupport.getConversationStats();
          res.json({ success: true, data: stats });
        } else {
          res.json({ success: true, data: { users: [], totalConversations: 0 } });
        }
      } catch (error) {
        logger.error('Guest conversations error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Self-modification status
    this.app.get('/api/selfmod/status', authenticateToken, async (req, res) => {
      try {
        const status = await this.agent.selfModification.getStatus();
        res.json({ success: true, data: status });
      } catch (error) {
        logger.error('Self-mod status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update self-modification config
    this.app.post('/api/selfmod/config', authenticateToken, async (req, res) => {
      try {
        const updates = req.body;
        await this.agent.selfModification.updateConfig(updates);
        res.json({ success: true, message: 'Configuration updated' });
      } catch (error) {
        logger.error('Self-mod config error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Toggle self-modification
    this.app.post('/api/selfmod/toggle', authenticateToken, async (req, res) => {
      try {
        const { enabled } = req.body;
        if (enabled) {
          await this.agent.selfModification.enable();
        } else {
          await this.agent.selfModification.disable();
        }
        res.json({ success: true, enabled });
      } catch (error) {
        logger.error('Self-mod toggle error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Toggle analysis-only mode
    this.app.post('/api/selfmod/analysis-toggle', authenticateToken, async (req, res) => {
      try {
        const { analysisOnly } = req.body;
        await this.agent.selfModification.setAnalysisOnly(analysisOnly);
        res.json({ success: true, analysisOnly });
      } catch (error) {
        logger.error('Analysis-only toggle error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Manually trigger self-modification check
    this.app.post('/api/selfmod/check', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.selfModification.enabled) {
          return res.status(400).json({ 
            success: false, 
            error: 'Self-modification service is disabled' 
          });
        }
        
        if (this.agent.selfModification.isRunning) {
          return res.status(400).json({ 
            success: false, 
            error: 'Self-modification check is already running' 
          });
        }
        
        // Run the check asynchronously
        this.agent.selfModification.checkForImprovements()
          .catch(error => logger.error('Self-modification check error:', error));
        
        res.json({ 
          success: true, 
          message: 'Self-modification check started',
          analysisOnly: this.agent.selfModification.analysisOnly
        });
      } catch (error) {
        logger.error('Self-mod manual check error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Plugin development service status
    this.app.get('/api/plugin-dev/status', authenticateToken, async (req, res) => {
      try {
        const status = await this.agent.pluginDevelopment.getStatus();
        res.json({ success: true, data: status });
      } catch (error) {
        logger.error('Plugin dev status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update plugin development config
    this.app.post('/api/plugin-dev/config', authenticateToken, async (req, res) => {
      try {
        const updates = req.body;
        this.agent.pluginDevelopment.updateConfig(updates);
        res.json({ success: true, message: 'Configuration updated' });
      } catch (error) {
        logger.error('Plugin dev config error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Toggle plugin development service
    this.app.post('/api/plugin-dev/toggle', authenticateToken, async (req, res) => {
      try {
        const { enabled } = req.body;
        if (enabled) {
          await this.agent.pluginDevelopment.enable();
        } else {
          await this.agent.pluginDevelopment.disable();
        }
        res.json({ success: true, enabled });
      } catch (error) {
        logger.error('Plugin dev toggle error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Trigger plugin development check manually
    this.app.post('/api/plugin-dev/check', authenticateToken, async (req, res) => {
      try {
        logger.info('Manual plugin development check triggered via API');
        
        if (!this.agent.pluginDevelopment) {
          logger.error('Plugin development service not available');
          return res.status(500).json({ success: false, error: 'Plugin development service not available' });
        }
        
        // Run check asynchronously
        this.agent.pluginDevelopment.checkForPluginOpportunities()
          .catch(err => logger.error('Plugin development check failed:', err));
        
        res.json({ 
          success: true, 
          message: 'Plugin development check started. Check logs for progress.' 
        });
      } catch (error) {
        logger.error('Plugin dev check error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Bug Fixing Service Routes
    this.app.get('/api/bug-fixing/status', authenticateToken, async (req, res) => {
      try {
        const status = this.agent.bugFixing.getStatus();
        res.json({ success: true, data: status });
      } catch (error) {
        logger.error('Bug fixing status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Toggle bug fixing service
    this.app.post('/api/bug-fixing/toggle', authenticateToken, async (req, res) => {
      try {
        const { enabled } = req.body;
        
        if (enabled) {
          await this.agent.bugFixing.enable();
        } else {
          await this.agent.bugFixing.disable();
        }
        
        res.json({ success: true, enabled: this.agent.bugFixing.enabled });
      } catch (error) {
        logger.error('Bug fixing toggle error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update bug fixing config
    this.app.post('/api/bug-fixing/config', authenticateToken, async (req, res) => {
      try {
        const config = req.body;
        this.agent.bugFixing.updateConfig(config);
        res.json({ success: true });
      } catch (error) {
        logger.error('Bug fixing config error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Run bug fixing session manually
    this.app.post('/api/bug-fixing/run', authenticateToken, async (req, res) => {
      try {
        // Run session asynchronously
        this.agent.bugFixing.runBugFixingSession()
          .catch(err => logger.error('Bug fixing session failed:', err));
        
        res.json({ 
          success: true, 
          message: 'Bug fixing session started. Check logs for progress.' 
        });
      } catch (error) {
        logger.error('Bug fixing run error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Email Management Routes
    this.app.get('/api/emails', authenticateToken, async (req, res) => {
      try {
        const { Email } = await import('../../models/Email.js');
        const { showUnprocessedOnly = false, type, limit, skip } = req.query;

        let filter = {};
        if (showUnprocessedOnly === 'true') {
          filter.processed = false;
        }
        if (type && type !== 'all') {
          filter.type = type;
        }

        const queryLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
        const querySkip = Math.max(parseInt(skip) || 0, 0);

        const emails = await Email.find(filter)
          .sort({ sentDate: -1 })
          .skip(querySkip)
          .limit(queryLimit);
        
        const stats = await Email.getTodayStats();
        const unprocessedCount = await Email.getUnprocessedCount();
        
        res.json({ 
          success: true, 
          data: {
            emails,
            stats: {
              ...stats,
              unprocessedCount,
              totalEmails: await Email.countDocuments()
            }
          }
        });
      } catch (error) {
        logger.error('Get emails error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Mark email as processed
    this.app.post('/api/emails/:id/process', authenticateToken, async (req, res) => {
      try {
        const { Email } = await import('../../models/Email.js');
        const email = await Email.findById(req.params.id);
        
        if (!email) {
          return res.status(404).json({ success: false, error: 'Email not found' });
        }
        
        await email.markAsProcessed('manual');
        res.json({ success: true, message: 'Email marked as processed' });
      } catch (error) {
        logger.error('Process email error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Batch mark emails as processed
    this.app.post('/api/emails/batch-process', authenticateToken, async (req, res) => {
      try {
        const { emailIds } = req.body;
        
        if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
          return res.status(400).json({ success: false, error: 'Invalid email IDs provided' });
        }
        
        const { Email } = await import('../../models/Email.js');
        let processed = 0;
        
        for (const emailId of emailIds) {
          try {
            const email = await Email.findById(emailId);
            if (email && !email.processed) {
              await email.markAsProcessed('manual-batch');
              processed++;
            }
          } catch (error) {
            logger.warn(`Failed to process email ${emailId}:`, error.message);
          }
        }
        
        res.json({ 
          success: true, 
          processed,
          message: `${processed} emails marked as processed`
        });
      } catch (error) {
        logger.error('Batch process emails error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Refresh emails (check for new emails)
    this.app.post('/api/emails/refresh', authenticateToken, async (req, res) => {
      try {
        // Trigger email check in background tasks
        const emailPlugin = this.agent.apiManager.getPlugin('email');
        if (emailPlugin && emailPlugin.api.checkEmails) {
          await emailPlugin.api.checkEmails();
          res.json({ success: true, message: 'Email check initiated' });
        } else {
          res.status(503).json({ success: false, error: 'Email plugin not available' });
        }
      } catch (error) {
        logger.error('Refresh emails error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Email Notification Settings Routes
    this.app.get('/api/email/notification-settings', authenticateToken, async (req, res) => {
      try {
        const emailPlugin = this.agent.apiManager.getPlugin('email');
        if (!emailPlugin) {
          return res.status(503).json({ success: false, error: 'Email plugin not available' });
        }

        const result = await emailPlugin.execute({ action: 'getNotificationSettings' });
        res.json(result);
      } catch (error) {
        logger.error('Get email notification settings error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/email/notification-settings', authenticateToken, async (req, res) => {
      try {
        const emailPlugin = this.agent.apiManager.getPlugin('email');
        if (!emailPlugin) {
          return res.status(503).json({ success: false, error: 'Email plugin not available' });
        }

        const result = await emailPlugin.execute({ 
          action: 'setNotificationSettings', 
          ...req.body 
        });
        res.json(result);
      } catch (error) {
        logger.error('Set email notification settings error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Projects Management Routes
    this.app.get('/api/projects', authenticateToken, async (req, res) => {
      try {
        const projectsPlugin = this.agent.apiManager?.getPlugin('projects');
        if (!projectsPlugin) {
          logger.warn('Projects plugin not found in API manager');
          return res.status(503).json({ success: false, error: 'Projects plugin not available' });
        }
        
        logger.info('Projects API called, plugin found');
        const result = await projectsPlugin.handleAPIRequest('GET', '', req.query);
        logger.info('Projects API result:', result);
        res.json(result);
      } catch (error) {
        logger.error('Projects list error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/projects/:id', authenticateToken, async (req, res) => {
      try {
        const projectsPlugin = this.agent.apiManager?.getPlugin('projects');
        if (!projectsPlugin) {
          return res.status(404).json({ success: false, error: 'Projects plugin not available' });
        }
        
        const result = await projectsPlugin.handleAPIRequest('GET', req.params.id);
        res.json(result);
      } catch (error) {
        logger.error('Project get error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/projects', authenticateToken, async (req, res) => {
      try {
        const projectsPlugin = this.agent.apiManager?.getPlugin('projects');
        if (!projectsPlugin) {
          return res.status(503).json({ success: false, error: 'Projects plugin not available' });
        }
        
        const result = await projectsPlugin.handleAPIRequest('POST', '', req.body);
        res.json(result);
      } catch (error) {
        logger.error('Project create error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.put('/api/projects/:id', authenticateToken, async (req, res) => {
      try {
        const projectsPlugin = this.agent.apiManager?.getPlugin('projects');
        if (!projectsPlugin) {
          return res.status(503).json({ success: false, error: 'Projects plugin not available' });
        }
        
        const result = await projectsPlugin.handleAPIRequest('PUT', req.params.id, req.body);
        res.json(result);
      } catch (error) {
        logger.error('Project update error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
      try {
        const projectsPlugin = this.agent.apiManager?.getPlugin('projects');
        if (!projectsPlugin) {
          return res.status(503).json({ success: false, error: 'Projects plugin not available' });
        }
        
        const result = await projectsPlugin.handleAPIRequest('DELETE', req.params.id);
        res.json(result);
      } catch (error) {
        logger.error('Project delete error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Background Tasks Management Routes
    this.app.get('/api/background/pm2-status', authenticateToken, async (req, res) => {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        try {
          const { stdout } = await execAsync('pm2 jlist');
          // PM2 may output non-JSON messages before the JSON array
          let jsonStr = stdout;
          const jsonStart = stdout.indexOf('[');
          if (jsonStart > 0) jsonStr = stdout.slice(jsonStart);
          const processes = safeJsonParse(jsonStr, []);
          const lanAgent = processes.find(p => p.name === 'lan-agent');
          
          if (lanAgent) {
            res.json({
              success: true,
              process: {
                status: lanAgent.pm2_env.status,
                uptime: this.formatUptime(Date.now() - lanAgent.pm2_env.created_at),
                restarts: lanAgent.pm2_env.restart_time,
                memory: this.formatBytes(lanAgent.monit.memory || 0)
              }
            });
          } else {
            res.json({ success: false, error: 'Process not found' });
          }
        } catch (pmError) {
          // Fallback to current process info
          res.json({
            success: true,
            process: {
              status: 'online',
              uptime: this.formatUptime(process.uptime() * 1000),
              restarts: 'N/A',
              memory: this.formatBytes(process.memoryUsage().heapUsed)
            }
          });
        }
      } catch (error) {
        logger.error('PM2 status error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Manual trigger for weekly report
    this.app.post('/api/background/trigger-weekly-report', authenticateToken, async (req, res) => {
      try {
        const scheduler = this.agent.scheduler;
        if (!scheduler) {
          return res.json({ success: false, error: 'Task scheduler not available' });
        }
        
        const result = await scheduler.triggerWeeklyReport();
        res.json(result);
      } catch (error) {
        logger.error('Manual weekly report trigger error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Manual trigger for GitHub discovery
    this.app.post('/api/background/trigger-github-discovery', authenticateToken, async (req, res) => {
      try {
        const scheduler = this.agent.scheduler;
        if (!scheduler) {
          return res.json({ success: false, error: 'Task scheduler not available' });
        }
        
        const result = await scheduler.triggerGitHubDiscovery();
        res.json(result);
      } catch (error) {
        logger.error('Manual GitHub discovery trigger error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Report settings endpoints
    this.app.get('/api/system/report-settings', authenticateToken, async (req, res) => {
      try {
        const scheduler = this.agent.scheduler;
        if (!scheduler) {
          return res.json({ success: false, error: 'Task scheduler not available' });
        }
        
        const settings = await scheduler.getReportSettings();
        res.json({ success: true, settings });
      } catch (error) {
        logger.error('Get report settings error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/system/report-settings', authenticateToken, async (req, res) => {
      try {
        const scheduler = this.agent.scheduler;
        if (!scheduler) {
          return res.json({ success: false, error: 'Task scheduler not available' });
        }
        
        const { frequency, time } = req.body;
        const settings = await scheduler.setReportSettings(frequency, time);
        res.json({ success: true, settings });
      } catch (error) {
        logger.error('Set report settings error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/background/agenda-jobs', authenticateToken, async (req, res) => {
      try {
        // Get jobs from Agenda scheduler (all jobs should be here)
        const scheduler = this.agent.scheduler;
        if (!scheduler) {
          logger.warn('Task scheduler not found on agent');
          return res.json({ success: false, error: 'Task scheduler not available' });
        }

        const jobStatus = await scheduler.getJobStatus();
        const stats = jobStatus.stats;
        
        logger.info(`Agenda has ${stats.total} jobs`);

        // Get last activities from scheduler
        const lastActivities = {
          emailCheck: scheduler.lastEmailCheck,
          taskReminder: scheduler.lastTaskReminder,
          systemStats: scheduler.lastSystemStats,
          modelUpdate: scheduler.lastModelUpdate,
          gitCheck: scheduler.lastGitCheck,
          maintenance: scheduler.lastMaintenance,
          systemHealth: scheduler.lastSystemHealth,
          codeAnalysis: scheduler.lastCodeAnalysis,
          processTasks: scheduler.lastProcessTasks,
          selfModScan: scheduler.lastSelfModScan,
          weeklyReport: scheduler.lastWeeklyReport,
          dailyBugScan: scheduler.lastDailyBugScan,
          bugFixing: scheduler.lastBugFixing,
          githubDiscovery: scheduler.lastGitHubDiscovery,
          cleanupJobs: scheduler.lastCleanupJobs,
          systemDiagnostics: scheduler.lastSystemDiagnostics
        };

        res.json({
          success: true,
          stats,
          jobs: jobStatus.jobs,
          lastActivities
        });
      } catch (error) {
        logger.error('Background jobs error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/background/recent-logs', authenticateToken, async (req, res) => {
      try {
        // Read recent logs from the log file
        const { readFile } = await import('fs/promises');
        const path = await import('path');
        const logsPath = path.join(process.cwd(), 'logs', 'all-activity.log');
        
        try {
          const logContent = await readFile(logsPath, 'utf-8');
          const lines = logContent.split('\n').filter(line => line.trim());
          
          // Get last 50 lines that contain background task keywords
          // Note: crypto strategy keywords removed - now managed by SubAgent system, not Agenda
          const backgroundKeywords = ['email check', 'system stats', 'model update', 'reminder', 'background', 'scheduled'];
          const relevantLogs = [];
          
          for (let i = lines.length - 1; i >= 0 && relevantLogs.length < 50; i--) {
            const line = lines[i];
            if (backgroundKeywords.some(keyword => line.toLowerCase().includes(keyword))) {
              const parsed = safeJsonParse(line, null);
              if (parsed) {
                relevantLogs.push({
                  timestamp: parsed.timestamp || new Date().toISOString(),
                  level: parsed.level || 'info',
                  message: parsed.message || line,
                  source: 'background'
                });
              } else {
                // If not JSON, still include it
                relevantLogs.push({
                  timestamp: new Date().toISOString(),
                  level: 'info',
                  message: line,
                  source: 'background'
                });
              }
            }
          }
          
          res.json({
            success: true,
            logs: relevantLogs.reverse()
          });
        } catch (fileError) {
          // If can't read file, return empty logs
          res.json({
            success: true,
            logs: []
          });
        }
      } catch (error) {
        logger.error('Background logs error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update AI model for a provider
    this.app.post('/api/ai/update-model', authenticateToken, async (req, res) => {
      try {
        const { provider, model } = req.body;
        
        const providerInstance = this.agent.providerManager.providers.get(provider);
        if (!providerInstance) {
          return res.status(404).json({ success: false, error: 'Provider not found' });
        }
        
        // Log before update
        logger.info(`Updating ${provider} model from ${providerInstance.models?.chat || providerInstance.model} to ${model}`);
        
        // Update the model in the provider
        if (providerInstance.models && typeof providerInstance.models === 'object') {
          // Update chat model by default
          providerInstance.models.chat = model;
          
          // Also update vision model if it's the same
          if (providerInstance.models.vision === providerInstance.models.chat) {
            providerInstance.models.vision = model;
          }
        } else if (providerInstance.model) {
          providerInstance.model = model;
        }
        
        // Verify update
        logger.info(`Provider ${provider} runtime model updated to: ${providerInstance.models?.chat || providerInstance.model}`);
        
        // Save updated configuration
        const { Agent } = await import('../../models/Agent.js');
        const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
        if (agentData) {
          if (!agentData.aiProviders) agentData.aiProviders = {};
          if (!agentData.aiProviders.configurations) agentData.aiProviders.configurations = {};
          if (!agentData.aiProviders.configurations[provider]) agentData.aiProviders.configurations[provider] = {};
          
          // Save to the configurations structure  
          agentData.aiProviders.configurations[provider].model = model;
          
          // Also save chatModel for backward compatibility
          if (!agentData.aiProviders[provider]) agentData.aiProviders[provider] = {};
          agentData.aiProviders[provider].chatModel = model;
          
          await agentData.save();
        }
        
        res.json({ success: true, message: `Model updated to ${model}` });
      } catch (error) {
        logger.error('Update model error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Generic plugin execution endpoint
    this.app.post('/api/plugin', authenticateToken, async (req, res) => {
      try {
        const { plugin, action, ...data } = req.body;
        
        if (!plugin || !action) {
          return res.status(400).json({ 
            success: false, 
            error: 'Plugin name and action are required' 
          });
        }
        
        const pluginInstance = this.agent.apiManager.getPlugin(plugin);
        if (!pluginInstance) {
          return res.status(404).json({ 
            success: false, 
            error: `Plugin '${plugin}' not found or not loaded` 
          });
        }
        
        // Execute the plugin action — unwrap nested params if present
        const execData = data.params && typeof data.params === 'object' && !Array.isArray(data.params)
          ? { action, ...data.params }
          : { action, ...data };
        const result = await pluginInstance.execute(execData);
        
        res.json(result);
      } catch (error) {
        logger.error('Plugin execution error:', error);
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // Voice API endpoints (temporary direct implementation)
    this.app.get('/api/voice/voices', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.ttsService) {
          return res.json({ success: false, error: 'TTS Service not available' });
        }
        const voices = this.agent.ttsService.getAvailableVoices();
        res.json({ success: true, data: voices });
      } catch (error) {
        logger.error('Voice voices error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/voice/settings', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.ttsService) {
          return res.json({ success: false, error: 'TTS Service not available' });
        }
        const settings = this.agent.ttsService.getVoiceSettings();
        res.json({ success: true, data: settings });
      } catch (error) {
        logger.error('Voice settings error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/voice/settings', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.ttsService) {
          return res.json({ success: false, error: 'TTS Service not available' });
        }
        await this.agent.ttsService.updateVoiceSettings(req.body);
        res.json({ success: true, message: 'Voice settings updated successfully' });
      } catch (error) {
        logger.error('Voice settings update error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/voice/test', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.ttsService) {
          return res.json({ success: false, error: 'TTS Service not available' });
        }
        
        const { voice = 'nova', text = 'Hello! This is a voice test.', model, speed, format, instructions, provider } = req.body;
        
        const result = await this.agent.ttsService.generateSpeech(text, {
          voice, model, speed, format, instructions, provider
        });

        // Save to temporary file for web access
        const tempDir = path.join(__dirname, '../../../temp');
        await fs.mkdir(tempDir, { recursive: true });

        const filename = `voice-test-${voice}-${Date.now()}.${result.format}`;
        const filepath = path.join(tempDir, filename);
        
        logger.info(`Creating voice test file: ${filepath} (${result.buffer.length} bytes)`);
        await fs.writeFile(filepath, result.buffer);
        
        // Verify file was created
        const stats = await fs.stat(filepath);
        logger.info(`Voice test file created successfully: ${filename} (${stats.size} bytes)`);

        res.json({
          success: true,
          data: {
            voice: result.voice,
            model: result.model,
            cost: result.cost,
            duration: result.duration,
            size: result.size,
            audioUrl: `/api/voice/audio/${filename}`
          }
        });
      } catch (error) {
        logger.error('Voice test error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/voice/audio/:filename', async (req, res) => {
      try {
        const { filename } = req.params;
        logger.info(`Voice audio request for file: ${filename}`);
        
        // Validate filename for security
        if (!filename || !/^voice-test-[\w-]+-\d+\.(mp3|wav|ogg|aac|flac|opus)$/.test(filename)) {
          logger.warn(`Invalid filename format: ${filename}`);
          return res.status(400).json({ error: 'Invalid filename' });
        }

        const tempDir = path.join(__dirname, '../../../temp');
        const filepath = path.join(tempDir, filename);
        logger.info(`Looking for audio file at: ${filepath}`);

        // Check if file exists
        try {
          await fs.access(filepath);
          logger.info(`Audio file found: ${filepath}`);
        } catch (error) {
          logger.error(`Audio file not found: ${filepath}`);
          return res.status(404).json({ error: 'Audio file not found' });
        }

        // Get file stats
        const stats = await fs.stat(filepath);
        logger.info(`Audio file stats: ${stats.size} bytes, modified: ${stats.mtime}`);
        
        // Set appropriate headers
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = {
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.ogg': 'audio/ogg',
          '.aac': 'audio/aac',
          '.flac': 'audio/flac',
          '.opus': 'audio/opus'
        };

        const contentType = mimeTypes[ext] || 'audio/mpeg';
        logger.info(`Serving audio file with Content-Type: ${contentType}, size: ${stats.size} bytes`);
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Accept-Ranges', 'bytes');

        // Stream the file
        const stream = fsSync.createReadStream(filepath);
        stream.on('error', (streamError) => {
          logger.error('Stream error while serving audio:', streamError);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Error streaming audio file' });
          }
        });
        stream.pipe(res);
      } catch (error) {
        logger.error('Error serving audio file:', error);
        res.status(500).json({ error: 'Error serving audio file' });
      }
    });

    // Wake Word Training API endpoints
    this.app.get('/api/voice/wakeword/status', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.wakeWordTraining) {
          return res.json({ success: false, error: 'Wake word training service not available' });
        }

        const status = this.agent.wakeWordTraining.getStatus();
        const modelInfo = await this.agent.wakeWordTraining.getModelInfo();

        res.json({
          success: true,
          status,
          modelInfo
        });
      } catch (error) {
        logger.error('Error getting wake word status:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/voice/wakeword/start', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.wakeWordTraining) {
          return res.json({ success: false, error: 'Wake word training service not available' });
        }

        // WebUI training sends user to Telegram for voice samples
        const wakeWord = this.agent.wakeWordTraining.getWakeWord();
        const telegramUsername = process.env.TELEGRAM_BOT_USERNAME || 'your_bot';

        res.json({
          success: true,
          message: `To train a custom wake word model for "${wakeWord}", please use Telegram:\n\n` +
            `1. Open Telegram and find @${telegramUsername}\n` +
            `2. Send the command: /train_wakeword\n` +
            `3. Follow the instructions to record voice samples\n\n` +
            `The agent will guide you through recording positive samples (saying "${wakeWord}") ` +
            `and negative samples (other phrases).`,
          wakeWord,
          telegramCommand: '/train_wakeword'
        });
      } catch (error) {
        logger.error('Error starting wake word training:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Voice Interaction Service API endpoints (wake word listening)
    this.app.get('/api/voice/interaction/status', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.voiceInteraction) {
          return res.json({ success: false, error: 'Voice interaction service not available' });
        }
        const status = this.agent.voiceInteraction.getStatus();
        res.json({ success: true, ...status });
      } catch (error) {
        logger.error('Error getting voice interaction status:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/voice/interaction/start', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.voiceInteraction) {
          return res.json({ success: false, error: 'Voice interaction service not available' });
        }
        const result = await this.agent.voiceInteraction.start();

        // Persist the enabled state to database
        if (result && this.agent.agentDoc) {
          try {
            this.agent.agentDoc.voice = this.agent.agentDoc.voice || {};
            this.agent.agentDoc.voice.voiceInteractionEnabled = true;
            await this.agent.agentDoc.save();
            logger.info('[VoiceInteraction] Enabled state persisted to database');
          } catch (saveError) {
            logger.warn('[VoiceInteraction] Failed to persist enabled state:', saveError.message);
          }
        }

        const status = this.agent.voiceInteraction.getStatus();
        res.json({ success: result, message: result ? 'Voice interaction started' : 'Failed to start', ...status });
      } catch (error) {
        logger.error('Error starting voice interaction:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/voice/interaction/stop', authenticateToken, async (req, res) => {
      try {
        if (!this.agent.voiceInteraction) {
          return res.json({ success: false, error: 'Voice interaction service not available' });
        }
        this.agent.voiceInteraction.stop();

        // Persist the disabled state to database
        if (this.agent.agentDoc) {
          try {
            this.agent.agentDoc.voice = this.agent.agentDoc.voice || {};
            this.agent.agentDoc.voice.voiceInteractionEnabled = false;
            await this.agent.agentDoc.save();
            logger.info('[VoiceInteraction] Disabled state persisted to database');
          } catch (saveError) {
            logger.warn('[VoiceInteraction] Failed to persist disabled state:', saveError.message);
          }
        }

        const status = this.agent.voiceInteraction.getStatus();
        res.json({ success: true, message: 'Voice interaction stopped', ...status });
      } catch (error) {
        logger.error('Error stopping voice interaction:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ======= MEDIA GENERATION ENDPOINTS =======

    // Get media generation settings (image + video)
    this.app.get('/api/media/settings', authenticateToken, async (req, res) => {
      try {
        const { Agent } = await import('../../models/Agent.js');
        const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });

        res.json({
          success: true,
          image: agent?.mediaGeneration?.image || {
            enabled: true,
            provider: 'openai',
            openai: { model: 'gpt-image-1', size: '1024x1024', quality: 'auto' },
            huggingface: { model: 'black-forest-labs/FLUX.1-schnell', numInferenceSteps: 5 }
          },
          video: agent?.mediaGeneration?.video || {
            enabled: true,
            provider: 'openai',
            openai: { model: 'sora-2', duration: '8', quality: 'standard' },
            huggingface: { model: 'Wan-AI/Wan2.1-T2V-14B' }
          }
        });
      } catch (error) {
        logger.error('Failed to get media settings:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update image generation settings
    this.app.post('/api/media/image/settings', authenticateToken, async (req, res) => {
      try {
        const { Agent } = await import('../../models/Agent.js');
        const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });

        if (!agent) {
          return res.status(404).json({ success: false, error: 'Agent not found' });
        }

        if (!agent.mediaGeneration) {
          agent.mediaGeneration = {};
        }

        agent.mediaGeneration.image = req.body;
        await agent.save();

        logger.info('Image generation settings updated');
        res.json({ success: true, message: 'Image generation settings saved' });
      } catch (error) {
        logger.error('Failed to update image settings:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Update video generation settings
    this.app.post('/api/media/video/settings', authenticateToken, async (req, res) => {
      try {
        const { Agent } = await import('../../models/Agent.js');
        const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });

        if (!agent) {
          return res.status(404).json({ success: false, error: 'Agent not found' });
        }

        if (!agent.mediaGeneration) {
          agent.mediaGeneration = {};
        }

        const settings = req.body;

        // Handle ModelsLab API key: encrypt if new, preserve existing if not sent
        if (settings['modelslab']) {
          if (settings['modelslab'].apiKey) {
            settings['modelslab'].apiKey = encrypt(settings['modelslab'].apiKey);
          } else {
            // Preserve existing encrypted key
            const existingKey = agent.mediaGeneration?.video?.['modelslab']?.apiKey;
            if (existingKey) {
              settings['modelslab'].apiKey = existingKey;
            }
          }
        }

        agent.mediaGeneration.video = settings;
        await agent.save();

        // Reload video service to pick up new settings/credentials
        try {
          const videoService = (await import('../../services/media/videoGenerationService.js')).default;
          await videoService.reloadCredentials();
          await videoService.loadSettings();
        } catch (reloadErr) {
          logger.warn('Failed to reload video service after settings update:', reloadErr.message);
        }

        logger.info('Video generation settings updated');
        res.json({ success: true, message: 'Video generation settings saved' });
      } catch (error) {
        logger.error('Failed to update video settings:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Generate image (direct API endpoint)
    this.app.post('/api/media/image/generate', authenticateToken, async (req, res) => {
      try {
        const imageService = (await import('../../services/media/imageGenerationService.js')).default;
        await imageService.initialize(this.agent.providerManager);

        const { prompt, options = {} } = req.body;
        if (!prompt) {
          return res.status(400).json({ success: false, error: 'Prompt is required' });
        }

        const result = await imageService.generate(prompt, options);

        if (result.success && result.images?.length > 0) {
          // Return base64 encoded image for web display
          const base64 = result.images[0].buffer.toString('base64');
          res.json({
            success: true,
            image: `data:image/png;base64,${base64}`,
            model: result.model
          });
        } else {
          throw new Error('No image was generated');
        }
      } catch (error) {
        logger.error('Image generation API error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Generate video (direct API endpoint)
    this.app.post('/api/media/video/generate', authenticateToken, async (req, res) => {
      try {
        const videoService = (await import('../../services/media/videoGenerationService.js')).default;
        await videoService.initialize(this.agent.providerManager);

        const { prompt, options = {} } = req.body;
        if (!prompt) {
          return res.status(400).json({ success: false, error: 'Prompt is required' });
        }

        const result = await videoService.generate(prompt, options);

        if (result.success) {
          if (result.video?.buffer) {
            // Direct result - return base64 encoded video
            const base64 = result.video.buffer.toString('base64');
            res.json({
              success: true,
              video: `data:video/mp4;base64,${base64}`,
              model: result.model
            });
          } else if (result.jobId) {
            // Async job - return job ID for polling
            res.json({
              success: true,
              async: true,
              jobId: result.jobId,
              status: result.status,
              message: 'Video generation started. Use /api/media/video/status/:jobId to check progress.'
            });
          }
        } else {
          throw new Error('Video generation failed');
        }
      } catch (error) {
        logger.error('Video generation API error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get video job status
    this.app.get('/api/media/video/status/:jobId', authenticateToken, async (req, res) => {
      try {
        const { jobId } = req.params;
        const videoService = (await import('../../services/media/videoGenerationService.js')).default;
        const openaiProvider = this.agent.providerManager?.providers?.get('openai');

        if (!openaiProvider) {
          return res.status(503).json({ success: false, error: 'OpenAI provider not available' });
        }

        const status = await openaiProvider.getVideoStatus(jobId);
        res.json(status);
      } catch (error) {
        logger.error('Video status API error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get pending video jobs
    this.app.get('/api/media/video/pending', authenticateToken, async (req, res) => {
      try {
        const videoService = (await import('../../services/media/videoGenerationService.js')).default;
        const jobs = videoService.getPendingJobs();
        res.json({ success: true, jobs });
      } catch (error) {
        logger.error('Pending jobs API error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get image generation stats
    this.app.get('/api/media/image/stats', authenticateToken, async (req, res) => {
      try {
        const { TokenUsage } = await import('../../models/TokenUsage.js');

        // Get all image generation records
        const allImageRecords = await TokenUsage.find({ requestType: 'image' }).lean();

        let totalRequests = allImageRecords.length;
        let totalCost = 0;
        let monthlyCost = 0;
        let monthlyRequests = 0;

        // Get first day of current month
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const firstDayOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        // Calculate costs by provider
        const costByProvider = { openai: 0, huggingface: 0 };
        const requestsByProvider = { openai: 0, huggingface: 0 };

        for (const record of allImageRecords) {
          totalCost += record.cost || 0;

          const provider = record.provider || 'unknown';
          if (costByProvider[provider] !== undefined) {
            costByProvider[provider] += record.cost || 0;
            requestsByProvider[provider] += 1;
          }

          // Check if record is from this month
          if (record.createdAt >= firstDayOfMonth && record.createdAt < firstDayOfNextMonth) {
            monthlyCost += record.cost || 0;
            monthlyRequests++;
          }
        }

        res.json({
          success: true,
          data: {
            totalRequests,
            totalCost,
            monthlyCost,
            monthlyRequests,
            costByProvider,
            requestsByProvider,
            currentMonth: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
          }
        });
      } catch (error) {
        logger.error('Image stats API error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get video generation stats
    this.app.get('/api/media/video/stats', authenticateToken, async (req, res) => {
      try {
        const { TokenUsage } = await import('../../models/TokenUsage.js');

        // Get all video generation records
        const allVideoRecords = await TokenUsage.find({ requestType: 'video' }).lean();

        let totalRequests = allVideoRecords.length;
        let totalCost = 0;
        let monthlyCost = 0;
        let monthlyRequests = 0;

        // Get first day of current month
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const firstDayOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        // Calculate costs by provider
        const costByProvider = { openai: 0, huggingface: 0 };
        const requestsByProvider = { openai: 0, huggingface: 0 };

        for (const record of allVideoRecords) {
          totalCost += record.cost || 0;

          const provider = record.provider || 'unknown';
          if (costByProvider[provider] !== undefined) {
            costByProvider[provider] += record.cost || 0;
            requestsByProvider[provider] += 1;
          }

          // Check if record is from this month
          if (record.createdAt >= firstDayOfMonth && record.createdAt < firstDayOfNextMonth) {
            monthlyCost += record.cost || 0;
            monthlyRequests++;
          }
        }

        res.json({
          success: true,
          data: {
            totalRequests,
            totalCost,
            monthlyCost,
            monthlyRequests,
            costByProvider,
            requestsByProvider,
            currentMonth: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
          }
        });
      } catch (error) {
        logger.error('Video stats API error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Generic plugin API handler
    this.app.all('/api/:pluginName/*', (req, res, next) => {
      // Skip routes handled by dedicated routers
      if (req.params.pluginName === 'external') return next('route');
      // Allow ?token= query param for image/asset routes (img tags can't send headers)
      if (!req.headers.authorization && req.query.token) {
        req.headers.authorization = `Bearer ${req.query.token}`;
      }
      return authenticateToken(req, res, next);
    }, async (req, res) => {
      try {
        const { pluginName } = req.params;

        if (!this.agent.apiManager) {
          return res.status(500).json({ success: false, error: 'API Manager not available' });
        }
        
        if (!this.agent.apiManager.apis) {
          return res.status(500).json({ success: false, error: 'API Manager not properly initialized' });
        }
        
        const pluginWrapper = this.agent.apiManager.apis.get(pluginName);
        
        if (!pluginWrapper) {
          return res.status(404).json({ success: false, error: `Plugin '${pluginName}' not found` });
        }

        // Get the actual plugin instance from the wrapper
        const plugin = pluginWrapper.instance;
        
        if (!plugin) {
          return res.status(404).json({ success: false, error: `Plugin '${pluginName}' instance not found` });
        }

        if (!plugin.getRoutes || typeof plugin.getRoutes !== 'function') {
          return res.status(404).json({ success: false, error: `Plugin '${pluginName}' does not support HTTP routes` });
        }

        const routes = plugin.getRoutes();
        const pathParts = req.path.split('/').slice(3); // Remove /api/pluginName
        const requestPath = '/' + pathParts.join('/');
        
        // Debug logging for calendar delete issues
        if (pluginName === 'calendar' && req.path.includes('delete')) {
          logger.info(`Calendar delete request - Full path: ${req.path}, Request path: ${requestPath}, Method: ${req.method}`);
          logger.info(`Available calendar routes: ${routes.map(r => `${r.method} ${r.path}`).join(', ')}`);
        }
        
        // Find matching route with support for path parameters
        let matchingRoute = null;
        let pathParams = {};
        
        for (const route of routes) {
          if (route.method.toLowerCase() !== req.method.toLowerCase()) continue;
          
          // Check for exact match first
          if (route.path === requestPath) {
            matchingRoute = route;
            break;
          }
          
          // Check for parameter match (e.g., /alerts/:id)
          const routeParts = route.path.split('/');
          const requestParts = requestPath.split('/');
          
          if (routeParts.length === requestParts.length) {
            let isMatch = true;
            const params = {};
            
            for (let i = 0; i < routeParts.length; i++) {
              if (routeParts[i].startsWith(':')) {
                // This is a parameter
                const paramName = routeParts[i].substring(1);
                params[paramName] = requestParts[i];
              } else if (routeParts[i] !== requestParts[i]) {
                // Not a match
                isMatch = false;
                break;
              }
            }
            
            if (isMatch) {
              matchingRoute = route;
              pathParams = params;
              break;
            }
          }
        }

        if (!matchingRoute) {
          // Log available routes for debugging
          logger.error(`Route not found: ${req.method} ${requestPath} in plugin ${pluginName}`);
          logger.error(`Available routes: ${routes.map(r => `${r.method} ${r.path}`).join(', ')}`);
          return res.status(404).json({ success: false, error: `Route '${req.method} ${requestPath}' not found in plugin '${pluginName}'` });
        }

        // Add path parameters to request object
        if (!req.params) req.params = {};
        Object.assign(req.params, pathParams);

        const result = await matchingRoute.handler(req.body, req, res);
        
        // Only send response if handler hasn't already done so (like for file serving)
        if (!res.headersSent) {
          // Check if result indicates HTML content
          if (result && result.contentType === 'text/html' && result.html) {
            res.header('Content-Type', 'text/html');
            res.send(result.html);
          } else {
            res.json(result);
          }
        }
      } catch (error) {
        logger.error(`Plugin API error for ${req.path}:`, error);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: error.message });
        }
      }
    });

    // Serve index.html for all other routes (SPA)
    // Skip /api/ paths so dynamically-imported routes (e.g. accounts) still match
    this.app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ success: false, error: 'API route not found' });
      }
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
  }

  setupWebSocket() {
    this.io = new Server(this.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });

    this.io.use((socket, next) => {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }
      
      try {
        const decoded = verifyToken(token);
        socket.userId = decoded.user;
        next();
      } catch (error) {
        next(new Error('Invalid token'));
      }
    });

    this.io.on('connection', (socket) => {
      logger.info(`Web client connected: ${socket.id}`);
      this.connectedClients.set(socket.id, {
        userId: socket.userId,
        connectedAt: new Date()
      });

      // Send initial status
      this.sendStatus(socket);

      // Handle commands
      socket.on('execute', async (data, callback) => {
        try {
          const result = await this.agent.processNaturalLanguage(data.command, {
            userId: socket.userId,
            interface: 'web-socket'
          });
          callback({ success: true, result });
        } catch (error) {
          logger.error('Socket command error:', error);
          callback({ success: false, error: error.message });
        }
      });

      // Handle approval
      socket.on('approve', async (data, callback) => {
        try {
          const result = await this.agent.systemExecutor.execute(data.command, { 
            approved: true 
          });
          callback({ success: true, result });
        } catch (error) {
          logger.error('Socket approval error:', error);
          callback({ success: false, error: error.message });
        }
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        logger.info(`Web client disconnected: ${socket.id}`);
        this.connectedClients.delete(socket.id);
      });
    });
  }

  async start() {
    return new Promise((resolve, reject) => {
      logger.info(`Attempting to start web interface on port ${this.port}...`);
      logger.info(`WebInterface server object exists: ${!!this.server}`);
      
      if (!this.server) {
        logger.error('Web server not initialized - calling initialize() first');
        reject(new Error('Web server not initialized'));
        return;
      }
      
      this.server.listen(this.port, (err) => {
        if (err) {
          logger.error('Failed to start web server:', err);
          reject(err);
          return;
        }
        
        logger.info(`✅ Web Interface successfully running on port ${this.port}`);
        logger.info(`🌐 Access at: http://localhost:${this.port}`);
        
        // Start periodic updates
        this.startPeriodicUpdates();

        // Auto-sync Skynet services after plugins are loaded (delayed to ensure full init)
        setTimeout(async () => {
          try {
            const apiManager = this.agent?.apiManager || this.agent?.services?.get('apiManager');
            const result = await syncServicesFromPlugins(apiManager);
            if (result.synced > 0) {
              logger.info(`Skynet auto-sync: ${result.message}`);
            }
          } catch (err) {
            logger.warn('Skynet auto-sync failed (non-critical):', err.message);
          }
        }, 30000);

        resolve();
      });

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${this.port} is already in use`);
        } else if (error.code === 'EACCES' && this.port < 1024) {
          logger.error(`Port ${this.port} requires elevated privileges. Run as root or use a port >= 1024`);
        } else {
          logger.error('Web server error:', error);
        }
        reject(error);
      });
    });
  }

  async stop() {
    // Stop periodic updates
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Close WebSocket connections
    if (this.io) {
      this.io.close();
    }

    // Close HTTP server
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('Web Interface stopped');
          resolve();
        });
      });
    }
  }

  startPeriodicUpdates() {
    this.updateInterval = setInterval(async () => {
      if (this.connectedClients.size > 0) {
        try {
          const status = await this.agent.getSystemStatus();
          this.io.emit('status', status);
        } catch (error) {
          logger.error('Periodic update error:', error);
        }
      }
    }, 10000); // Update every 10 seconds
  }

  async sendStatus(socket) {
    try {
      const status = await this.agent.getSystemStatus();
      socket.emit('status', status);
    } catch (error) {
      logger.error('Send status error:', error);
    }
  }

  async getLogs() {
    // Get comprehensive logs including all operations
    const operations = this.agent.getOperationLogs(100);
    const systemCommands = this.agent.systemExecutor.getHistory(50);
    const summary = this.agent.getOperationSummary();
    
    // Format operations for display
    const formattedOps = this.agent.operationLogger.formatForDisplay(operations);
    
    return {
      operations: formattedOps,
      system: systemCommands,
      summary: summary,
      lastUpdate: new Date()
    };
  }

  // Generate prioritized upgrade plans for self-modification
  async generateUpgradePlans() {
    try {
      // Try to get plans from self-modification service first
      if (this.agent.selfModification) {
        const dynamicPlans = await this.agent.selfModification.generateUpgradePlans();
        if (dynamicPlans && dynamicPlans.length > 0) {
          return dynamicPlans;
        }
      }
      
      // Only return dynamic plans based on current system analysis
      const systemIssues = await this.analyzeSystemForUpgrades();
      return systemIssues;
    } catch (error) {
      logger.error('Failed to generate upgrade plans:', error);
      return [];
    }
  }

  // Analyze current system state to identify improvement opportunities
  async analyzeSystemForUpgrades() {
    const dynamicPlans = [];
    
    try {
      // Check memory usage
      const memUsage = process.memoryUsage();
      if (memUsage.heapUsed / memUsage.heapTotal > 0.8) {
        dynamicPlans.push({
          id: 'memory-optimization',
          title: 'Memory Usage Optimization',
          description: 'Current memory usage is high - optimize memory-intensive operations',
          priority: 'High',
          estimatedEffort: 'Medium',
          benefits: ['Better performance', 'Reduced resource usage'],
          status: 'Urgent'
        });
      }

      // Check plugin errors
      const pluginErrors = await this.checkPluginHealth();
      if (pluginErrors.length > 0) {
        dynamicPlans.push({
          id: 'plugin-stability',
          title: 'Plugin Stability Improvements',
          description: `${pluginErrors.length} plugins showing errors - need stability fixes`,
          priority: 'High',
          estimatedEffort: 'Low',
          benefits: ['More reliable operations', 'Better user experience'],
          status: 'Urgent'
        });
      }
    } catch (error) {
      logger.warn('System analysis for upgrades failed:', error.message);
    }

    return dynamicPlans;
  }

  // Check health status of all plugins
  async checkPluginHealth() {
    const errors = [];
    
    if (this.agent.apiManager && this.agent.apiManager.apis) {
      for (const [name, plugin] of this.agent.apiManager.apis) {
        try {
          // Simple health check - could be enhanced per plugin
          if (!plugin.enabled) {
            errors.push(name);
          }
        } catch (error) {
          errors.push(name);
        }
      }
    }
    
    return errors;
  }

  // Get plugin information with proper descriptions and command counts
  /**
   * Get the list of required credentials for a plugin
   * Plugins can define their own requiredCredentials array, or we use a lookup table
   */
  getPluginRequiredCredentials(pluginName, plugin) {
    // If plugin defines its own credentials requirements, use those
    if (plugin.requiredCredentials && Array.isArray(plugin.requiredCredentials)) {
      return plugin.requiredCredentials;
    }

    // Lookup table for known plugins
    const credentialMap = {
      here: [
        { key: 'apiKey', label: 'API Key', envVar: 'HERE_API_KEY', required: true }
      ],
      news: [
        { key: 'apiKey', label: 'API Key', envVar: 'NEWS_API_KEY', required: true }
      ],
      coingecko: [
        { key: 'apiKey', label: 'API Key (optional)', envVar: 'COINGECKO_API_KEY', required: false }
      ],
      alphavantage: [
        { key: 'apiKey', label: 'API Key', envVar: 'ALPHA_VANTAGE_API_KEY', required: true }
      ],
      nasa: [
        { key: 'apiKey', label: 'API Key', envVar: 'NASA_API_KEY', required: true }
      ],
      virustotal: [
        { key: 'apiKey', label: 'API Key', envVar: 'VIRUSTOTAL_API_KEY', required: true }
      ],
      govee: [
        { key: 'apiKey', label: 'API Key', envVar: 'GOVEE_API_KEY', required: true }
      ],
      sendgrid: [
        { key: 'apiKey', label: 'API Key', envVar: 'SENDGRID_API_KEY', required: true },
        { key: 'fromEmail', label: 'From Email', envVar: 'SENDGRID_FROM_EMAIL', required: true }
      ],
      slack: [
        { key: 'apiKey', label: 'Bot Token', envVar: 'SLACK_API_KEY', required: true }
      ],
      trello: [
        { key: 'apiKey', label: 'API Key', envVar: 'TRELLO_API_KEY', required: true },
        { key: 'oauthToken', label: 'OAuth Token', envVar: 'TRELLO_OAUTH_TOKEN', required: true }
      ],
      asana: [
        { key: 'apiKey', label: 'Personal Access Token', envVar: 'ASANA_API_KEY', required: true }
      ],
      freshping: [
        { key: 'apiKey', label: 'API Key', envVar: 'FRESHPING_API_KEY', required: true },
        { key: 'subdomain', label: 'Subdomain', envVar: 'FRESHPING_SUBDOMAIN', required: true }
      ],
      statuscake: [
        { key: 'apiKey', label: 'API Key', envVar: 'STATUSCAKE_API_KEY', required: true }
      ],
      newrelic: [
        { key: 'apiKey', label: 'API Key', envVar: 'NEW_RELIC_API_KEY', required: true }
      ],
      thingsboard: [
        { key: 'url', label: 'Server URL', envVar: 'THINGSBOARD_URL', required: true },
        { key: 'username', label: 'Username', envVar: 'THINGSBOARD_USERNAME', required: true },
        { key: 'password', label: 'Password', envVar: 'THINGSBOARD_PASSWORD', required: true }
      ],
      thingspeak: [
        { key: 'apiKey', label: 'API Key', envVar: 'THINGSPEAK_API_KEY', required: true }
      ],
      vonage: [
        { key: 'apiKey', label: 'API Key', envVar: 'VONAGE_API_KEY', required: true },
        { key: 'apiSecret', label: 'API Secret', envVar: 'VONAGE_API_SECRET', required: true }
      ],
      signalwire: [
        { key: 'projectId', label: 'Project ID', envVar: 'SIGNALWIRE_PROJECT_ID', required: true },
        { key: 'apiToken', label: 'API Token', envVar: 'SIGNALWIRE_API_TOKEN', required: true },
        { key: 'spaceUrl', label: 'Space URL', envVar: 'SIGNALWIRE_SPACE_URL', required: true }
      ],
      microsoftgraph: [
        { key: 'accessToken', label: 'Access Token', envVar: 'MICROSOFT_GRAPH_ACCESS_TOKEN', required: true }
      ],
      firebasecloudmessagingfcm: [
        { key: 'apiKey', label: 'Server Key', envVar: 'FIREBASE_CLOUD_MESSAGING_FCM_API_KEY', required: true }
      ],
      integromatnowmake: [
        { key: 'apiKey', label: 'API Key', envVar: 'INTEGROMAT_NOW_MAKE_API_KEY', required: true }
      ],
      whois: [
        { key: 'apiKey', label: 'API Key', envVar: 'WHOISJSON_API_KEY', required: true }
      ],
      chainlink: [
        { key: 'rpcUrl', label: 'RPC URL', envVar: 'ETHEREUM_RPC_URL', required: false }
      ],
      jellyfin: [
        { key: 'url', label: 'Jellyfin Server URL', envVar: 'JELLYFIN_URL', required: true },
        { key: 'apiKey', label: 'Jellyfin API Key', envVar: 'JELLYFIN_API_KEY', required: true }
      ],
      calibre: [
        { key: 'url', label: 'Calibre Server URL', envVar: 'CALIBRE_URL', required: true },
        { key: 'username', label: 'Username (if auth enabled)', envVar: 'CALIBRE_USERNAME', required: false },
        { key: 'password', label: 'Password (if auth enabled)', envVar: 'CALIBRE_PASSWORD', required: false }
      ]
    };

    return credentialMap[pluginName] || [];
  }

  getPluginInfo(name, plugin) {
    // Get the actual plugin instance from the wrapper
    const instance = plugin.instance;
    
    const pluginInfo = {
      name: instance?.name || name || 'unnamed',
      version: instance?.version || '1.0.0',
      description: instance?.description || 'No description available',
      commandCount: 0,
      commands: []
    };

    // Try to get actual command count and commands from plugin
    if (instance && instance.commands && Array.isArray(instance.commands)) {
      pluginInfo.commandCount = instance.commands.length;
      pluginInfo.commands = instance.commands;
    }

    // Define known plugin descriptions and command counts
    const knownPlugins = {
      'email': {
        description: 'Email integration with Gmail support for sending, receiving, scheduling, and managing emails',
        commandCount: 15
      },
      'git': {
        description: 'Git version control operations including commits, branches, and repository management',
        commandCount: 8
      },
      'system': {
        description: 'System monitoring and control including process management, disk usage, and system info',
        commandCount: 6
      },
      'network': {
        description: 'Network utilities including connectivity tests, port scanning, and network diagnostics',
        commandCount: 5
      },
      'monitoring': {
        description: 'System monitoring including CPU temperature, performance metrics, and resource usage',
        commandCount: 4
      },
      'tasks': {
        description: 'Task and reminder management with scheduling and notification capabilities',
        commandCount: 7
      },
      'websearch': {
        description: 'Web search capabilities using multiple search engines and result processing',
        commandCount: 3
      },
      'scraper': {
        description: 'Web scraping and data extraction from websites with content processing',
        commandCount: 4
      },
      'microcontroller': {
        description: 'Arduino and microcontroller integration for IoT and hardware control',
        commandCount: 6
      },
      'software': {
        description: 'Software installation and package management for various package managers',
        commandCount: 5
      },
      'development': {
        description: 'Development tools and utilities for coding assistance and project management',
        commandCount: 4
      },
      'backupStrategy': {
        description: 'Automated backup management with scheduled backups and restoration capabilities',
        commandCount: 6
      },
      'bugDetector': {
        description: 'Automated bug detection and reporting with code analysis and GitHub integration',
        commandCount: 5
      },
      'devenv': {
        description: 'Development environment management with project setup and server control',
        commandCount: 8
      },
      'documentIntelligence': {
        description: 'Document analysis and intelligent processing with content extraction',
        commandCount: 4
      },
      'samba': {
        description: 'Samba/CIFS network share management for file sharing and mounting',
        commandCount: 7
      },
      'systemAdmin': {
        description: 'Advanced system administration with automated maintenance and security management',
        commandCount: 9
      },
      'virustotal': {
        description: 'VirusTotal integration for malware scanning and security analysis',
        commandCount: 4
      },
      'voice': {
        description: 'Voice and text-to-speech capabilities with multiple voice options',
        commandCount: 3
      },
      'vpn': {
        description: 'VPN management and control for ExpressVPN connections',
        commandCount: 7
      },
      'calendar': {
        description: 'CalDAV calendar integration for Google, iCloud, Yahoo & Outlook - manage events without OAuth',
        commandCount: 10
      },
      'ffmpeg': {
        description: 'Audio and video processing using FFmpeg',
        commandCount: 6
      },
      'ytdlp': {
        description: 'Download videos and audio from YouTube and other platforms using yt-dlp',
        commandCount: 5
      },
      'projects': {
        description: 'Project management system for development workflows',
        commandCount: 2
      }
    };

    // Use known info if available
    if (knownPlugins[name]) {
      pluginInfo.description = knownPlugins[name].description;
      pluginInfo.commandCount = knownPlugins[name].commandCount;
    }

    // Try to get actual description from plugin if available
    if (plugin.description && plugin.description !== 'No description') {
      pluginInfo.description = plugin.description;
    }

    return pluginInfo;
  }

  // Format file size to human readable format
  formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 Bytes';
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
  }

  // Notify web clients of events
  broadcast(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  // Format bytes to human readable format
  formatBytes(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (!bytes || bytes === 0) return '0 Bytes';
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
  }

  // Format uptime in milliseconds to human readable format
  formatUptime(ms) {
    if (!ms || ms < 0) return '0s';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Get human-readable description for cron jobs
  getCronDescription(jobName) {
    const descriptions = {
      'emailChecker': 'Every 3 minutes',
      'systemMonitor': 'Every 5 minutes',
      'gitMonitor': 'Every hour',
      'selfModScanner': 'Every hour',
      'reminderProcessor': 'Every minute',
      'systemMaintenance': 'Daily at 3 AM',
      'weeklyReport': 'Weekly on Mondays',
      'modelUpdater': 'Daily at 3 AM'
    };
    return descriptions[jobName] || 'Custom schedule';
  }
}