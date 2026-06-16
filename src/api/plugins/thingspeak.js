import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

/**
 * Usage Examples:
 * - Natural language: "use thingspeak to [action]"
 * - Command format: api thingspeak <action> <params>
 * - Telegram: Just type naturally about thingspeak
 */

export default class ThingSpeakPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'thingspeak';
    this.version = '1.0.0';
    this.description = 'An open-source IoT platform with MATLAB analytics for data collection, storage, analysis, visualization, and action from sensors or devices';
    this.commands = [
      {
        command: 'sendData',
        description: 'Send data to a ThingSpeak channel',
        usage: 'sendData [field1] [field2]'
      },
      {
        command: 'readChannel',
        description: 'Read data from a ThingSpeak channel',
        usage: 'readChannel [channelId]'
      },
      {
        command: 'getChannelStatus',
        description: 'Get the status of a ThingSpeak channel',
        usage: 'getChannelStatus [channelId]'
      },
      {
        command: 'sendBulkData',
        description: 'Send bulk data to ThingSpeak channels with rate limiting',
        usage: 'sendBulkData [dataArray] [options]'
      },
      {
        command: 'readBulkChannels',
        description: 'Read data from multiple ThingSpeak channels in parallel',
        usage: 'readBulkChannels [channelIds]'
      },
      {
        command: 'transformAndSendData',
        description: 'Transform data and send it to a ThingSpeak channel',
        usage: 'transformAndSendData [data] [transformations]'
      }
    ];
    
    this.apiKey = process.env.THINGSPEAK_API_KEY;
    this.baseUrl = 'https://api.thingspeak.com';
    
    // ThingSpeak rate limits
    this.rateLimits = {
      free: 15000,     // 15 seconds for free accounts
      paid: 1000       // 1 second for paid accounts (configurable)
    };
    this.maxBulkSize = 100;  // Maximum items in bulk operations
    this.maxConcurrentReads = 5;  // Maximum parallel read operations
  }

  async execute(params) {
    const { action, field1, field2, channelId, dataArray, channelIds, options, data, transformations } = params;

    try {
      switch(action) {
        case 'sendData':
          return await this.sendData(field1, field2);

        case 'readChannel':
          return await this.readChannel(channelId);

        case 'getChannelStatus':
          return await this.getChannelStatus(channelId);
          
        case 'sendBulkData':
          return await this.sendBulkData(dataArray, options);
          
        case 'readBulkChannels':
          return await this.readBulkChannels(channelIds);

        case 'transformAndSendData':
          return await this.transformAndSendData(data, transformations);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('ThingSpeak plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send data to a ThingSpeak channel.
   * @param {string} field1 - The value for field1.
   * @param {string} field2 - The value for field2.
   * @returns {Promise<Object>} The result of the operation.
   */
  async sendData(field1, field2) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const validation = this.validateParams({ field1, field2 }, {
      field1: { required: true, type: 'string' },
      field2: { required: true, type: 'string' }
    });

    if (!validation.success) {
      return validation;
    }

    try {
      logger.info(`Sending data to ThingSpeak: field1=${field1}, field2=${field2}`);
      const response = await retryOperation(() => axios.post(`${this.baseUrl}/update`, null, {
        params: {
          api_key: this.apiKey,
          field1,
          field2
        }
      }), { retries: 3, context: 'ThingSpeak sendData' });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error sending data to ThingSpeak:', error.message);
      return { success: false, error: 'Error sending data to ThingSpeak' };
    }
  }

  /**
   * Read data from a ThingSpeak channel.
   * @param {string} channelId - The ID of the channel to read from.
   * @returns {Promise<Object>} The channel data.
   */
  async readChannel(channelId) {
    const validation = this.validateParams({ channelId }, {
      channelId: { required: true, type: 'string' }
    });

    if (!validation.success) {
      return validation;
    }

    try {
      logger.info(`Reading data from ThingSpeak channel: ${channelId}`);
      const response = await retryOperation(() => axios.get(`${this.baseUrl}/channels/${channelId}/feeds.json`, {
        params: {
          api_key: this.apiKey
        }
      }), { retries: 3, context: 'ThingSpeak readChannel' });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error reading data from ThingSpeak:', error.message);
      return { success: false, error: 'Error reading data from ThingSpeak' };
    }
  }

  /**
   * Get the status of a ThingSpeak channel.
   * @param {string} channelId - The ID of the channel.
   * @returns {Promise<Object>} The channel status.
   */
  async getChannelStatus(channelId) {
    const validation = this.validateParams({ channelId }, {
      channelId: { required: true, type: 'string' }
    });

    if (!validation.success) {
      return validation;
    }

    try {
      logger.info(`Getting status for ThingSpeak channel: ${channelId}`);
      const response = await retryOperation(() => axios.get(`${this.baseUrl}/channels/${channelId}/status.json`, {
        params: {
          api_key: this.apiKey
        }
      }), { retries: 3, context: 'ThingSpeak getChannelStatus' });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error getting channel status from ThingSpeak:', error.message);
      return { success: false, error: 'Error getting channel status from ThingSpeak' };
    }
  }

  /**
   * Send bulk data to ThingSpeak channels with proper rate limiting.
   * @param {Array<Object>} dataArray - Array of data objects to be sent.
   * @param {Object} options - Options for bulk operation (e.g., accountType, progressCallback)
   * @returns {Promise<Object>} The result of the operation.
   */
  async sendBulkData(dataArray, options = {}) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    // Validate input
    if (!Array.isArray(dataArray)) {
      return { success: false, error: 'dataArray must be an array' };
    }

    if (dataArray.length === 0) {
      return { success: false, error: 'dataArray cannot be empty' };
    }

    if (dataArray.length > this.maxBulkSize) {
      return { 
        success: false, 
        error: `Bulk size exceeds maximum limit of ${this.maxBulkSize} items` 
      };
    }

    // Determine rate limit based on account type
    const accountType = options.accountType || 'free';
    const rateLimit = this.rateLimits[accountType] || this.rateLimits.free;
    const progressCallback = options.progressCallback || null;

    logger.info(`Starting bulk data send for ${dataArray.length} items with ${rateLimit}ms rate limit`);

    const results = [];
    const errors = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const data = dataArray[i];
      
      try {
        // Validate each data entry
        if (!data || typeof data !== 'object') {
          const error = { index: i, error: 'Invalid data format' };
          errors.push(error);
          results.push({ success: false, ...error });
          failCount++;
          continue;
        }

        const { field1, field2 } = data;
        const validation = this.validateParams({ field1, field2 }, {
          field1: { required: true, type: 'string' },
          field2: { required: true, type: 'string' }
        });

        if (!validation.success) {
          const error = { index: i, error: validation.error };
          errors.push(error);
          results.push({ success: false, ...error });
          failCount++;
          continue;
        }

        // Send data
        logger.info(`Sending bulk item ${i + 1}/${dataArray.length}: field1=${field1}, field2=${field2}`);

        const response = await retryOperation(() => axios.post(`${this.baseUrl}/update`, null, {
          params: {
            api_key: this.apiKey,
            field1,
            field2
          }
        }), { retries: 3, context: 'ThingSpeak sendBulkData' });

        results.push({ 
          success: true, 
          index: i, 
          data: response.data 
        });
        successCount++;

        // Report progress if callback provided
        if (progressCallback && typeof progressCallback === 'function') {
          progressCallback({
            current: i + 1,
            total: dataArray.length,
            successCount,
            failCount
          });
        }

        // Apply rate limit (except for last item)
        if (i < dataArray.length - 1) {
          logger.info(`Waiting ${rateLimit}ms before next request...`);
          await new Promise(resolve => setTimeout(resolve, rateLimit));
        }

      } catch (error) {
        logger.error(`Error sending bulk item ${i}:`, error.message);
        const errorData = { 
          index: i, 
          error: error.message || 'Network error' 
        };
        errors.push(errorData);
        results.push({ success: false, ...errorData });
        failCount++;
      }
    }

    return { 
      success: errors.length === 0,
      summary: {
        total: dataArray.length,
        successful: successCount,
        failed: failCount
      },
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Read data from multiple ThingSpeak channels with parallel execution.
   * @param {Array<string>} channelIds - Array of channel IDs to read from.
   * @returns {Promise<Object>} The channels data.
   */
  async readBulkChannels(channelIds) {
    // Validate input
    if (!Array.isArray(channelIds)) {
      return { success: false, error: 'channelIds must be an array' };
    }

    if (channelIds.length === 0) {
      return { success: false, error: 'channelIds cannot be empty' };
    }

    if (channelIds.length > this.maxBulkSize) {
      return { 
        success: false, 
        error: `Bulk size exceeds maximum limit of ${this.maxBulkSize} items` 
      };
    }

    // Sanitize channel IDs
    const sanitizedIds = channelIds.map((id, index) => {
      if (typeof id !== 'string' && typeof id !== 'number') {
        return { index, error: 'Invalid channel ID type', valid: false };
      }
      
      // Convert to string and validate format (alphanumeric only)
      const idStr = String(id).trim();
      if (!/^[a-zA-Z0-9]+$/.test(idStr)) {
        return { index, error: 'Channel ID must be alphanumeric', valid: false };
      }
      
      return { index, id: idStr, valid: true };
    });

    const invalidIds = sanitizedIds.filter(item => !item.valid);
    if (invalidIds.length > 0) {
      return {
        success: false,
        error: 'Invalid channel IDs detected',
        invalidIds: invalidIds.map(item => ({ index: item.index, error: item.error }))
      };
    }

    logger.info(`Starting bulk channel read for ${channelIds.length} channels`);

    try {
      // Process in batches to respect concurrency limit
      const validIds = sanitizedIds.filter(item => item.valid);
      const results = [];
      const errors = [];

      for (let i = 0; i < validIds.length; i += this.maxConcurrentReads) {
        const batch = validIds.slice(i, i + this.maxConcurrentReads);
        
        logger.info(`Processing batch ${Math.floor(i / this.maxConcurrentReads) + 1} with ${batch.length} channels`);

        const batchPromises = batch.map(async ({ index, id }) => {
          try {
            logger.info(`Reading data from ThingSpeak channel: ${id}`);
            const response = await retryOperation(() => axios.get(`${this.baseUrl}/channels/${id}/feeds.json`, {
              params: {
                api_key: this.apiKey
              }
            }), { retries: 3, context: 'ThingSpeak readBulkChannels' });

            return {
              success: true,
              index,
              channelId: id,
              data: response.data
            };
          } catch (error) {
            logger.error(`Error reading channel ${id}:`, error.message);
            const errorData = {
              index,
              channelId: id,
              error: error.response?.status === 404 
                ? 'Channel not found' 
                : error.message || 'Network error'
            };
            errors.push(errorData);
            return { success: false, ...errorData };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Small delay between batches to be respectful
        if (i + this.maxConcurrentReads < validIds.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      return { 
        success: errors.length === 0,
        summary: {
          total: channelIds.length,
          successful: successCount,
          failed: failCount
        },
        results,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      logger.error('Error in bulk channel read:', error);
      return { 
        success: false, 
        error: 'Unexpected error during bulk read operation',
        details: error.message 
      };
    }
  }

  /**
   * Transform data and send it to a ThingSpeak channel.
   * @param {Object} data - The data to be transformed and sent.
   * @param {Object} transformations - The transformations to apply.
   * @returns {Promise<Object>} The result of the operation.
   */
  async transformAndSendData(data, transformations) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    // Validate input
    if (!data || typeof data !== 'object') {
      return { success: false, error: 'Data must be an object' };
    }

    if (!transformations || typeof transformations !== 'object') {
      return { success: false, error: 'Transformations must be an object' };
    }

    try {
      // Apply transformations
      const transformedData = this.applyTransformations(data, transformations);

      // Validate transformed data
      const { field1, field2 } = transformedData;
      const validation = this.validateParams({ field1, field2 }, {
        field1: { required: true, type: 'string' },
        field2: { required: true, type: 'string' }
      });

      if (!validation.success) {
        return validation;
      }

      // Send transformed data
      logger.info(`Sending transformed data to ThingSpeak: field1=${field1}, field2=${field2}`);
      const response = await retryOperation(() => axios.post(`${this.baseUrl}/update`, null, {
        params: {
          api_key: this.apiKey,
          field1,
          field2
        }
      }), { retries: 3, context: 'ThingSpeak transformAndSendData' });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error transforming and sending data to ThingSpeak:', error.message);
      return { success: false, error: 'Error transforming and sending data to ThingSpeak' };
    }
  }

  /**
   * Apply transformations to data.
   * @param {Object} data - The original data.
   * @param {Object} transformations - The transformations to apply.
   * @returns {Object} The transformed data.
   */
  applyTransformations(data, transformations) {
    let transformedData = { ...data };

    // Example transformation: scaling
    if (transformations.scale) {
      const scale = transformations.scale;
      if (typeof scale === 'number') {
        transformedData.field1 = (parseFloat(transformedData.field1) * scale).toString();
        transformedData.field2 = (parseFloat(transformedData.field2) * scale).toString();
      }
    }

    // Additional transformations can be added here

    return transformedData;
  }

  /**
   * Utility method to validate channel ID format
   * @private
   */
  validateChannelId(channelId) {
    if (!channelId) return false;
    const idStr = String(channelId).trim();
    return /^[a-zA-Z0-9]+$/.test(idStr);
  }
}