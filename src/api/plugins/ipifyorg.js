import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';
import net from 'node:net';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class ipifyorgPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'ipifyorg';
    this.version = '1.0.0';
    this.description = 'Simple API to get your public IP address';

    // Define required credentials for this plugin
    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'IPIFYORG_API_KEY', required: false }
    ];

    // Commands array - CRITICAL for AI natural language support
    this.commands = [
      {
        command: 'getPublicIp',
        description: 'Get the current public IP address',
        usage: 'getPublicIp()',
        examples: [
          'what is my public IP address?',
          'show me my external IP',
          'get current public IP',
          'find my internet IP address'
        ]
      },
      {
        command: 'getFormattedIp',
        description: 'Get the public IP in a specific format (json, text)',
        usage: 'getFormattedIp({ format: "json" })',
        examples: [
          'get my IP in JSON format',
          'show IP as plain text',
          'return IP address in structured format'
        ]
      },
      {
        command: 'getPublicIpByProtocol',
        description: 'Get the public IPv4, IPv6, or dual-stack addresses',
        usage: 'getPublicIpByProtocol({ protocol: "v4"|"v6"|"dual" })',
        examples: [
          'get my IPv4 address',
          'show my IPv6 address',
          'detect both public IP addresses'
        ]
      }
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null,
      baseUrl: 'https://api.ipify.org',
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 minute cache
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      // Load credentials using BasePlugin helper
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.apiKey = credentials.apiKey;
        this.logger.info('Loaded API credentials');
      } catch (credError) {
        this.logger.warn(`Credentials not configured: ${credError.message}`);
      }

      // Load other cached configuration
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      // Save non-credential config to cache
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
    
    // Handle AI parameter extraction
    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }
    
    try {
      switch (action) {
        case 'getPublicIp':
          return await this.getPublicIp(data);
        case 'getFormattedIp':
          return await this.getFormattedIp(data);
        case 'getPublicIpByProtocol':
          return await this.getPublicIpByProtocol(data);
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

    Return JSON with appropriate parameters based on the action.
    
    Examples:
    - For getPublicIp: {}
    - For getFormattedIp: {"format": "json"} or {"format": "text"}
    - For getPublicIpByProtocol: {"protocol": "v4"}, {"protocol": "v6"}, or {"protocol": "dual"}`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    // Use safeJsonParse to avoid throwing on malformed JSON
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
  
  // Implementation methods for each action
  async getPublicIp(params = {}) {
    try {
      const cacheKey = 'public-ip';
      const cached = this.cache.get(cacheKey);
      
      if (cached) {
        this.logger.debug('Returning cached public IP');
        return {
          success: true,
          data: { ip: cached },
          source: 'cache'
        };
      }
      
      const url = `${this.config.baseUrl}?format=json`;
      
      const response = await retryOperation(() => 
        axios.get(url, {
          headers: {
            'User-Agent': 'LANAgent-Plugin/1.0'
          },
          timeout: 5000
        }), 
        { retries: 3, context: 'ipify API call' }
      );
      
      const ip = response.data.ip;
      this.cache.set(cacheKey, ip);
      
      return {
        success: true,
        data: { ip }
      };
    } catch (error) {
      this.logger.error('Failed to get public IP:', error);
      throw error;
    }
  }
  
  async getFormattedIp(params = {}) {
    try {
      const { format = 'json' } = params;
      
      this.validateParams({ format }, {
        format: {
          required: false,
          type: 'string',
          enum: ['json', 'text']
        }
      });
      
      const cacheKey = `formatted-ip-${format}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached) {
        this.logger.debug(`Returning cached formatted IP (${format})`);
        return {
          success: true,
          data: cached,
          source: 'cache'
        };
      }
      
      const url = `${this.config.baseUrl}?format=${format}`;
      
      const response = await retryOperation(() => 
        axios.get(url, {
          headers: {
            'User-Agent': 'LANAgent-Plugin/1.0'
          },
          timeout: 5000
        }), 
        { retries: 3, context: 'ipify API call' }
      );
      
      let result;
      if (format === 'json') {
        result = response.data;
      } else {
        result = { ip: response.data.trim() };
      }
      
      this.cache.set(cacheKey, result);
      
      return {
        success: true,
        data: result
      };
    } catch (error) {
      this.logger.error('Failed to get formatted IP:', error);
      throw error;
    }
  }

  /**
   * Get the public address for IPv4, IPv6, or both protocols.
   */
  async getPublicIpByProtocol(params = {}) {
    const { protocol = 'dual' } = params;

    this.validateParams({ protocol }, {
      protocol: {
        required: true,
        type: 'string',
        enum: ['v4', 'v6', 'dual']
      }
    });

    const hosts = {
      v4: 'https://api.ipify.org',
      v6: 'https://api6.ipify.org'
    };

    const protocols = protocol === 'dual' ? ['v4', 'v6'] : [protocol];
    const results = {};
    const failures = {};

    await Promise.all(protocols.map(async currentProtocol => {
      const cacheKey = `public-ip-${currentProtocol}`;
      const cached = this.cache.get(cacheKey);

      if (cached) {
        results[currentProtocol] = {
          protocol: currentProtocol,
          address: cached
        };
        return;
      }

      try {
        const response = await retryOperation(() =>
          axios.get(hosts[currentProtocol], {
            params: { format: 'json' },
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'LANAgent-Plugin/1.0'
            },
            timeout: 5000
          }),
          { retries: 3, context: `ipify ${currentProtocol} API call` }
        );

        const address = typeof response.data === 'string'
          ? response.data.trim()
          : response.data?.ip;

        if (!address || net.isIP(address) === 0) {
          throw new Error(`ipify returned an invalid ${currentProtocol} address`);
        }

        const detectedProtocol = net.isIP(address) === 4 ? 'v4' : 'v6';
        if (detectedProtocol !== currentProtocol) {
          throw new Error(`ipify returned an address with an unexpected protocol: ${detectedProtocol}`);
        }

        this.cache.set(cacheKey, address);
        results[currentProtocol] = {
          protocol: currentProtocol,
          address
        };
      } catch (error) {
        failures[currentProtocol] = error.message;
      }
    }));

    if (protocol !== 'dual' && !results[protocol]) {
      throw new Error(failures[protocol] || `Unable to detect public ${protocol} address`);
    }

    if (protocol === 'dual' && Object.keys(results).length === 0) {
      throw new Error(`Unable to detect public addresses: ${Object.values(failures).join('; ')}`);
    }

    return {
      success: true,
      data: {
        protocol,
        addresses: results,
        ...(Object.keys(failures).length > 0 ? { unavailable: failures } : {})
      },
      ...(Object.keys(failures).length > 0 ? { partial: true } : {})
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
