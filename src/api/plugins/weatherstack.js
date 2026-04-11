import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class WeatherstackPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'weatherstack';
    this.version = '1.0.0';
    this.description = 'Instant, accurate weather information';

    // Define required credentials for this plugin
    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'WEATHERSTACK_API_KEY', required: true }
    ];

    // Commands array - CRITICAL for AI natural language support
    this.commands = [
      {
        command: 'getCurrentWeather',
        description: 'Get current weather information for a specified location',
        usage: 'getCurrentWeather({ location: "New York" })',
        examples: [
          'What is the current weather in New York?',
          'Tell me the weather in London right now',
          'Get current weather for Tokyo'
        ]
      },
      {
        command: 'getWeatherDescription',
        description: 'Get a brief weather description for a specified location',
        usage: 'getWeatherDescription({ location: "Paris" })',
        examples: [
          'Describe the weather in Paris',
          'What is the weather like in Berlin?',
          'Weather description for Sydney'
        ]
      },
      {
        command: 'getTemperature',
        description: 'Get the current temperature for a specified location',
        usage: 'getTemperature({ location: "San Francisco" })',
        examples: [
          'What is the temperature in San Francisco?',
          'How hot is it in Cairo?',
          'Tell me the temperature in Beijing'
        ]
      },
      {
        command: 'getHistoricalWeather',
        description: 'Get historical weather information for a specified location and date',
        usage: 'getHistoricalWeather({ location: "New York", date: "2023-01-01" })',
        examples: [
          'What was the weather in New York on January 1, 2023?',
          'Tell me the weather in London on 2022-12-25',
          'Get historical weather for Tokyo on 2021-07-15'
        ]
      },
      {
        command: 'getWeatherForecast',
        description: 'Get weather forecast for a specified location and number of days',
        usage: 'getWeatherForecast({ location: "Los Angeles", days: 3 })',
        examples: [
          'What is the weather forecast for Los Angeles for the next 3 days?',
          'Tell me the weather forecast in Tokyo for the next 5 days',
          'Get weather forecast for New York for the next 7 days'
        ]
      }
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null, 
      baseUrl: 'http://api.weatherstack.com',
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
        case 'getCurrentWeather':
          return await this.getCurrentWeather(data);
        case 'getWeatherDescription':
          return await this.getWeatherDescription(data);
        case 'getTemperature':
          return await this.getTemperature(data);
        case 'getHistoricalWeather':
          return await this.getHistoricalWeather(data);
        case 'getWeatherForecast':
          return await this.getWeatherForecast(data);
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

  async getCurrentWeather({ location }) {
    this.validateParams({ location }, {
      location: { required: true, type: 'string' }
    });

    try {
      const url = `${this.config.baseUrl}/current?access_key=${this.config.apiKey}&query=${location}`;
      const response = await retryOperation(() => axios.get(url), { retries: 3, context: 'getCurrentWeather' });

      const data = response.data;
      if (data.error) {
        throw new Error(data.error.info);
      }
      return { success: true, data };
    } catch (error) {
      this.logger.error('getCurrentWeather error:', error);
      return { success: false, error: error.message };
    }
  }

  async getWeatherDescription({ location }) {
    const result = await this.getCurrentWeather({ location });
    if (result.success) {
      const description = result.data.current.weather_descriptions[0];
      return { success: true, data: description };
    }
    return result;
  }

  async getTemperature({ location }) {
    const result = await this.getCurrentWeather({ location });
    if (result.success) {
      const temperature = result.data.current.temperature;
      return { success: true, data: temperature };
    }
    return result;
  }

  /**
   * New feature: Retrieve historical weather data
   */
  async getHistoricalWeather({ location, date }) {
    this.validateParams({ location, date }, {
      location: { required: true, type: 'string' },
      date: { required: true, type: 'string' }
    });

    try {
      const url = `${this.config.baseUrl}/historical?access_key=${this.config.apiKey}&query=${location}&historical_date=${date}`;
      const response = await retryOperation(() => axios.get(url), { retries: 3, context: 'getHistoricalWeather' });

      const data = response.data;
      if (data.error) {
        throw new Error(data.error.info);
      }
      return { success: true, data };
    } catch (error) {
      this.logger.error('getHistoricalWeather error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * New feature: Retrieve weather forecast data
   */
  async getWeatherForecast({ location, days }) {
    this.validateParams({ location, days }, {
      location: { required: true, type: 'string' },
      days: { required: true, type: 'number' }
    });

    try {
      const url = `${this.config.baseUrl}/forecast?access_key=${this.config.apiKey}&query=${location}&forecast_days=${days}`;
      const response = await retryOperation(() => axios.get(url), { retries: 3, context: 'getWeatherForecast' });

      const data = response.data;
      if (data.error) {
        throw new Error(data.error.info);
      }
      return { success: true, data };
    } catch (error) {
      this.logger.error('getWeatherForecast error:', error);
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
