import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import NodeCache from 'node-cache';

export default class ChecklyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'checkly';
    this.version = '1.0.0';
    this.description = 'Browser and API monitoring service with a free tier';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'CHECKLY_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'get_checks',
        description: 'Retrieve all checks from Checkly',
        usage: 'get_checks()',
        examples: [
          'retrieve all checks',
          'get a list of checks',
          'fetch all monitoring checks'
        ]
      },
      {
        command: 'get_check_details',
        description: 'Retrieve details of a specific check by ID',
        usage: 'get_check_details({ checkId: "12345" })',
        examples: [
          'get details of check ID 12345',
          'fetch information for check 67890',
          'retrieve check details by ID'
        ]
      },
      {
        command: 'create_check',
        description: 'Create a new check in Checkly',
        usage: 'create_check({ name: "New Check", type: "API", ... })',
        examples: [
          'create a new API check',
          'add a browser check with specific settings'
        ]
      },
      {
        command: 'delete_check',
        description: 'Delete a check by ID in Checkly',
        usage: 'delete_check({ checkId: "12345" })',
        examples: [
          'delete check with ID 12345',
          'remove a specific monitoring check'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'https://api.checklyhq.com/v1',
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.apiKey = credentials.apiKey;
      this.logger.info('Loaded API credentials');

      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      if (!this.config.apiKey) {
        this.logger.warn('API key not configured - plugin will have limited functionality');
      }

      const { apiKey, ...configToCache } = this.config;
      await PluginSettings.setCached(this.name, 'config', configToCache);

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      throw error;
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });

    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }

    try {
      switch (action) {
        case 'get_checks':
          return await this.getChecks();
        case 'get_check_details':
          this.validateParams(data, {
            checkId: { required: true, type: 'string' }
          });
          return await this.getCheckDetails(data.checkId);
        case 'create_check':
          this.validateParams(data, {
            name: { required: true, type: 'string' },
            type: { required: true, type: 'string' }
          });
          return await this.createCheck(data);
        case 'delete_check':
          this.validateParams(data, {
            checkId: { required: true, type: 'string' }
          });
          return await this.deleteCheck(data.checkId);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async extractParameters(input, action) {
    const prompt = `Extract parameters from: "${input}"
    For ${this.name} plugin action: ${action}

    Return JSON with appropriate parameters based on the action.`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    const parsed = safeJsonParse(response.content, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      this.logger.warn('Failed to parse AI parameters from response');
    }
    return parsed;
  }

  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }

  async getChecks() {
    try {
      const cachedChecks = this.cache.get('checks');
      if (cachedChecks) {
        return { success: true, data: cachedChecks };
      }

      const response = await retryOperation(() => axios.get(`${this.config.baseUrl}/checks`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`
        }
      }), { retries: 3, context: 'Checkly getChecks' });

      this.cache.set('checks', response.data);
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      this.logger.error('get_checks failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getCheckDetails(checkId) {
    try {
      const cacheKey = `check_${checkId}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return { success: true, data: cached };
      }

      const response = await retryOperation(() => axios.get(`${this.config.baseUrl}/checks/${checkId}`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`
        }
      }), { retries: 3, context: 'Checkly getCheckDetails' });

      this.cache.set(cacheKey, response.data);
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      this.logger.error('get_check_details failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async createCheck(data) {
    try {
      const response = await retryOperation(() => axios.post(`${this.config.baseUrl}/checks`, data, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'Checkly createCheck' });

      this.cache.del('checks');

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      this.logger.error('create_check failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async deleteCheck(checkId) {
    try {
      await retryOperation(() => axios.delete(`${this.config.baseUrl}/checks/${checkId}`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`
        }
      }), { retries: 3, context: 'Checkly deleteCheck' });

      this.cache.del('checks');
      this.cache.del(`check_${checkId}`);

      return {
        success: true,
        message: `Check ${checkId} deleted successfully`
      };
    } catch (error) {
      this.logger.error('delete_check failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.cache.flushAll();
    await PluginSettings.clearCache(this.name);
    this.initialized = false;
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}