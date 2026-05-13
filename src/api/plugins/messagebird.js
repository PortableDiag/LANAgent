import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class MessageBirdPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'messagebird';
    this.version = '1.0.0';
    this.description = 'Global communication API for SMS, chat, and voice';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'MESSAGEBIRD_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'sendSMS',
        description: 'Send an SMS to a recipient',
        usage: 'sendSMS({ originator: "YourName", recipient: "+1234567890", message: "Hello!" })',
        examples: [
          'send an SMS to John saying hello',
          'text my friend about the meeting',
          'send a message to +1234567890'
        ]
      },
      {
        command: 'sendMMS',
        description: 'Send an MMS with media to a recipient',
        usage: 'sendMMS({ originator: "YourName", recipient: "+1234567890", message: "Check this out!", mediaUrl: "https://example.com/image.jpg" })',
        examples: [
          'send an MMS to John with a photo',
          'send a picture message to +1234567890',
          'MMS a photo to my friend'
        ]
      },
      {
        command: 'getBalance',
        description: 'Retrieve account balance',
        usage: 'getBalance()',
        examples: [
          'check my MessageBird account balance',
          'how much balance do I have left',
          'account balance status'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'https://rest.messagebird.com',
    };

    this.initialized = false;
    this.cache = new Map();
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
        
        case 'sendSMS':
          return await this.sendSMS(data);

        case 'sendMMS':
          return await this.sendMMS(data);

        case 'getBalance':
          return await this.getBalance();
        
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

  async sendSMS({ originator, recipient, message }) {
    this.validateParams({ originator, recipient, message }, {
      originator: { required: true, type: 'string' },
      recipient: { required: true, type: 'string' },
      message: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}/messages`;
    const headers = {
      Authorization: `AccessKey ${this.config.apiKey}`
    };
    const data = {
      originator,
      recipients: [recipient],
      body: message
    };

    try {
      const response = await retryOperation(() => axios.post(url, data, { headers }), { retries: 3, context: 'sendSMS' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('sendSMS failed:', error);
      return { success: false, error: error.message };
    }
  }

  async sendMMS({ originator, recipient, message, mediaUrl }) {
    this.validateParams({ originator, recipient, mediaUrl }, {
      originator: { required: true, type: 'string' },
      recipient: { required: true, type: 'string' },
      mediaUrl: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}/mms`;
    const headers = {
      Authorization: `AccessKey ${this.config.apiKey}`
    };
    const data = {
      originator,
      recipients: [recipient],
      body: message || '',
      mediaUrls: [mediaUrl]
    };

    try {
      const response = await retryOperation(() => axios.post(url, data, { headers }), { retries: 3, context: 'sendMMS' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('sendMMS failed:', error);
      return { success: false, error: error.message };
    }
  }

  async getBalance() {
    const url = `${this.config.baseUrl}/balance`;
    const headers = {
      Authorization: `AccessKey ${this.config.apiKey}`
    };

    try {
      const response = await retryOperation(() => axios.get(url, { headers }), { retries: 3, context: 'getBalance' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('getBalance failed:', error);
      return { success: false, error: error.message };
    }
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.cache.clear();
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