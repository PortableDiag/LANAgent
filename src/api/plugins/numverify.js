import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export default class NumverifyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'numverify';
    this.version = '1.0.0';
    this.description = 'Global Phone Number Validation & Lookup';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'NUMVERIFY_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'validatePhoneNumber',
        description: 'Validate a phone number and retrieve its details',
        usage: 'validatePhoneNumber({ number: "+14158586273" })',
        examples: [
          'validate the phone number +14158586273',
          'check if +447911123456 is a valid phone number',
          'get details for the number +33123456789'
        ]
      },
      {
        command: 'getCarrierInfo',
        description: 'Retrieve carrier information for a phone number',
        usage: 'getCarrierInfo({ number: "+14158586273" })',
        examples: [
          'find the carrier for +14158586273',
          'what is the carrier for +4915123456789',
          'get carrier details of +33123456789'
        ]
      },
      {
        command: 'batchValidatePhoneNumbers',
        description: 'Validate multiple phone numbers in a single batch operation (max 50)',
        usage: 'batchValidatePhoneNumbers({ numbers: ["+14158586273", "+447911123456"] })',
        examples: [
          'validate these phone numbers: +14158586273, +447911123456',
          'batch validate +33123456789 and +4915123456789'
        ]
      },
      {
        command: 'convertPhoneNumberFormat',
        description: 'Convert a phone number to a specified format',
        usage: 'convertPhoneNumberFormat({ number: "+14158586273", format: "E.164" })',
        examples: [
          'convert +14158586273 to E.164 format',
          'convert +447911123456 to national format',
          'convert +33123456789 to international format'
        ]
      },
      {
        command: 'detectPhoneNumberRegion',
        description: 'Detect the region of a given phone number',
        usage: 'detectPhoneNumberRegion({ number: "+14158586273" })',
        examples: [
          'detect the region for +14158586273',
          'find out the region of +447911123456',
          'get the region for +33123456789'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'http://apilayer.net/api/validate'
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL for phone validation results
  }

  /**
   * Get cached data or fetch and cache it
   */
  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.logger.debug(`Cache hit for ${key}`);
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
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
        case 'validatePhoneNumber':
          return await this.validatePhoneNumber(data);

        case 'batchValidatePhoneNumbers':
          return await this.batchValidatePhoneNumbers(data);

        case 'getCarrierInfo':
          return await this.getCarrierInfo(data);

        case 'convertPhoneNumberFormat':
          return await this.convertPhoneNumberFormat(data);

        case 'detectPhoneNumberRegion':
          return await this.detectPhoneNumberRegion(data);

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

  async validatePhoneNumber({ number }) {
    const cacheKey = `validate:${number}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        const response = await retryOperation(() =>
          axios.get(this.config.baseUrl, {
            params: {
              access_key: this.config.apiKey,
              number
            }
          }), { retries: 3, context: 'validatePhoneNumber API call' });

        return { success: true, data: response.data };
      } catch (error) {
        this.logger.error('validatePhoneNumber failed:', error);
        return { success: false, error: 'Failed to validate phone number' };
      }
    });
  }

  async getCarrierInfo({ number }) {
    const cacheKey = `carrier:${number}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        const response = await retryOperation(() =>
          axios.get(this.config.baseUrl, {
            params: {
              access_key: this.config.apiKey,
              number
            }
          }), { retries: 3, context: 'getCarrierInfo API call' });

        const { carrier, line_type } = response.data;
        return { success: true, data: { carrier, line_type } };
      } catch (error) {
        this.logger.error('getCarrierInfo failed:', error);
        return { success: false, error: 'Failed to retrieve carrier information' };
      }
    });
  }

  async convertPhoneNumberFormat({ number, format }) {
    try {
      const phoneNumber = parsePhoneNumberFromString(number);
      if (!phoneNumber) {
        throw new Error('Invalid phone number');
      }

      let formattedNumber;
      switch (format.toLowerCase()) {
        case 'e.164':
          formattedNumber = phoneNumber.format('E.164');
          break;
        case 'national':
          formattedNumber = phoneNumber.format('NATIONAL');
          break;
        case 'international':
          formattedNumber = phoneNumber.format('INTERNATIONAL');
          break;
        default:
          throw new Error(`Unsupported format: ${format}`);
      }

      return { success: true, data: { formattedNumber } };
    } catch (error) {
      this.logger.error('convertPhoneNumberFormat failed:', error);
      return { success: false, error: error.message };
    }
  }

  async batchValidatePhoneNumbers({ numbers }) {
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return { success: false, error: 'numbers must be a non-empty array' };
    }
    if (numbers.length > 50) {
      return { success: false, error: `Too many numbers (${numbers.length}). Maximum is 50 per batch.` };
    }

    const BATCH_SIZE = 10;
    const results = [];

    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
      const chunk = numbers.slice(i, i + BATCH_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(async (number) => {
          const result = await this.validatePhoneNumber({ number });
          return { number, ...result };
        })
      );
      results.push(...chunkResults);

      // Brief delay between batches to avoid API rate limits
      if (i + BATCH_SIZE < numbers.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    return {
      success: true,
      data: {
        total: results.length,
        successCount,
        failureCount,
        results
      }
    };
  }

  async detectPhoneNumberRegion({ number }) {
    try {
      const phoneNumber = parsePhoneNumberFromString(number);
      if (!phoneNumber) {
        throw new Error('Invalid phone number');
      }

      const region = phoneNumber.country || 'Unknown';
      return { success: true, data: { region } };
    } catch (error) {
      this.logger.error('detectPhoneNumberRegion failed:', error);
      return { success: false, error: error.message };
    }
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
