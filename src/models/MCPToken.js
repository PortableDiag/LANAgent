import mongoose from 'mongoose';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

/**
 * MCPToken model for managing access tokens for MCP server mode
 * Allows external MCP clients to access LANAgent tools
 */

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
    expiresIn = null, // milliseconds, null = never expires
    createdBy = 'system',
    description = '',
    usageThreshold = 1000 // Default threshold
  } = options;

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
