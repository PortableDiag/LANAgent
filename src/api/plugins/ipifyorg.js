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
        usage: 'getPublicIp({ forceRefresh: true, cacheTtlSeconds: 60 })',
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
        usage: 'getFormattedIp({ format: "json", forceRefresh: true })',
        examples: [
          'get my IP in JSON format',
          'show IP as plain text',
          'return IP address in structured format'
        ]
      },
      {
        command: 'getPublicIpByProtocol',
        description: 'Get the public IPv4, IPv6, or dual-stack addresses',
        usage: 'getPublicIpByProtocol({ protocol: "v4"|"v6"|"dual", forceRefresh: true })',
        examples: [
          'get my IPv4 address',
          'show my IPv6 address',
          'detect both public IP addresses'
        ]
      },
      {
        command: 'clearCache',
        description: 'Invalidate cached public IP results',
        usage: 'clearCache({ scope: "all"|"v4"|"v6"|"formatted" })',
        examples: [
          'clear all cached public IP results',
          'refresh my IPv4 lookup cache',
          'invalidate formatted IP results'
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
        case 'clearCache':
          return await this.clearCache(data);
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
    - For getPublicIpByProtocol: {"protocol": "v4"}, {"protocol": "v6"}, or {"protocol": "dual"}
    - For clearCache: {"scope": "all"}, {"scope": "v4"}, {"scope": "v6"}, or {"scope": "formatted"}`;

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
      const {
        forceRefresh = false,
        cacheTtlSeconds
      } = params;

      this.validateParams({ forceRefresh, cacheTtlSeconds }, {
        forceRefresh: {
          required: false,
          type: 'boolean'
        },
        cacheTtlSeconds: {
          required: false,
          type: 'number',
          // NodeCache treats a TTL of 0 as never-expire; that is not a refresh.
          min: 1
        }
      });

      const cacheKey = 'public-ip';
      const cached = forceRefresh ? undefined : this.cache.get(cacheKey);
      
      if (cached !== undefined) {
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
      if (!ip || net.isIP(ip) === 0) {
        throw new Error('ipify returned an invalid public IP address');
      }

      if (cacheTtlSeconds === undefined) {
        this.cache.set(cacheKey, ip);
      } else {
        this.cache.set(cacheKey, ip, cacheTtlSeconds);
      }
      
      return {
        success: true,
        data: { ip },
        source: 'fetched'
      };
    } catch (error) {
      this.logger.error('Failed to get public IP:', error);
      throw error;
    }
  }
  
  async getFormattedIp(params = {}) {
    try {
      const {
        format = 'json',
        forceRefresh = false,
        cacheTtlSeconds
      } = params;
      
      this.validateParams({ format, forceRefresh, cacheTtlSeconds }, {
        format: {
          required: false,
          type: 'string',
          enum: ['json', 'text']
        },
        forceRefresh: {
          required: false,
          type: 'boolean'
        },
        cacheTtlSeconds: {
          required: false,
          type: 'number',
          // NodeCache treats a TTL of 0 as never-expire; that is not a refresh.
          min: 1
        }
      });
      
      const cacheKey = `formatted-ip-${format}`;
      const cached = forceRefresh ? undefined : this.cache.get(cacheKey);
      
      if (cached !== undefined) {
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

      const ip = result?.ip;
      if (!ip || net.isIP(ip) === 0) {
        throw new Error('ipify returned an invalid formatted IP address');
      }
      
      if (cacheTtlSeconds === undefined) {
        this.cache.set(cacheKey, result);
      } else {
        this.cache.set(cacheKey, result, cacheTtlSeconds);
      }
      
      return {
        success: true,
        data: result,
        source: 'fetched'
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
    const {
      protocol = 'dual',
      forceRefresh = false,
      cacheTtlSeconds
    } = params;

    this.validateParams({ protocol, forceRefresh, cacheTtlSeconds }, {
      protocol: {
        required: true,
        type: 'string',
        enum: ['v4', 'v6', 'dual']
      },
      forceRefresh: {
        required: false,
        type: 'boolean'
      },
      cacheTtlSeconds: {
        required: false,
        type: 'number',
        // NodeCache treats a TTL of 0 as never-expire; that is not a refresh.
        min: 1
      }
    });

    const hosts = {
      v4: 'https://api.ipify.org',
      v6: 'https://api6.ipify.org'
    };

    const protocols = protocol === 'dual' ? ['v4', 'v6'] : [protocol];
    const results = {};
    const failures = {};
    const sources = [];

    await Promise.all(protocols.map(async currentProtocol => {
      const cacheKey = `public-ip-${currentProtocol}`;
      const cached = forceRefresh ? undefined : this.cache.get(cacheKey);

      if (cached !== undefined) {
        results[currentProtocol] = {
          protocol: currentProtocol,
          address: cached,
          source: 'cache'
        };
        sources.push('cache');
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

        if (cacheTtlSeconds === undefined) {
          this.cache.set(cacheKey, address);
        } else {
          this.cache.set(cacheKey, address, cacheTtlSeconds);
        }

        results[currentProtocol] = {
          protocol: currentProtocol,
          address,
          source: 'fetched'
        };
        sources.push('fetched');
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

    const uniqueSources = [...new Set(sources)];

    return {
      success: true,
      data: {
        protocol,
        addresses: results,
        ...(Object.keys(failures).length > 0 ? { unavailable: failures } : {})
      },
      source: uniqueSources.length === 1 ? uniqueSources[0] : 'mixed',
      ...(Object.keys(failures).length > 0 ? { partial: true } : {})
    };
  }

  /**
   * Clear cached public IP results without restarting the plugin.
   *
   * @param {Object} params Cache invalidation options.
   * @param {'all'|'v4'|'v6'|'formatted'} [params.scope='all'] Cache scope to clear.
   * @returns {Promise<Object>} Cache invalidation result.
   */
  async clearCache(params = {}) {
    const { scope = 'all' } = params;

    this.validateParams({ scope }, {
      scope: {
        required: false,
        type: 'string',
        enum: ['all', 'v4', 'v6', 'formatted']
      }
    });

    if (scope === 'all') {
      this.cache.flushAll();
    } else if (scope === 'formatted') {
      this.cache.del(['formatted-ip-json', 'formatted-ip-text']);
    } else {
      this.cache.del(`public-ip-${scope}`);
    }

    this.logger.info(`Cleared ${scope} public IP cache`);
    return {
      success: true,
      data: {
        scope,
        cleared: true
      },
      source: 'cache'
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
