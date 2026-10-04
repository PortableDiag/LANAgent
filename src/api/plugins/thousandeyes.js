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
        command: 'refreshAgents',
        description: 'Invalidate the cached agent list and retrieve current agents from ThousandEyes',
        usage: 'refreshAgents()',
        examples: [
          'refresh the available agents',
          'get the current agent list',
          'reload agents from ThousandEyes'
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
      },
      {
        command: 'refreshTests',
        description: 'Invalidate the cached test list and retrieve current tests from ThousandEyes',
        usage: 'refreshTests()',
        examples: [
          'refresh the configured tests',
          'get the current test list',
          'reload tests from ThousandEyes'
        ]
      },
      {
        command: 'getTestDetails',
        description: 'Get the configuration and metadata of a specific test by ID',
        usage: 'getTestDetails({ testId: "12345", testType: "http-server" })',
        parameters: {
          testId: { required: true, type: 'string' },
          testType: { required: false, type: 'string', description: 'v7 test type; looked up from the test list when omitted' }
        },
        examples: [
          'check details of test 12345',
          'get configuration for test with ID 67890',
          'test details for ID 54321'
        ]
      },
      {
        command: 'listAlerts',
        description: 'Retrieve a list of alerts from ThousandEyes',
        usage: 'listAlerts()',
        examples: [
          'show me the current alerts',
          'list all alerts',
          'retrieve alert list'
        ]
      },
      {
        command: 'refreshAlerts',
        description: 'Invalidate the cached alert list and retrieve current alerts from ThousandEyes',
        usage: 'refreshAlerts()',
        examples: [
          'refresh the current alerts',
          'get the latest alert list',
          'reload alerts from ThousandEyes'
        ]
      },
      {
        command: 'getAlertDetails',
        description: 'Get details of a specific alert by ID',
        usage: 'getAlertDetails({ alertId: "12345" })',
        examples: [
          'check details of alert 12345',
          'get information for alert with ID 67890',
          'alert details for ID 54321'
        ]
      },
      {
        command: 'refreshAll',
        description: 'Clear all cached ThousandEyes data and retrieve current agents, tests, and alerts',
        usage: 'refreshAll()',
        examples: [
          'refresh all ThousandEyes data',
          'reload the current ThousandEyes configuration',
          'get all current ThousandEyes resources'
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
   * Invalidate cached entries belonging to one or more ThousandEyes
   * resource scopes.
   * @param {string[]} scopes - Resource scopes to invalidate
   * @returns {{scopes: string[], keys: string[]}}
   */
  _invalidateCacheScopes(scopes) {
    const prefixesByScope = {
      agents: ['agents_list'],
      tests: ['tests_list'],
      alerts: ['alerts_list'],
      agentDetails: ['agent_status_'],
      testDetails: ['test_details_'],
      alertDetails: ['alert_details_']
    };

    const keysToDelete = new Set();
    for (const scope of scopes) {
      const prefixes = prefixesByScope[scope] || [];
      for (const key of this.cache.keys()) {
        if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) {
          keysToDelete.add(key);
        }
      }
    }

    const keys = [...keysToDelete];
    if (keys.length > 0) {
      this.cache.del(keys);
    }

    return {
      scopes: [...scopes],
      keys
    };
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
        case 'refreshAgents':
          return await this.refreshAgents();
        case 'getAgentStatus':
          return await this.getAgentStatus(data);
        case 'listTests':
          return await this.listTests();
        case 'refreshTests':
          return await this.refreshTests();
        case 'getTestDetails':
          return await this.getTestDetails(data);
        case 'listAlerts':
          return await this.listAlerts();
        case 'refreshAlerts':
          return await this.refreshAlerts();
        case 'getAlertDetails':
          return await this.getAlertDetails(data);
        case 'refreshAll':
          return await this.refreshAll();
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

  /**
   * Invalidate and immediately reload the ThousandEyes agent list.
   * @returns {Promise<{success: boolean, data?: any, error?: string, cacheScopesInvalidated: string[], cacheKeysInvalidated: string[]}>}
   */
  async refreshAgents() {
    const invalidation = this._invalidateCacheScopes(['agents']);
    this.logger.info(`Refreshing ThousandEyes agents; invalidated ${invalidation.keys.length} cache entries`);

    const result = await this.listAgents();
    return {
      ...result,
      cacheScopesInvalidated: invalidation.scopes,
      cacheKeysInvalidated: invalidation.keys
    };
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

  /**
   * Invalidate and immediately reload the ThousandEyes test list.
   * @returns {Promise<{success: boolean, data?: any, error?: string, cacheScopesInvalidated: string[], cacheKeysInvalidated: string[]}>}
   */
  async refreshTests() {
    const invalidation = this._invalidateCacheScopes(['tests']);
    this.logger.info(`Refreshing ThousandEyes tests; invalidated ${invalidation.keys.length} cache entries`);

    const result = await this.listTests();
    return {
      ...result,
      cacheScopesInvalidated: invalidation.scopes,
      cacheKeysInvalidated: invalidation.keys
    };
  }

  /**
   * Retrieve the configuration and metadata for an individual ThousandEyes test.
   *
   * v7 has no generic /tests/{id} resource: single tests live under their type,
   * e.g. /tests/http-server/{id}. When the caller does not give the type it is
   * looked up from the (cached) test list, which carries `type` for every test.
   * @param {Object} params - Command parameters
   * @param {string|number} params.testId - ThousandEyes test identifier
   * @param {string} [params.testType] - v7 test type (e.g. "http-server"); optional
   * @returns {Promise<{success: boolean, data?: any, error?: string}>}
   */
  async getTestDetails({ testId, testType } = {}) {
    // Ids extracted from natural language often arrive as numbers.
    const id = testId === undefined || testId === null ? testId : String(testId);
    this.validateParams({ testId: id }, {
      testId: { required: true, type: 'string' }
    });

    try {
      let type = testType ? String(testType) : null;
      if (!type) {
        const list = await this.getCachedData('tests_list', () => this._fetch('/tests', 'listTests'));
        const tests = Array.isArray(list?.tests) ? list.tests : [];
        const match = tests.find(t => String(t?.testId) === id);
        if (!match) {
          return { success: false, error: `Test ${id} not found` };
        }
        if (!match.type) {
          return { success: false, error: `Test ${id} has no type in the test list` };
        }
        type = String(match.type);
      }

      const cacheKey = `test_details_${type}_${id}`;
      const path = `/tests/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
      const data = await this.getCachedData(
        cacheKey,
        () => this._fetch(path, 'getTestDetails')
      );
      return { success: true, data };
    } catch (error) {
      this.logger.error('getTestDetails failed:', error);
      return { success: false, error: error.message };
    }
  }

  async listAlerts() {
    try {
      const data = await this.getCachedData('alerts_list', () => this._fetch('/alerts', 'listAlerts'));
      return { success: true, data };
    } catch (error) {
      this.logger.error('listAlerts failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Invalidate and immediately reload the ThousandEyes alert list.
   * @returns {Promise<{success: boolean, data?: any, error?: string, cacheScopesInvalidated: string[], cacheKeysInvalidated: string[]}>}
   */
  async refreshAlerts() {
    const invalidation = this._invalidateCacheScopes(['alerts']);
    this.logger.info(`Refreshing ThousandEyes alerts; invalidated ${invalidation.keys.length} cache entries`);

    const result = await this.listAlerts();
    return {
      ...result,
      cacheScopesInvalidated: invalidation.scopes,
      cacheKeysInvalidated: invalidation.keys
    };
  }

  async getAlertDetails({ alertId, alertRuleId }) {
    this.validateParams({ alertId }, {
      alertId: { required: true, type: 'string' }
    });

    try {
      // Encode both: they are caller-supplied and are interpolated into a URL. An id
      // carrying a '/', '?' or '&' would otherwise rewrite the path or inject a
      // parameter rather than being sent as a value.
      let path = `/alerts/${encodeURIComponent(alertId)}`;
      if (alertRuleId) {
        path += `?alertRuleId=${encodeURIComponent(alertRuleId)}`;
      }
      // The cache key has to carry every input that changes the response. Keying on
      // alertId alone means a request filtered by one rule would be answered from a
      // different rule's cached result for the life of the entry.
      const cacheKey = `alert_details_${alertId}::${alertRuleId || 'all'}`;
      const data = await this.getCachedData(cacheKey, () => this._fetch(path, 'getAlertDetails'));
      return { success: true, data };
    } catch (error) {
      this.logger.error('getAlertDetails failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear all cached ThousandEyes resource and detail entries, then reload
   * each resource list so callers receive current configuration immediately.
   * @returns {Promise<{success: boolean, data: Object, errors?: Object, cacheScopesInvalidated: string[], cacheKeysInvalidated: string[]}>}
   */
  async refreshAll() {
    const cacheKeysInvalidated = this.cache.keys();
    this.cache.flushAll();

    const cacheScopesInvalidated = [
      'agents',
      'tests',
      'alerts',
      'agentDetails',
      'testDetails',
      'alertDetails'
    ];

    this.logger.info(`Refreshing all ThousandEyes resources; invalidated ${cacheKeysInvalidated.length} cache entries`);

    const [agents, tests, alerts] = await Promise.all([
      this.listAgents(),
      this.listTests(),
      this.listAlerts()
    ]);

    const data = {
      agents: agents.data,
      tests: tests.data,
      alerts: alerts.data
    };

    const results = { agents, tests, alerts };
    const errors = Object.entries(results).reduce((acc, [resource, result]) => {
      if (!result.success) {
        acc[resource] = result.error;
      }
      return acc;
    }, {});

    return {
      success: Object.keys(errors).length === 0,
      data,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
      cacheScopesInvalidated,
      cacheKeysInvalidated
    };
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
