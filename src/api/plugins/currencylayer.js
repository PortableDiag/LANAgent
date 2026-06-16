import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { retryOperation } from '../../utils/retryUtils.js';

export default class CurrencylayerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'currencylayer';
    this.version = '1.0.0';
    this.description = 'Exchange rates and currency conversion API via currencylayer';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'CURRENCYLAYER_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'getLiveRates',
        description: 'Retrieve live exchange rates for specified currencies',
        usage: 'getLiveRates({ currencies: "EUR,GBP,CAD", source: "USD" })',
        examples: [
          'get live exchange rates for EUR, GBP',
          'fetch current rates for CAD against USD',
          'live rates for currencies'
        ]
      },
      {
        command: 'getHistoricalRates',
        description: 'Retrieve historical exchange rates for a given date',
        usage: 'getHistoricalRates({ date: "2023-01-01", currencies: "EUR,GBP", source: "USD" })',
        examples: [
          'historical rates for EUR on 2023-01-01',
          'fetch past rates for GBP on a specific date',
          'what were the rates for CAD on 2023-01-01'
        ]
      },
      {
        command: 'convertCurrency',
        description: 'Convert an amount from one currency to another',
        usage: 'convertCurrency({ from: "USD", to: "EUR", amount: 100 })',
        examples: [
          'convert 100 USD to EUR',
          'how much is 50 GBP in CAD',
          'currency conversion from USD to JPY'
        ]
      },
      {
        command: 'getRateTrends',
        description: 'Retrieve exchange rate trends over a specified period',
        usage: 'getRateTrends({ startDate: "2023-01-01", endDate: "2023-01-31", currencies: "EUR,GBP", source: "USD" })',
        examples: [
          'exchange rate trends for EUR and GBP from 2023-01-01 to 2023-01-31',
          'fetch rate trends for CAD over a month',
          'trends for currencies over a specified period'
        ]
      },
      {
        command: 'getCurrencyFluctuations',
        description: 'Retrieve currency fluctuation data over a specified period',
        usage: 'getCurrencyFluctuations({ startDate: "2023-01-01", endDate: "2023-01-31", currencies: "EUR,GBP", source: "USD" })',
        examples: [
          'currency fluctuations for EUR and GBP from 2023-01-01 to 2023-01-31',
          'fetch fluctuation data for CAD over a month',
          'fluctuations for currencies over a specified period'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'http://api.currencylayer.com'
    };

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
        case 'getLiveRates':
          return await this.getLiveRates(data);
        case 'getHistoricalRates':
          return await this.getHistoricalRates(data);
        case 'convertCurrency':
          return await this.convertCurrency(data);
        case 'getRateTrends':
          return await this.getRateTrends(data);
        case 'getCurrencyFluctuations':
          return await this.getCurrencyFluctuations(data);
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

  async getLiveRates({ currencies = 'EUR,GBP', source = 'USD' }) {
    const url = `${this.config.baseUrl}/live`;
    const response = await retryOperation(() => axios.get(url, {
      params: {
        access_key: this.config.apiKey,
        currencies,
        source
      }
    }), { retries: 3, context: 'currencylayer getLiveRates' });

    if (response.data.success) {
      return { success: true, data: response.data.quotes };
    } else {
      throw new Error(response.data.error?.info || 'Failed to get live rates');
    }
  }

  async getHistoricalRates({ date, currencies = 'EUR,GBP', source = 'USD' }) {
    if (!date) {
      return { success: false, error: 'Date parameter is required (YYYY-MM-DD)' };
    }

    const url = `${this.config.baseUrl}/historical`;
    const response = await retryOperation(() => axios.get(url, {
      params: {
        access_key: this.config.apiKey,
        date,
        currencies,
        source
      }
    }), { retries: 3, context: 'currencylayer getHistoricalRates' });

    if (response.data.success) {
      return { success: true, data: response.data.quotes };
    } else {
      throw new Error(response.data.error?.info || 'Failed to get historical rates');
    }
  }

  async convertCurrency({ from, to, amount }) {
    if (!from || !to || amount === undefined) {
      return { success: false, error: 'from, to, and amount parameters are required' };
    }

    const url = `${this.config.baseUrl}/convert`;
    const response = await retryOperation(() => axios.get(url, {
      params: {
        access_key: this.config.apiKey,
        from,
        to,
        amount
      }
    }), { retries: 3, context: 'currencylayer convertCurrency' });

    if (response.data.success) {
      return { success: true, data: response.data.result, info: response.data.info };
    } else {
      throw new Error(response.data.error?.info || 'Failed to convert currency');
    }
  }

  async getRateTrends({ startDate, endDate, currencies = 'EUR,GBP', source = 'USD' }) {
    if (!startDate || !endDate) {
      return { success: false, error: 'startDate and endDate parameters are required (YYYY-MM-DD)' };
    }

    const url = `${this.config.baseUrl}/timeseries`;
    const response = await retryOperation(() => axios.get(url, {
      params: {
        access_key: this.config.apiKey,
        start_date: startDate,
        end_date: endDate,
        currencies,
        source
      }
    }), { retries: 3, context: 'currencylayer getRateTrends' });

    if (response.data.success) {
      return { success: true, data: response.data.quotes };
    } else {
      throw new Error(response.data.error?.info || 'Failed to get rate trends');
    }
  }

  /**
   * New feature: Currency fluctuation analysis
   */
  async getCurrencyFluctuations({ startDate, endDate, currencies = 'EUR,GBP', source = 'USD' }) {
    if (!startDate || !endDate) {
      return { success: false, error: 'startDate and endDate parameters are required (YYYY-MM-DD)' };
    }

    const url = `${this.config.baseUrl}/fluctuation`;
    const response = await retryOperation(() => axios.get(url, {
      params: {
        access_key: this.config.apiKey,
        start_date: startDate,
        end_date: endDate,
        currencies,
        source
      }
    }), { retries: 3, context: 'currencylayer getCurrencyFluctuations' });

    if (response.data.success) {
      return { success: true, data: response.data.quotes };
    } else {
      throw new Error(response.data.error?.info || 'Failed to get currency fluctuations');
    }
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