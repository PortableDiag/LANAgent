import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { retryOperation } from '../../utils/retryUtils.js';

export default class FixerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'fixer';
    this.version = '1.0.0';
    this.description = 'Current and historical foreign exchange rates API';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'FIXER_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'getLatestRates',
        description: 'Fetch the latest exchange rates for all supported currencies.',
        usage: 'getLatestRates({ base: "USD" })',
        examples: [
          'get the latest exchange rates with USD as base',
          'fetch current rates using EUR as base currency',
          'retrieve exchange rates for the latest date'
        ]
      },
      {
        command: 'getHistoricalRates',
        description: 'Fetch historical exchange rates for a given date.',
        usage: 'getHistoricalRates({ date: "2023-05-24", base: "USD" })',
        examples: [
          'get exchange rates on 2023-05-24 using USD as base',
          'retrieve historical rates for 2022-01-01',
          'fetch past rates for a specific date'
        ]
      },
      {
        command: 'convertCurrency',
        description: 'Convert an amount from one currency to another.',
        usage: 'convertCurrency({ amount: 100, from: "USD", to: "EUR" })',
        examples: [
          'convert 100 USD to EUR',
          'how much is 200 GBP in JPY?',
          'exchange 50 CAD to AUD'
        ]
      },
      {
        command: 'batchConvertCurrency',
        description: 'Convert multiple amounts and currency pairs using one latest-rates request.',
        usage: 'batchConvertCurrency({ conversions: [{ amount: 100, from: "USD", to: "EUR" }] })',
        examples: [
          'convert several currency amounts at once',
          'batch convert USD, GBP, and CAD amounts to EUR',
          'convert multiple currency pairs using the latest rates'
        ]
      },
      {
        command: 'getFluctuation',
        description: 'Calculate the fluctuation percentage between two dates for a given currency pair.',
        usage: 'getFluctuation({ startDate: "2023-01-01", endDate: "2023-01-31", base: "USD", target: "EUR" })',
        examples: [
          'calculate fluctuation of USD to EUR from 2023-01-01 to 2023-01-31',
          'get fluctuation percentage for GBP to JPY over a month',
          'analyze currency fluctuation between two specific dates'
        ]
      },
      {
        command: 'getCurrencyTrend',
        description: 'Analyze the trend of a currency pair over a specified period.',
        usage: 'getCurrencyTrend({ startDate: "2023-01-01", endDate: "2023-01-31", base: "USD", target: "EUR" })',
        examples: [
          'analyze trend of USD to EUR from 2023-01-01 to 2023-01-31',
          'determine if GBP to JPY is increasing, decreasing, or stable over a month',
          'get currency trend between two specific dates'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'http://data.fixer.io/api/',
      cacheDuration: 300 // default cache duration in seconds
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: this.config.cacheDuration, checkperiod: 60 });
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
        case 'getLatestRates':
          return await this.getLatestRates(data);
        case 'getHistoricalRates':
          return await this.getHistoricalRates(data);
        case 'convertCurrency':
          return await this.convertCurrency(data);
        case 'batchConvertCurrency':
          return await this.batchConvertCurrency(data);
        case 'getFluctuation':
          return await this.getFluctuation(data);
        case 'getCurrencyTrend':
          return await this.getCurrencyTrend(data);
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

  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
  }

  async getLatestRates({ base }) {
    this.validateParams({ base }, {
      base: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}latest`;
    const cacheKey = `latestRates_${base}`;

    return await this.getCachedData(cacheKey, async () => {
      try {
        const response = await retryOperation(() => axios.get(url, {
          params: { access_key: this.config.apiKey, base }
        }));
        return { success: true, data: response.data };
      } catch (error) {
        this.logger.error('getLatestRates failed:', error);
        return { success: false, error: error.message };
      }
    });
  }

  async getHistoricalRates({ date, base }) {
    this.validateParams({ date, base }, {
      date: { required: true, type: 'string' },
      base: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}${date}`;
    const cacheKey = `historicalRates_${date}_${base}`;

    return await this.getCachedData(cacheKey, async () => {
      try {
        const response = await retryOperation(() => axios.get(url, {
          params: { access_key: this.config.apiKey, base }
        }));
        return { success: true, data: response.data };
      } catch (error) {
        this.logger.error('getHistoricalRates failed:', error);
        return { success: false, error: error.message };
      }
    });
  }

  async convertCurrency({ amount, from, to }) {
    this.validateParams({ amount, from, to }, {
      amount: { required: true, type: 'number' },
      from: { required: true, type: 'string' },
      to: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}convert`;
    try {
      const response = await retryOperation(() => axios.get(url, {
        params: { access_key: this.config.apiKey, amount, from, to }
      }));
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('convertCurrency failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Convert multiple amounts with a single latest-rates request.
   *
   * Fixer's free tier only serves EUR-based rates (any other `base` returns HTTP 200 with
   * success:false, code 105), so every pair is computed as a cross rate off one EUR table:
   * rate(from->to) = rates[to] / rates[from]. One request covers any number of pairs.
   */
  async batchConvertCurrency({ conversions } = {}) {
    const currencyCode = value => typeof value === 'string' && /^[A-Za-z]{3}$/.test(value);

    if (!Array.isArray(conversions) || conversions.length === 0 || conversions.length > 100) {
      throw new Error('conversions must be a non-empty array containing no more than 100 items');
    }

    const parsed = conversions.map((conversion, index) => {
      if (!conversion || typeof conversion !== 'object' || Array.isArray(conversion)) {
        return { index, success: false, error: 'Malformed conversion entry' };
      }
      const { amount, from, to } = conversion;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return { index, success: false, error: 'amount must be a positive number' };
      }
      if (!currencyCode(from) || !currencyCode(to)) {
        return { index, success: false, error: 'from and to must be three-letter currency codes' };
      }
      return { index, amount, from: from.toUpperCase(), to: to.toUpperCase() };
    });

    const needsRates = parsed.some(item => item.success !== false && item.from !== item.to);
    let rates = null;
    let rateDate = null;
    let ratesError = null;
    if (needsRates) {
      const response = await this.getLatestRates({ base: 'EUR' });
      if (response?.success && response.data?.success !== false && response.data?.rates) {
        rates = { ...response.data.rates, EUR: 1 };
        rateDate = response.data.date || null;
      } else {
        ratesError = response?.data?.error?.info || response?.error || 'Failed to retrieve latest rates';
      }
    }

    const results = parsed.map(item => {
      if (item.success === false) return item;
      const { index, amount, from, to } = item;

      if (from === to) {
        return { index, success: true, amount, from, to, result: amount, effectiveRate: 1, rateDate: null };
      }
      if (!rates) {
        return { index, success: false, from, to, error: ratesError };
      }
      const fromRate = rates[from];
      const toRate = rates[to];
      if (!(Number.isFinite(fromRate) && fromRate > 0) || !Number.isFinite(toRate)) {
        return { index, success: false, from, to, error: `Rate for ${from} to ${to} not found` };
      }
      const effectiveRate = toRate / fromRate;
      return { index, success: true, amount, from, to, result: amount * effectiveRate, effectiveRate, rateDate };
    });

    return {
      success: results.every(item => item.success),
      results
    };
  }

  /**
   * Calculate the fluctuation percentage between two dates for a given currency pair.
   */
  async getFluctuation({ startDate, endDate, base, target }) {
    this.validateParams({ startDate, endDate, base, target }, {
      startDate: { required: true, type: 'string' },
      endDate: { required: true, type: 'string' },
      base: { required: true, type: 'string' },
      target: { required: true, type: 'string' }
    });

    const startRates = await this.getHistoricalRates({ date: startDate, base });
    const endRates = await this.getHistoricalRates({ date: endDate, base });

    if (!startRates.success || !endRates.success) {
      throw new Error('Failed to retrieve historical rates for fluctuation calculation');
    }

    const startRate = startRates.data.rates[target];
    const endRate = endRates.data.rates[target];

    if (!startRate || !endRate) {
      throw new Error(`Rates for target currency ${target} not found`);
    }

    const fluctuation = ((endRate - startRate) / startRate) * 100;
    return { success: true, fluctuation };
  }

  /**
   * Analyze the trend of a currency pair over a specified period.
   */
  async getCurrencyTrend({ startDate, endDate, base, target }) {
    this.validateParams({ startDate, endDate, base, target }, {
      startDate: { required: true, type: 'string' },
      endDate: { required: true, type: 'string' },
      base: { required: true, type: 'string' },
      target: { required: true, type: 'string' }
    });

    const startRates = await this.getHistoricalRates({ date: startDate, base });
    const endRates = await this.getHistoricalRates({ date: endDate, base });

    if (!startRates.success || !endRates.success) {
      throw new Error('Failed to retrieve historical rates for trend analysis');
    }

    const startRate = startRates.data.rates[target];
    const endRate = endRates.data.rates[target];

    if (!startRate || !endRate) {
      throw new Error(`Rates for target currency ${target} not found`);
    }

    let trend;
    if (endRate > startRate) {
      trend = 'increasing';
    } else if (endRate < startRate) {
      trend = 'decreasing';
    } else {
      trend = 'stable';
    }

    return { success: true, trend };
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
