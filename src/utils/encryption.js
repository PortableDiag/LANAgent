import crypto from 'crypto';
import NodeCache from 'node-cache';
import { logger } from './logger.js';

// Encryption configuration
const algorithm = 'aes-256-gcm';
const saltLength = 32; // 256 bits
const ivLength = 16; // 128 bits
const tagLength = 16; // 128 bits
const pbkdf2Iterations = 100000;
const keyLength = 32; // 256 bits

// Get encryption key from environment or generate one
const getEncryptionKey = () => {
  if (!process.env.ENCRYPTION_KEY) {
    logger.warn('ENCRYPTION_KEY not found in environment. Generating a new key...');
    const newKey = crypto.randomBytes(32).toString('hex');
    logger.warn(`Generated encryption key: ${newKey}`);
    logger.warn('Please add this to your .env file: ENCRYPTION_KEY=' + newKey);
    return Buffer.from(newKey, 'hex');
  }
  return Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
};

// Cache the key after first retrieval
let encryptionKey = null;

// Initialize cache for derived keys with 5-minute TTL
const keyCache = new NodeCache({ 
  stdTTL: 300, // 5 minutes
  checkperiod: 60, // Check for expired keys every minute
  maxKeys: 1000, // Limit cache size
  useClones: false // Don't clone buffers for performance
});

// Clear sensitive data from memory when keys expire
keyCache.on('expired', (key, value) => {
  if (Buffer.isBuffer(value)) {
    value.fill(0); // Zero out the buffer
  }
});

/**
 * Encrypt sensitive data
 * @param {string} text - The text to encrypt
 * @returns {string} - Base64 encoded encrypted data with salt, iv, tag
 */
export function encrypt(text) {
  if (!text) return '';

  try {
    // Get or cache the encryption key
    if (!encryptionKey) {
      encryptionKey = getEncryptionKey();
    }

    // Generate a random salt and IV for this encryption
    const salt = crypto.randomBytes(saltLength);
    const iv = crypto.randomBytes(ivLength);

    // Check cache for derived key
    const cacheKey = `enc_${salt.toString('hex')}`;
    let key = keyCache.get(cacheKey);
    
    if (!key) {
      // Derive a key from the master key and salt
      key = crypto.pbkdf2Sync(encryptionKey, salt, pbkdf2Iterations, keyLength, 'sha256');
      keyCache.set(cacheKey, key);
    }

    // Create cipher
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    // Encrypt the text
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final()
    ]);

    // Get the authentication tag
    const tag = cipher.getAuthTag();

    // Combine salt, iv, tag, and encrypted data
    const combined = Buffer.concat([salt, iv, tag, encrypted]);

    // Return as base64
    return combined.toString('base64');
  } catch (error) {
    logger.error('Encryption failed:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @returns {string} - Decrypted text
 */
export function decrypt(encryptedData) {
  if (!encryptedData) return '';

  try {
    // Get or cache the encryption key
    if (!encryptionKey) {
      encryptionKey = getEncryptionKey();
    }

    // Decode from base64
    const combined = Buffer.from(encryptedData, 'base64');

    // Extract components
    const salt = combined.slice(0, saltLength);
    const iv = combined.slice(saltLength, saltLength + ivLength);
    const tag = combined.slice(saltLength + ivLength, saltLength + ivLength + tagLength);
    const encrypted = combined.slice(saltLength + ivLength + tagLength);

    // Check cache for derived key
    const cacheKey = `enc_${salt.toString('hex')}`;
    let key = keyCache.get(cacheKey);
    
    if (!key) {
      // Derive the key from the master key and salt
      key = crypto.pbkdf2Sync(encryptionKey, salt, pbkdf2Iterations, keyLength, 'sha256');
      keyCache.set(cacheKey, key);
    }

    // Create decipher
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(tag);

    // Decrypt
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    logger.error('Decryption failed:', error);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Walk `fieldPath` while cloning every level along the way, so the returned root
 * shares no mutable object with the input.
 *
 * A plain `{ ...obj }` is a SHALLOW copy: for a nested path it hands back a root
 * whose children are still the caller's objects, so writing the encrypted value
 * mutated the caller's original in place. The advertised example
 * ('user.profile.email') hit exactly that, and the ciphertext was written into
 * both the "copy" and the source.
 *
 * @param {object} obj - Root object
 * @param {string[]} parts - Path segments
 * @returns {{root: object, parent: object, key: string}}
 */
function cloneAlongPath(obj, parts) {
  const copy = (v) => (Array.isArray(v) ? [...v] : { ...v });
  const root = copy(obj);
  let current = root;

  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i];
    const child = current[segment];
    if (child === null || typeof child !== 'object') {
      throw new Error(`Field path ${parts.join('.')} does not exist in object`);
    }
    current[segment] = copy(child);
    current = current[segment];
  }

  const key = parts[parts.length - 1];
  if (!(key in current)) {
    throw new Error(`Field ${key} does not exist at path ${parts.join('.')}`);
  }
  return { root, parent: current, key };
}

/**
 * Encrypt a specific field in an object, returning a new object.
 *
 * Non-string values are JSON-encoded before encryption. Note this is lossy in one
 * direction: a plain string that happens to look like JSON ('{"a":1}') will come
 * back from decryptField as a parsed object. Encrypt a wrapper if that matters.
 *
 * @param {object} obj - The object containing the field to encrypt
 * @param {string} fieldPath - Dot notation path to the field (e.g., 'user.profile.email')
 * @returns {object} - New object with the specified field encrypted; `obj` is untouched
 */
export function encryptField(obj, fieldPath) {
  if (!obj || !fieldPath) {
    throw new Error('Object and field path are required');
  }

  const { root, parent, key } = cloneAlongPath(obj, fieldPath.split('.'));
  const value = parent[key];

  if (typeof value === 'string') {
    parent[key] = encrypt(value);
  } else if (typeof value === 'object' && value !== null) {
    parent[key] = encrypt(JSON.stringify(value));
  } else {
    parent[key] = encrypt(String(value));
  }

  return root;
}

/**
 * Decrypt a specific field in an object, returning a new object.
 *
 * A field that cannot be decrypted is left exactly as-is (and logged), so calling
 * this on a record that was never encrypted is a no-op rather than an error.
 *
 * @param {object} obj - The object containing the field to decrypt
 * @param {string} fieldPath - Dot notation path to the field (e.g., 'user.profile.email')
 * @returns {object} - New object with the specified field decrypted; `obj` is untouched
 */
export function decryptField(obj, fieldPath) {
  if (!obj || !fieldPath) {
    throw new Error('Object and field path are required');
  }

  const { root, parent, key } = cloneAlongPath(obj, fieldPath.split('.'));
  const value = parent[key];

  if (typeof value !== 'string') return root;

  try {
    const plain = decrypt(value);
    const looksJson = (plain.startsWith('{') && plain.endsWith('}')) ||
                      (plain.startsWith('[') && plain.endsWith(']'));
    if (looksJson) {
      try {
        parent[key] = JSON.parse(plain);
      } catch {
        parent[key] = plain;
      }
    } else {
      parent[key] = plain;
    }
  } catch (error) {
    logger.warn(`Failed to decrypt field ${fieldPath}:`, error.message);
    // Leave the field as-is if decryption fails
  }

  return root;
}

/**
 * Generate a new encryption key
 * @returns {string} - Hex encoded encryption key
 */
export function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate that the encryption key is properly set
 * @returns {boolean} - True if encryption key is valid
 */
export function isEncryptionConfigured() {
  return !!process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length === 64;
}

/**
 * Clear the key cache (useful for security or memory management)
 */
export function clearKeyCache() {
  keyCache.flushAll();
  logger.info('Encryption key cache cleared');
}

/**
 * Get cache statistics
 * @returns {object} - Cache statistics
 */
export function getKeyCacheStats() {
  return {
    keys: keyCache.keys().length,
    hits: keyCache.getStats().hits,
    misses: keyCache.getStats().misses,
    ksize: keyCache.getStats().ksize,
    vsize: keyCache.getStats().vsize
  };
}
