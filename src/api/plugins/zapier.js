import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class ZapierPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'zapier';
    this.version = '1.0.0';
    this.description = 'Workflow automation API that connects different apps and services';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'ZAPIER_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'list_zaps',
        description: 'List all available Zaps',
        usage: 'list_zaps()',
        examples: [
          'show all zaps',
          'list my workflows',
          'display available zaps',
          'get all automations'
        ]
      },
      {
        command: 'get_zap_details',
        description: 'Get details of a specific Zap by ID',
        usage: 'get_zap_details({ zapId: "12345" })',
        examples: [
          'show details for Zap 12345',
          'get info on zap number 67890',
          'what is the status of Zap 112233'
        ]
      },
      {
        command: 'run_zap',
        description: 'Manually trigger a Zap by ID',
        usage: 'run_zap({ zapId: "12345" })',
        examples: [
          'trigger zap 12345',
          'run automation 67890',
          'execute workflow 112233'
        ]
      },
      {
        command: 'schedule_zap',
        description: 'Schedule a Zap to run at a specific time (ISO 8601)',
        usage: 'schedule_zap({ zapId: "12345", time: "2026-10-31T10:00:00Z" })',
        examples: [
          'schedule zap 12345 to run at 10 AM on October 31',
          'set zap 67890 to execute at midnight',
          'plan zap 112233 for next Monday at 9 AM'
        ]
      },
      {
        command: 'pause_zap',
        description: 'Pause a specific Zap by ID',
        usage: 'pause_zap({ zapId: "12345" })',
        examples: [
          'pause zap 12345',
          'halt automation 67890',
          'stop workflow 112233 temporarily'
        ]
      },
      {
        command: 'resume_zap',
        description: 'Resume a specific paused Zap by ID',
        usage: 'resume_zap({ zapId: "12345" })',
        examples: [
          'resume zap 12345',
          'continue automation 67890',
          'restart workflow 112233'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'https://zapier.com/api/v1',
    };

    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    this.initialized = false;
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
      if (error && error.message && (error.message.includes('Missing required credentials') || /API[_-]?KEY.*(required|missing|not configured)/i.test(error.message) || /environment variable .* (required|not set)/i.test(error.message) || /credentials? (not configured|missing|required)/i.test(error.message))) {
        this.logger.warn(`Failed to initialize ${this.name} plugin: ${error.message}`);
      } else {
        this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      }
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
        case 'list_zaps':
          return await this.listZaps();
        case 'get_zap_details':
          return await this.getZapDetails(data);
        case 'run_zap':
          return await this.runZap(data);
        case 'schedule_zap':
          return await this.scheduleZap(data);
        case 'pause_zap':
          return await this.pauseZap(data);
        case 'resume_zap':
          return await this.resumeZap(data);
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
  
  async listZaps() {
    const cached = this.cache.get('listZaps');
    if (cached) return cached;

    try {
      const response = await retryOperation(() => axios.get(`${this.config.baseUrl}/zaps`, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'listZaps API call' });

      const result = { success: true, data: response.data };
      this.cache.set('listZaps', result);
      return result;
    } catch (error) {
      this.logger.error('listZaps failed:', error);
      return { success: false, error: error.message };
    }
  }

  async getZapDetails({ zapId }) {
    this.validateParams({ zapId }, {
      zapId: { required: true, type: 'string' }
    });

    const cacheKey = `zapDetails:${zapId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await retryOperation(() => axios.get(`${this.config.baseUrl}/zaps/${zapId}`, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'getZapDetails API call' });

      const result = { success: true, data: response.data };
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.logger.error('getZapDetails failed:', error);
      return { success: false, error: error.message };
    }
  }

  async runZap({ zapId }) {
    this.validateParams({ zapId }, {
      zapId: { required: true, type: 'string' }
    });

    try {
      const response = await retryOperation(() => axios.post(`${this.config.baseUrl}/zaps/${zapId}/run`, {}, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'runZap API call' });

      this.cache.del('listZaps');
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('runZap failed:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Schedule a one-shot Zap run via Agenda (TaskScheduler).
   * Defers actual execution to the `zapier-run-zap` Agenda job defined in scheduler.js.
   * @param {Object} params
   * @param {string} params.zapId
   * @param {string} params.time - ISO 8601 timestamp
   */
  async scheduleZap({ zapId, time }) {
    this.validateParams({ zapId, time }, {
      zapId: { required: true, type: 'string' },
      time: { required: true, type: 'string' }
    });

    const date = new Date(time);
    if (isNaN(date.getTime())) {
      return { success: false, error: 'Invalid time format (expected ISO 8601)' };
    }
    if (date.getTime() <= Date.now()) {
      return { success: false, error: 'Scheduled time must be in the future' };
    }

    const agenda = this.agent?.scheduler?.agenda;
    if (!agenda) {
      return { success: false, error: 'TaskScheduler is not initialized; cannot schedule zap' };
    }

    try {
      const job = await agenda.schedule(date, 'zapier-run-zap', { zapId });
      this.logger.info(`Scheduled zap ${zapId} for ${date.toISOString()} (job ${job.attrs._id})`);
      return {
        success: true,
        message: `Zap ${zapId} scheduled to run at ${date.toISOString()}`,
        jobId: String(job.attrs._id)
      };
    } catch (error) {
      this.logger.error('scheduleZap failed:', error);
      return { success: false, error: error.message };
    }
  }

  async pauseZap({ zapId }) {
    this.validateParams({ zapId }, {
      zapId: { required: true, type: 'string' }
    });

    try {
      const response = await retryOperation(() => axios.post(`${this.config.baseUrl}/zaps/${zapId}/pause`, {}, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'pauseZap API call' });

      this.cache.del('listZaps');
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('pauseZap failed:', error);
      return { success: false, error: error.message };
    }
  }

  async resumeZap({ zapId }) {
    this.validateParams({ zapId }, {
      zapId: { required: true, type: 'string' }
    });

    try {
      const response = await retryOperation(() => axios.post(`${this.config.baseUrl}/zaps/${zapId}/resume`, {}, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'resumeZap API call' });

      this.cache.del('listZaps');
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('resumeZap failed:', error);
      return { success: false, error: error.message };
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
