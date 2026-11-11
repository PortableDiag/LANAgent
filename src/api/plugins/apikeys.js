import { BasePlugin } from '../core/basePlugin.js';
import apiKeyService from '../../services/apiKeyService.js';
import { logger } from '../../utils/logger.js';
import NodeCache from 'node-cache';
import ApiKey from '../../models/ApiKey.js';

export default class ApiKeysPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'apikeys';
    this.version = '1.0.0';
    this.description = 'API key management for external applications and services';
    this.category = 'system';
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    this.commands = [
      {
        command: 'create',
        description: 'Create a new API key',
        usage: 'create({ name: "My App", description: "Production API key", expiresIn: "30d", rateLimit: 100 })'
      },
      {
        command: 'list',
        description: 'List all API keys with pagination',
        usage: 'list({ status: "active", page: 1, pageSize: 20 })'
      },
      {
        command: 'revoke',
        description: 'Revoke an API key',
        usage: 'revoke({ keyId: "key_id" })'
      },
      {
        command: 'suspend',
        description: 'Temporarily suspend an API key',
        usage: 'suspend({ keyId: "key_id" })'
      },
      {
        command: 'reactivate',
        description: 'Reactivate a suspended API key',
        usage: 'reactivate({ keyId: "key_id" })'
      },
      {
        command: 'delete',
        description: 'Permanently delete an API key',
        usage: 'delete({ keyId: "key_id" })'
      },
      {
        command: 'stats',
        description: 'Get API key usage statistics',
        usage: 'stats()'
      },
      {
        command: 'fix',
        description: 'Fix API keys with incorrect expiration dates',
        usage: 'fix({ dryRun: true })'
      },
      {
        command: 'update',
        description: 'Update an existing API key\'s metadata',
        usage: 'update({ keyId: "...", name: "...", description: "...", rateLimit: 100, expiresIn: "30d" })'
      }
    ];
  }

  async initialize() {
    logger.info('API Keys plugin initialized');
  }

  async execute(params) {
    const { action } = params;
    
    this.validateParams(params, {
      action: { 
        required: true, 
        type: 'string',
        enum: ['create', 'list', 'revoke', 'suspend', 'reactivate', 'delete', 'stats', 'fix', 'update']
      }
    });

    // listKeys caches for 5 minutes; any action that changes a key must drop that cache,
    // or a revoked/renamed key keeps showing its old state.
    if (!['list', 'stats'].includes(action) && !(action === 'fix' && params.dryRun !== false)) {
      this.cache.flushAll();
    }

    switch (action) {
      case 'create':
        return await this.createKey(params);
      case 'list':
        return await this.listKeys(params);
      case 'revoke':
        return await this.revokeKey(params);
      case 'suspend':
        return await this.suspendKey(params);
      case 'reactivate':
        return await this.reactivateKey(params);
      case 'delete':
        return await this.deleteKey(params);
      case 'stats':
        return await this.getStats();
      case 'fix':
        return await this.fixExpiredKeys(params);
      case 'update':
        return await this.updateKey(params);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Best-effort record of a key lifecycle action to agent memory.
   * The underlying key operation has already succeeded by the time this runs,
   * so a memory failure must never bubble up and mark the action as failed.
   */
  async _rememberKeyAction(summary, metadata) {
    try {
      await this.storeMemory(summary, metadata);
    } catch (error) {
      logger.warn(`Failed to record key action to memory (non-fatal): ${error.message}`);
    }
  }

  async createKey(params) {
    const { name, description, expiresIn, rateLimit = 100 } = params;
    
    if (!name) {
      throw new Error('API key name is required');
    }

    try {
      // Calculate expiration date if expiresIn is provided
      let expiresAt = null;
      if (expiresIn) {
        expiresAt = this.calculateExpiration(expiresIn);
      }

      const keyInfo = await apiKeyService.createApiKey({
        name,
        description,
        expiresAt,
        rateLimit,
        createdBy: 'agent'
      });

      // Save the key info to agent's memory (best-effort)
      await this._rememberKeyAction(
        `Created API key: ${name}`,
        { 
          type: 'api_key_created',
          keyId: keyInfo.id,
          keyPrefix: keyInfo.keyPrefix,
          name: keyInfo.name
        }
      );

      return {
        success: true,
        message: `API key created successfully`,
        key: keyInfo.key,
        keyId: keyInfo.id,
        keyPrefix: keyInfo.keyPrefix,
        name: keyInfo.name,
        expiresAt: keyInfo.expiresAt,
        important: 'Save this key securely - you won\'t be able to see it again!'
      };
    } catch (error) {
      logger.error('Failed to create API key:', error);
      throw new Error(`Failed to create API key: ${error.message}`);
    }
  }

  async listKeys(params) {
    const { status, page = 1, pageSize = 20 } = params;

    try {
      const filter = {};
      if (status) filter.status = status;

      // Use cached data if available
      const cacheKey = `listKeys:${JSON.stringify(filter)}`;
      let keys = this.cache.get(cacheKey);

      if (keys === undefined) {
        keys = await apiKeyService.listApiKeys(filter);
        this.cache.set(cacheKey, keys);
      }

      // Apply pagination
      const startIndex = (page - 1) * pageSize;
      const paginatedKeys = keys.slice(startIndex, startIndex + pageSize);

      return {
        success: true,
        total: keys.length,
        page,
        pageSize,
        totalPages: Math.ceil(keys.length / pageSize),
        shown: paginatedKeys.length,
        keys: paginatedKeys.map(key => ({
          id: key.id,
          name: key.name,
          description: key.description,
          keyPrefix: key.keyPrefix,
          status: key.status,
          usageCount: key.usageCount,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          expiresAt: key.expiresAt
        }))
      };
    } catch (error) {
      logger.error('Failed to list API keys:', error);
      throw new Error(`Failed to list API keys: ${error.message}`);
    }
  }

  async revokeKey(params) {
    const { keyId } = params;
    
    if (!keyId) {
      throw new Error('Key ID is required');
    }

    try {
      const success = await apiKeyService.revokeApiKey(keyId);
      
      if (success) {
        await this._rememberKeyAction(
          `Revoked API key: ${keyId}`,
          { type: 'api_key_revoked', keyId }
        );
        
        return {
          success: true,
          message: 'API key revoked successfully'
        };
      } else {
        return {
          success: false,
          error: 'API key not found'
        };
      }
    } catch (error) {
      logger.error('Failed to revoke API key:', error);
      throw new Error(`Failed to revoke API key: ${error.message}`);
    }
  }

  async suspendKey(params) {
    const { keyId } = params;
    
    if (!keyId) {
      throw new Error('Key ID is required');
    }

    try {
      const success = await apiKeyService.suspendApiKey(keyId);
      
      if (success) {
        return {
          success: true,
          message: 'API key suspended successfully'
        };
      } else {
        return {
          success: false,
          error: 'API key not found'
        };
      }
    } catch (error) {
      logger.error('Failed to suspend API key:', error);
      throw new Error(`Failed to suspend API key: ${error.message}`);
    }
  }

  async reactivateKey(params) {
    const { keyId } = params;
    
    if (!keyId) {
      throw new Error('Key ID is required');
    }

    try {
      const success = await apiKeyService.reactivateApiKey(keyId);
      
      if (success) {
        return {
          success: true,
          message: 'API key reactivated successfully'
        };
      } else {
        return {
          success: false,
          error: 'API key not found or not suspended'
        };
      }
    } catch (error) {
      logger.error('Failed to reactivate API key:', error);
      throw new Error(`Failed to reactivate API key: ${error.message}`);
    }
  }

  async deleteKey(params) {
    const { keyId } = params;
    
    if (!keyId) {
      throw new Error('Key ID is required');
    }

    try {
      const success = await apiKeyService.deleteApiKey(keyId);
      
      if (success) {
        await this._rememberKeyAction(
          `Deleted API key: ${keyId}`,
          { type: 'api_key_deleted', keyId }
        );
        
        return {
          success: true,
          message: 'API key deleted permanently'
        };
      } else {
        return {
          success: false,
          error: 'API key not found'
        };
      }
    } catch (error) {
      logger.error('Failed to delete API key:', error);
      throw new Error(`Failed to delete API key: ${error.message}`);
    }
  }

  async getStats() {
    try {
      const stats = await apiKeyService.getApiKeyStats();
      
      return {
        success: true,
        stats: {
          total: stats.total,
          active: stats.active,
          suspended: stats.suspended,
          revoked: stats.revoked,
          totalUsage: stats.totalUsage,
          averageUsagePerKey: stats.total > 0 ? Math.round(stats.totalUsage / stats.total) : 0
        }
      };
    } catch (error) {
      logger.error('Failed to get API key stats:', error);
      throw new Error(`Failed to get API key stats: ${error.message}`);
    }
  }

  async fixExpiredKeys(params) {
    const { dryRun = true } = params;
    
    try {
      const result = await apiKeyService.fixExpiredKeys(dryRun);
      
      if (result.keysFound === 0) {
        return {
          success: true,
          message: 'No expired API keys found. All keys are working correctly.'
        };
      }
      
      return {
        success: true,
        message: result.message,
        keysFound: result.keysFound,
        dryRun: result.dryRun,
        fixes: result.fixes
      };
    } catch (error) {
      logger.error('Failed to fix expired keys:', error);
      throw new Error(`Failed to fix expired keys: ${error.message}`);
    }
  }

  /**
   * Update an existing API key's metadata (name, description, rateLimit, expiresAt).
   * Only provided fields are updated; others remain unchanged.
   * @param {Object} params - { keyId, name, description, rateLimit, expiresIn }
   * @returns {Object} success response with updated key info
   */
  async updateKey(params) {
    const { keyId, name, description, rateLimit, expiresIn } = params;
    
    if (!keyId) {
      throw new Error('Key ID is required');
    }

    const updates = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('name must be a non-empty string');
      updates.name = name.trim();
    }
    if (description !== undefined) {
      if (typeof description !== 'string') throw new Error('description must be a string');
      updates.description = description;
    }
    if (rateLimit !== undefined) {
      const n = Number(rateLimit);
      if (!Number.isInteger(n) || n < 1) throw new Error('rateLimit must be a positive whole number (requests per minute)');
      updates.rateLimit = n;
    }
    if (expiresIn !== undefined) {
      // calculateExpiration throws on anything it cannot parse, so a typo can never
      // clear the expiry (null = never expires). Removing an expiry is not offered here.
      if (typeof expiresIn !== 'string') throw new Error('expiresIn must be a duration like "30d", "24h" or "60m"');
      updates.expiresAt = this.calculateExpiration(expiresIn);
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update provided');
    }

    try {
      const updatedKey = await ApiKey.findByIdAndUpdate(
        keyId,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updatedKey) {
        return {
          success: false,
          error: 'API key not found'
        };
      }

      await this._rememberKeyAction(
        `Updated API key: ${keyId}`,
        { type: 'api_key_updated', keyId, updates }
      );

      return {
        success: true,
        message: 'API key updated successfully',
        key: {
          id: updatedKey.id,
          name: updatedKey.name,
          description: updatedKey.description,
          rateLimit: updatedKey.rateLimit,
          expiresAt: updatedKey.expiresAt
        }
      };
    } catch (error) {
      logger.error('Failed to update API key:', error);
      throw new Error(`Failed to update API key: ${error.message}`);
    }
  }

  calculateExpiration(expiresIn) {
    const now = new Date();
    
    // Parse duration string (e.g., "30d", "1h", "60m")
    const match = expiresIn.match(/^(\d+)([dhm])$/);
    if (!match) {
      throw new Error('Invalid expiration format. Use format like "30d", "24h", or "60m"');
    }
    
    const [, amount, unit] = match;
    const value = parseInt(amount);
    
    switch (unit) {
      case 'd': // days
        now.setDate(now.getDate() + value);
        break;
      case 'h': // hours
        now.setHours(now.getHours() + value);
        break;
      case 'm': // minutes
        now.setMinutes(now.getMinutes() + value);
        break;
    }
    
    return now;
  }

  async detectIntent(message) {
    const lowerMessage = message.toLowerCase();
    
    // API key creation patterns
    if (lowerMessage.includes('create') && (lowerMessage.includes('api key') || lowerMessage.includes('apikey'))) {
      return { intent: 51, confidence: 0.9 };
    }
    
    // List API keys
    if ((lowerMessage.includes('list') || lowerMessage.includes('show')) && 
        (lowerMessage.includes('api key') || lowerMessage.includes('apikey'))) {
      return { intent: 51, confidence: 0.85 };
    }
    
    // Revoke/suspend/delete API keys
    if ((lowerMessage.includes('revoke') || lowerMessage.includes('suspend') || 
         lowerMessage.includes('delete') || lowerMessage.includes('remove')) && 
        (lowerMessage.includes('api key') || lowerMessage.includes('apikey'))) {
      return { intent: 51, confidence: 0.9 };
    }
    
    // API key stats
    if (lowerMessage.includes('api') && 
        (lowerMessage.includes('stats') || lowerMessage.includes('usage') || lowerMessage.includes('statistics'))) {
      return { intent: 51, confidence: 0.8 };
    }
    
    return null;
  }
}
