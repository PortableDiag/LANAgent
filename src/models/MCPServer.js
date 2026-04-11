import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import fs from 'fs';
import path from 'path';
import { safeJsonParse } from '../utils/jsonUtils.js';
import { retryOperation } from '../utils/retryUtils.js';
import axios from 'axios';

/**
 * MCPServer model for storing MCP server configurations
 * Supports both stdio and SSE transport types
 */

// Initialize cache with 5-minute default TTL
const serverCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false
});

const mcpServerSchema = new mongoose.Schema({
  // Display name for the server
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },

  // Server URL (for SSE) or command path (for stdio)
  url: {
    type: String,
    required: true
  },

  // Transport type
  transport: {
    type: String,
    enum: ['stdio', 'sse'],
    default: 'sse'
  },

  // For stdio transport: command and arguments
  command: {
    type: String,
    default: null
  },
  args: {
    type: [String],
    default: []
  },

  // Server configuration
  enabled: {
    type: Boolean,
    default: true,
    index: true
  },
  autoConnect: {
    type: Boolean,
    default: true
  },

  // Authentication configuration (encrypted)
  authType: {
    type: String,
    enum: ['none', 'apiKey', 'bearer', 'basic'],
    default: 'none'
  },
  authCredentials: {
    type: String,
    default: null
  },

  // Discovered tools from the server (cached)
  discoveredTools: [{
    name: {
      type: String,
      required: true
    },
    description: String,
    inputSchema: mongoose.Schema.Types.Mixed,
    registeredIntent: String // Intent ID if registered with intent system
  }],

  // Connection status
  status: {
    type: String,
    enum: ['disconnected', 'connecting', 'connected', 'error'],
    default: 'disconnected'
  },
  lastConnected: Date,
  lastError: String,
  lastToolDiscovery: Date,

  // Metadata
  description: String,
  tags: [String],

  // Webhook URL for status notifications
  webhookUrl: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
mcpServerSchema.index({ enabled: 1, autoConnect: 1 });
mcpServerSchema.index({ status: 1, enabled: 1 });

// Encrypt credentials before saving
mcpServerSchema.pre('save', function(next) {
  if (this.isModified('authCredentials') && this.authCredentials) {
    try {
      // Only encrypt if not already encrypted (check for base64 pattern)
      if (!this.authCredentials.match(/^[A-Za-z0-9+/=]{44,}$/)) {
        this.authCredentials = encrypt(this.authCredentials);
      }
    } catch (error) {
      logger.error('Failed to encrypt MCP server credentials:', error);
      return next(error);
    }
  }
  next();
});

// Clear cache on save
mcpServerSchema.post('save', function(doc) {
  serverCache.del(`server:${doc._id}`);
  serverCache.del(`server:name:${doc.name}`);
  serverCache.del('servers:all');
  serverCache.del('servers:enabled');
  logger.debug(`Cleared MCP server cache after save: ${doc.name}`);
});

// Clear cache on update
mcpServerSchema.post('findOneAndUpdate', function(doc) {
  if (doc) {
    serverCache.del(`server:${doc._id}`);
    serverCache.del(`server:name:${doc.name}`);
    serverCache.del('servers:all');
    serverCache.del('servers:enabled');
    logger.debug(`Cleared MCP server cache after update: ${doc.name}`);
  }
});

// Clear cache on delete
mcpServerSchema.post('findOneAndDelete', function(doc) {
  if (doc) {
    serverCache.del(`server:${doc._id}`);
    serverCache.del(`server:name:${doc.name}`);
    serverCache.del('servers:all');
    serverCache.del('servers:enabled');
    logger.debug(`Cleared MCP server cache after delete: ${doc.name}`);
  }
});

/**
 * Get decrypted credentials
 * @returns {string|null} Decrypted credentials
 */
mcpServerSchema.methods.getDecryptedCredentials = function() {
  if (!this.authCredentials) return null;
  try {
    return decrypt(this.authCredentials);
  } catch (error) {
    logger.error('Failed to decrypt MCP server credentials:', error);
    return null;
  }
};

/**
 * Get auth headers for HTTP requests
 * @returns {object} Headers object
 */
mcpServerSchema.methods.getAuthHeaders = function() {
  const headers = {};
  const creds = this.getDecryptedCredentials();

  if (!creds || this.authType === 'none') {
    return headers;
  }

  try {
    const parsed = JSON.parse(creds);

    switch (this.authType) {
      case 'apiKey':
        if (parsed.headerName && parsed.value) {
          headers[parsed.headerName] = parsed.value;
        }
        break;
      case 'bearer':
        if (parsed.token) {
          headers['Authorization'] = `Bearer ${parsed.token}`;
        }
        break;
      case 'basic':
        if (parsed.username && parsed.password) {
          const base64 = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
          headers['Authorization'] = `Basic ${base64}`;
        }
        break;
    }
  } catch (error) {
    logger.error('Failed to parse auth credentials:', error);
  }

  return headers;
};

/**
 * Update connection status with retry mechanism
 * @param {string} status - New status
 * @param {string} error - Optional error message
 */
mcpServerSchema.methods.updateStatus = async function(status, error = null) {
  await retryOperation(async () => {
    this.status = status;
    if (status === 'connected') {
      this.lastConnected = new Date();
      this.lastError = null;
    } else if (status === 'error' && error) {
      this.lastError = error;
    }
    await this.save();
    await this.notifyStatusChange(status, error);
  }, {
    retries: 3,
    onRetry: (err, attempt) => {
      logger.warn(`Retrying updateStatus (attempt ${attempt}):`, err);
    }
  });
};

/**
 * Notify status change via webhook
 * @param {string} status - New status
 * @param {string} error - Optional error message
 */
mcpServerSchema.methods.notifyStatusChange = async function(status, error = null) {
  if (!this.webhookUrl) return;

  const payload = {
    serverName: this.name,
    status,
    error,
    timestamp: new Date()
  };

  try {
    await axios.post(this.webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    logger.info(`Webhook notification sent for server: ${this.name}`);
  } catch (err) {
    logger.error(`Failed to send webhook notification for server: ${this.name}`, err);
  }
};

/**
 * Update discovered tools
 * @param {Array} tools - Array of tool definitions
 */
mcpServerSchema.methods.updateTools = async function(tools) {
  this.discoveredTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema || tool.input_schema
  }));
  this.lastToolDiscovery = new Date();
  await this.save();
};

/**
 * Format for display
 * @returns {object} Display-friendly object
 */
mcpServerSchema.methods.toDisplay = function() {
  return {
    id: this._id,
    name: this.name,
    url: this.url,
    transport: this.transport,
    enabled: this.enabled,
    autoConnect: this.autoConnect,
    status: this.status,
    authType: this.authType,
    toolCount: this.discoveredTools?.length || 0,
    lastConnected: this.lastConnected,
    lastError: this.lastError,
    description: this.description,
    tags: this.tags
  };
};

/**
 * Get cached server by ID
 */
mcpServerSchema.statics.getCached = async function(id, ttl = 300) {
  const cacheKey = `server:${id}`;
  const cached = serverCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const doc = await this.findById(id);
  if (doc) {
    serverCache.set(cacheKey, doc, ttl);
  }
  return doc;
};

/**
 * Get cached server by name
 */
mcpServerSchema.statics.getByName = async function(name, ttl = 300) {
  const cacheKey = `server:name:${name}`;
  const cached = serverCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const doc = await this.findOne({ name });
  if (doc) {
    serverCache.set(cacheKey, doc, ttl);
  }
  return doc;
};

/**
 * Get all enabled servers
 */
mcpServerSchema.statics.getEnabled = async function(ttl = 300) {
  const cacheKey = 'servers:enabled';
  const cached = serverCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const docs = await this.find({ enabled: true });
  serverCache.set(cacheKey, docs, ttl);
  return docs;
};

/**
 * Get servers with autoConnect enabled
 */
mcpServerSchema.statics.getAutoConnect = async function() {
  return this.find({ enabled: true, autoConnect: true });
};

/**
 * Clear the cache
 */
mcpServerSchema.statics.clearCache = function() {
  serverCache.flushAll();
  logger.info('MCP server cache cleared');
};

/**
 * Watch for configuration file changes and update server instances dynamically
 * @param {string} configFilePath - Path to the configuration file
 */
mcpServerSchema.statics.watchConfigFile = function(configFilePath) {
  const absolutePath = path.resolve(configFilePath);
  fs.watch(absolutePath, async (eventType, filename) => {
    if (eventType === 'change') {
      logger.info(`Configuration file changed: ${filename}`);
      try {
        const configData = fs.readFileSync(absolutePath, 'utf-8');
        const configJson = safeJsonParse(configData, null);
        if (configJson) {
          await this.updateServerConfigurations(configJson);
        }
      } catch (error) {
        logger.error('Failed to read or parse configuration file:', error);
      }
    }
  });
};

/**
 * Update server configurations dynamically
 * @param {object} configJson - Parsed configuration JSON
 */
mcpServerSchema.statics.updateServerConfigurations = async function(configJson) {
  try {
    for (const serverConfig of configJson.servers) {
      const existingServer = await this.findOne({ name: serverConfig.name });
      if (existingServer) {
        existingServer.set(serverConfig);
        await existingServer.save();
        logger.info(`Updated configuration for server: ${serverConfig.name}`);
      } else {
        await this.create(serverConfig);
        logger.info(`Created new server configuration: ${serverConfig.name}`);
      }
    }
    this.clearCache();
  } catch (error) {
    logger.error('Failed to update server configurations:', error);
  }
};

export const MCPServer = mongoose.model('MCPServer', mcpServerSchema);
