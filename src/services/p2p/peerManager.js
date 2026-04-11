import { logger } from '../../utils/logger.js';
import { P2PPeer } from '../../models/P2PPeer.js';

/**
 * PeerManager handles tracking known peers, their trust levels, and online status
 */
class PeerManager {
  constructor() {
    this.onlinePeers = new Set(); // fingerprints currently online
    this.peerGroups = new Map(); // peer groups by trustLevel:capabilitiesHash
    this.peerGroupIndex = new Map(); // fingerprint -> current group key (for cleanup)
  }

  /**
   * Initialize - reset all peers to offline on startup
   */
  async initialize() {
    try {
      await P2PPeer.resetOnlineStatus();
      this.onlinePeers.clear();
      this.peerGroups.clear();
      this.peerGroupIndex.clear();
      logger.info('P2P PeerManager initialized, all peers marked offline');
    } catch (error) {
      logger.error('Failed to initialize PeerManager:', error);
    }
  }

  /**
   * Get or create a peer record
   * @param {string} fingerprint
   * @param {string} publicKey - Base64 encoded DER public key
   * @returns {Promise<P2PPeer>}
   */
  async getOrCreatePeer(fingerprint, signPublicKey, dhPublicKey) {
    let peer = await P2PPeer.findByFingerprint(fingerprint);

    // Normalize keys to base64 strings for comparison (may arrive as Buffer or string)
    const signKeyStr = Buffer.isBuffer(signPublicKey) ? signPublicKey.toString('base64') : signPublicKey;
    const dhKeyStr = Buffer.isBuffer(dhPublicKey) ? dhPublicKey.toString('base64') : dhPublicKey;

    if (peer) {
      // TOFU: Check if signing public key changed (peer restarted with new identity)
      if (peer.signPublicKey !== signKeyStr) {
        logger.warn(`P2P signing key changed for ${fingerprint.slice(0, 8)}... — peer likely restarted. Re-keying.`);
        peer.signPublicKey = signKeyStr;
        peer.dhPublicKey = dhKeyStr;
        peer._keysUpdated = true; // Signal to caller that keys changed
        try {
          const { cryptoManager } = await import('./cryptoManager.js');
          cryptoManager.invalidateSessionKey(fingerprint);
        } catch {}
        await peer.save();
        return peer;
      }
      // Update DH key if changed (key rotation is allowed)
      if (peer.dhPublicKey !== dhKeyStr) {
        logger.info(`P2P DH key rotated for ${fingerprint.slice(0, 8)}... — updating and clearing session cache`);
        peer.dhPublicKey = dhKeyStr;
        peer._keysUpdated = true;
        try {
          const { cryptoManager } = await import('./cryptoManager.js');
          cryptoManager.invalidateSessionKey(fingerprint);
        } catch {}
        await peer.save();
      }
      return peer;
    }

    // New peer - Trust On First Use
    peer = await P2PPeer.create({
      fingerprint,
      signPublicKey: signKeyStr,
      dhPublicKey: dhKeyStr,
      firstSeen: new Date(),
      lastSeen: new Date()
    });

    logger.info(`P2P new peer discovered: ${fingerprint.slice(0, 8)}...`);
    return peer;
  }

  /**
   * Set trust level for a peer
   * @param {string} fingerprint
   * @param {'untrusted'|'trusted'} level
   */
  async setTrustLevel(fingerprint, level) {
    if (!['untrusted', 'trusted'].includes(level)) {
      throw new Error(`Invalid trust level: ${level}`);
    }

    const peer = await P2PPeer.findByFingerprint(fingerprint);
    if (!peer) throw new Error(`Unknown peer: ${fingerprint}`);

    peer.trustLevel = level;
    await peer.save();

    this.updatePeerGroup(peer);

    logger.info(`P2P peer ${fingerprint.slice(0, 8)}... trust level set to: ${level}`);
    return peer;
  }

  /**
   * Get a peer by fingerprint
   * @param {string} fingerprint
   * @returns {Promise<P2PPeer|null>}
   */
  async getPeer(fingerprint) {
    return P2PPeer.findByFingerprint(fingerprint);
  }

  /**
   * Mark a peer as online
   * @param {string} fingerprint
   * @param {string} capabilitiesHash
   */
  async markOnline(fingerprint, capabilitiesHash) {
    this.onlinePeers.add(fingerprint);

    const peer = await P2PPeer.findByFingerprint(fingerprint);
    if (peer) {
      peer.isOnline = true;
      peer.lastSeen = new Date();
      if (capabilitiesHash) peer.capabilitiesHash = capabilitiesHash;
      await peer.save();
      this.updatePeerGroup(peer);
    }
  }

  /**
   * Mark a peer as offline
   * @param {string} fingerprint
   */
  async markOffline(fingerprint) {
    this.onlinePeers.delete(fingerprint);

    const peer = await P2PPeer.findByFingerprint(fingerprint);
    if (peer) {
      peer.isOnline = false;
      await peer.save();
    }
  }

  /**
   * Update last seen timestamp
   * @param {string} fingerprint
   */
  async updateLastSeen(fingerprint) {
    const peer = await P2PPeer.findByFingerprint(fingerprint);
    if (peer) {
      await peer.touch();
    }
  }

  /**
   * Update capabilities for a peer
   * @param {string} fingerprint
   * @param {Array<{name: string, version: string, description: string}>} capabilities
   */
  async updateCapabilities(fingerprint, capabilities) {
    const peer = await P2PPeer.findByFingerprint(fingerprint);
    if (!peer) return;

    peer.capabilities = capabilities;
    await peer.save();

    this.updatePeerGroup(peer);

    logger.debug(`P2P peer ${fingerprint.slice(0, 8)}... capabilities updated (${capabilities.length} items)`);
  }

  /**
   * Increment transfer count for a peer
   * @param {string} fingerprint
   */
  async incrementTransferCount(fingerprint) {
    await P2PPeer.findOneAndUpdate(
      { fingerprint },
      { $inc: { transferCount: 1 } }
    );
  }

  /**
   * Get all online peers
   * @returns {Promise<P2PPeer[]>}
   */
  async getOnlinePeers() {
    return P2PPeer.getOnlinePeers();
  }

  /**
   * Get all known peers
   * @returns {Promise<P2PPeer[]>}
   */
  async getAllPeers() {
    return P2PPeer.find().sort({ lastSeen: -1 });
  }

  /**
   * Get trusted peers
   * @returns {Promise<P2PPeer[]>}
   */
  async getTrustedPeers() {
    return P2PPeer.getTrustedPeers();
  }

  /**
   * Check if a peer is online
   * @param {string} fingerprint
   * @returns {boolean}
   */
  isOnline(fingerprint) {
    return this.onlinePeers.has(fingerprint);
  }

  /**
   * Get peer count
   * @returns {{ online: number, total: number }}
   */
  async getCounts() {
    const total = await P2PPeer.countDocuments();
    return {
      online: this.onlinePeers.size,
      total
    };
  }

  /**
   * Update ERC-8004 verification info for a peer
   * @param {string} fingerprint
   * @param {object} erc8004 - { agentId, txHash, verified }
   */
  async updateERC8004(fingerprint, erc8004) {
    const peer = await P2PPeer.findByFingerprint(fingerprint);
    if (!peer) return;

    peer.erc8004 = {
      ...erc8004,
      verifiedAt: new Date()
    };
    await peer.save();

    logger.info(`P2P peer ${fingerprint.slice(0, 8)}... ERC-8004 updated: verified=${erc8004.verified}`);
  }

  /**
   * Update peer's group membership, removing from old group if changed
   * @param {P2PPeer} peer
   */
  updatePeerGroup(peer) {
    const newKey = `${peer.trustLevel}:${peer.capabilitiesHash || 'unknown'}`;
    const oldKey = this.peerGroupIndex.get(peer.fingerprint);

    // Remove from old group if it changed
    if (oldKey && oldKey !== newKey) {
      const oldGroup = this.peerGroups.get(oldKey);
      if (oldGroup) {
        oldGroup.delete(peer.fingerprint);
        if (oldGroup.size === 0) this.peerGroups.delete(oldKey);
      }
    }

    // Add to new group
    if (!this.peerGroups.has(newKey)) {
      this.peerGroups.set(newKey, new Set());
    }
    this.peerGroups.get(newKey).add(peer.fingerprint);
    this.peerGroupIndex.set(peer.fingerprint, newKey);
  }

  /**
   * Get peers by trust level and capabilities hash
   * @param {string} trustLevel
   * @param {string} capabilitiesHash
   * @returns {Set<string>} Set of fingerprints
   */
  getPeersByGroup(trustLevel, capabilitiesHash) {
    const key = `${trustLevel}:${capabilitiesHash || 'unknown'}`;
    return this.peerGroups.get(key) || new Set();
  }

  /**
   * Shutdown - cleanup
   */
  shutdown() {
    this.onlinePeers.clear();
    this.peerGroups.clear();
    this.peerGroupIndex.clear();
  }
}

export const peerManager = new PeerManager();
export default PeerManager;
