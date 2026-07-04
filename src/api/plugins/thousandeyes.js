import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import NodeCache from 'node-cache';

export default class ThousandEyesPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'thousandeyes';
    this.version = '1.0.0';
    this.description = 'Provides monitoring capabilities using the ThousandEyes API';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'THOUSANDEYES_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'listAgents',
        description: 'Retrieve a list of agents available in ThousandEyes',
        usage: 'listAgents()',
        examples: [
          'show me the available agents',
          'list all agents',
          'retrieve agent list'
        ]
      },
      {
        command: 'getAgentStatus',
        description: 'Get details of a specific agent by ID',
        usage: 'getAgentStatus({ agentId: "12345" })',
        examples: [
          'check status of agent 12345',
          'get status for agent with ID 67890',
          'agent status for ID 54321'
        ]
      },
      {
        command: 'listTests',
        description: 'Retrieve a list of tests configured in ThousandEyes',
        usage: 'listTests()',
        examples: [
          'show me the available tests',
          'list all tests',
          'retrieve test list'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      // ThousandEyes v7 REST API — suffix-less resource paths (the legacy
      // `.json` suffix is v6 and 404s on v7).
      baseUrl: 'https://api.thousandeyes.com/v7'
    };

    this.initialized = false;

    // In-memory response cache: 5 min TTL, swept every minute. Cuts repeat
    // ThousandEyes calls for list endpoints that change infrequently.
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
      // Missing-credential errors are expected when the API key isn't set —
      // the plugin loader registers the plugin as disabled in that case.
      this.logger.warn(`Failed to initialize ${this.name} plugin: ${error.message}`);
      throw error;
    }
  }

  /**
   * Return cached data for a key, or fetch (and cache) it on a miss.
   * Failures are NOT cached — fetchFunc rejects before the set() runs.
   * @param {string} key - Cache key
   * @param {Function} fetchFunc - Async fetcher, must resolve to the data to cache
   * @returns {Promise<any>}
   */
  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
  }

  /**
   * Fetch a ThousandEyes resource with auth + retry, returning response.data.
   * Caching response.data (not the raw axios response) avoids stashing the
   * Authorization header in the in-memory cache.
   */
  async _fetch(path, context) {
    const response = await retryOperation(() => axios.get(`${this.config.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` }
    }), { retries: 3, context });
    return response.data;
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
        case 'listAgents':
          return await this.listAgents();
        case 'getAgentStatus':
          return await this.getAgentStatus(data);
        case 'listTests':
          return await this.listTests();
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

  async listAgents() {
    try {
      const data = await this.getCachedData('agents_list', () => this._fetch('/agents', 'listAgents'));
      return { success: true, data };
    } catch (error) {
      this.logger.error('listAgents failed:', error);
      return { success: false, error: error.message };
    }
  }

  async getAgentStatus({ agentId }) {
    this.validateParams({ agentId }, {
      agentId: { required: true, type: 'string' }
    });

    try {
      const data = await this.getCachedData(`agent_status_${agentId}`, () => this._fetch(`/agents/${agentId}`, 'getAgentStatus'));
      return { success: true, data };
    } catch (error) {
      this.logger.error('getAgentStatus failed:', error);
      return { success: false, error: error.message };
    }
  }

  async listTests() {
    try {
      const data = await this.getCachedData('tests_list', () => this._fetch('/tests', 'listTests'));
      return { success: true, data };
    } catch (error) {
      this.logger.error('listTests failed:', error);
      return { success: false, error: error.message };
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
