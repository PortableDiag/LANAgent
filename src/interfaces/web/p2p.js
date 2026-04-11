import express from 'express';
import { authenticateToken } from './auth.js';
import { logger } from '../../utils/logger.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { SystemSettings } from '../../models/SystemSettings.js';
import SkynetServiceConfig from '../../models/SkynetServiceConfig.js';
import SkynetPayment from '../../models/SkynetPayment.js';
import SkynetBounty from '../../models/SkynetBounty.js';
import SkynetGovernance from '../../models/SkynetGovernance.js';
import DataListing from '../../models/DataListing.js';
import ArbSignal from '../../models/ArbSignal.js';
import ComputeJob from '../../models/ComputeJob.js';

const router = express.Router();
const P2P_SETTINGS_PLUGIN = 'p2p-federation';
const P2P_SETTINGS_KEY = 'settings';

// Only these plugin categories are appropriate to offer as Skynet P2P services.
// Excluded: system admin, security, personal data, internal tools, communication accounts,
// financial data feeds (trust issues - peers shouldn't serve price data), internal AI.
const SKYNET_ELIGIBLE_CATEGORIES = new Set([
  'aiDetector', 'anime', 'aviationstack', 'chainlink', 'challengeQuestions', 'contractAudit',
  'ffmpeg', 'here', 'huggingface', 'imageTools', 'ipstack', 'lyrics', 'mediastack', 'music', 'nasa',
  'news', 'numverify', 'scraper', 'tokenProfiler', 'walletProfiler', 'weatherstack',
  'websearch', 'whois', 'ytdlp'
]);

// Actions that should NEVER be exposed as paid services (admin, internal, settings, diagnostics)
const BLOCKED_SERVICE_ACTIONS = new Set([
  // Admin/settings operations
  'configure', 'settings', 'updateSettings', 'getSettings', 'setPreferences',
  'getPreferences', 'config', 'setup', 'initialize', 'reset',
  // Version/update operations
  'version', 'update', 'upgrade', 'checkUpdate', 'showVersion',
  // Internal diagnostics
  'status', 'health', 'ping', 'test', 'debug', 'stats',
  // Destructive operations
  'delete', 'remove', 'purge', 'clear', 'wipe',
  // Diagnostic/info-only operations
  'listFormats', 'checkStatus', 'list',
]);

// Patterns in action names or descriptions that indicate internal/admin operations
const BLOCKED_SERVICE_PATTERNS = [
  /^(get|set|update|view).*(?:setting|config|preference|option)/i,
  /(?:update|upgrade|install|version).*(?:yt-dlp|ffmpeg|package|module)/i,
  /(?:current|show).*(?:version|status|config)/i,
];

function isServiceEligible(cmd) {
  const action = cmd.command || cmd.name || '';
  const desc = cmd.description || '';

  // Explicit flag from plugin dev — highest priority
  if (cmd.offerAsService === false) return false;
  if (cmd.offerAsService === true) return true;

  // Check blocklist
  if (BLOCKED_SERVICE_ACTIONS.has(action)) return false;

  // Check patterns
  for (const pattern of BLOCKED_SERVICE_PATTERNS) {
    if (pattern.test(action) || pattern.test(desc)) return false;
  }

  return true;
}

/**
 * P2P Federation Web Interface Routes
 * Provides REST API for managing peers, plugin sharing, and federation settings
 *
 * The p2pService is accessed via req.app.locals.agent.p2pService
 */

function getP2PService(req) {
  return req.app.locals.agent?.p2pService;
}

// ==================== Status & Identity ====================

// Get federation status
router.get('/api/status', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) {
      return res.json({
        success: true,
        enabled: false,
        message: 'Skynet is not enabled.'
      });
    }

    const status = p2p.getConnectionStatus();
    const identity = p2p.getIdentity();

    // Get wallet address for Skynet services
    let walletAddress = null;
    try {
      walletAddress = await p2p.skynetServiceExecutor?.getRecipientAddress?.() || null;
    } catch {}

    res.json({
      success: true,
      enabled: true,
      identity: {
        fingerprint: identity?.fingerprint,
        publicKey: identity?.publicKey
      },
      connection: status,
      walletAddress,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('P2P status API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Peer Management ====================

// Get all known peers
router.get('/api/peers', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const peers = await p2p.getAllPeers();

    res.json({
      success: true,
      peers: peers.map(p => ({
        fingerprint: p.fingerprint,
        displayName: p.displayName,
        trustLevel: p.trustLevel,
        isOnline: p.isOnline,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        capabilitiesCount: p.capabilities?.length || 0,
        transferCount: p.transferCount,
        erc8004: p.erc8004?.verified ? { agentId: p.erc8004.agentId, verified: true } : null,
        trustScore: p.trustScore || 0,
        skynetBalance: p.skynetBalance || 0,
        skynetBalanceVerified: p.skynetBalanceVerified || false
      }))
    });
  } catch (error) {
    logger.error('P2P peers API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get online peers only
router.get('/api/peers/online', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const peers = await p2p.getOnlinePeers();

    res.json({
      success: true,
      peers: peers.map(p => ({
        fingerprint: p.fingerprint,
        displayName: p.displayName,
        trustLevel: p.trustLevel,
        capabilitiesCount: p.capabilities?.length || 0
      }))
    });
  } catch (error) {
    logger.error('P2P online peers API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get peer details including capabilities
router.get('/api/peers/:fingerprint', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const { peerManager } = await import('../../services/p2p/peerManager.js');
    const peer = await peerManager.getPeer(req.params.fingerprint);
    const capabilities = peer?.capabilities || [];

    res.json({
      success: true,
      fingerprint: req.params.fingerprint,
      displayName: peer?.displayName || 'Unknown',
      walletAddress: peer?.walletAddress || null,
      trustLevel: peer?.trustLevel || 'untrusted',
      isOnline: peer?.isOnline || false,
      lastSeen: peer?.lastSeen || null,
      firstSeen: peer?.firstSeen || null,
      version: peer?.version || null,
      transferCount: peer?.transferCount || 0,
      skynetBalance: peer?.skynetBalance || 0,
      erc8004: peer?.erc8004 || null,
      capabilities
    });
  } catch (error) {
    logger.error('P2P peer details API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Set trust level for a peer
router.post('/api/peers/:fingerprint/trust', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const { level } = req.body;
    if (!['untrusted', 'trusted'].includes(level)) {
      return res.status(400).json({ success: false, error: 'Invalid trust level. Must be "untrusted" or "trusted".' });
    }

    await p2p.setTrustLevel(req.params.fingerprint, level);

    res.json({
      success: true,
      fingerprint: req.params.fingerprint,
      trustLevel: level
    });
  } catch (error) {
    logger.error('P2P set trust API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ping a peer
router.post('/api/peers/:fingerprint/ping', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const result = await p2p.pingPeer(req.params.fingerprint);

    res.json({
      success: result.sent,
      latency: result.latency,
      timeout: result.timeout || false
    });
  } catch (error) {
    logger.error('P2P ping API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Plugin Sharing ====================

// Request plugin list from a peer
router.post('/api/peers/:fingerprint/plugins', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    // Request and wait for the plugin list response
    const pluginSharing = p2p.pluginSharing;
    if (pluginSharing?.requestAndWaitForPluginList) {
      const plugins = await pluginSharing.requestAndWaitForPluginList(
        req.params.fingerprint,
        p2p.sendMessage.bind(p2p),
        10000
      );
      return res.json({
        success: true,
        plugins: plugins || [],
        count: plugins?.length || 0,
        message: plugins ? `Received ${plugins.length} plugins` : 'No response (peer may be offline)'
      });
    }

    // Fallback: just send the request
    const sent = await p2p.requestPluginList(req.params.fingerprint);
    res.json({ success: sent, message: sent ? 'Plugin list requested' : 'Failed to send request' });
  } catch (error) {
    logger.error('P2P plugin list request API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Request a specific plugin from a peer
router.post('/api/peers/:fingerprint/plugins/:pluginName/request', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const sent = await p2p.requestPlugin(req.params.fingerprint, req.params.pluginName);

    res.json({ success: sent, message: sent ? 'Plugin requested' : 'Failed to send request' });
  } catch (error) {
    logger.error('P2P plugin request API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Transfer Management ====================

// Get transfer history
router.get('/api/transfers', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const limit = parseInt(req.query.limit) || 50;
    const transfers = await p2p.getTransferHistory(limit);

    res.json({
      success: true,
      transfers: transfers.map(t => ({
        id: t._id,
        peerFingerprint: t.peerFingerprint,
        pluginName: t.pluginName,
        pluginVersion: t.pluginVersion,
        direction: t.direction,
        status: t.status,
        totalSize: t.totalSize,
        signatureVerified: t.signatureVerified,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        error: t.error
      }))
    });
  } catch (error) {
    logger.error('P2P transfers API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get pending approvals
router.get('/api/transfers/pending', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const pending = await p2p.getPendingApprovals();

    res.json({
      success: true,
      pending: pending.map(t => ({
        id: t._id,
        peerFingerprint: t.peerFingerprint,
        pluginName: t.pluginName,
        pluginVersion: t.pluginVersion,
        totalSize: t.totalSize,
        sha256: t.sha256,
        signatureVerified: t.signatureVerified,
        manifest: t.manifest,
        createdAt: t.createdAt
      }))
    });
  } catch (error) {
    logger.error('P2P pending approvals API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Approve a plugin transfer
router.post('/api/transfers/:transferId/approve', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const success = await p2p.approvePluginInstall(req.params.transferId);

    res.json({
      success,
      message: success ? 'Plugin approved and installed' : 'Failed to approve plugin'
    });
  } catch (error) {
    logger.error('P2P approve transfer API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reject a plugin transfer
router.post('/api/transfers/:transferId/reject', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const success = await p2p.rejectPluginInstall(req.params.transferId);

    res.json({
      success,
      message: success ? 'Plugin rejected' : 'Failed to reject plugin'
    });
  } catch (error) {
    logger.error('P2P reject transfer API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Knowledge Packs ====================

// List knowledge packs (filter by direction/status via query params)
router.get('/api/knowledge-packs', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const limit = parseInt(req.query.limit) || 50;
    const packs = await p2p.getKnowledgePackHistory(limit);

    res.json({
      success: true,
      packs: packs.map(p => ({
        id: p._id,
        packId: p.packId,
        title: p.title,
        version: p.version,
        summary: p.summary,
        topic: p.topic,
        tags: p.tags,
        authorFingerprint: p.authorFingerprint,
        authorName: p.authorName,
        direction: p.direction,
        status: p.status,
        manifest: p.manifest,
        totalSize: p.totalSize,
        sha256: p.sha256,
        signatureVerified: p.signatureVerified,
        peerFingerprint: p.peerFingerprint,
        importResults: p.importResults,
        aiEvaluation: p.aiEvaluation,
        createdAt: p.createdAt,
        completedAt: p.completedAt,
        error: p.error
      }))
    });
  } catch (error) {
    logger.error('P2P knowledge packs list API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get pending knowledge pack approvals
router.get('/api/knowledge-packs/pending', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const pending = await p2p.getPendingKnowledgePacks();

    res.json({
      success: true,
      pending: pending.map(p => ({
        id: p._id,
        packId: p.packId,
        title: p.title,
        version: p.version,
        summary: p.summary,
        topic: p.topic,
        tags: p.tags,
        authorFingerprint: p.authorFingerprint,
        authorName: p.authorName,
        manifest: p.manifest,
        totalSize: p.totalSize,
        sha256: p.sha256,
        signatureVerified: p.signatureVerified,
        peerFingerprint: p.peerFingerprint,
        aiEvaluation: p.aiEvaluation,
        status: p.status,
        createdAt: p.createdAt
      }))
    });
  } catch (error) {
    logger.error('P2P knowledge packs pending API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single knowledge pack details
router.get('/api/knowledge-packs/:id', authenticateToken, async (req, res) => {
  try {
    const { KnowledgePack } = await import('../../models/KnowledgePack.js');
    const pack = await KnowledgePack.findById(req.params.id);
    if (!pack) return res.status(404).json({ success: false, error: 'Pack not found' });

    res.json({ success: true, pack });
  } catch (error) {
    logger.error('P2P knowledge pack detail API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create knowledge pack from memories
router.post('/api/knowledge-packs', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const { title, summary, topic, tags, version, query } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Title is required' });

    const pack = await p2p.createKnowledgePack({ title, summary, topic, tags, version, query });

    res.json({
      success: true,
      pack: {
        id: pack._id,
        packId: pack.packId,
        title: pack.title,
        version: pack.version,
        topic: pack.topic,
        memoryCount: pack.manifest?.memoryCount || pack.memories?.length || 0,
        totalSize: pack.totalSize
      }
    });
  } catch (error) {
    logger.error('P2P create knowledge pack API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Approve knowledge pack
router.post('/api/knowledge-packs/:id/approve', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const success = await p2p.approveKnowledgePack(req.params.id);

    res.json({
      success,
      message: success ? 'Knowledge pack approved and imported' : 'Failed to approve knowledge pack'
    });
  } catch (error) {
    logger.error('P2P approve knowledge pack API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reject knowledge pack
router.post('/api/knowledge-packs/:id/reject', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const success = await p2p.rejectKnowledgePack(req.params.id);

    res.json({
      success,
      message: success ? 'Knowledge pack rejected' : 'Failed to reject knowledge pack'
    });
  } catch (error) {
    logger.error('P2P reject knowledge pack API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete local knowledge pack
router.delete('/api/knowledge-packs/:id', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const success = await p2p.deleteKnowledgePack(req.params.id);

    res.json({
      success,
      message: success ? 'Knowledge pack deleted' : 'Cannot delete this pack'
    });
  } catch (error) {
    logger.error('P2P delete knowledge pack API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Request knowledge pack list from a peer
router.get('/api/peers/:fingerprint/knowledge-packs', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const sent = await p2p.requestKnowledgePackList(req.params.fingerprint);

    // Return cached list if available
    const cached = p2p.getCachedPeerKnowledgePacks(req.params.fingerprint);

    res.json({
      success: sent,
      message: sent ? 'Knowledge pack list requested' : 'Failed to send request',
      packs: cached || []
    });
  } catch (error) {
    logger.error('P2P peer knowledge pack list API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Request full knowledge pack from a peer
router.post('/api/peers/:fingerprint/knowledge-packs/:packId/request', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not enabled' });

    const sent = await p2p.requestKnowledgePack(req.params.fingerprint, req.params.packId);

    res.json({
      success: sent,
      message: sent ? 'Knowledge pack requested' : 'Failed to send request'
    });
  } catch (error) {
    logger.error('P2P request knowledge pack API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Toggle ====================

// Enable or disable Skynet (P2P) dynamically
router.post('/api/toggle', authenticateToken, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }

    const agent = req.app.locals.agent;

    // Persist the setting
    await SystemSettings.setSetting('p2p_enabled', enabled, 'Enable/disable Skynet P2P federation', 'p2p');

    if (enabled) {
      // Start P2P service if not already running
      if (!agent.p2pService) {
        const { P2PService } = await import('../../services/p2p/p2pService.js');
        agent.p2pService = new P2PService(agent);
        await agent.p2pService.initialize();
        agent.services.set('p2pFederation', agent.p2pService);
        logger.info('Skynet enabled via web UI');
      }
    } else {
      // Stop P2P service if running
      if (agent.p2pService) {
        await agent.p2pService.shutdown();
        agent.services.delete('p2pFederation');
        agent.p2pService = null;
        logger.info('Skynet disabled via web UI');
      }
    }

    res.json({ success: true, enabled, message: `Skynet ${enabled ? 'enabled' : 'disabled'}` });
  } catch (error) {
    logger.error('P2P toggle API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Settings ====================

// Get P2P settings
router.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const saved = await PluginSettings.getCached(P2P_SETTINGS_PLUGIN, P2P_SETTINGS_KEY);

    const p2pEnabled = await SystemSettings.getSetting('p2p_enabled', process.env.P2P_ENABLED !== 'false');
    const settings = {
      enabled: !!p2pEnabled,
      registryUrl: process.env.P2P_REGISTRY_URL || 'wss://registry.lanagent.net',
      displayName: saved?.displayName || process.env.P2P_DISPLAY_NAME || '',
      autoShare: saved?.autoShare !== undefined ? saved.autoShare : true,
      autoInstallTrusted: saved?.autoInstallTrusted !== undefined ? saved.autoInstallTrusted : true,
      kpAutoImport: await SystemSettings.getSetting('knowledge_packs_auto_import', false),
      kpTopicWhitelist: await SystemSettings.getSetting('knowledge_packs_topic_whitelist', []),
    };

    // Identity info
    const p2p = getP2PService(req);
    const identity = p2p?.getIdentity();

    res.json({
      success: true,
      settings,
      identity: {
        fingerprint: identity?.fingerprint || null,
        createdAt: saved?.identityCreatedAt || null
      }
    });
  } catch (error) {
    logger.error('P2P get settings API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save P2P settings
router.post('/api/settings', authenticateToken, async (req, res) => {
  try {
    const { registryUrl, displayName, autoShare, autoInstallTrusted, kpAutoImport, kpTopicWhitelist } = req.body;

    // Load existing settings to preserve identity data
    const existing = await PluginSettings.getCached(P2P_SETTINGS_PLUGIN, P2P_SETTINGS_KEY) || {};

    // Save to PluginSettings (persists across restarts)
    const newSettings = {
      ...existing,
      displayName: typeof displayName === 'string' ? displayName.trim().slice(0, 32) : (existing.displayName || ''),
      autoShare: typeof autoShare === 'boolean' ? autoShare : (existing.autoShare !== undefined ? existing.autoShare : true),
      autoInstallTrusted: typeof autoInstallTrusted === 'boolean' ? autoInstallTrusted : (existing.autoInstallTrusted !== undefined ? existing.autoInstallTrusted : true),
    };

    await PluginSettings.setCached(P2P_SETTINGS_PLUGIN, P2P_SETTINGS_KEY, newSettings);

    // Save knowledge pack settings to SystemSettings
    if (typeof kpAutoImport === 'boolean') {
      await SystemSettings.setSetting('knowledge_packs_auto_import', kpAutoImport, 'Auto-import knowledge packs after AI evaluation', 'p2p');
    }
    if (Array.isArray(kpTopicWhitelist)) {
      await SystemSettings.setSetting('knowledge_packs_topic_whitelist', kpTopicWhitelist, 'Topic whitelist for auto-importing knowledge packs', 'p2p');
    }

    // Track if registry URL env change needs a restart
    let restartRequired = false;

    if (typeof registryUrl === 'string' && registryUrl.trim()) {
      const currentUrl = process.env.P2P_REGISTRY_URL || 'wss://registry.lanagent.net';
      if (registryUrl.trim() !== currentUrl) {
        restartRequired = true;
        try {
          const fs = await import('fs/promises');
          const envPath = process.cwd() + '/.env';
          let envContent = await fs.readFile(envPath, 'utf8');
          const url = registryUrl.trim();
          if (envContent.includes('P2P_REGISTRY_URL=')) {
            envContent = envContent.replace(/P2P_REGISTRY_URL=.*/g, `P2P_REGISTRY_URL=${url}`);
          } else {
            envContent += `\nP2P_REGISTRY_URL=${url}`;
          }
          await fs.writeFile(envPath, envContent, 'utf8');
          logger.info('P2P registry URL updated in .env file');
        } catch (envError) {
          logger.error('Failed to update .env file:', envError.message);
        }
      }
    }

    logger.info('P2P settings saved');
    res.json({
      success: true,
      restartRequired,
      message: restartRequired ? 'Settings saved. Restart required for registry URL change to take effect.' : 'Settings saved.'
    });
  } catch (error) {
    logger.error('P2P save settings API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Skynet Services ====================

// Get Skynet service stats and dashboard data
router.get('/api/skynet/stats', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    const stats = p2p ? await p2p.getSkynetServiceStats() : {
      totalRevenue: 0, totalRequests: 0, enabledServices: 0, totalServices: 0, recentPayments: []
    };
    res.json({ success: true, ...stats });
  } catch (error) {
    logger.error('Skynet stats API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all Skynet service configs (only from eligible + enabled plugins)
router.get('/api/skynet/services', authenticateToken, async (req, res) => {
  try {
    // Filter to only eligible categories
    const eligibleFilter = { category: { $in: Array.from(SKYNET_ELIGIBLE_CATEGORIES) } };

    // Further filter by enabled plugins if apiManager is available
    const agent = req.app.locals.agent;
    const apiManager = agent?.apiManager || agent?.services?.get('apiManager');
    if (apiManager?.apis) {
      const disabledPlugins = [];
      for (const [pluginName, pluginInfo] of apiManager.apis) {
        if (pluginInfo.enabled === false) disabledPlugins.push(pluginName);
      }
      if (disabledPlugins.length > 0) {
        eligibleFilter.category.$nin = disabledPlugins;
      }
    }

    const services = await SkynetServiceConfig.find(eligibleFilter).sort({ category: 1, name: 1 });
    res.json({ success: true, services });
  } catch (error) {
    logger.error('Skynet services list API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update a Skynet service config (enable/disable, price, rate limit)
router.put('/api/skynet/services/:serviceId', authenticateToken, async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { skynetEnabled, skynetPrice, rateLimit } = req.body;

    const update = {};
    if (skynetEnabled !== undefined) update.skynetEnabled = skynetEnabled;
    if (skynetPrice !== undefined) update.skynetPrice = Math.max(0, parseFloat(skynetPrice) || 0);
    if (rateLimit) update.rateLimit = rateLimit;

    const service = await SkynetServiceConfig.findOneAndUpdate(
      { serviceId },
      { $set: update },
      { new: true }
    );

    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    logger.info(`Skynet service ${serviceId} updated: enabled=${service.skynetEnabled}, price=${service.skynetPrice}`);
    res.json({ success: true, service });
  } catch (error) {
    logger.error('Skynet service update API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk enable/disable all services (global toggle)
router.post('/api/skynet/services/bulk', authenticateToken, async (req, res) => {
  try {
    const { skynetEnabled, skynetPrice } = req.body;

    const update = {};
    if (skynetEnabled !== undefined) update.skynetEnabled = skynetEnabled;
    if (skynetPrice !== undefined) update.skynetPrice = Math.max(0, parseFloat(skynetPrice) || 0);

    await SkynetServiceConfig.updateMany({}, { $set: update });

    const count = await SkynetServiceConfig.countDocuments({});
    logger.info(`Skynet bulk update: ${count} services, enabled=${skynetEnabled}`);
    res.json({ success: true, updated: count });
  } catch (error) {
    logger.error('Skynet bulk update API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current SKYNET token price from PancakeSwap V2 LP reserves
router.get('/api/skynet/token-price', authenticateToken, async (req, res) => {
  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org', undefined, { batchMaxCount: 1 });
    const LP_PAIR = '0xF3dEF3534EEC3195e0C217938F710E6F2838694A';
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const pair = new ethers.Contract(LP_PAIR, [
      'function getReserves() external view returns (uint112, uint112, uint32)',
      'function token0() external view returns (address)'
    ], provider);

    const [reserves, token0Addr] = await Promise.all([pair.getReserves(), pair.token0()]);
    const r0 = Number(ethers.formatEther(reserves[0]));
    const r1 = Number(ethers.formatEther(reserves[1]));

    // Identify which reserve is BNB by checking if token0 is WBNB
    const isBnbToken0 = token0Addr.toLowerCase() === WBNB.toLowerCase();
    const bnbReserve = isBnbToken0 ? r0 : r1;
    const skynetReserve = isBnbToken0 ? r1 : r0;

    // Get BNB/USD from CoinGecko
    const bnbRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
    const bnbData = await bnbRes.json();
    const bnbUsd = bnbData?.binancecoin?.usd || 630;

    let skynetUsd, skynetBnb;
    if (skynetReserve > 0 && bnbReserve > 0) {
      skynetBnb = bnbReserve / skynetReserve;
      skynetUsd = skynetBnb * bnbUsd;
    } else {
      // Fallback: initial LP was 50M SKYNET + 0.5 BNB
      skynetBnb = 0.5 / 50000000;
      skynetUsd = skynetBnb * bnbUsd;
    }

    res.json({
      success: true,
      price: skynetUsd,
      priceInBnb: skynetBnb,
      bnbPrice: bnbUsd,
      reserves: { skynet: skynetReserve, bnb: bnbReserve },
      token0: token0Addr
    });
  } catch (error) {
    // Fallback if LP query fails entirely
    logger.error('Skynet token price API error:', error);
    try {
      const bnbRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
      const bnbData = await bnbRes.json();
      const bnbUsd = bnbData?.binancecoin?.usd || 630;
      const skynetBnb = 0.5 / 50000000;
      res.json({ success: true, price: skynetBnb * bnbUsd, priceInBnb: skynetBnb, bnbPrice: bnbUsd, fallback: true });
    } catch {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// USD price tiers per service category (what each service call is worth)
const SERVICE_USD_TIERS = {
  chainlink: 0.01, lyrics: 0.005, whois: 0.005, numverify: 0.005, ipstack: 0.005,
  news: 0.01, weatherstack: 0.01, anime: 0.01, aviationstack: 0.01,
  mediastack: 0.01, nasa: 0.01, here: 0.01, music: 0.01,
  websearch: 0.02, scraper: 0.02,
  ffmpeg: 0.05, ytdlp: 0.03,
  huggingface: 0.10,
  aiDetector: 0.05,
  challengeQuestions: 0.02,
  tokenProfiler: 0.03,
  walletProfiler: 0.03,
  contractAudit: 0.05,
  imageTools: 0.02
};

// Auto-price toggle status
router.get('/api/skynet/services/auto-price-status', authenticateToken, async (req, res) => {
  try {
    const { SystemSettings: SS } = await import('../../models/SystemSettings.js');
    const enabled = await SS.getSetting('skynet.autoPriceEnabled', true);
    res.json({ success: true, enabled });
  } catch (error) {
    res.json({ success: true, enabled: true }); // default ON
  }
});

// Auto-price toggle
router.post('/api/skynet/services/auto-price-toggle', authenticateToken, async (req, res) => {
  try {
    const { enabled } = req.body;
    const { SystemSettings: SS } = await import('../../models/SystemSettings.js');
    await SS.setSetting('skynet.autoPriceEnabled', enabled === true);
    if (enabled) {
      // Trigger immediate price update
      autoUpdateMarketPrices().catch(() => {});
    }
    res.json({ success: true, enabled: enabled === true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Set market-rate prices for all services based on current SKYNET token price
router.post('/api/skynet/services/market-prices', authenticateToken, async (req, res) => {
  try {
    let { skynetUsdPrice } = req.body;

    // If no price provided, trigger auto-pricing (fetches on-chain)
    if (!skynetUsdPrice || skynetUsdPrice <= 0) {
      await autoUpdateMarketPrices();
      return res.json({ success: true, message: 'Auto-pricing triggered (on-chain price fetch)' });
    }

    let updated = 0;
    const services = await SkynetServiceConfig.find({
      category: { $in: Array.from(SKYNET_ELIGIBLE_CATEGORIES) }
    });

    for (const svc of services) {
      const usdTier = SERVICE_USD_TIERS[svc.category] || 0.01;
      const skynetPrice = Math.round((usdTier / skynetUsdPrice) * 1000) / 1000; // 3 decimal places
      svc.skynetPrice = skynetPrice;
      svc.skynetEnabled = true;
      await svc.save();
      updated++;
    }

    res.json({ success: true, updated, message: `${updated} services priced at market rate` });
  } catch (error) {
    logger.error('Skynet market pricing API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Auto-price services based on current SKYNET market value.
 * Runs every 15 minutes by default. Fetches SKYNET price from PancakeSwap LP reserves.
 * Also updates ExternalServiceConfig prices (for ERC-8004/API gateway).
 */
let autoPriceInterval = null;

async function autoUpdateMarketPrices() {
  try {
    // Get SKYNET price from LP reserves
    const { SystemSettings: SS } = await import('../../models/SystemSettings.js');
    const autoPriceEnabled = await SS.getSetting('skynet.autoPriceEnabled', true);
    if (!autoPriceEnabled) return;

    const { getSkynetUsdPrice } = await import('../../services/crypto/skynetPrice.js');
    const priceInfo = await getSkynetUsdPrice();
    if (!priceInfo) return;
    const { skynetUsd, bnbUsd } = priceInfo;

    const margin = await SS.getSetting('skynet.priceMargin', 1.2); // 20% margin

    // Update P2P service prices
    let p2pUpdated = 0;
    const services = await SkynetServiceConfig.find({
      category: { $in: Array.from(SKYNET_ELIGIBLE_CATEGORIES) }
    });
    for (const svc of services) {
      const usdTier = SERVICE_USD_TIERS[svc.category] || 0.01;
      const skynetPrice = Math.round((usdTier * margin / skynetUsd) * 1000) / 1000;
      if (svc.skynetPrice !== skynetPrice || !svc.skynetEnabled) {
        svc.skynetPrice = skynetPrice;
        svc.skynetEnabled = true;
        await svc.save();
        p2pUpdated++;
      }
    }

    // Update ExternalServiceConfig prices (for ERC-8004 external routes)
    try {
      const ExternalServiceConfig = (await import('../../models/ExternalServiceConfig.js')).default;
      const extServices = await ExternalServiceConfig.find({});
      const EXT_USD_COSTS = {
        'youtube-download': 0.01, 'youtube-audio': 0.008, 'media-transcode': 0.02,
        'image-generation': 0.03, 'web-scraping': 0.005, 'document-processing': 0.01,
        'code-sandbox': 0.02, 'pdf-toolkit': 0.005, 'challenge-questions': 0.02
      };
      for (const ext of extServices) {
        const usd = EXT_USD_COSTS[ext.serviceId] || 0.01;
        const bnbPrice = (usd * margin / bnbUsd).toFixed(8);
        if (ext.price !== bnbPrice) {
          ext.price = bnbPrice;
          await ext.save();
        }
      }
    } catch {}

    if (p2pUpdated > 0) {
      logger.debug(`Auto-priced ${p2pUpdated} services (SKYNET=$${skynetUsd.toFixed(8)}, margin=${margin}x)`);
    }
  } catch (err) {
    logger.debug('Auto-price update failed:', err.message);
  }
}

// Start auto-pricing (every 15 minutes)
function startAutoPricing() {
  if (autoPriceInterval) return;
  // Initial run after 30s (let plugins load)
  setTimeout(() => {
    autoUpdateMarketPrices().catch(() => {});
    autoPriceInterval = setInterval(() => autoUpdateMarketPrices().catch(() => {}), 15 * 60 * 1000);
  }, 30000);
  logger.info('Auto-pricing scheduler started (every 15 min)');
}

// Auto-start on module load
startAutoPricing();

// Core sync logic — registers eligible plugin services in the Skynet catalog.
// Can be called from the API route or programmatically on startup.
async function syncServicesFromPlugins(apiManager) {
  if (!apiManager || !apiManager.apis) {
    return { synced: 0, removed: 0, message: 'No API manager available' };
  }

  let synced = 0;
  for (const [pluginName, pluginInfo] of apiManager.apis) {
    if (!SKYNET_ELIGIBLE_CATEGORIES.has(pluginName)) continue;
    if (pluginInfo.enabled === false) continue;

    const instance = pluginInfo.instance || pluginInfo;
    const commands = instance.commands || [];
    for (const cmd of commands) {
      const actionName = cmd.command || cmd.name;
      if (!actionName) continue;

      if (!isServiceEligible(cmd)) continue;

      const serviceId = `${pluginName}:${actionName}`;
      const existing = await SkynetServiceConfig.findOne({ serviceId });
      if (!existing) {
        await SkynetServiceConfig.create({
          serviceId,
          pluginName,
          action: actionName,
          name: cmd.description || `${pluginName} - ${actionName}`,
          description: cmd.usage || cmd.description || '',
          category: pluginName,
          skynetEnabled: true,
          skynetPrice: 0
        });
        synced++;
      }
    }
  }

  // Remove services from non-eligible categories (security, admin, personal data)
  const disabledPlugins = [];
  for (const [pluginName, pluginInfo] of apiManager.apis) {
    if (pluginInfo.enabled === false) disabledPlugins.push(pluginName);
  }
  const removeFilter = {
    $or: [
      { category: { $nin: Array.from(SKYNET_ELIGIBLE_CATEGORIES) } },
      ...(disabledPlugins.length > 0 ? [{ category: { $in: disabledPlugins } }] : [])
    ]
  };
  const removed = await SkynetServiceConfig.deleteMany(removeFilter);

  // Also remove services that match the blocked action patterns
  const allServices = await SkynetServiceConfig.find({});
  let blockedRemoved = 0;
  for (const svc of allServices) {
    const action = svc.action || '';
    const desc = svc.name || '';
    const fakeCmd = { command: action, description: desc };
    if (!isServiceEligible(fakeCmd)) {
      await SkynetServiceConfig.deleteOne({ _id: svc._id });
      blockedRemoved++;
    }
  }

  const totalRemoved = (removed.deletedCount || 0) + blockedRemoved;
  const msg = totalRemoved > 0
    ? `${synced} new services discovered, ${totalRemoved} ineligible/blocked services removed`
    : `${synced} new services discovered`;
  return { synced, removed: totalRemoved, message: msg };
}

// Sync services from local plugins (discover available services)
// Only syncs services from SKYNET_ELIGIBLE_CATEGORIES (data/info/media/AI services).
// Removes any previously synced services from non-eligible categories (security, admin, personal data).
router.post('/api/skynet/services/sync', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const apiManager = agent?.apiManager || agent?.services?.get('apiManager');
    const result = await syncServicesFromPlugins(apiManager);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Skynet sync API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get recent Skynet payments
router.get('/api/skynet/payments', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const payments = await SkynetPayment.find({}).sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, payments });
  } catch (error) {
    logger.error('Skynet payments API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Request service catalog from a peer
router.post('/api/peers/:fingerprint/catalog', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    if (!p2p?.initialized) {
      return res.status(503).json({ success: false, error: 'P2P not initialized' });
    }
    await p2p.requestServiceCatalog(req.params.fingerprint);
    res.json({ success: true, message: 'Catalog request sent' });
  } catch (error) {
    logger.error('Skynet catalog request API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Bounties ====================

router.get('/api/skynet/bounties', authenticateToken, async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const p2p = getP2PService(req);
    const bounties = p2p ? await p2p.skynetEconomy.getBounties(filter)
      : await SkynetBounty.find({}).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, bounties });
  } catch (error) {
    logger.error('Skynet bounties API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/skynet/bounties', authenticateToken, async (req, res) => {
  try {
    const { title, description, category, reward, expiresInDays } = req.body;
    if (!title || !reward) {
      return res.status(400).json({ success: false, error: 'title and reward required' });
    }
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not initialized' });

    const bounty = await p2p.skynetEconomy.createBounty(title, description, category, reward, expiresInDays || 7);
    // Broadcast to peers
    await p2p.broadcastBounty(bounty);
    res.json({ success: true, bounty });
  } catch (error) {
    logger.error('Skynet create bounty API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Governance ====================

router.get('/api/skynet/proposals', authenticateToken, async (req, res) => {
  try {
    const filter = req.query.filter || 'active';
    const p2p = getP2PService(req);
    const proposals = p2p ? await p2p.skynetEconomy.getProposals(filter)
      : await SkynetGovernance.find({}).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, proposals });
  } catch (error) {
    logger.error('Skynet proposals API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/skynet/proposals', authenticateToken, async (req, res) => {
  try {
    const { title, description, category, votingDays } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, error: 'title required' });
    }
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not initialized' });

    const proposal = await p2p.skynetEconomy.createProposal(title, description, category, votingDays || 3);
    await p2p.broadcastProposal(proposal);
    res.json({ success: true, proposal });
  } catch (error) {
    logger.error('Skynet create proposal API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/skynet/proposals/:proposalId/vote', authenticateToken, async (req, res) => {
  try {
    const { vote } = req.body;
    if (!['for', 'against', 'abstain'].includes(vote)) {
      return res.status(400).json({ success: false, error: 'vote must be for, against, or abstain' });
    }
    const proposal = await SkynetGovernance.findOne({ proposalId: req.params.proposalId, status: 'active' });
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found or expired' });

    const added = proposal.castVote('local', vote, 1);
    if (!added) return res.json({ success: false, error: 'Already voted' });
    await proposal.save();
    res.json({ success: true, proposal });
  } catch (error) {
    logger.error('Skynet vote API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Data Marketplace ====================

router.get('/api/skynet/data-listings', authenticateToken, async (req, res) => {
  try {
    const filter = req.query.filter || 'active';
    const p2p = getP2PService(req);
    const listings = p2p ? await p2p.skynetEconomy.getDataListings(filter)
      : await DataListing.find({}).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, listings });
  } catch (error) {
    logger.error('Data listings API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/skynet/data-listings', authenticateToken, async (req, res) => {
  try {
    const { title, description, category, dataType, price, size, samplePreview, expiresInDays } = req.body;
    if (!title || price === undefined) {
      return res.status(400).json({ success: false, error: 'title and price required' });
    }
    const p2p = getP2PService(req);
    if (!p2p) return res.status(503).json({ success: false, error: 'P2P not initialized' });

    const listing = await p2p.skynetEconomy.createDataListing(title, description, category, dataType, price, size, samplePreview, expiresInDays || 30);
    await p2p.broadcastDataListing(listing);
    res.json({ success: true, listing });
  } catch (error) {
    logger.error('Create data listing API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Arbitrage Signals ====================

router.get('/api/skynet/arb-signals', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const p2p = getP2PService(req);
    const signals = p2p ? await p2p.skynetEconomy.getRecentArbSignals(limit)
      : await ArbSignal.find({ expired: false }).sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, signals });
  } catch (error) {
    logger.error('Arb signals API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Referral Stats ====================

router.get('/api/skynet/referrals', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    const stats = p2p ? await p2p.skynetEconomy.getReferralStats() : { totalRewards: 0, count: 0 };
    res.json({ success: true, ...stats });
  } catch (error) {
    logger.error('Referral stats API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Compute Rental ====================

router.get('/api/skynet/compute-jobs', authenticateToken, async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const p2p = getP2PService(req);
    const jobs = p2p ? await p2p.skynetEconomy.getComputeJobs(filter)
      : await ComputeJob.find({}).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, jobs });
  } catch (error) {
    logger.error('Compute jobs API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Email Leases ====================

// List all email leases (with optional status filter)
router.get('/api/email-leases', authenticateToken, async (req, res) => {
  try {
    const EmailLease = (await import('../../models/EmailLease.js')).default;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const leases = await EmailLease.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, leases });
  } catch (error) {
    logger.error('Email leases list API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get email lease stats
router.get('/api/email-leases/stats', authenticateToken, async (req, res) => {
  try {
    const EmailLease = (await import('../../models/EmailLease.js')).default;
    const stats = await EmailLease.getStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    logger.error('Email lease stats API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get email lease config/pricing
router.get('/api/email-leases/config', authenticateToken, async (req, res) => {
  try {
    const config = {
      leasePrice: await SystemSettings.getSetting('email.leasePrice', 100),
      renewalPrice: await SystemSettings.getSetting('email.renewalPrice', 80),
      leaseDurationDays: await SystemSettings.getSetting('email.leaseDurationDays', 365),
      defaultQuotaMB: await SystemSettings.getSetting('email.defaultQuotaMB', 500),
      maxLeasesPerPeer: await SystemSettings.getSetting('email.maxLeasesPerPeer', 3),
      enabled: process.env.EMAIL_LEASE_ENABLED === 'true',
      mailApiConfigured: !!process.env.MAIL_API_URL
    };
    res.json({ success: true, config });
  } catch (error) {
    logger.error('Email lease config API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update email lease config/pricing
router.put('/api/email-leases/config', authenticateToken, async (req, res) => {
  try {
    const { leasePrice, renewalPrice, leaseDurationDays, defaultQuotaMB, maxLeasesPerPeer } = req.body;

    if (leasePrice !== undefined)
      await SystemSettings.setSetting('email.leasePrice', parseFloat(leasePrice), 'Email lease price in SKYNET', 'email');
    if (renewalPrice !== undefined)
      await SystemSettings.setSetting('email.renewalPrice', parseFloat(renewalPrice), 'Email renewal price in SKYNET', 'email');
    if (leaseDurationDays !== undefined)
      await SystemSettings.setSetting('email.leaseDurationDays', parseInt(leaseDurationDays), 'Lease duration in days', 'email');
    if (defaultQuotaMB !== undefined)
      await SystemSettings.setSetting('email.defaultQuotaMB', parseInt(defaultQuotaMB), 'Default mailbox quota in MB', 'email');
    if (maxLeasesPerPeer !== undefined)
      await SystemSettings.setSetting('email.maxLeasesPerPeer', parseInt(maxLeasesPerPeer), 'Max leases per peer', 'email');

    logger.info('Email lease config updated');
    res.json({ success: true, message: 'Email lease config updated' });
  } catch (error) {
    logger.error('Email lease config update API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin revoke a lease
router.post('/api/email-leases/:leaseId/revoke', authenticateToken, async (req, res) => {
  try {
    const emailLeaseService = (await import('../../services/email/emailLeaseService.js')).default;
    if (!emailLeaseService.initialized) await emailLeaseService.initialize();

    const lease = await emailLeaseService.revokeLease(req.params.leaseId, req.body.reason || 'Admin revocation');

    // Notify peer via P2P
    const p2p = getP2PService(req);
    if (p2p?.initialized && lease.peerFingerprint) {
      await p2p.sendMessage(lease.peerFingerprint, {
        type: 'email_lease_revoke',
        leaseId: lease.leaseId,
        email: lease.email,
        reason: lease.revokeReason,
        revokedAt: lease.revokedAt.toISOString()
      });
    }

    res.json({ success: true, lease });
  } catch (error) {
    logger.error('Email lease revoke API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin reset password for a lease
router.post('/api/email-leases/:leaseId/reset-password', authenticateToken, async (req, res) => {
  try {
    const emailLeaseService = (await import('../../services/email/emailLeaseService.js')).default;
    if (!emailLeaseService.initialized) await emailLeaseService.initialize();

    // Get P2P send function for credential delivery
    const p2p = getP2PService(req);
    const sendFn = p2p?.initialized ? p2p.sendMessage.bind(p2p) : null;

    const result = await emailLeaseService.resetLeasePassword(req.params.leaseId, sendFn);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Email lease reset-password API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Economy Stats ====================

router.get('/api/skynet/economy', authenticateToken, async (req, res) => {
  try {
    const p2p = getP2PService(req);
    const stats = p2p ? await p2p.getSkynetEconomyStats() : {
      bounties: { open: 0, total: 0, totalRewards: 0 },
      governance: { active: 0, total: 0 }
    };
    res.json({ success: true, ...stats });
  } catch (error) {
    logger.error('Skynet economy API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export { syncServicesFromPlugins };
export default router;
