import ApiKey from '../models/ApiKey.js';
import { logger } from '../utils/logger.js';

class ApiKeyService {
  constructor() {
    this.rateLimitCache = new Map(); // Simple in-memory rate limit tracking
  }

  /**
   * Create a new API key
   * @param {Object} params - Key parameters
   * @param {string} params.name - Name for the key
   * @param {string} params.description - Optional description
   * @param {string} params.createdBy - Who created it (user, agent, system)
   * @param {Date} params.expiresAt - Optional expiration date
   * @param {number} params.rateLimit - Requests per minute limit
   * @returns {Object} The created key info including the raw key (only returned once)
   */
  async createApiKey(params) {
    try {
      const { name, description = '', createdBy = 'user', expiresAt = null, rateLimit = 100 } = params;
      
      // Generate a new key
      const rawKey = ApiKey.generateKey();
      const keyHash = ApiKey.hashKey(rawKey);
      const keyPrefix = ApiKey.getKeyPrefix(rawKey);
      
      // Create the API key document
      const apiKey = new ApiKey({
        keyHash,
        keyPrefix,
        name,
        description,
        createdBy,
        expiresAt,
        rateLimit,
        status: 'active'
      });
      
      await apiKey.save();
      
      logger.info(`API key created: ${name} by ${createdBy}, ID: ${apiKey._id}, prefix: ${keyPrefix}`);
      
      // Verify the key was saved
      const savedKey = await ApiKey.findById(apiKey._id);
      if (!savedKey) {
        logger.error(`API key failed to save properly - not found after save: ${name}`);
        throw new Error('API key creation failed - database save error');
      }
      
      // Return the key info including the raw key
      // IMPORTANT: The raw key is only returned once, on creation
      return {
        id: apiKey._id,
        key: rawKey,
        keyPrefix,
        name,
        description,
        createdAt: apiKey.createdAt,
        expiresAt,
        rateLimit,
        status: 'active'
      };
    } catch (error) {
      logger.error('Failed to create API key:', error);
      throw error;
    }
  }

  /**
   * Validate an API key and return its info
   * @param {string} key - The raw API key
   * @returns {Object|null} The key info if valid, null otherwise
   */
  async validateApiKey(key) {
    try {
      if (!key || !key.startsWith('la_')) {
        logger.debug('API key validation failed: invalid format or missing prefix');
        return null;
      }
      
      const keyHash = ApiKey.hashKey(key);
      const keyPrefix = ApiKey.getKeyPrefix(key);
      const apiKey = await ApiKey.findOne({ keyHash });
      
      if (!apiKey) {
        logger.warn(`API key validation failed: key not found in database. Prefix: ${keyPrefix}, Hash: ${keyHash.substring(0, 8)}...`);
        return null;
      }
      
      // Log detailed validation info
      logger.debug('API key found:', {
        name: apiKey.name,
        status: apiKey.status,
        expiresAt: apiKey.expiresAt,
        isExpired: apiKey.expiresAt && apiKey.expiresAt < new Date()
      });
      
      if (!apiKey.isValid()) {
        logger.debug('API key validation failed: isValid() returned false', {
          status: apiKey.status,
          expiresAt: apiKey.expiresAt,
          now: new Date(),
          isExpired: apiKey.expiresAt && apiKey.expiresAt < new Date()
        });
        return null;
      }
      
      // Check rate limit
      if (!this.checkRateLimit(apiKey._id.toString(), apiKey.rateLimit)) {
        logger.warn(`Rate limit exceeded for API key: ${apiKey.name}`);
        return null;
      }
      
      // Update usage asynchronously (don't wait)
      apiKey.incrementUsage().catch(err => {
        logger.error('Failed to increment API key usage:', err);
      });
      
      return {
        id: apiKey._id,
        name: apiKey.name,
        scopes: apiKey.scopes,
        metadata: apiKey.metadata
      };
    } catch (error) {
      logger.error('Failed to validate API key:', error);
      return null;
    }
  }

  /**
   * Simple rate limiting check
   * @param {string} keyId - The API key ID
   * @param {number} limit - Requests per minute limit
   * @returns {boolean} True if within limit
   */
  checkRateLimit(keyId, limit) {
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window
    
    if (!this.rateLimitCache.has(keyId)) {
      this.rateLimitCache.set(keyId, []);
    }
    
    const requests = this.rateLimitCache.get(keyId);
    // Remove old requests outside the window
    const recentRequests = requests.filter(timestamp => timestamp > windowStart);
    
    if (recentRequests.length >= limit) {
      return false;
    }
    
    recentRequests.push(now);
    this.rateLimitCache.set(keyId, recentRequests);
    
    return true;
  }

  /**
   * List all API keys (without the raw keys)
   * @param {Object} filter - Optional filter
   * @returns {Array} List of API keys
   */
  async listApiKeys(filter = {}) {
    try {
      const query = {};
      if (filter.status) query.status = filter.status;
      if (filter.createdBy) query.createdBy = filter.createdBy;
      
      const keys = await ApiKey.find(query).sort({ createdAt: -1 });
      
      return keys.map(key => ({
        id: key._id,
        name: key.name,
        description: key.description,
        keyPrefix: key.keyPrefix,
        status: key.status,
        usageCount: key.usageCount,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdBy: key.createdBy,
        rateLimit: key.rateLimit,
        isSystemKey: key.isSystemKey || false
      }));
    } catch (error) {
      logger.error('Failed to list API keys:', error);
      throw error;
    }
  }

  /**
   * Revoke an API key
   * @param {string} keyId - The API key ID
   * @returns {boolean} Success status
   */
  async revokeApiKey(keyId) {
    try {
      const result = await ApiKey.updateOne(
        { _id: keyId },
        { status: 'revoked' }
      );
      
      if (result.modifiedCount > 0) {
        logger.info(`API key revoked: ${keyId}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to revoke API key:', error);
      throw error;
    }
  }

  /**
   * Suspend an API key (can be reactivated)
   * @param {string} keyId - The API key ID
   * @returns {boolean} Success status
   */
  async suspendApiKey(keyId) {
    try {
      const result = await ApiKey.updateOne(
        { _id: keyId },
        { status: 'suspended' }
      );
      
      if (result.modifiedCount > 0) {
        logger.info(`API key suspended: ${keyId}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to suspend API key:', error);
      throw error;
    }
  }

  /**
   * Reactivate a suspended API key
   * @param {string} keyId - The API key ID
   * @returns {boolean} Success status
   */
  async reactivateApiKey(keyId) {
    try {
      const result = await ApiKey.updateOne(
        { _id: keyId, status: 'suspended' },
        { status: 'active' }
      );
      
      if (result.modifiedCount > 0) {
        logger.info(`API key reactivated: ${keyId}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to reactivate API key:', error);
      throw error;
    }
  }

  /**
   * Delete an API key permanently
   * @param {string} keyId - The API key ID
   * @returns {boolean} Success status
   */
  async deleteApiKey(keyId) {
    try {
      const result = await ApiKey.deleteOne({ _id: keyId });
      
      if (result.deletedCount > 0) {
        logger.info(`API key deleted: ${keyId}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to delete API key:', error);
      throw error;
    }
  }

  /**
   * Get statistics for API keys
   * @returns {Object} Statistics
   */
  async getApiKeyStats() {
    try {
      const stats = await ApiKey.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalUsage: { $sum: '$usageCount' }
          }
        }
      ]);
      
      const result = {
        total: 0,
        active: 0,
        suspended: 0,
        revoked: 0,
        totalUsage: 0
      };
      
      stats.forEach(stat => {
        result[stat._id] = stat.count;
        result.total += stat.count;
        result.totalUsage += stat.totalUsage;
      });
      
      return result;
    } catch (error) {
      logger.error('Failed to get API key stats:', error);
      throw error;
    }
  }

  /**
   * Set usage alert for an API key
   * @param {string} keyId - The API key ID
   * @param {number} limit - Usage limit to trigger alert
   * @param {string} notifyEmail - Email to send alert to
   * @returns {boolean} - Success status
   */
  async setApiKeyAlert(keyId, limit, notifyEmail) {
    try {
      const apiKey = await ApiKey.findById(keyId);
      if (!apiKey) {
        throw new Error('API key not found');
      }

      // Add alert configuration to the API key
      apiKey.alertConfig = {
        enabled: true,
        usageLimit: limit,
        notifyEmail: notifyEmail,
        lastAlertSent: null
      };

      await apiKey.save();
      
      logger.info(`Usage alert set for API key ${keyId}: limit ${limit}, notify ${notifyEmail}`);
      return true;
    } catch (error) {
      logger.error('Failed to set API key alert:', error);
      return false;
    }
  }

  /**
   * Check and send usage alerts for all API keys
   * This should be called periodically (e.g., via cron job)
   */
  async checkUsageAlerts() {
    try {
      const keysWithAlerts = await ApiKey.find({
        'alertConfig.enabled': true,
        status: 'active'
      });

      for (const apiKey of keysWithAlerts) {
        const { usageLimit, notifyEmail, lastAlertSent } = apiKey.alertConfig;
        
        // Check if usage exceeds limit
        if (apiKey.usageCount >= usageLimit) {
          // Check if we've already sent an alert recently (within 24 hours)
          const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          if (!lastAlertSent || lastAlertSent < dayAgo) {
            // Send alert (would integrate with email service)
            logger.warn(`API key ${apiKey.name} usage (${apiKey.usage}) exceeds limit (${usageLimit})`);
            
            // Update last alert sent time
            apiKey.alertConfig.lastAlertSent = new Date();
            await apiKey.save();
            
            // TODO: Integrate with email service to send actual notification
            logger.info(`Alert would be sent to ${notifyEmail} for API key ${apiKey.name}`);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to check usage alerts:', error);
    }
  }

  /**
   * Fix API keys with incorrect expiration dates
   * This removes expiration from keys that shouldn't have expired
   * @param {boolean} dryRun - If true, only reports what would be fixed
   * @returns {Object} Summary of fixes
   */
  async fixExpiredKeys(dryRun = true) {
    try {
      // Find all active keys that have expired
      const expiredKeys = await ApiKey.find({
        status: 'active',
        expiresAt: { $lt: new Date() }
      });

      logger.info(`Found ${expiredKeys.length} expired active API keys`);

      const fixes = [];
      
      for (const key of expiredKeys) {
        const daysSinceCreation = (new Date() - key.createdAt) / (1000 * 60 * 60 * 24);
        
        fixes.push({
          id: key._id,
          name: key.name,
          createdAt: key.createdAt,
          expiresAt: key.expiresAt,
          daysSinceCreation: daysSinceCreation.toFixed(1)
        });

        if (!dryRun) {
          // Remove the expiration date
          key.expiresAt = null;
          await key.save();
          logger.info(`Fixed expiration for API key: ${key.name}`);
        }
      }

      return {
        success: true,
        keysFound: expiredKeys.length,
        dryRun,
        fixes,
        message: dryRun 
          ? `Found ${expiredKeys.length} keys that would be fixed. Run with dryRun=false to apply fixes.`
          : `Fixed ${expiredKeys.length} API keys by removing expiration dates.`
      };
    } catch (error) {
      logger.error('Failed to fix expired keys:', error);
      throw error;
    }
  }

  /**
   * Generate detailed usage report for API keys
   * @param {Object} params - Parameters for report generation
   * @param {string} params.startDate - Start date for the report (ISO string)
   * @param {string} params.endDate - End date for the report (ISO string)
   * @param {string} params.keyId - Optional specific key ID to report on
   * @returns {Object} Usage report with statistics
   */
  async generateUsageReport(params = {}) {
    try {
      const { startDate, endDate, keyId } = params;
      const matchStage = {};

      if (keyId) {
        matchStage._id = keyId;
      }

      if (startDate || endDate) {
        matchStage.createdAt = {};
        if (startDate) matchStage.createdAt.$gte = new Date(startDate);
        if (endDate) matchStage.createdAt.$lte = new Date(endDate);
      }

      const usageData = await ApiKey.aggregate([
        { $match: matchStage },
        {
          $project: {
            name: 1,
            usageCount: 1,
            createdAt: 1,
            lastUsedAt: 1,
            isActive: 1,
            permissions: 1,
            daysSinceCreation: {
              $divide: [
                { $subtract: [new Date(), '$createdAt'] },
                1000 * 60 * 60 * 24
              ]
            },
            avgUsagePerDay: {
              $cond: {
                if: { $gt: [{ $subtract: [new Date(), '$createdAt'] }, 0] },
                then: {
                  $divide: [
                    '$usageCount',
                    { $divide: [{ $subtract: [new Date(), '$createdAt'] }, 1000 * 60 * 60 * 24] }
                  ]
                },
                else: '$usageCount'
              }
            }
          }
        },
        { $sort: { usageCount: -1 } }
      ]);

      const totalUsage = usageData.reduce((sum, key) => sum + (key.usageCount || 0), 0);
      const activeKeys = usageData.filter(key => key.isActive).length;

      const report = {
        generatedAt: new Date().toISOString(),
        summary: {
          totalKeys: usageData.length,
          activeKeys,
          inactiveKeys: usageData.length - activeKeys,
          totalUsage,
          averageUsagePerKey: usageData.length > 0 ? Math.round(totalUsage / usageData.length) : 0
        },
        keys: usageData
      };

      logger.info(`Generated API key usage report: ${usageData.length} keys, ${totalUsage} total usage`);
      return report;
    } catch (error) {
      logger.error('Failed to generate usage report:', error);
      throw error;
    }
  }
}

// Export singleton instance
export default new ApiKeyService();