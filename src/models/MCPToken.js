import mongoose from 'mongoose';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
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

  // Calculate expiration
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn) : null;

  // Create the document
  const doc = new this({
    name,
    token: hashedToken,
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
 * Validate a token and return the document if valid
 * @param {string} tokenValue - The plaintext token
 * @returns {object|null} Token document or null if invalid
 */
mcpTokenSchema.statics.validateToken = async function(tokenValue) {
  if (!tokenValue || !tokenValue.startsWith('mcp_')) {
    return null;
  }

  // Find all active tokens
  const tokens = await this.find({ active: true });

  for (const token of tokens) {
    // Check if expired
    if (token.expiresAt && token.expiresAt < new Date()) {
      continue;
    }

    // Compare token
    const isMatch = await bcrypt.compare(tokenValue, token.token);
    if (isMatch) {
      // Update usage stats
      token.lastUsed = new Date();
      token.usageCount += 1;
      await token.save();

      // Check usage threshold and notify if necessary
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
