import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const REQUEST_TIMEOUT = 15000; // 15 seconds
const MAX_RECONNECT_DELAY = 60000; // 60 seconds
const INITIAL_RECONNECT_DELAY = 5000; // 5 seconds

/**
 * RegistryClient manages the WebSocket connection to the LANP registry server
 * Follows the MQTT service reconnection pattern and MCPTransport request/response pattern
 *
 * Events emitted:
 *   - 'connected' - Connected and registered with registry
 *   - 'disconnected' - Disconnected from registry
 *   - 'peer_online' - { fingerprint, capabilities_hash }
 *   - 'peer_offline' - { fingerprint }
 *   - 'message' - { from, payload } (encrypted message from a peer)
 *   - 'error' - Error object
 */
class RegistryClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.state = 'disconnected'; // disconnected, connecting, connected
    this.registryUrl = '';
    this.fingerprint = '';
    this.version = '';
    this.capabilitiesHash = '';
    this.agentId = null;       // ERC-8004 agent ID
    this.walletAddress = null; // BSC wallet address
    this.serviceUrl = null;    // Public service URL for gateway discovery
    this.heartbeatInterval = null;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.reconnectTimeout = null;
    this.shouldReconnect = true;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timeout }
    this.requestId = 0;
    this.stats = {
      connectCount: 0,
      messagesSent: 0,
      messagesReceived: 0,
      reconnectCount: 0,
      lastConnected: null,
      lastDisconnected: null
    };
  }

  /**
   * Connect to the registry server
   * @param {object} options
   * @param {string} options.registryUrl - WebSocket URL of registry
   * @param {string} options.fingerprint - Our identity fingerprint
   * @param {string} options.version - LANAgent version
   * @param {string} options.capabilitiesHash - SHA-256 hash of capabilities
   */
  async connect({ registryUrl, fingerprint, version, capabilitiesHash, agentId, walletAddress, serviceUrl }) {
    this.registryUrl = registryUrl;
    this.fingerprint = fingerprint;
    this.version = version;
    this.capabilitiesHash = capabilitiesHash;
    this.agentId = agentId || null;
    this.walletAddress = walletAddress || null;
    this.serviceUrl = serviceUrl || null;
    this.shouldReconnect = true;

    await this._connect();
  }

  /**
   * Internal connection method with retry
   */
  async _connect() {
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.state = 'connecting';

    try {
      await retryOperation(
        () => this._createConnection(),
        {
          retries: 3,
          minTimeout: 2000,
          maxTimeout: 10000,
          context: 'P2P Registry connection'
        }
      );
    } catch (error) {
      logger.error('Failed to connect to P2P registry after retries:', error.message);
      this.state = 'disconnected';
      this._scheduleReconnect();
    }
  }

  /**
   * Create WebSocket connection
   * @returns {Promise<void>}
   */
  _createConnection() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.registryUrl, {
          handshakeTimeout: 10000
        });

        const connectTimeout = setTimeout(() => {
          if (this.ws) {
            this.ws.terminate();
          }
          reject(new Error('Connection timeout'));
        }, 15000);

        this.ws.on('open', () => {
          clearTimeout(connectTimeout);
          this._onOpen();
          resolve();
        });

        this.ws.on('message', (data) => {
          this._onMessage(data.toString());
        });

        this.ws.on('close', (code, reason) => {
          clearTimeout(connectTimeout);
          this._onClose(code, reason?.toString());
        });

        this.ws.on('error', (error) => {
          clearTimeout(connectTimeout);
          if (this.state === 'connecting') {
            reject(error);
          }
          this._onError(error);
        });

        this.ws.on('pong', () => {
          // Connection is alive
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle WebSocket open - register with the registry
   */
  _onOpen() {
    this.state = 'connected';
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.stats.connectCount++;
    this.stats.lastConnected = Date.now();

    logger.info(`P2P Registry connected: ${this.registryUrl}`);

    // Register with the registry (include service metadata for gateway auto-discovery)
    const regMsg = {
      type: 'register',
      fingerprint: this.fingerprint,
      version: this.version,
      capabilities_hash: this.capabilitiesHash
    };
    if (this.agentId) regMsg.agentId = this.agentId;
    if (this.walletAddress) regMsg.walletAddress = this.walletAddress;
    if (this.serviceUrl) regMsg.serviceUrl = this.serviceUrl;
    this._send(regMsg);

    // Start heartbeat
    this._startHeartbeat();

    this.emit('connected');
  }

  /**
   * Handle incoming message
   */
  _onMessage(raw) {
    this.stats.messagesReceived++;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn('P2P Registry: received invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'registered':
        logger.info(`P2P Registry: registered, ${msg.peers_online} peers online`);
        break;

      case 'heartbeat_ack':
        // Heartbeat acknowledged
        break;

      case 'peer_online':
        logger.debug(`P2P peer online: ${msg.fingerprint?.slice(0, 8)}...`);
        this.emit('peer_online', {
          fingerprint: msg.fingerprint,
          capabilities_hash: msg.capabilities_hash
        });
        break;

      case 'peer_offline':
        logger.debug(`P2P peer offline: ${msg.fingerprint?.slice(0, 8)}...`);
        this.emit('peer_offline', { fingerprint: msg.fingerprint });
        break;

      case 'message':
        this.emit('message', {
          from: msg.from,
          payload: msg.payload
        });
        break;

      case 'peer_list':
        this._resolvePending('list_peers', msg.peers);
        break;

      case 'relay_failed':
        logger.warn(`P2P relay failed to ${msg.to?.slice(0, 8)}...: ${msg.reason}`);
        break;

      case 'error':
        logger.warn(`P2P Registry error: ${msg.reason}`);
        break;

      default:
        logger.debug(`P2P Registry: unknown message type: ${msg.type}`);
    }
  }

  /**
   * Handle WebSocket close
   */
  _onClose(code, reason) {
    const wasConnected = this.state === 'connected';
    this.state = 'disconnected';
    this.stats.lastDisconnected = Date.now();
    this._stopHeartbeat();

    if (wasConnected) {
      logger.info(`P2P Registry disconnected: ${code} ${reason || ''}`);
      this.emit('disconnected');
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    if (this.shouldReconnect) {
      this._scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket error
   */
  _onError(error) {
    logger.error('P2P Registry WebSocket error:', error.message);
    this.emit('error', error);
  }

  /**
   * Schedule a reconnection with exponential backoff
   */
  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimeout) return;

    logger.info(`P2P Registry: reconnecting in ${this.reconnectDelay / 1000}s...`);

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      this.stats.reconnectCount++;

      // Exponential backoff
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);

      await this._connect();
    }, this.reconnectDelay);
  }

  /**
   * Start heartbeat interval
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.state === 'connected') {
        this._send({ type: 'heartbeat' });
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat interval
   */
  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send a message to the registry
   * @param {object} message
   */
  _send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      this.stats.messagesSent++;
      return true;
    } catch (error) {
      logger.error('P2P Registry send error:', error.message);
      return false;
    }
  }

  /**
   * Relay an encrypted message to a peer through the registry
   * @param {string} targetFingerprint - Peer's fingerprint
   * @param {string} encryptedPayload - Base64 encoded encrypted envelope
   * @returns {boolean} Whether the message was sent to registry
   */
  relay(targetFingerprint, encryptedPayload) {
    return this._send({
      type: 'relay',
      to: targetFingerprint,
      payload: encryptedPayload
    });
  }

  /**
   * Request the list of online peers
   * @returns {Promise<Array<{fingerprint: string, capabilities_hash: string}>>}
   */
  listPeers() {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete('list_peers');
        reject(new Error('list_peers request timed out'));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set('list_peers', {
        resolve,
        reject,
        timeout: timeoutHandle
      });

      this._send({ type: 'list_peers' });
    });
  }

  /**
   * Resolve a pending request
   * @param {string} requestType
   * @param {*} data
   */
  _resolvePending(requestType, data) {
    const pending = this.pendingRequests.get(requestType);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestType);
      pending.resolve(data);
    }
  }

  /**
   * Disconnect from the registry
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.shouldReconnect = false;
    this._stopHeartbeat();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Reject pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnecting'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      return new Promise((resolve) => {
        this.ws.on('close', () => resolve());
        this.ws.close(1000, 'Client disconnecting');
        // Force close after 3 seconds
        setTimeout(() => {
          if (this.ws) {
            this.ws.terminate();
          }
          resolve();
        }, 3000);
      });
    }
  }

  /**
   * Update capabilities hash (e.g., after a plugin is installed)
   * @param {string} capabilitiesHash
   */
  updateCapabilitiesHash(capabilitiesHash) {
    this.capabilitiesHash = capabilitiesHash;
    // Re-register with new hash
    if (this.state === 'connected') {
      this._send({
        type: 'register',
        fingerprint: this.fingerprint,
        version: this.version,
        capabilities_hash: capabilitiesHash,
        ...(this.agentId ? { agentId: this.agentId } : {}),
        ...(this.walletAddress ? { walletAddress: this.walletAddress } : {}),
        ...(this.serviceUrl ? { serviceUrl: this.serviceUrl } : {})
      });
    }
  }

  /**
   * Get connection status
   * @returns {{ state: string, stats: object }}
   */
  getStatus() {
    return {
      state: this.state,
      registryUrl: this.registryUrl,
      fingerprint: this.fingerprint,
      ...this.stats
    };
  }
}

export const registryClient = new RegistryClient();
export default RegistryClient;
