import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { cryptoManager } from './cryptoManager.js';
import { registryClient } from './registryClient.js';
import { peerManager } from './peerManager.js';
import { messageHandler } from './messageHandler.js';
import PluginSharing from './pluginSharing.js';
import KnowledgePackSharing from './knowledgePackSharing.js';
import SkynetServiceExecutor from './skynetServiceExecutor.js';
import SkynetEconomy from './skynetEconomy.js';

/**
 * P2PService - Main orchestrator for the LANAgent Network Protocol (LANP)
 *
 * Follows the existing service pattern (EventEmitter, constructor(agent), initialize/shutdown).
 * Federation is opt-in via P2P_ENABLED=true.
 */
class P2PService extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.pluginSharing = new PluginSharing(agent);
    this.knowledgePackSharing = new KnowledgePackSharing(agent);
    this.skynetServiceExecutor = new SkynetServiceExecutor(agent);
    this.skynetEconomy = new SkynetEconomy(agent);
    this.initialized = false;
    this.startTime = null;
  }

  /**
   * Initialize the P2P federation service
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      // Load or generate Ed25519 identity
      const identity = await cryptoManager.loadOrCreateIdentity();
      logger.info(`P2P Federation identity: ${identity.fingerprint}`);

      // Initialize peer manager
      await peerManager.initialize();

      // Wire up message handler with plugin sharing, knowledge pack sharing, and Skynet services
      messageHandler.setPluginSharing(this.pluginSharing);
      messageHandler.setKnowledgePackSharing(this.knowledgePackSharing);
      messageHandler.setSkynetServiceExecutor(this.skynetServiceExecutor);
      messageHandler.setSkynetEconomy(this.skynetEconomy);

      // Get our capabilities hash
      const capabilities = await this.pluginSharing.getLocalCapabilities();
      const capabilitiesHash = cryptoManager.hashCapabilities(capabilities);

      // Set up registry client event handlers
      this._setupRegistryEvents();

      // Get the version from package.json
      const version = this.agent?.config?.version || '2.11.0';

      // Connect to registry
      const registryUrl = process.env.P2P_REGISTRY_URL || 'wss://registry.lanagent.net';
      // Get agent ID and wallet for gateway auto-discovery
      let agentId = null;
      let walletAddress = null;
      try {
        const { Agent: AgentModel } = await import('../../models/Agent.js');
        const agentDoc = await AgentModel.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
        agentId = agentDoc?.erc8004?.agentId || null;
        const walletService = (await import('../crypto/walletService.js')).default;
        const walletInfo = await walletService.getWalletInfo();
        walletAddress = walletInfo?.addresses?.find(a => a.chain === 'bsc' || a.chain === 'eth')?.address || null;
      } catch { /* non-critical */ }

      const serviceUrl = process.env.AGENT_SERVICE_URL || (agentId ? `https://api.lanagent.net/agents/${agentId}` : null);

      await registryClient.connect({
        registryUrl,
        fingerprint: identity.fingerprint,
        version,
        capabilitiesHash,
        agentId,
        walletAddress,
        serviceUrl
      });

      this.initialized = true;
      this.startTime = Date.now();
      logger.info('P2P Federation service initialized successfully');

      // Re-broadcast capabilities after a delay (ENS/email services may not be ready during initial introductions)
      setTimeout(async () => {
        try {
          const peers = await peerManager.getAllPeers();
          const onlinePeers = peers.filter(p => p.isOnline);
          if (onlinePeers.length > 0) {
            logger.info(`P2P re-broadcasting capabilities to ${onlinePeers.length} online peer(s)`);
            for (const peer of onlinePeers) {
              try {
                await this.sendMessage(peer.fingerprint, { type: 'capabilities_request' });
              } catch {}
            }
          }
        } catch (err) {
          logger.debug('P2P capability re-broadcast failed:', err.message);
        }
      }, 60000); // 60s delay — enough for ENS/email services to initialize

      // Start welcome package auto-request flow (fork side)
      try {
        const { welcomePackage } = await import('./welcomePackage.js');
        await welcomePackage.startAutoRequest(this);
      } catch (err) {
        logger.debug('Welcome package auto-request setup skipped:', err.message);
      }

      return true;
    } catch (error) {
      logger.error('Failed to initialize P2P Federation:', error);
      return false;
    }
  }

  /**
   * Set up event handlers for registry client events
   */
  _setupRegistryEvents() {
    registryClient.on('connected', () => {
      logger.info('P2P connected to registry');
      this.emit('connected');
    });

    registryClient.on('disconnected', () => {
      logger.info('P2P disconnected from registry');
      this.emit('disconnected');
    });

    registryClient.on('peer_online', async ({ fingerprint, capabilities_hash }) => {
      await peerManager.markOnline(fingerprint, capabilities_hash);
      this.emit('peer_online', { fingerprint });

      const peer = await peerManager.getPeer(fingerprint);
      if (peer) {
        // Known peer — try encrypted capabilities exchange
        const sent = await this.sendMessage(fingerprint, { type: 'capabilities_request' });
        if (!sent) {
          // Encrypted send failed — peer likely restarted with new keys
          // Re-introduce via cleartext to exchange new keys
          logger.info(`P2P encrypted send failed to ${fingerprint.slice(0, 8)}... — re-introducing`);
          this._sendIntroduction(fingerprint);
        }
      } else {
        // Unknown peer — send cleartext introduction with our public keys
        logger.info(`P2P auto-introducing to new peer: ${fingerprint.slice(0, 8)}...`);
        this._sendIntroduction(fingerprint);
      }
    });

    registryClient.on('peer_offline', async ({ fingerprint }) => {
      await peerManager.markOffline(fingerprint);
      this.emit('peer_offline', { fingerprint });
    });

    registryClient.on('message', async ({ from, payload }) => {
      // Check for cleartext introduction messages (not encrypted)
      const handled = await this._handleIntroduction(from, payload);
      if (!handled) {
        await messageHandler.handleMessage(from, payload, this.sendMessage.bind(this));
      }
    });

    registryClient.on('error', (error) => {
      logger.error('P2P registry error:', error.message);
      this.emit('error', error);
    });
  }

  /**
   * Send an encrypted, signed message to a peer
   * @param {string} targetFingerprint - Peer's fingerprint
   * @param {object} message - Message to send (will be encrypted)
   * @returns {Promise<boolean>}
   */
  async sendMessage(targetFingerprint, message) {
    try {
      const peer = await peerManager.getPeer(targetFingerprint);
      if (!peer) {
        logger.warn(`P2P cannot send to unknown peer: ${targetFingerprint.slice(0, 8)}...`);
        return false;
      }

      // Add sequence number and sign
      const seq = cryptoManager.getNextSeq(targetFingerprint);
      const messageWithSeq = { ...message, seq, ts: Date.now() };
      messageWithSeq.sig = cryptoManager.sign(messageWithSeq);

      // Encrypt using peer's DH key
      const plaintext = JSON.stringify(messageWithSeq);
      const envelope = cryptoManager.encrypt(plaintext, peer.dhPublicKey, targetFingerprint);

      // Relay through registry
      return registryClient.relay(targetFingerprint, JSON.stringify(envelope));
    } catch (error) {
      logger.error(`P2P failed to send message to ${targetFingerprint.slice(0, 8)}...:`, error.message);
      return false;
    }
  }

  // ==================== Auto-Introduction Protocol ====================

  /**
   * Send a cleartext introduction to a new peer via the registry relay.
   * Contains our public keys so the peer can create a record and start encrypted comms.
   */
  _sendIntroduction(targetFingerprint) {
    const identity = cryptoManager.identity;
    if (!identity) return false;

    const intro = JSON.stringify({
      type: 'introduce',
      fingerprint: identity.fingerprint,
      signPublicKey: identity.signPublicKey.toString('base64'),
      dhPublicKey: identity.dhPublicKey.toString('base64'),
      displayName: process.env.P2P_DISPLAY_NAME || process.env.AGENT_NAME || 'LANAgent'
    });

    return registryClient.relay(targetFingerprint, intro);
  }

  /**
   * Handle an incoming introduction message (cleartext, not encrypted).
   * Creates the peer record and sends our own introduction back if needed.
   * @returns {boolean} true if the payload was an introduction and was handled
   */
  async _handleIntroduction(fromFingerprint, payload) {
    try {
      let msg;
      try {
        msg = typeof payload === 'string' ? JSON.parse(payload) : payload;
      } catch {
        return false; // Not valid JSON — probably an encrypted envelope, let messageHandler try
      }

      if (msg?.type !== 'introduce') return false;

      const { signPublicKey, dhPublicKey, displayName } = msg;
      if (!signPublicKey || !dhPublicKey) {
        logger.warn(`P2P invalid introduction from ${fromFingerprint.slice(0, 8)}...`);
        return true;
      }

      logger.info(`P2P received introduction from ${displayName || fromFingerprint.slice(0, 8)}...`);

      // Create or verify the peer record (TOFU)
      const signPubBuf = Buffer.from(signPublicKey, 'base64');
      const dhPubBuf = Buffer.from(dhPublicKey, 'base64');

      try {
        const peer = await peerManager.getOrCreatePeer(fromFingerprint, signPubBuf, dhPubBuf);
        peer.isOnline = true;
        peer.lastSeen = new Date();
        if (displayName) peer.displayName = displayName;
        await peer.save();

        // Send our introduction back if this is a new peer OR if their keys changed
        // (so the other side can update our DH key for encrypted comms)
        const isNew = !peer.firstSeen || (Date.now() - peer.firstSeen.getTime()) < 10000;
        const keysChanged = peer._keysUpdated; // Set by peerManager.getOrCreatePeer when keys rotate
        if (isNew || keysChanged) {
          this._sendIntroduction(fromFingerprint);
        }

        // Now that keys are exchanged, request capabilities
        await this.sendMessage(fromFingerprint, { type: 'capabilities_request' });

        logger.info(`P2P peer ${displayName || fromFingerprint.slice(0, 8)}... introduced successfully`);
      } catch (err) {
        logger.error(`P2P introduction failed for ${fromFingerprint.slice(0, 8)}...: ${err.message}`);
      }

      return true;
    } catch (error) {
      logger.debug(`P2P introduction parse error: ${error.message}`);
      return false;
    }
  }

  // ==================== Public API ====================

  /**
   * Get our identity info
   * @returns {{ fingerprint: string, publicKey: string }}
   */
  getIdentity() {
    if (!cryptoManager.identity) return null;
    return cryptoManager.getPublicKeys();
  }

  /**
   * Get list of online peers
   * @returns {Promise<Array>}
   */
  async getOnlinePeers() {
    return peerManager.getOnlinePeers();
  }

  /**
   * Get all known peers
   * @returns {Promise<Array>}
   */
  async getAllPeers() {
    return peerManager.getAllPeers();
  }

  /**
   * Get capabilities of a specific peer
   * @param {string} fingerprint
   * @returns {Promise<Array>}
   */
  async getPeerCapabilities(fingerprint) {
    const peer = await peerManager.getPeer(fingerprint);
    return peer?.capabilities || [];
  }

  /**
   * Request plugin list from a peer
   * @param {string} fingerprint
   * @returns {Promise<boolean>}
   */
  async requestPluginList(fingerprint) {
    return this.sendMessage(fingerprint, { type: 'plugin_list_request' });
  }

  /**
   * Request a specific plugin from a peer
   * @param {string} fingerprint
   * @param {string} pluginName
   * @returns {Promise<boolean>}
   */
  async requestPlugin(fingerprint, pluginName) {
    return this.sendMessage(fingerprint, {
      type: 'plugin_request',
      name: pluginName
    });
  }

  /**
   * Approve a pending plugin installation
   * @param {string} transferId
   * @returns {Promise<boolean>}
   */
  async approvePluginInstall(transferId) {
    return this.pluginSharing.approveInstall(transferId);
  }

  /**
   * Reject a pending plugin installation
   * @param {string} transferId
   * @returns {Promise<boolean>}
   */
  async rejectPluginInstall(transferId) {
    return this.pluginSharing.rejectInstall(transferId);
  }

  /**
   * Set trust level for a peer
   * @param {string} fingerprint
   * @param {'untrusted'|'trusted'} level
   */
  async setTrustLevel(fingerprint, level) {
    return peerManager.setTrustLevel(fingerprint, level);
  }

  /**
   * Get transfer history
   * @returns {Promise<Array>}
   */
  async getTransferHistory(limit = 50) {
    return this.pluginSharing.getTransferHistory(limit);
  }

  /**
   * Get pending plugin approvals
   * @returns {Promise<Array>}
   */
  async getPendingApprovals() {
    return this.pluginSharing.getPendingApprovals();
  }

  /**
   * Get connection status
   * @returns {object}
   */
  getConnectionStatus() {
    const regStatus = registryClient.getStatus();
    return {
      initialized: this.initialized,
      connected: regStatus.state === 'connected',
      registryState: regStatus.state,
      peersOnline: peerManager.onlinePeers.size,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      stats: {
        messagesSent: regStatus.messagesSent,
        messagesReceived: regStatus.messagesReceived,
        reconnectCount: regStatus.reconnectCount
      }
    };
  }

  /**
   * Ping a peer and wait for pong response to measure latency.
   * @param {string} fingerprint
   * @returns {Promise<{sent: boolean, latency?: number}>}
   */
  async pingPeer(fingerprint) {
    const ts = Date.now();
    const sent = await this.sendMessage(fingerprint, { type: 'ping', ts });
    if (!sent) return { sent: false };

    // Wait for pong with 10s timeout
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        delete this._pendingPings?.[fingerprint];
        resolve({ sent: true, latency: null, timeout: true });
      }, 10000);

      if (!this._pendingPings) this._pendingPings = {};
      this._pendingPings[fingerprint] = (pongTs) => {
        clearTimeout(timeout);
        delete this._pendingPings[fingerprint];
        const latency = Date.now() - (pongTs || ts);
        resolve({ sent: true, latency });
      };
    });
  }

  /**
   * Called by message handler when a pong is received.
   * @param {string} fingerprint
   * @param {number} originalTs
   */
  handlePongReceived(fingerprint, originalTs) {
    this._pendingPings?.[fingerprint]?.(originalTs);
  }

  // ==================== Knowledge Pack API ====================

  async requestKnowledgePackList(fingerprint) {
    return this.sendMessage(fingerprint, { type: 'knowledge_pack_list_request' });
  }

  async requestKnowledgePack(fingerprint, packId) {
    return this.sendMessage(fingerprint, { type: 'knowledge_pack_request', packId });
  }

  async approveKnowledgePack(docId) {
    return this.knowledgePackSharing.approvePack(docId);
  }

  async rejectKnowledgePack(docId) {
    return this.knowledgePackSharing.rejectPack(docId);
  }

  async createKnowledgePack(options) {
    return this.knowledgePackSharing.createPackFromMemories(options);
  }

  async deleteKnowledgePack(docId) {
    return this.knowledgePackSharing.deletePack(docId);
  }

  async getKnowledgePackHistory(limit = 50) {
    return this.knowledgePackSharing.getHistory(limit);
  }

  async getPendingKnowledgePacks() {
    return this.knowledgePackSharing.getPendingApprovals();
  }

  async getPublishedKnowledgePacks() {
    return this.knowledgePackSharing.getPublishedPacks();
  }

  async getImportedKnowledgePacks() {
    return this.knowledgePackSharing.getImportedPacks();
  }

  getCachedPeerKnowledgePacks(fingerprint) {
    return this.knowledgePackSharing.getCachedPackList(fingerprint);
  }

  // ==================== Skynet Services API ====================

  /**
   * Request service catalog from a peer
   */
  async requestServiceCatalog(fingerprint) {
    return this.sendMessage(fingerprint, { type: 'service_catalog_request' });
  }

  /**
   * Request a paid service from a peer
   */
  async requestService(fingerprint, serviceId, params, paymentTxHash) {
    return this.sendMessage(fingerprint, {
      type: 'service_request',
      serviceId,
      params: params || {},
      paymentTxHash: paymentTxHash || null
    });
  }

  /**
   * Get Skynet service stats (revenue, requests, etc.)
   */
  async getSkynetServiceStats() {
    return this.skynetServiceExecutor.getStats();
  }

  // ==================== ENS Subname API ====================

  /**
   * Request an ENS subname from a genesis peer.
   * @param {string} fingerprint - Genesis peer's fingerprint
   * @param {string} label - Desired subname label
   * @param {string} ownerAddress - Wallet address for the subname
   * @param {string} [paymentTxHash] - Optional SKYNET payment tx hash
   */
  async requestENSSubname(fingerprint, label, ownerAddress, paymentTxHash) {
    return this.sendMessage(fingerprint, {
      type: 'ens_subname_request',
      label: label.toLowerCase(),
      ownerAddress,
      paymentTxHash: paymentTxHash || null
    });
  }

  // ==================== Email Lease API ====================

  /**
   * Request an email lease from a genesis peer.
   * @param {string} fingerprint - Genesis peer's fingerprint
   * @param {string} username - Desired username (without @domain)
   * @param {string} [wallet] - BSC wallet address
   * @param {string} [txHash] - Optional SKYNET payment tx hash
   */
  async requestEmailLease(fingerprint, username, wallet, txHash) {
    return this.sendMessage(fingerprint, {
      type: 'email_lease_request',
      desiredUsername: username.toLowerCase(),
      ownerWallet: wallet || null,
      paymentTxHash: txHash || null
    });
  }

  /**
   * Request renewal of an existing email lease.
   * @param {string} fingerprint - Genesis peer's fingerprint
   * @param {string} leaseId - Existing lease ID
   * @param {string} [txHash] - Optional SKYNET payment tx hash
   */
  async requestEmailLeaseRenewal(fingerprint, leaseId, txHash) {
    return this.sendMessage(fingerprint, {
      type: 'email_lease_renew',
      leaseId,
      paymentTxHash: txHash || null
    });
  }

  // ==================== Skynet Economy API ====================

  /**
   * Broadcast a bounty to all online peers
   */
  async broadcastBounty(bounty) {
    const peers = await this.getOnlinePeers();
    for (const peer of peers) {
      await this.sendMessage(peer.fingerprint, {
        type: 'bounty_post',
        bountyId: bounty.bountyId,
        title: bounty.title,
        description: bounty.description,
        category: bounty.category,
        reward: bounty.reward,
        expiresAt: bounty.expiresAt
      });
    }
  }

  /**
   * Broadcast a governance proposal to all online peers
   */
  async broadcastProposal(proposal) {
    const peers = await this.getOnlinePeers();
    for (const peer of peers) {
      await this.sendMessage(peer.fingerprint, {
        type: 'governance_proposal',
        proposalId: proposal.proposalId,
        title: proposal.title,
        description: proposal.description,
        category: proposal.category,
        votingEndsAt: proposal.votingEndsAt
      });
    }
  }

  /**
   * Send a tip notification to a peer
   */
  async sendTip(fingerprint, txHash, amount, note) {
    return this.sendMessage(fingerprint, {
      type: 'tip_received',
      txHash, amount, note
    });
  }

  /**
   * Broadcast a data listing to all online peers
   */
  async broadcastDataListing(listing) {
    const peers = await this.getOnlinePeers();
    for (const peer of peers) {
      await this.sendMessage(peer.fingerprint, {
        type: 'data_listing_post',
        listingId: listing.listingId,
        title: listing.title,
        description: listing.description,
        category: listing.category,
        dataType: listing.dataType,
        price: listing.price,
        size: listing.size,
        samplePreview: listing.samplePreview,
        expiresAt: listing.expiresAt
      });
    }
  }

  /**
   * Request to purchase data from a peer
   */
  async requestDataPurchase(fingerprint, listingId, paymentTxHash) {
    return this.sendMessage(fingerprint, {
      type: 'data_purchase_request',
      listingId,
      paymentTxHash: paymentTxHash || null
    });
  }

  /**
   * Broadcast an arbitrage signal to all online peers
   */
  async broadcastArbSignal(signal) {
    const peers = await this.getOnlinePeers();
    for (const peer of peers) {
      await this.sendMessage(peer.fingerprint, {
        type: 'arb_signal',
        token: signal.token,
        symbol: signal.symbol,
        network: signal.network,
        spread: signal.spread,
        buyProtocol: signal.buyProtocol,
        sellProtocol: signal.sellProtocol,
        netProfit: signal.netProfit,
        gasCostUsd: signal.gasCostUsd
      });
    }
  }

  /**
   * Get economy stats
   */
  async getSkynetEconomyStats() {
    return this.skynetEconomy.getEconomyStats();
  }

  /**
   * Shutdown the P2P service
   */
  async shutdown() {
    logger.info('P2P Federation service shutting down...');
    this.initialized = false;

    await registryClient.disconnect();
    peerManager.shutdown();
    this.pluginSharing.shutdown();
    this.knowledgePackSharing.shutdown();
    cryptoManager.shutdown();

    try {
      const { welcomePackage } = await import('./welcomePackage.js');
      welcomePackage.shutdown();
    } catch {}


    logger.info('P2P Federation service stopped');
  }
}

export { P2PService };
export default P2PService;
