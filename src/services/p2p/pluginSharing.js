import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../../utils/logger.js';
import { peerManager } from './peerManager.js';
import { cryptoManager } from './cryptoManager.js';
import { sanitizePluginSource, sanitizeManifest, validateSanitization } from './sanitizer.js';
import { P2PTransfer } from '../../models/P2PTransfer.js';

const CHUNK_SIZE = 65536; // 64KB per chunk
const PLUGINS_DIR = path.resolve('src/api/plugins');

/**
 * PluginSharing handles packaging, sanitizing, chunked transfer, and installation of plugins
 */
class PluginSharing {
  constructor(agent) {
    this.agent = agent;
    // In-progress incoming transfers: peerFingerprint:pluginName -> { chunks, manifest, transfer }
    this.incomingTransfers = new Map();
    // Cached plugin list responses from peers: peerFingerprint -> plugins[]
    this.peerPluginLists = new Map();
  }

  /**
   * Get local capabilities (plugin names + versions) for sharing
   * @returns {Promise<Array<{name: string, version: string, description: string}>>}
   */
  async getLocalCapabilities() {
    const capabilities = [];

    try {
      const apiManager = this.agent?.apiManager || this.agent?.services?.get('apiManager');
      if (!apiManager?.apis) {
        logger.warn(`getLocalCapabilities: apiManager not found (agent=${!!this.agent}, agent.apiManager=${!!this.agent?.apiManager}, apis=${!!apiManager?.apis})`);
        return capabilities;
      }
      logger.info(`getLocalCapabilities: found ${apiManager.apis.size} plugins`);

      for (const [name, api] of apiManager.apis) {
        if (api.enabled) {
          capabilities.push({
            name,
            version: api.instance?.version || '1.0.0',
            description: api.instance?.description || ''
          });
        }
      }
    } catch (error) {
      logger.error('Failed to get local capabilities:', error.message);
    }

    return capabilities;
  }

  /**
   * Get shareable plugin list with manifests
   * @returns {Promise<Array>}
   */
  async getShareablePluginList() {
    const plugins = [];

    try {
      const apiManager = this.agent?.services?.get('apiManager');
      if (!apiManager?.apis) return plugins;

      for (const [name, api] of apiManager.apis) {
        if (!api.enabled || !api.filename) continue;

        try {
          const filePath = path.join(PLUGINS_DIR, api.filename);
          const source = await fs.readFile(filePath, 'utf8');
          const hash = crypto.createHash('sha256').update(source).digest('hex');

          plugins.push(sanitizeManifest({
            name,
            version: api.instance?.version || '1.0.0',
            description: api.instance?.description || '',
            commands: api.instance?.commands || [],
            requiredDependencies: api.instance?.requiredDependencies || [],
            requiredCredentials: api.instance?.requiredCredentials || [],
            sourceHash: hash
          }));
        } catch {
          // Skip plugins we can't read
        }
      }
    } catch (error) {
      logger.error('Failed to get shareable plugin list:', error.message);
    }

    return plugins;
  }

  /**
   * Handle a plugin request from a peer - sanitize and send the plugin
   * @param {string} peerFingerprint
   * @param {string} pluginName
   * @param {string} version
   * @param {Function} sendFn
   */
  async handlePluginRequest(peerFingerprint, pluginName, version, sendFn) {
    try {
      const apiManager = this.agent?.services?.get('apiManager');
      const api = apiManager?.apis?.get(pluginName);

      if (!api || !api.filename) {
        logger.warn(`P2P plugin request for unknown plugin: ${pluginName}`);
        return;
      }

      const filePath = path.join(PLUGINS_DIR, api.filename);
      const rawSource = await fs.readFile(filePath, 'utf8');

      // Sanitize the source code
      const sanitizedSource = sanitizePluginSource(rawSource);

      // Validate sanitization
      const validation = validateSanitization(sanitizedSource);
      if (!validation.safe) {
        logger.error(`P2P refusing to share ${pluginName}: sanitization warnings: ${validation.warnings.join(', ')}`);
        return;
      }

      // Create manifest
      const manifest = sanitizeManifest({
        name: pluginName,
        version: api.instance?.version || version || '1.0.0',
        description: api.instance?.description || '',
        commands: api.instance?.commands || [],
        requiredDependencies: api.instance?.requiredDependencies || [],
        requiredCredentials: api.instance?.requiredCredentials || []
      });

      // Hash the sanitized source
      const sourceHash = crypto.createHash('sha256').update(sanitizedSource).digest('hex');
      manifest.sourceHash = sourceHash;

      // Sign the manifest
      manifest.signerFingerprint = cryptoManager.identity.fingerprint;
      manifest.signature = cryptoManager.sign(manifest);

      // Split into chunks
      const sourceBuffer = Buffer.from(sanitizedSource, 'utf8');
      const totalChunks = Math.ceil(sourceBuffer.length / CHUNK_SIZE);

      // Create transfer record
      const transfer = await P2PTransfer.create({
        peerFingerprint,
        pluginName,
        pluginVersion: manifest.version,
        direction: 'outgoing',
        status: 'transferring',
        totalChunks,
        totalSize: sourceBuffer.length,
        sha256: sourceHash,
        signerFingerprint: cryptoManager.identity.fingerprint
      });

      // Send offer
      await sendFn(peerFingerprint, {
        type: 'plugin_offer',
        name: pluginName,
        version: manifest.version,
        totalChunks,
        totalSize: sourceBuffer.length,
        sha256: sourceHash,
        manifest
      });

      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, sourceBuffer.length);
        const chunk = sourceBuffer.subarray(start, end);
        const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');

        await sendFn(peerFingerprint, {
          type: 'plugin_chunk',
          name: pluginName,
          chunkIndex: i,
          data: chunk.toString('base64'),
          sha256: chunkHash
        });
      }

      transfer.status = 'completed';
      transfer.completedAt = new Date();
      await transfer.save();

      await peerManager.incrementTransferCount(peerFingerprint);
      logger.info(`P2P sent plugin ${pluginName} to ${peerFingerprint.slice(0, 8)}... (${totalChunks} chunks, ${sourceBuffer.length} bytes)`);
    } catch (error) {
      logger.error(`P2P failed to send plugin ${pluginName}:`, error.message);
    }
  }

  /**
   * Handle a plugin offer from a peer
   * @param {string} peerFingerprint
   * @param {object} offer
   */
  async handlePluginOffer(peerFingerprint, offer) {
    const key = `${peerFingerprint}:${offer.name}`;

    // Create transfer record
    const transfer = await P2PTransfer.create({
      peerFingerprint,
      pluginName: offer.name,
      pluginVersion: offer.version,
      direction: 'incoming',
      status: 'transferring',
      totalChunks: offer.totalChunks,
      totalSize: offer.totalSize,
      sha256: offer.sha256,
      manifest: offer.manifest,
      signerFingerprint: offer.manifest?.signerFingerprint || ''
    });

    // Initialize incoming transfer buffer
    this.incomingTransfers.set(key, {
      chunks: new Array(offer.totalChunks).fill(null),
      receivedCount: 0,
      manifest: offer.manifest,
      sha256: offer.sha256,
      totalChunks: offer.totalChunks,
      totalSize: offer.totalSize,
      transfer
    });

    logger.info(`P2P receiving plugin ${offer.name} from ${peerFingerprint.slice(0, 8)}... (${offer.totalChunks} chunks, ${offer.totalSize} bytes)`);
  }

  /**
   * Handle a plugin chunk from a peer
   * @param {string} peerFingerprint
   * @param {object} chunk - { name, chunkIndex, data, sha256 }
   * @param {Function} sendFn
   */
  async handlePluginChunk(peerFingerprint, chunk, sendFn) {
    const key = `${peerFingerprint}:${chunk.name}`;
    const incoming = this.incomingTransfers.get(key);

    if (!incoming) {
      logger.warn(`P2P received chunk for unknown transfer: ${chunk.name}`);
      return;
    }

    // Verify chunk hash
    const chunkData = Buffer.from(chunk.data, 'base64');
    const chunkHash = crypto.createHash('sha256').update(chunkData).digest('hex');

    if (chunkHash !== chunk.sha256) {
      logger.error(`P2P chunk hash mismatch for ${chunk.name} chunk ${chunk.chunkIndex}`);
      incoming.transfer.status = 'failed';
      incoming.transfer.error = `Chunk ${chunk.chunkIndex} hash mismatch`;
      await incoming.transfer.save();
      this.incomingTransfers.delete(key);
      return;
    }

    incoming.chunks[chunk.chunkIndex] = chunkData;
    incoming.receivedCount++;

    // Update transfer progress
    incoming.transfer.receivedChunks = incoming.receivedCount;
    await incoming.transfer.save();

    // Check if all chunks received
    if (incoming.receivedCount === incoming.totalChunks) {
      await this._assemblePlugin(peerFingerprint, chunk.name, incoming, sendFn);
    }
  }

  /**
   * Assemble received chunks and verify the complete plugin
   */
  async _assemblePlugin(peerFingerprint, pluginName, incoming, sendFn) {
    const key = `${peerFingerprint}:${pluginName}`;

    try {
      // Assemble all chunks
      const assembled = Buffer.concat(incoming.chunks);
      const assembledHash = crypto.createHash('sha256').update(assembled).digest('hex');

      // Verify full hash
      if (assembledHash !== incoming.sha256) {
        logger.error(`P2P plugin hash mismatch for ${pluginName}: expected ${incoming.sha256.slice(0, 16)}, got ${assembledHash.slice(0, 16)}`);
        incoming.transfer.status = 'failed';
        incoming.transfer.error = 'Full hash mismatch';
        await incoming.transfer.save();
        this.incomingTransfers.delete(key);
        return;
      }

      // Verify signature if present
      let signatureVerified = false;
      if (incoming.manifest?.signature && incoming.manifest?.signerFingerprint) {
        const signerPeer = await peerManager.getPeer(incoming.manifest.signerFingerprint);
        if (signerPeer) {
          signatureVerified = cryptoManager.verify(
            incoming.manifest,
            incoming.manifest.signature,
            signerPeer.signPublicKey
          );
        }
      }

      incoming.transfer.signatureVerified = signatureVerified;
      incoming.transfer.assembledSource = assembled.toString('utf8');

      // Check trust level for auto-install
      const peer = await peerManager.getPeer(peerFingerprint);
      if (peer?.trustLevel === 'trusted') {
        incoming.transfer.status = 'approved';
        await incoming.transfer.save();
        await this._installPlugin(incoming.transfer);
      } else {
        incoming.transfer.status = 'awaiting_approval';
        await incoming.transfer.save();
        logger.info(`P2P plugin ${pluginName} from ${peerFingerprint.slice(0, 8)}... awaiting user approval`);
      }

      // Send confirmation
      await sendFn(peerFingerprint, {
        type: 'plugin_received',
        name: pluginName,
        verified: assembledHash === incoming.sha256
      });

      this.incomingTransfers.delete(key);
    } catch (error) {
      logger.error(`P2P failed to assemble plugin ${pluginName}:`, error.message);
      incoming.transfer.status = 'failed';
      incoming.transfer.error = error.message;
      await incoming.transfer.save();
      this.incomingTransfers.delete(key);
    }
  }

  /**
   * Install an approved plugin
   * @param {P2PTransfer} transfer
   * @returns {Promise<boolean>}
   */
  async _installPlugin(transfer) {
    try {
      const filename = `${transfer.pluginName}.js`;
      const filePath = path.join(PLUGINS_DIR, filename);

      // Check if plugin already exists
      try {
        await fs.access(filePath);
        // Plugin exists - back it up
        const backupPath = `${filePath}.p2p-backup-${Date.now()}`;
        await fs.copyFile(filePath, backupPath);
        logger.info(`P2P backed up existing plugin: ${filename}`);
      } catch {
        // Plugin doesn't exist, that's fine
      }

      // Write the plugin file
      await fs.writeFile(filePath, transfer.assembledSource, 'utf8');

      // Try to hot-load the plugin
      const apiManager = this.agent?.services?.get('apiManager');
      if (apiManager?.loadPlugin) {
        await apiManager.loadPlugin(filename);
        logger.info(`P2P installed and loaded plugin: ${transfer.pluginName}`);
      } else {
        logger.info(`P2P installed plugin ${transfer.pluginName} (will load on restart)`);
      }

      transfer.status = 'installed';
      transfer.completedAt = new Date();
      await transfer.save();

      await peerManager.incrementTransferCount(transfer.peerFingerprint);
      return true;
    } catch (error) {
      logger.error(`P2P failed to install plugin ${transfer.pluginName}:`, error.message);
      transfer.status = 'failed';
      transfer.error = error.message;
      await transfer.save();
      return false;
    }
  }

  /**
   * Approve a pending plugin transfer for installation
   * @param {string} transferId
   * @returns {Promise<boolean>}
   */
  async approveInstall(transferId) {
    const transfer = await P2PTransfer.findById(transferId);
    if (!transfer || transfer.status !== 'awaiting_approval') {
      return false;
    }

    transfer.status = 'approved';
    await transfer.save();

    return this._installPlugin(transfer);
  }

  /**
   * Reject a pending plugin transfer
   * @param {string} transferId
   * @returns {Promise<boolean>}
   */
  async rejectInstall(transferId) {
    const transfer = await P2PTransfer.findById(transferId);
    if (!transfer || transfer.status !== 'awaiting_approval') {
      return false;
    }

    transfer.status = 'rejected';
    transfer.assembledSource = ''; // Clear stored source
    transfer.completedAt = new Date();
    await transfer.save();

    logger.info(`P2P plugin ${transfer.pluginName} rejected by user`);
    return true;
  }

  /**
   * Handle plugin list response from a peer
   * @param {string} peerFingerprint
   * @param {Array} plugins
   */
  handlePluginListResponse(peerFingerprint, plugins) {
    this.peerPluginLists.set(peerFingerprint, plugins);
    logger.debug(`P2P cached ${plugins.length} plugins from ${peerFingerprint.slice(0, 8)}...`);

    // Resolve any pending waiters
    this._pluginListWaiters?.get(peerFingerprint)?.(plugins);
    this._pluginListWaiters?.delete(peerFingerprint);
  }

  /**
   * Request plugin list and wait for the response (with timeout).
   * @param {string} peerFingerprint
   * @param {Function} sendFn - P2P send function
   * @param {number} timeoutMs - Max wait time (default 10s)
   * @returns {Promise<Array|null>}
   */
  async requestAndWaitForPluginList(peerFingerprint, sendFn, timeoutMs = 10000) {
    // Check cache first
    const cached = this.peerPluginLists.get(peerFingerprint);

    // Send request
    await sendFn(peerFingerprint, { type: 'plugin_list_request' });

    // Wait for response
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this._pluginListWaiters?.delete(peerFingerprint);
        resolve(cached || null); // Return cached if available, else null
      }, timeoutMs);

      if (!this._pluginListWaiters) this._pluginListWaiters = new Map();
      this._pluginListWaiters.set(peerFingerprint, (plugins) => {
        clearTimeout(timeout);
        resolve(plugins);
      });
    });
  }

  /**
   * Get cached plugin list from a peer
   * @param {string} peerFingerprint
   * @returns {Array|null}
   */
  getCachedPluginList(peerFingerprint) {
    return this.peerPluginLists.get(peerFingerprint) || null;
  }

  /**
   * Get transfer history
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getTransferHistory(limit = 50) {
    return P2PTransfer.getHistory(limit);
  }

  /**
   * Get pending approvals
   * @returns {Promise<Array>}
   */
  async getPendingApprovals() {
    return P2PTransfer.getPendingApprovals();
  }

  /**
   * Shutdown - cleanup
   */
  shutdown() {
    this.incomingTransfers.clear();
    this.peerPluginLists.clear();
  }
}

export default PluginSharing;
