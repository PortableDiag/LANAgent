import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

export default class MediastackPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'mediastack';
    this.version = '1.0.0';
    this.description = 'Real-time news API via mediastack';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'MEDIASTACK_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'getLatestNews',
        description: 'Fetch the latest news articles',
        usage: 'getLatestNews({ countries: "us", languages: "en", limit: 5, date: "2026-01-22", sources: "cnn,bbc" })',
        examples: [
          'fetch the latest US news',
          'get recent articles in English',
          'show top 5 news articles',
          'get news from January 15th',
          'get news from CNN and BBC'
        ]
      },
      {
        command: 'searchNews',
        description: 'Search news articles by keyword',
        usage: 'searchNews({ query: "technology", limit: 10, dateFrom: "2026-01-01", dateTo: "2026-01-22", sources: "cnn" })',
        examples: [
          'search for technology news',
          'find articles about climate change',
          'search sports news from last week',
          'search news from CNN'
        ]
      },
      {
        command: 'getNewsByCategory',
        description: 'Get news articles by category',
        usage: 'getNewsByCategory({ category: "business", limit: 5, date: "2026-01-22", sources: "bbc" })',
        examples: [
          'fetch business news',
          'get entertainment articles',
          'show latest sports news from today',
          'get business news from BBC'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'http://api.mediastack.com/v1'
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

    // Simple request throttling (no external dependency needed)
    this.lastRequestTime = 0;
    this.minRequestInterval = 333; // ~3 requests per second max
  }

  async throttledRequest(fn) {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
    return fn();
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
        case 'getLatestNews':
          return await this.getLatestNews(data);
        case 'searchNews':
          return await this.searchNews(data);
        case 'getNewsByCategory':
          return await this.getNewsByCategory(data);
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

  async getLatestNews({ countries = 'us', languages = 'en', limit = 5, date, dateFrom, dateTo, sources }) {
    let url = `${this.config.baseUrl}/news?access_key=${this.config.apiKey}&countries=${countries}&languages=${languages}&limit=${limit}`;
    url += this.buildDateParams(date, dateFrom, dateTo);
    if (sources) {
      url += `&sources=${encodeURIComponent(sources)}`;
    }
    return await this.getCachedData(url, () => this.fetchNews(url));
  }

  async searchNews({ query, limit = 10, date, dateFrom, dateTo, sources }) {
    if (!query) {
      return { success: false, error: 'Query parameter is required' };
    }
    let url = `${this.config.baseUrl}/news?access_key=${this.config.apiKey}&keywords=${encodeURIComponent(query)}&limit=${limit}`;
    url += this.buildDateParams(date, dateFrom, dateTo);
    if (sources) {
      url += `&sources=${encodeURIComponent(sources)}`;
    }
    return await this.getCachedData(url, () => this.fetchNews(url));
  }

  async getNewsByCategory({ category, limit = 5, date, dateFrom, dateTo, sources }) {
    if (!category) {
      return { success: false, error: 'Category parameter is required' };
    }
    let url = `${this.config.baseUrl}/news?access_key=${this.config.apiKey}&categories=${category}&limit=${limit}`;
    url += this.buildDateParams(date, dateFrom, dateTo);
    if (sources) {
      url += `&sources=${encodeURIComponent(sources)}`;
    }
    return await this.getCachedData(url, () => this.fetchNews(url));
  }

  buildDateParams(date, dateFrom, dateTo) {
    // Mediastack uses 'date' for single date or date range (YYYY-MM-DD,YYYY-MM-DD)
    if (date) {
      return `&date=${date}`;
    }
    if (dateFrom && dateTo) {
      return `&date=${dateFrom},${dateTo}`;
    }
    if (dateFrom) {
      return `&date=${dateFrom}`;
    }
    return '';
  }

  async fetchNews(url) {
    try {
      const response = await this.throttledRequest(() =>
        retryOperation(() => axios.get(url), { retries: 3, context: 'mediastack API call' })
      );
      return { success: true, data: response.data };
    } catch (error) {
      if (error.response) {
        const apiMsg = error.response.data?.error?.message || error.response.statusText;
        this.logger.error(`API error: ${error.response.status} - ${apiMsg}`);
        return { success: false, error: `API error: ${error.response.status} - ${apiMsg}` };
      }
      this.logger.error('Error fetching news:', error.message);
      return { success: false, error: error.message };
    }
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
