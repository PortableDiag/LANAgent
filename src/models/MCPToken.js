import mongoose from 'mongoose';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import net from 'net';

/**
 * MCPToken model for managing access tokens for MCP server mode
 * Allows external MCP clients to access LANAgent tools
 */

// ---------------------------------------------------------------------------
// CIDR matching helpers (IPv4 and IPv6)
// ---------------------------------------------------------------------------

/**
 * Convert an IPv4 address string to a 32-bit unsigned integer.
 * @param {string} ip - IPv4 address (e.g. "192.168.1.1")
 * @returns {number}
 */
function ipv4ToInt(ip) {
  const octets = ip.split('.').map(Number);
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/**
 * Expand an IPv6 address to its full 8-group hexadecimal representation.
 * Handles :: abbreviation.
 * @param {string} ip - IPv6 address (e.g. "2001:db8::1")
 * @returns {string} Expanded address with 8 groups (e.g. "2001:0db8:0000:0000:0000:0000:0000:0001")
 */
function expandIPv6(ip) {
  // Remove zone index if present
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.substring(0, zoneIdx);

  const groups = ip.split(':');
  // Count the number of groups (including empty ones from ::)
  const emptyIndex = groups.indexOf('');
  if (emptyIndex !== -1) {
    // Replace the empty string with the appropriate number of zero groups
    const missing = 8 - groups.length + 1; // +1 because the empty string is already a placeholder
    groups.splice(emptyIndex, 1, ...Array(missing).fill('0'));
  }
  // Pad each group to 4 hex digits
  return groups.map(g => g.padStart(4, '0')).join(':');
}

/**
 * Convert an IPv6 address string to a BigInt.
 * @param {string} ip - IPv6 address
 * @returns {bigint}
 */
function ipv6ToBigInt(ip) {
  const expanded = expandIPv6(ip);
  const hex = expanded.replace(/:/g, '');
  return BigInt('0x' + hex);
}

/**
 * Check whether an IP address falls within a CIDR range.
 * Supports both IPv4 and IPv6.
 * @param {string} ip - The client IP address
 * @param {string} cidr - CIDR notation (e.g. "192.168.1.0/24", "2001:db8::/32")
 * @returns {boolean}
 */
function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  let v = ip.trim();
  // Express reports IPv4 peers on a dual-stack socket as ::ffff:a.b.c.d
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) v = mapped[1];
  return v;
}

/**
 * Parse one allow/block entry: a CIDR range or a bare address (treated as a single host).
 * Returns { network, prefixLen, version } or null when the entry is not usable.
 */
function parseIpEntry(entry) {
  if (typeof entry !== 'string') return null;
  const [rawNet, rawPrefix, extra] = entry.trim().split('/');
  if (extra !== undefined) return null;
  const network = normalizeIp(rawNet);
  const version = net.isIP(network);
  if (version === 0) return null;
  // IPv6 with an embedded dotted quad is not supported by the BigInt conversion
  if (version === 6 && network.includes('.')) return null;
  const maxLen = version === 4 ? 32 : 128;
  if (rawPrefix === undefined) return { network, prefixLen: maxLen, version };
  if (!/^\d{1,3}$/.test(rawPrefix)) return null;
  const prefixLen = Number(rawPrefix);
  if (prefixLen > maxLen) return null;
  return { network, prefixLen, version };
}

/**
 * Validate and normalise an allow/block list supplied at token creation.
 * @throws {TypeError} when any entry is not an IP address or CIDR range
 */
function normalizeIpList(list, field) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new TypeError(`${field} must be an array of IP addresses or CIDR ranges`);
  return list.map(entry => {
    if (!parseIpEntry(entry)) throw new TypeError(`${field} entry is not an IP address or CIDR range: ${entry}`);
    return entry.trim();
  });
}

function isIpInCidr(ip, cidr) {
  const client = normalizeIp(ip);
  const parsed = parseIpEntry(cidr);
  if (!client || !parsed) return false;

  const ipVersion = net.isIP(client);
  if (ipVersion !== parsed.version) return false;
  const { network, prefixLen } = parsed;

  if (ipVersion === 4) {
    const ipInt = ipv4ToInt(client);
    const netInt = ipv4ToInt(network);
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    return (ipInt & mask) === (netInt & mask);
  }

  if (client.includes('.')) return false;
  const ipBig = ipv6ToBigInt(client);
  const netBig = ipv6ToBigInt(network);
  const mask = prefixLen === 0 ? 0n : ((1n << BigInt(128 - prefixLen)) - 1n) ^ ((1n << 128n) - 1n);
  return (ipBig & mask) === (netBig & mask);
}

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

const mcpTokenSchema = new mongoose.Schema({
  // Display name for the token
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },

  // Hashed token value
  token: {
    type: String,
    required: true,
    unique: true
  },

  // sha256 of the plaintext token for O(1) lookup; pre-existing tokens may not
  // have this until they are next validated (opportunistic backfill).
  lookupKey: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },

  // Token prefix for display (e.g., "mcp_XXXX...")
  tokenPrefix: {
    type: String,
    required: true
  },

  // Permissions - tool categories allowed
  permissions: {
    type: [String],
    default: ['*'],
    enum: ['*', 'system', 'network', 'media', 'development', 'communication', 'integration', 'crypto', 'automation']
  },

  // Specific tools allowed (empty = all enabled based on permissions)
  allowedTools: {
    type: [String],
    default: []
  },

  // Specific tools denied (blacklist)
  deniedTools: {
    type: [String],
    default: []
  },

  // IP allow list – if non-empty, only these CIDR ranges are permitted
  allowedIps: {
    type: [String],
    default: []
  },

  // IP block list – any IP matching these CIDR ranges is denied, even if allowed
  blockedIps: {
    type: [String],
    default: []
  },

  // Token expiration
  expiresAt: {
    type: Date,
    default: null,
    index: true
  },

  // Usage tracking
  lastUsed: Date,
  usageCount: {
    type: Number,
    default: 0
  },

  // Rate limiting
  rateLimit: {
    requests: {
      type: Number,
      default: 100
    },
    window: {
      type: Number,
      default: 60000 // 1 minute in ms
    }
  },

  // Metadata
  createdBy: String,
  description: String,
  active: {
    type: Boolean,
    default: true,
    index: true
  },
  revocationReason: String,
  revokedAt: Date,
  rotatedAt: Date,

  // Token usage analytics
  usageAnalytics: {
    peakUsageTimes: {
      type: Map,
      of: Number,
      default: () => new Map()
    },
    mostAccessedTools: {
      type: Map,
      of: Number,
      default: () => new Map()
    }
  },

  // Custom usage threshold for alerts
  usageThreshold: {
    type: Number,
    default: 1000 // Default threshold
  }
}, {
  timestamps: true
});

// Compound indexes
mcpTokenSchema.index({ active: 1, expiresAt: 1 });

/**
 * Generate a new MCP token
 * @param {object} options - Token options
 * @returns {object} { token: plaintext, doc: saved document }
 */
mcpTokenSchema.statics.generateToken = async function(options = {}) {
  const {
    name,
    permissions = ['*'],
    allowedTools = [],
    deniedTools = [],
    allowedIps = [],
    blockedIps = [],
    expiresIn = null, // milliseconds, null = never expires
    createdBy = 'system',
    description = '',
    usageThreshold = 1000 // Default threshold
  } = options;

  const allowedIpList = normalizeIpList(allowedIps, 'allowedIps');
  const blockedIpList = normalizeIpList(blockedIps, 'blockedIps');

  // Generate random token
  const tokenValue = `mcp_${crypto.randomBytes(32).toString('hex')}`;
  const tokenPrefix = `mcp_${tokenValue.slice(4, 8)}...`;

  // Hash the token for storage
  const hashedToken = await bcrypt.hash(tokenValue, 10);
  const lookupKey = crypto.createHash('sha256').update(tokenValue).digest('hex');

  // Calculate expiration
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn) : null;

  // Create the document
  const doc = new this({
    name,
    token: hashedToken,
    lookupKey,
    tokenPrefix,
    permissions,
    allowedTools,
    deniedTools,
    allowedIps: allowedIpList,
    blockedIps: blockedIpList,
    expiresAt,
    createdBy,
    description,
    active: true,
    usageThreshold
  });

  await doc.save();
  logger.info(`Generated new MCP token: ${name} (${tokenPrefix})`);

  // Return both the plaintext token (only shown once) and the document
  return {
    token: tokenValue,
    doc
  };
};

/**
 * Rotate an active MCP token: issue a replacement that carries the same access
 * policy and invalidate the original credential.
 * A revoked token is never rotated — revocation is how a compromised credential
 * is cut off, and rotating it would hand its access back out under a new value.
 * @param {string|mongoose.Types.ObjectId} tokenId - ID of the token to rotate
 * @param {object} options - Optional rotation overrides
 * @param {string} [options.name] - Replacement token display name
 * @param {number|null} [options.expiresIn] - Replacement lifetime in milliseconds (null = never expires).
 *   Omitted = the replacement keeps the original token's expiry time.
 * @param {string} [options.description] - Replacement token description
 * @returns {object} { token: plaintext, doc: replacement document, display: safe representation }
 */
mcpTokenSchema.statics.rotateToken = async function(tokenId, options = {}) {
  if (!tokenId) {
    throw new TypeError('A token ID is required for rotation');
  }

  const sourceToken = await this.findById(tokenId);
  if (!sourceToken) {
    throw new Error('MCP token not found');
  }

  if (!sourceToken.active) {
    throw new Error('Cannot rotate a revoked MCP token');
  }

  const now = Date.now();
  if (sourceToken.expiresAt && sourceToken.expiresAt.getTime() <= now) {
    throw new Error('Cannot rotate an expired MCP token');
  }

  let expiresAt = sourceToken.expiresAt || null;
  if (Object.prototype.hasOwnProperty.call(options, 'expiresIn')) {
    expiresAt = null;
    if (options.expiresIn !== null) {
      if (typeof options.expiresIn !== 'number' || !Number.isFinite(options.expiresIn) || options.expiresIn <= 0) {
        throw new TypeError('expiresIn must be a positive number of milliseconds or null');
      }
      expiresAt = new Date(now + options.expiresIn);
    }
  }

  const name = options.name === undefined ? sourceToken.name : options.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('Token name must be a non-empty string');
  }

  const description = options.description === undefined
    ? sourceToken.description
    : options.description;

  // Generate the replacement credential independently so the old plaintext
  // token can never be recovered from either document.
  const tokenValue = `mcp_${crypto.randomBytes(32).toString('hex')}`;
  const tokenPrefix = `mcp_${tokenValue.slice(4, 8)}...`;
  const hashedToken = await bcrypt.hash(tokenValue, 10);
  const lookupKey = crypto.createHash('sha256').update(tokenValue).digest('hex');

  const replacement = new this({
    name,
    token: hashedToken,
    lookupKey,
    tokenPrefix,
    permissions: [...(sourceToken.permissions || [])],
    allowedTools: [...(sourceToken.allowedTools || [])],
    deniedTools: [...(sourceToken.deniedTools || [])],
    allowedIps: [...(sourceToken.allowedIps || [])],
    blockedIps: [...(sourceToken.blockedIps || [])],
    expiresAt,
    rateLimit: sourceToken.rateLimit
      ? {
          requests: sourceToken.rateLimit.requests,
          window: sourceToken.rateLimit.window
        }
      : undefined,
    createdBy: sourceToken.createdBy,
    description,
    active: true,
    usageThreshold: sourceToken.usageThreshold
  });

  // Persist the replacement first; if this fails nothing has changed and the
  // original token keeps working.
  await retryOperation(() => replacement.save(), { retries: 3 });

  // Invalidate the original with a conditional update so two concurrent
  // rotations of the same token cannot both succeed and leave two live
  // replacements. If it is no longer active, or the update fails, the
  // replacement is removed again so no extra credential survives.
  const rotationTimestamp = new Date();
  let invalidated = null;
  try {
    invalidated = await retryOperation(() => this.findOneAndUpdate(
      { _id: sourceToken._id, active: true },
      {
        $set: {
          active: false,
          revocationReason: 'Token rotated',
          revokedAt: rotationTimestamp,
          rotatedAt: rotationTimestamp
        }
      },
      { new: true }
    ), { retries: 3 });
  } catch (error) {
    logger.error('Failed to invalidate MCP token during rotation; removing replacement', {
      tokenId: sourceToken._id?.toString(),
      replacementId: replacement._id?.toString(),
      error: error.message
    });
    await this.deleteOne({ _id: replacement._id }).catch(() => {});
    throw error;
  }

  if (!invalidated) {
    await this.deleteOne({ _id: replacement._id }).catch(() => {});
    throw new Error('MCP token was revoked or rotated concurrently');
  }

  logger.info(`Rotated MCP token: ${sourceToken.name} (${sourceToken.tokenPrefix}) -> ${replacement.tokenPrefix}`, {
    tokenId: sourceToken._id?.toString(),
    replacementId: replacement._id?.toString()
  });

  return {
    token: tokenValue,
    doc: replacement,
    display: replacement.toDisplay()
  };
};

/**
 * Validate a token and return the document if valid
 * @param {string} tokenValue - The plaintext token
 * @returns {object|null} Token document or null if invalid
 */
mcpTokenSchema.statics.validateToken = async function(tokenValue) {
  if (!tokenValue || !tokenValue.startsWith('mcp_')) {
    return null;
  }

  const lookupKey = crypto.createHash('sha256').update(tokenValue).digest('hex');
  const now = new Date();
  const expiryClause = { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };

  // Fast path: indexed lookup by sha256(plaintext). bcrypt.compare still runs
  // for cryptographic safety — lookupKey is only an O(1) index probe.
  const fast = await this.findOne({ active: true, lookupKey, ...expiryClause });
  if (fast) {
    if (await bcrypt.compare(tokenValue, fast.token)) {
      fast.lastUsed = now;
      fast.usageCount += 1;
      await fast.save();
      await fast.checkUsageThreshold();
      return fast;
    }
    // lookupKey collision with bcrypt mismatch — should never happen for sha256
    logger.warn('MCPToken lookupKey matched but bcrypt did not', { tokenId: fast._id?.toString() });
    return null;
  }

  // Backward compatibility: scan active tokens missing a lookupKey and
  // opportunistically backfill on match.
  const legacyTokens = await this.find({ active: true, lookupKey: { $exists: false }, ...expiryClause });
  for (const token of legacyTokens) {
    if (await bcrypt.compare(tokenValue, token.token)) {
      token.lastUsed = now;
      token.usageCount += 1;
      token.lookupKey = lookupKey;
      await token.save();
      await token.checkUsageThreshold();
      return token;
    }
  }

  return null;
};

/**
 * Check if a tool is allowed for this token
 * @param {string} toolName - The tool name to check
 * @param {string} category - The tool category
 * @returns {boolean} Whether the tool is allowed
 */
mcpTokenSchema.methods.isToolAllowed = function(toolName, category = null) {
  // Check denied list first
  if (this.deniedTools.includes(toolName)) {
    return false;
  }

  // Check specific allowed tools
  if (this.allowedTools.length > 0) {
    return this.allowedTools.includes(toolName);
  }

  // Check category permissions
  if (this.permissions.includes('*')) {
    return true;
  }

  if (category && this.permissions.includes(category)) {
    return true;
  }

  return false;
};

/**
 * Determine whether a client IP address is permitted to use this token.
 *
 * Rules (applied in order):
 * 1. If `blockedIps` is non-empty and the IP matches any blocked CIDR, deny.
 * 2. If `allowedIps` is non-empty and the IP does NOT match any allowed CIDR, deny.
 * 3. Otherwise, allow.
 *
 * @param {string} clientIp - The IP address of the client (IPv4 or IPv6)
 * @returns {boolean} true if the IP is allowed, false otherwise
 */
mcpTokenSchema.methods.isIpAllowed = function(clientIp) {
  const hasBlock = Array.isArray(this.blockedIps) && this.blockedIps.length > 0;
  const hasAllow = Array.isArray(this.allowedIps) && this.allowedIps.length > 0;
  // Unrestricted tokens never depend on the caller's address being known
  if (!hasBlock && !hasAllow) return true;

  clientIp = normalizeIp(clientIp);
  if (!clientIp || net.isIP(clientIp) === 0) {
    logger.warn('MCPToken.isIpAllowed called with invalid IP', { tokenId: this._id?.toString(), clientIp });
    return false;
  }

  // Block list takes precedence
  if (Array.isArray(this.blockedIps) && this.blockedIps.length > 0) {
    for (const cidr of this.blockedIps) {
      if (isIpInCidr(clientIp, cidr)) {
        logger.debug('MCPToken IP blocked by block list', { tokenId: this._id?.toString(), clientIp, cidr });
        return false;
      }
    }
  }

  // If an allow list is defined, the IP must match at least one entry
  if (Array.isArray(this.allowedIps) && this.allowedIps.length > 0) {
    for (const cidr of this.allowedIps) {
      if (isIpInCidr(clientIp, cidr)) {
        return true;
      }
    }
    logger.debug('MCPToken IP not in allow list', { tokenId: this._id?.toString(), clientIp });
    return false;
  }

  // No restrictions
  return true;
};

/**
 * Revoke the token
 */
mcpTokenSchema.methods.revoke = async function() {
  this.active = false;
  await this.save();
  logger.info(`Revoked MCP token: ${this.name} (${this.tokenPrefix})`);
};

/**
 * Format for display (safe, no sensitive data)
 */
mcpTokenSchema.methods.toDisplay = function() {
  return {
    id: this._id,
    name: this.name,
    tokenPrefix: this.tokenPrefix,
    permissions: this.permissions,
    allowedTools: this.allowedTools,
    deniedTools: this.deniedTools,
    allowedIps: this.allowedIps,
    blockedIps: this.blockedIps,
    expiresAt: this.expiresAt,
    lastUsed: this.lastUsed,
    usageCount: this.usageCount,
    active: this.active,
    createdBy: this.createdBy,
    description: this.description,
    createdAt: this.createdAt
  };
};

/**
 * Get all active tokens
 */
mcpTokenSchema.statics.getActive = async function() {
  return this.find({
    active: true,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ]
  });
};

/**
 * Clean up expired tokens
 */
mcpTokenSchema.statics.cleanupExpired = async function() {
  const result = await this.updateMany(
    {
      active: true,
      expiresAt: { $lt: new Date() }
    },
    {
      active: false
    }
  );

  if (result.modifiedCount > 0) {
    logger.info(`Deactivated ${result.modifiedCount} expired MCP tokens`);
  }

  return result.modifiedCount;
};

/**
 * Track token usage analytics - records peak usage hours and most accessed tools
 * @param {string} toolName - The tool being accessed
 */
mcpTokenSchema.methods.trackUsageAnalytics = async function(toolName) {
  const currentHour = new Date().getHours().toString();
  const currentCount = this.usageAnalytics.peakUsageTimes.get(currentHour) || 0;
  this.usageAnalytics.peakUsageTimes.set(currentHour, currentCount + 1);

  const toolCount = this.usageAnalytics.mostAccessedTools.get(toolName) || 0;
  this.usageAnalytics.mostAccessedTools.set(toolName, toolCount + 1);

  await this.save();
};

/**
 * Aggregate usage analytics across all active tokens
 * @returns {Object} Aggregated analytics data
 */
mcpTokenSchema.statics.aggregateUsageAnalytics = async function() {
  const tokens = await this.find({ active: true });
  const aggregated = {
    peakUsageTimes: {},
    mostAccessedTools: {}
  };

  for (const token of tokens) {
    if (token.usageAnalytics?.peakUsageTimes) {
      for (const [hour, count] of token.usageAnalytics.peakUsageTimes) {
        aggregated.peakUsageTimes[hour] = (aggregated.peakUsageTimes[hour] || 0) + count;
      }
    }
    if (token.usageAnalytics?.mostAccessedTools) {
      for (const [tool, count] of token.usageAnalytics.mostAccessedTools) {
        aggregated.mostAccessedTools[tool] = (aggregated.mostAccessedTools[tool] || 0) + count;
      }
    }
  }

  return aggregated;
};

/**
 * Check usage threshold and notify if necessary
 */
mcpTokenSchema.methods.checkUsageThreshold = async function() {
  if (this.usageCount >= this.usageThreshold) {
    logger.warn(`Token usage threshold exceeded for: ${this.name} (${this.tokenPrefix})`);
    // Additional notification logic (e.g., send email) can be implemented here
  }
};

export const MCPToken = mongoose.model('MCPToken', mcpTokenSchema);
export { isIpInCidr, normalizeIpList };
