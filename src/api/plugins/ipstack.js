import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import NodeCache from 'node-cache';

export default class IPstackPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'ipstack';
    this.version = '1.0.0';
    this.description = 'Locate and Identify Website Visitors by IP Address';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'IPSTACK_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'getLocation',
        description: 'Get geolocation data for a given IP address or range',
        usage: 'getLocation({ ip: "134.201.250.155" }) or getLocation({ ipRange: ["134.201.250.155", "134.201.250.160"] })',
        examples: [
          'get location for IP 134.201.250.155',
          'find geolocation of IP address 192.168.1.1',
          'retrieve location data for IP 8.8.8.8',
          'get location for IP range 134.201.250.155 to 134.201.250.160'
        ]
      },
      {
        command: 'getOwnLocation',
        description: 'Get geolocation data for the requester\'s IP address',
        usage: 'getOwnLocation()',
        examples: [
          'get my location data',
          'where am I located',
          'find my IP geolocation'
        ]
      },
      {
        command: 'getTimezone',
        description: 'Get timezone information for a given IP address',
        usage: 'getTimezone({ ip: "134.201.250.155" })',
        examples: [
          'get timezone for IP 134.201.250.155',
          'find timezone of IP address 192.168.1.1',
          'retrieve timezone data for IP 8.8.8.8'
        ]
      },
      {
        command: 'getOwnTimezone',
        description: 'Get timezone information for the requester\'s IP address',
        usage: 'getOwnTimezone()',
        examples: [
          'get my timezone data',
          'what is my timezone',
          'find my IP timezone'
        ]
      },
      {
        command: 'getTimezones',
        description: 'Get timezone information for multiple IP addresses',
        usage: 'getTimezones({ ipAddresses: ["134.201.250.155", "192.168.1.1"] })',
        examples: [
          'get timezones for IPs 134.201.250.155 and 192.168.1.1',
          'find timezones of multiple IP addresses',
          'retrieve timezone data for IPs 8.8.8.8 and 8.8.4.4'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'http://api.ipstack.com'
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      // Try to load credentials but don't fail if missing
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.apiKey = credentials.apiKey;
        this.logger.info('Loaded API credentials');
      } catch (credError) {
        if (credError.message.includes('Missing required credentials')) {
          this.logger.warn(`${this.name} plugin: API key not configured - plugin will show as unconfigured`);
          this.needsConfiguration = true;
        } else {
          throw credError;
        }
      }

      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      if (!this.config.apiKey) {
        this.logger.warn('API key not configured - plugin will have limited functionality');
        this.needsConfiguration = true;
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
        case 'getLocation':
          return await this.getLocation(data);
        case 'getOwnLocation':
          return await this.getOwnLocation();
        case 'getTimezone':
          return await this.getTimezone(data);
        case 'getOwnTimezone':
          return await this.getOwnTimezone();
        case 'getTimezones':
          return await this.getTimezones(data);
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

  async getLocation(data) {
    this.validateParams(data, {
      ip: { required: false, type: 'string' },
      ipRange: { required: false, type: 'array' }
    });

    if (!data.ip && !data.ipRange) {
      throw new Error('Either ip or ipRange must be provided');
    }

    if (data.ip) {
      return await this.getCachedData(data.ip, () => this.fetchGeolocation(data.ip));
    } else if (data.ipRange) {
      return await this.fetchGeolocationBatch(data.ipRange);
    }
  }

  async fetchGeolocation(ip) {
    const url = `${this.config.baseUrl}/${ip}?access_key=${this.config.apiKey}`;
    
    try {
      const response = await retryOperation(() => axios.get(url), { retries: 3, context: 'IPstack API' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching geolocation data:', error);
      return { success: false, error: 'Failed to fetch geolocation data.' };
    }
  }

  async fetchGeolocationBatch(ipRange) {
    const results = [];
    for (const ip of ipRange) {
      const result = await this.getCachedData(ip, () => this.fetchGeolocation(ip));
      results.push(result);
    }
    return { success: true, data: results };
  }

  async getOwnLocation() {
    const url = `${this.config.baseUrl}/check?access_key=${this.config.apiKey}`;
    
    try {
      const response = await retryOperation(() => axios.get(url), { retries: 3, context: 'IPstack API' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching own location data:', error);
      return { success: false, error: 'Failed to fetch own location data.' };
    }
  }

  async getTimezone(data) {
    this.validateParams(data, {
      ip: { required: true, type: 'string' }
    });

    return await this.getCachedData(data.ip, () => this.fetchTimezone(data.ip));
  }

  async fetchTimezone(ip) {
    const url = `${this.config.baseUrl}/${ip}?access_key=${this.config.apiKey}&fields=timezone`;
    
    try {
      const response = await retryOperation(() => axios.get(url), { retries: 3, context: 'IPstack API' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching timezone data:', error);
      return { success: false, error: 'Failed to fetch timezone data.' };
    }
  }

  async getOwnTimezone() {
    const url = `${this.config.baseUrl}/check?access_key=${this.config.apiKey}&fields=timezone`;
    
    try {
      const response = await retryOperation(() => axios.get(url), { retries: 3, context: 'IPstack API' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching own timezone data:', error);
      return { success: false, error: 'Failed to fetch own timezone data.' };
    }
  }

  /**
   * New feature: Batch timezone retrieval for multiple IP addresses
   */
  async getTimezones(data) {
    this.validateParams(data, {
      ipAddresses: { required: true, type: 'array' }
    });

    return await this.fetchTimezoneBatch(data.ipAddresses);
  }

  async fetchTimezoneBatch(ipAddresses) {
    const results = [];
    for (const ip of ipAddresses) {
      const result = await this.getCachedData(ip, () => this.fetchTimezone(ip));
      results.push(result);
    }
    return { success: true, data: results };
  }

  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
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
