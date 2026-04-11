import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

/**
 * Usage Examples:
 * - Natural language: "use freshping to check my sites"
 * - Command format: api freshping <action> <params>
 * - Telegram: Just type naturally about freshping
 */

export default class FreshpingPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'freshping';
    this.version = '1.0.0';
    this.description = 'Uptime and performance monitoring for websites and APIs';
    this.commands = [
      {
        command: 'getchecks',
        description: 'Retrieve list of all monitoring checks',
        usage: 'getchecks()'
      },
      {
        command: 'getcheckstatus',
        description: 'Get the status of a specific check',
        usage: 'getcheckstatus({ checkId: "12345" })'
      },
      {
        command: 'createcheck',
        description: 'Create a new monitoring check',
        usage: 'createcheck({ name: "My Website", url: "https://example.com", check_frequency: 1 })'
      },
      {
        command: 'deletecheck',
        description: 'Delete a monitoring check',
        usage: 'deletecheck({ checkId: "12345" })'
      },
      {
        command: 'updatecheck',
        description: 'Update an existing monitoring check',
        usage: 'updatecheck({ checkId: "12345", name: "Updated Name", url: "https://updated-url.com" })'
      }
    ];
    
    this.apiKey = process.env.FRESHPING_API_KEY;
    this.subdomain = process.env.FRESHPING_SUBDOMAIN;
    this.baseUrl = 'https://api.freshping.io/api/v1';
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'getchecks':
          return await this.getChecks();
          
        case 'getcheckstatus':
          return await this.getCheckStatus(params);
          
        case 'createcheck':
          return await this.createCheck(params);
          
        case 'deletecheck':
          return await this.deleteCheck(params);

        case 'updatecheck':
          return await this.updateCheck(params);
          
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Freshping plugin error:', error);
      return { success: false, error: error.message };
    }
  }
  
  async getChecks() {
    if (!this.apiKey || !this.subdomain) {
      return { success: false, error: 'API key or subdomain not configured' };
    }
    
    try {
      logger.info('Fetching all monitoring checks');
      const response = await retryOperation(() => axios.get(`${this.baseUrl}/checks`, {
        auth: {
          username: this.apiKey,
          password: this.subdomain
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'freshping getChecks' });
      
      return { 
        success: true, 
        data: response.data,
        count: response.data.length || 0
      };
      
    } catch (error) {
      logger.error('Error fetching checks:', error.message);
      return { success: false, error: `Failed to fetch checks: ${error.message}` };
    }
  }

  async getCheckStatus(params) {
    this.validateParams(params, { 
      checkId: { required: true, type: 'string' }
    });
    
    if (!this.apiKey || !this.subdomain) {
      return { success: false, error: 'API key or subdomain not configured' };
    }
    
    try {
      logger.info(`Fetching status for check: ${params.checkId}`);
      const response = await retryOperation(() => axios.get(`${this.baseUrl}/checks/${params.checkId}`, {
        auth: {
          username: this.apiKey,
          password: this.subdomain
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'freshping getCheckStatus' });
      
      return { 
        success: true, 
        data: response.data,
        status: response.data.check_state || 'unknown'
      };
      
    } catch (error) {
      logger.error('Error fetching check status:', error.message);
      return { success: false, error: `Failed to fetch check status: ${error.message}` };
    }
  }
  
  async createCheck(params) {
    this.validateParams(params, {
      name: { required: true, type: 'string' },
      url: { required: true, type: 'string' },
      check_frequency: { required: false, type: 'number' }
    });

    if (!this.apiKey || !this.subdomain) {
      return { success: false, error: 'API key or subdomain not configured' };
    }
    
    try {
      logger.info(`Creating new check: ${params.name} for ${params.url}`);
      
      const checkData = {
        name: params.name,
        url: params.url,
        check_frequency: params.check_frequency || 1, // Default 1 minute
        request_headers: [],
        notify_when_down: 3, // Notify after 3 failures
        escalation_policy: null
      };
      
      const response = await retryOperation(() => axios.post(`${this.baseUrl}/checks`, checkData, {
        auth: {
          username: this.apiKey,
          password: this.subdomain
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'freshping createCheck' });
      
      return { 
        success: true, 
        data: response.data,
        message: `Check created successfully with ID: ${response.data.id}`
      };
      
    } catch (error) {
      logger.error('Error creating check:', error.message);
      return { success: false, error: `Failed to create check: ${error.message}` };
    }
  }
  
  async deleteCheck(params) {
    this.validateParams(params, { 
      checkId: { required: true, type: 'string' }
    });
    
    if (!this.apiKey || !this.subdomain) {
      return { success: false, error: 'API key or subdomain not configured' };
    }
    
    try {
      logger.info(`Deleting check: ${params.checkId}`);
      await retryOperation(() => axios.delete(`${this.baseUrl}/checks/${params.checkId}`, {
        auth: {
          username: this.apiKey,
          password: this.subdomain
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'freshping deleteCheck' });
      
      return { 
        success: true, 
        message: `Check ${params.checkId} deleted successfully`
      };
      
    } catch (error) {
      logger.error('Error deleting check:', error.message);
      return { success: false, error: `Failed to delete check: ${error.message}` };
    }
  }

  /**
   * Update an existing monitoring check
   * @param {Object} params - Parameters for updating the check
   * @param {string} params.checkId - ID of the check to update
   * @param {string} [params.name] - New name for the check
   * @param {string} [params.url] - New URL for the check
   * @param {number} [params.check_frequency] - New check frequency
   * @returns {Promise<Object>} Result of the update operation
   */
  async updateCheck(params) {
    this.validateParams(params, { 
      checkId: { required: true, type: 'string' },
      name: { required: false, type: 'string' },
      url: { required: false, type: 'string' },
      check_frequency: { required: false, type: 'number' }
    });

    if (!this.apiKey || !this.subdomain) {
      return { success: false, error: 'API key or subdomain not configured' };
    }
    
    try {
      logger.info(`Updating check: ${params.checkId}`);
      
      const updateData = {};
      if (params.name) updateData.name = params.name;
      if (params.url) updateData.url = params.url;
      if (params.check_frequency) updateData.check_frequency = params.check_frequency;
      
      const response = await retryOperation(() => axios.put(`${this.baseUrl}/checks/${params.checkId}`, updateData, {
        auth: {
          username: this.apiKey,
          password: this.subdomain
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'freshping updateCheck' });
      
      return { 
        success: true, 
        data: response.data,
        message: `Check ${params.checkId} updated successfully`
      };
      
    } catch (error) {
      logger.error('Error updating check:', error.message);
      return { success: false, error: `Failed to update check: ${error.message}` };
    }
  }
}