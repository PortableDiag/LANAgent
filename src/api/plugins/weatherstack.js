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
      const url = `${this.config.baseUrl}/current?access_key=${this.config.apiKey}&query=${encodeURIComponent(location)}`;
      const response = await retryOperation(() => axios.get(url), { retries: 1, context: 'getCurrentWeather' });

      const data = response.data;
      if (data.error) {
        throw new Error(data.error.info);
      }
      return { success: true, data };
    } catch (error) {
      this.logger.error('getCurrentWeather error:', error.message);
      return await this.viaOpenMeteo('current', { location }, error);
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
      const url = `${this.config.baseUrl}/historical?access_key=${this.config.apiKey}&query=${encodeURIComponent(location)}&historical_date=${encodeURIComponent(date)}`;
      const response = await retryOperation(() => axios.get(url), { retries: 1, context: 'getHistoricalWeather' });

      const data = response.data;
      if (data.error) {
        throw new Error(data.error.info);
      }
      return { success: true, data };
    } catch (error) {
      this.logger.error('getHistoricalWeather error:', error.message);
      return await this.viaOpenMeteo('historical', { location, date }, error);
    }
  }

  /**
   * New feature: Retrieve weather forecast data
   */
  async getWeatherForecast({ location, days = 3 }) {
    this.validateParams({ location, days }, {
      location: { required: true, type: 'string' },
      days: { required: true, type: 'number' }
    });
    days = Math.max(1, Math.min(16, Number(days) || 3));

    try {
      const url = `${this.config.baseUrl}/forecast?access_key=${this.config.apiKey}&query=${encodeURIComponent(location)}&forecast_days=${encodeURIComponent(days)}`;
      const response = await retryOperation(() => axios.get(url), { retries: 1, context: 'getWeatherForecast' });

      const data = response.data;
      if (data.error) {
        throw new Error(data.error.info);
      }
      return { success: true, data };
    } catch (error) {
      this.logger.error('getWeatherForecast error:', error.message);
      return await this.viaOpenMeteo('forecast', { location, days }, error);
    }
  }

  /**
   * Open-Meteo (free, no key) answers when Weatherstack does not: on 2026-11-09 Weatherstack refused the configured key
   * (401) and every paid weather call failed. The answer keeps Weatherstack's shape (location, current.temperature,
   * current.weather_descriptions, forecast / historical by date), so callers and the gateway see no difference but `source`.
   */
  async viaOpenMeteo(kind, { location, date, days = 3 }, cause) {
    const WMO = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Depositing rime fog',
      51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Dense freezing drizzle',
      61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
      71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light rain showers', 81: 'Rain showers',
      82: 'Violent rain showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail' };
    try {
      const geo = (await axios.get('https://geocoding-api.open-meteo.com/v1/search', { params: { name: String(location).split(',')[0].trim(), count: 1 }, timeout: 15000 })).data?.results?.[0];
      if (!geo) return { success: false, error: `No place called '${location}' was found` };
      const place = { name: geo.name, country: geo.country, region: geo.admin1, lat: String(geo.latitude), lon: String(geo.longitude), timezone_id: geo.timezone };
      const daily = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max';
      const common = { latitude: geo.latitude, longitude: geo.longitude, timezone: 'auto' };
      const dayRows = (d) => Object.fromEntries((d?.time || []).map((day, i) => [day, {
        date: day, maxtemp: d.temperature_2m_max[i], mintemp: d.temperature_2m_min[i], totalprecip: d.precipitation_sum[i],
        maxwind: d.wind_speed_10m_max[i], weather_descriptions: [WMO[d.weather_code[i]] || `Code ${d.weather_code[i]}`] }]));
      let data;
      if (kind === 'current') {
        const c = (await axios.get('https://api.open-meteo.com/v1/forecast', { params: { ...common,
          current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,precipitation,cloud_cover,is_day' }, timeout: 15000 })).data.current;
        data = { location: place, current: { observation_time: c.time, temperature: c.temperature_2m, feelslike: c.apparent_temperature,
          humidity: c.relative_humidity_2m, wind_speed: c.wind_speed_10m, wind_degree: c.wind_direction_10m, pressure: c.pressure_msl,
          precip: c.precipitation, cloudcover: c.cloud_cover, is_day: c.is_day ? 'yes' : 'no',
          weather_code: c.weather_code, weather_descriptions: [WMO[c.weather_code] || `Code ${c.weather_code}`] } };
      } else if (kind === 'forecast') {
        const d = (await axios.get('https://api.open-meteo.com/v1/forecast', { params: { ...common, daily, forecast_days: Math.max(1, Math.min(16, Number(days) || 3)) }, timeout: 15000 })).data.daily;
        data = { location: place, forecast: dayRows(d) };
      } else if (kind === 'historical') {
        const d = (await axios.get('https://archive-api.open-meteo.com/v1/archive', { params: { ...common, daily, start_date: date, end_date: date }, timeout: 15000 })).data.daily;
        data = { location: place, historical: dayRows(d) };
      } else return { success: false, error: cause?.message || 'unknown weather request' };
      this.logger.info(`Weather from Open-Meteo (${kind}, ${place.name}); Weatherstack: ${cause?.message || 'not used'}`);
      return { success: true, data, source: 'open-meteo' };
    } catch (e) {
      return { success: false, error: `Weatherstack failed (${cause?.message}) and Open-Meteo failed (${e.message})` };
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
