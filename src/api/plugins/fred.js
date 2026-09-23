import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class FREDPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'fred';
    this.version = '1.0.0';
    this.description = 'Economic time series data from Federal Reserve Economic Data (FRED)';

    // Define required credentials for this plugin
    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'FRED_API_KEY', required: true }
    ];

    // Commands array - CRITICAL for AI natural language support
    this.commands = [
      {
        command: 'get_series_data',
        description: 'Get economic time series data for a specific series ID',
        usage: 'get_series_data({ seriesId: "GDP", startDate: "2020-01-01", endDate: "2023-12-31" })',
        examples: [
          'get GDP data for the last 5 years',
          'show me unemployment rate statistics',
          'fetch consumer price index values',
          'retrieve federal funds rate history'
        ]
      },
      {
        command: 'search_series',
        description: 'Search for economic series by text query',
        usage: 'search_series({ query: "inflation", limit: 10 })',
        examples: [
          'search for inflation related economic data',
          'find series about housing prices',
          'look up interest rate datasets',
          'search for employment statistics'
        ]
      },
      {
        command: 'get_series_info',
        description: 'Get metadata information about a specific economic series',
        usage: 'get_series_info({ seriesId: "GDP" })',
        examples: [
          'get information about the GDP series',
          'show me details for consumer price index',
          'what does the UNRATE series represent',
          'tell me about this economic dataset'
        ]
      },
      {
        command: 'get_category_info',
        description: 'Get information about an economic data category',
        usage: 'get_category_info({ categoryId: 125 })',
        examples: [
          'get information about national accounts category',
          'show me details for production data category',
          'what series are in the prices category',
          'tell me about economic indicators category'
        ]
      }
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null,
      baseUrl: 'https://api.stlouisfed.org/fred/',
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
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

      // Check if API key is configured
      if (!this.config.apiKey) {
        this.logger.warn('API key not configured - plugin will have limited functionality');
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
        case 'get_series_data':
          return await this.getSeriesData(data);
        case 'search_series':
          return await this.searchSeries(data);
        case 'get_series_info':
          return await this.getSeriesInfo(data);
        case 'get_category_info':
          return await this.getCategoryInfo(data);
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
  
  // Implementation methods for each action
  async getSeriesData(params) {
    this.validateParams(params, {
      seriesId: { required: true, type: 'string' },
      startDate: { required: false, type: 'string' },
      endDate: { required: false, type: 'string' },
      frequency: { required: false, type: 'string' },
      units: { required: false, type: 'string' }
    });

    const cacheKey = `series_${params.seriesId}_${params.startDate || ''}_${params.endDate || ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}series/observations`, {
          params: {
            api_key: this.config.apiKey,
            file_type: 'json',
            series_id: params.seriesId,
            observation_start: params.startDate,
            observation_end: params.endDate,
            frequency: params.frequency,
            units: params.units
          }
        }), 
        { retries: 3, context: 'FRED series data' }
      );

      const result = response.data;
      this.cache.set(cacheKey, result);
      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to fetch series data: ${error.message}`);
    }
  }

  async searchSeries(params) {
    this.validateParams(params, {
      query: { required: true, type: 'string' },
      limit: { required: false, type: 'number' },
      orderBy: { required: false, type: 'string' },
      sortOrder: { required: false, type: 'string' }
    });

    const cacheKey = `search_${params.query}_${params.limit || 10}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}series/search`, {
          params: {
            api_key: this.config.apiKey,
            file_type: 'json',
            search_text: params.query,
            limit: params.limit,
            order_by: params.orderBy,
            sort_order: params.sortOrder
          }
        }),
        { retries: 3, context: 'FRED series search' }
      );

      const result = response.data;
      this.cache.set(cacheKey, result);
      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to search series: ${error.message}`);
    }
  }

  async getSeriesInfo(params) {
    this.validateParams(params, {
      seriesId: { required: true, type: 'string' }
    });

    const cacheKey = `info_${params.seriesId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}series`, {
          params: {
            api_key: this.config.apiKey,
            file_type: 'json',
            series_id: params.seriesId
          }
        }),
        { retries: 3, context: 'FRED series info' }
      );

      const result = response.data;
      this.cache.set(cacheKey, result);
      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to fetch series info: ${error.message}`);
    }
  }

  async getCategoryInfo(params) {
    this.validateParams(params, {
      categoryId: { required: true, type: 'number' }
    });

    const cacheKey = `category_${params.categoryId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}category`, {
          params: {
            api_key: this.config.apiKey,
            file_type: 'json',
            category_id: params.categoryId
          }
        }),
        { retries: 3, context: 'FRED category info' }
      );

      const result = response.data;
      this.cache.set(cacheKey, result);
      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to fetch category info: ${error.message}`);
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