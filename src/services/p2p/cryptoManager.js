import crypto from 'crypto';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import { PluginSettings } from '../../models/PluginSettings.js';

const PLUGIN_NAME = 'p2p-federation';
const IDENTITY_KEY = 'identity_keypair';
const FINGERPRINT_LENGTH = 16; // 16 bytes = 32 hex chars

// Cache session keys for 1 hour
const sessionKeyCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 300,
  useClones: false,
  maxKeys: 200
});

// Cache nonces for replay protection (1 hour)
const nonceCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 300,
  maxKeys: 10000
});

// Clear sensitive data when keys expire
sessionKeyCache.on('expired', (key, value) => {
  if (Buffer.isBuffer(value)) {
    value.fill(0);
  }
});

/**
 * CryptoManager handles Ed25519 identity, X25519 ECDH key exchange, and AES-256-GCM encryption.
 *
 * Identity consists of TWO keypairs:
 *   - Ed25519 for signing/verification (identity + authentication)
 *   - X25519 for ECDH key exchange (encryption)
 *
 * Both are stored together. The fingerprint is derived from the Ed25519 public key.
 * Peers exchange BOTH public keys during capability exchange.
 *
 * Uses ONLY Node.js built-in crypto module.
 */
class CryptoManager {
  constructor() {
    this.identity = null;
    // identity = { signPublicKey, signPrivateKey, dhPublicKey, dhPrivateKey, fingerprint }
    // signPublicKey/signPrivateKey: Ed25519 DER buffers (for sign/verify)
    // dhPublicKey/dhPrivateKey: X25519 DER buffers (for ECDH encryption)
    this.peerSequences = new Map(); // fingerprint -> last seen seq
    this.outboundSeq = new Map(); // fingerprint -> next outbound seq
  }

  /**
   * Generate a new identity (Ed25519 signing + X25519 ECDH keypairs)
   * @returns {{ signPublicKey: Buffer, signPrivateKey: Buffer, dhPublicKey: Buffer, dhPrivateKey: Buffer, fingerprint: string }}
   */
  generateIdentity() {
    // Ed25519 keypair for signing
    const { publicKey: signPub, privateKey: signPriv } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });

    // X25519 keypair for ECDH
    const { publicKey: dhPub, privateKey: dhPriv } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });

    const fingerprint = this.computeFingerprint(signPub);

    return {
      signPublicKey: signPub,
      signPrivateKey: signPriv,
      dhPublicKey: dhPub,
      dhPrivateKey: dhPriv,
      fingerprint
    };
  }

  /**
   * Compute fingerprint from Ed25519 public key
   * @param {Buffer} publicKey - DER-encoded Ed25519 public key
   * @returns {string} 32 hex char fingerprint
   */
  computeFingerprint(publicKey) {
    const hash = crypto.createHash('sha256').update(publicKey).digest();
    return hash.subarray(0, FINGERPRINT_LENGTH).toString('hex');
  }

  /**
   * Load existing identity from PluginSettings or generate a new one
   * @returns {Promise<object>} Identity object
   */
  async loadOrCreateIdentity() {
    try {
      const stored = await PluginSettings.getCached(PLUGIN_NAME, IDENTITY_KEY);

      if (stored && stored.signPublicKey && stored.signPrivateKey && stored.dhPublicKey && stored.dhPrivateKey) {
        this.identity = {
          signPublicKey: Buffer.from(stored.signPublicKey, 'base64'),
          signPrivateKey: Buffer.from(stored.signPrivateKey, 'base64'),
          dhPublicKey: Buffer.from(stored.dhPublicKey, 'base64'),
          dhPrivateKey: Buffer.from(stored.dhPrivateKey, 'base64'),
          fingerprint: stored.fingerprint
        };
        logger.info(`P2P identity loaded, fingerprint: ${this.identity.fingerprint}`);
        return this.identity;
      }
    } catch (error) {
      logger.warn('Failed to load P2P identity, generating new one:', error.message);
    }

    // Generate new identity
    this.identity = this.generateIdentity();

    // Persist to PluginSettings
    try {
      await PluginSettings.setCached(PLUGIN_NAME, IDENTITY_KEY, {
        signPublicKey: this.identity.signPublicKey.toString('base64'),
        signPrivateKey: this.identity.signPrivateKey.toString('base64'),
        dhPublicKey: this.identity.dhPublicKey.toString('base64'),
        dhPrivateKey: this.identity.dhPrivateKey.toString('base64'),
        fingerprint: this.identity.fingerprint,
        createdAt: new Date().toISOString()
      });
      logger.info(`P2P identity generated, fingerprint: ${this.identity.fingerprint}`);
    } catch (error) {
      logger.error('Failed to persist P2P identity:', error);
    }

    return this.identity;
  }

  /**
   * Get the public keys for sharing with peers (both signing and DH)
   * @returns {{ signPublicKey: string, dhPublicKey: string, fingerprint: string }}
   */
  getPublicKeys() {
    if (!this.identity) throw new Error('Identity not initialized');
    return {
      signPublicKey: this.identity.signPublicKey.toString('base64'),
      dhPublicKey: this.identity.dhPublicKey.toString('base64'),
      fingerprint: this.identity.fingerprint
    };
  }

  /**
   * Derive a shared session key with a peer using X25519 ECDH + HKDF
   *
   * @param {Buffer|string} theirDHPublicKey - Peer's X25519 DER public key (or base64 string)
   * @param {string} theirFingerprint - Peer's fingerprint (for salt derivation)
   * @returns {Buffer} 32-byte AES session key
   */
  deriveSessionKey(theirDHPublicKey, theirFingerprint) {
    if (!this.identity) throw new Error('Identity not initialized');

    if (typeof theirDHPublicKey === 'string') {
      theirDHPublicKey = Buffer.from(theirDHPublicKey, 'base64');
    }

    const cacheKey = `session_${theirFingerprint}`;

    // Check cache
    const cached = sessionKeyCache.get(cacheKey);
    if (cached) return cached;

    // X25519 ECDH
    const myPrivateKeyObj = crypto.createPrivateKey({
      key: this.identity.dhPrivateKey,
      format: 'der',
      type: 'pkcs8'
    });
    const theirPublicKeyObj = crypto.createPublicKey({
      key: theirDHPublicKey,
      format: 'der',
      type: 'spki'
    });

    const sharedSecret = crypto.diffieHellman({
      privateKey: myPrivateKeyObj,
      publicKey: theirPublicKeyObj
    });

    // Derive session key with HKDF
    // Salt = sorted fingerprints to ensure both sides derive the same key
    const fingerprints = [this.identity.fingerprint, theirFingerprint].sort();
    const salt = Buffer.from(fingerprints.join(''), 'hex');

    const sessionKey = crypto.hkdfSync(
      'sha256',
      sharedSecret,
      salt,
      Buffer.from('lanp-v1'),
      32
    );

    const keyBuffer = Buffer.from(sessionKey);
    sessionKeyCache.set(cacheKey, keyBuffer);
    return keyBuffer;
  }

  /**
   * Encrypt a message for a specific peer
   * @param {string} plaintext - Message to encrypt (JSON string)
   * @param {Buffer|string} theirDHPublicKey - Peer's X25519 DER public key
   * @param {string} theirFingerprint - Peer's fingerprint
   * @returns {object} Encrypted envelope { v, nonce, iv, ciphertext, tag }
   */
  encrypt(plaintext, theirDHPublicKey, theirFingerprint) {
    const sessionKey = this.deriveSessionKey(theirDHPublicKey, theirFingerprint);

    const nonce = crypto.randomBytes(24);
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return {
      v: 1,
      nonce: nonce.toString('hex'),
      iv: iv.toString('hex'),
      ciphertext: encrypted.toString('base64'),
      tag: tag.toString('hex')
    };
  }

  /**
   * Decrypt a message from a specific peer
   * @param {object} envelope - Encrypted envelope { v, nonce, iv, ciphertext, tag }
   * @param {Buffer|string} theirDHPublicKey - Peer's X25519 DER public key
   * @param {string} theirFingerprint - Peer's fingerprint
   * @returns {string} Decrypted plaintext
   */
  decrypt(envelope, theirDHPublicKey, theirFingerprint) {
    if (envelope.v !== 1) {
      throw new Error(`Unsupported envelope version: ${envelope.v}`);
    }

    // Replay protection: check nonce
    const nonceKey = `nonce_${envelope.nonce}`;
    if (nonceCache.get(nonceKey)) {
      throw new Error('Replay detected: duplicate nonce');
    }
    nonceCache.set(nonceKey, true);

    const sessionKey = this.deriveSessionKey(theirDHPublicKey, theirFingerprint);
    const iv = Buffer.from(envelope.iv, 'hex');
    const tag = Buffer.from(envelope.tag, 'hex');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Sign a message with our Ed25519 private key
   * @param {object} message - Message to sign (sig field will be excluded from hash)
   * @returns {string} Hex-encoded signature
   */
  sign(message) {
    if (!this.identity) throw new Error('Identity not initialized');

    const { sig, ...messageWithoutSig } = message;
    const canonical = JSON.stringify(messageWithoutSig, Object.keys(messageWithoutSig).sort());
    const hash = crypto.createHash('sha256').update(canonical).digest();

    const privateKeyObj = crypto.createPrivateKey({
      key: this.identity.signPrivateKey,
      format: 'der',
      type: 'pkcs8'
    });

    const signature = crypto.sign(null, hash, privateKeyObj);
    return signature.toString('hex');
  }

  /**
   * Verify a message signature from a peer
   * @param {object} message - Message with sig field
   * @param {string} signature - Hex-encoded signature
   * @param {Buffer|string} theirSignPublicKey - Peer's Ed25519 DER public key
   * @returns {boolean} Whether the signature is valid
   */
  verify(message, signature, theirSignPublicKey) {
    if (typeof theirSignPublicKey === 'string') {
      theirSignPublicKey = Buffer.from(theirSignPublicKey, 'base64');
    }

    const { sig, ...messageWithoutSig } = message;
    const canonical = JSON.stringify(messageWithoutSig, Object.keys(messageWithoutSig).sort());
    const hash = crypto.createHash('sha256').update(canonical).digest();

    const publicKeyObj = crypto.createPublicKey({
      key: theirSignPublicKey,
      format: 'der',
      type: 'spki'
    });

    const sigBuffer = Buffer.from(signature, 'hex');
    return crypto.verify(null, hash, publicKeyObj, sigBuffer);
  }

  /**
   * Check sequence number for replay protection
   * @param {string} peerFingerprint
   * @param {number} seq - Received sequence number
   * @returns {boolean} Whether the sequence is valid (newer than last seen)
   */
  checkSequence(peerFingerprint, seq) {
    const lastSeen = this.peerSequences.get(peerFingerprint) || 0;
    if (seq <= lastSeen) return false;
    this.peerSequences.set(peerFingerprint, seq);
    return true;
  }

  /**
   * Get next outbound sequence number for a peer
   * @param {string} peerFingerprint
   * @returns {number}
   */
  getNextSeq(peerFingerprint) {
    const current = this.outboundSeq.get(peerFingerprint) || 0;
    const next = current + 1;
    this.outboundSeq.set(peerFingerprint, next);
    return next;
  }

  /**
   * Get a SHA-256 hash of capabilities for the registry
   * @param {Array} capabilities - Array of { name, version } objects
   * @returns {string} Hex-encoded SHA-256 hash
   */
  hashCapabilities(capabilities) {
    const canonical = JSON.stringify(capabilities, Object.keys(capabilities).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Invalidate a specific peer's cached session key (call when DH key rotates)
   */
  invalidateSessionKey(fingerprint) {
    sessionKeyCache.del(`session_${fingerprint}`);
  }

  /**
   * Clear session key cache (useful for security rotation)
   */
  clearSessionKeys() {
    sessionKeyCache.flushAll();
    logger.info('P2P session key cache cleared');
  }

  /**
   * Rotate the X25519 ECDH (DH) keypair while preserving the Ed25519 signing
   * keypair (and therefore the peer fingerprint / trust relationships).
   *
   * Persists the new DH keys to PluginSettings, clears the session-key cache so
   * peers will renegotiate, and returns the new public DH key. The peerManager
   * already handles incoming DH key rotation from peers; this is the symmetric
   * outbound rotation.
   */
  async rotateDhKeys() {
    if (!this.identity) {
      throw new Error('Identity not initialized — cannot rotate DH keys');
    }

    const { publicKey: dhPub, privateKey: dhPriv } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });

    this.identity.dhPublicKey = dhPub;
    this.identity.dhPrivateKey = dhPriv;

    try {
      await PluginSettings.setCached(PLUGIN_NAME, IDENTITY_KEY, {
        signPublicKey: this.identity.signPublicKey.toString('base64'),
        signPrivateKey: this.identity.signPrivateKey.toString('base64'),
        dhPublicKey: this.identity.dhPublicKey.toString('base64'),
        dhPrivateKey: this.identity.dhPrivateKey.toString('base64'),
        fingerprint: this.identity.fingerprint,
        dhRotatedAt: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to persist rotated DH keys:', error);
      throw error;
    }

    this.clearSessionKeys();
    logger.info(`P2P DH keys rotated; fingerprint preserved: ${this.identity.fingerprint}`);

    return this.identity.dhPublicKey.toString('base64');
  }

  /**
   * Shutdown - clear all sensitive material
   */
  shutdown() {
    sessionKeyCache.flushAll();
    nonceCache.flushAll();
    this.peerSequences.clear();
    this.outboundSeq.clear();
    this.identity = null;
  }
}

export const cryptoManager = new CryptoManager();
export default CryptoManager;
