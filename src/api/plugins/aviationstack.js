import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

export default class AviationstackPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'aviationstack';
    this.version = '1.0.0';
    this.description = 'Real-time flight status and global aviation data via aviationstack';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'AVIATIONSTACK_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'getFlightStatus',
        description: 'Retrieve the status of a specific flight',
        usage: 'getFlightStatus({ flightNumber: "BA2490", date: "2023-10-12" })',
        examples: [
          'What is the status of flight BA2490?',
          'Check the flight status for UA1234 on October 12th',
          'Is flight LH5678 on time today?'
        ]
      },
      {
        command: 'getAirlineInfo',
        description: 'Retrieve information about a specific airline',
        usage: 'getAirlineInfo({ airlineCode: "AA" })',
        examples: [
          'Tell me about American Airlines',
          'Get details for airline code UA',
          'Fetch information about Delta Airlines'
        ]
      },
      {
        command: 'getAirportInfo',
        description: 'Retrieve information about a specific airport',
        usage: 'getAirportInfo({ airportCode: "JFK" })',
        examples: [
          'What can you tell me about JFK airport?',
          'Get details for LAX airport',
          'Fetch information about Heathrow airport'
        ]
      },
      {
        command: 'getHistoricalFlightData',
        description: 'Retrieve historical flight data for a specific flight number and date range',
        usage: 'getHistoricalFlightData({ flightNumber: "BA2490", startDate: "2023-01-01", endDate: "2023-01-31" })',
        examples: [
          'Get historical data for flight BA2490 from January 1st to January 31st',
          'Fetch historical flight information for UA1234 for the past week'
        ]
      },
      {
        command: 'getFlightsByRoute',
        description: 'Retrieve flights for a specific route (departure and arrival IATA codes)',
        usage: 'getFlightsByRoute({ depIata: "JFK", arrIata: "LAX", date: "2026-05-22", limit: 50, offset: 0 })',
        examples: ['List flights from JFK to LAX today', 'Show flights from SFO to SEA on October 12']
      },
      {
        command: 'getAirlineFlights',
        description: 'Retrieve flights operated by a specific airline (IATA code)',
        usage: 'getAirlineFlights({ airlineCode: "AA", date: "2026-05-22", limit: 50, offset: 0 })',
        examples: ['Show American Airlines flights today', 'List UA flights on Oct 12']
      },
      {
        command: 'getLiveFlightPosition',
        description: 'Retrieve the live position for a specific flight number',
        usage: 'getLiveFlightPosition({ flightNumber: "BA2490", date: "2026-05-22" })',
        examples: ['Where is BA2490 right now?', 'Get current position of UA1234']
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'https://api.aviationstack.com/v1'
    };

    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    this.initialized = false;
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.apiKey = credentials.apiKey;

      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
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
        case 'getFlightStatus':
          return await this.getFlightStatus(data);
        case 'getAirlineInfo':
          return await this.getAirlineInfo(data);
        case 'getAirportInfo':
          return await this.getAirportInfo(data);
        case 'getHistoricalFlightData':
          return await this.getHistoricalFlightData(data);
        case 'getFlightsByRoute':
          return await this.getFlightsByRoute(data);
        case 'getAirlineFlights':
          return await this.getAirlineFlights(data);
        case 'getLiveFlightPosition':
          return await this.getLiveFlightPosition(data);
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

  async getFlightStatus({ flightNumber, date }) {
    if (!flightNumber) {
      return { success: false, error: 'flightNumber parameter is required' };
    }

    const url = `${this.config.baseUrl}/flights`;
    try {
      const params = {
        access_key: this.config.apiKey,
        flight_iata: flightNumber
      };
      if (date) {
        params.flight_date = date;
      }

      const response = await retryOperation(() => axios.get(url, { params }), {
        retries: 3,
        context: 'aviationstack getFlightStatus'
      });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching flight status:', error);
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

  async getAirlineInfo({ airlineCode }) {
    if (!airlineCode) {
      return { success: false, error: 'airlineCode parameter is required' };
    }

    const url = `${this.config.baseUrl}/airlines`;
    try {
      const response = await this.getCachedData(`airlineInfo_${airlineCode}`, async () => {
        return await retryOperation(() => axios.get(url, {
          params: {
            access_key: this.config.apiKey,
            iata_code: airlineCode
          }
        }), { retries: 3, context: 'aviationstack getAirlineInfo' });
      });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching airline info:', error);
      return { success: false, error: error.message };
    }
  }

  async getAirportInfo({ airportCode }) {
    if (!airportCode) {
      return { success: false, error: 'airportCode parameter is required' };
    }

    const url = `${this.config.baseUrl}/airports`;
    try {
      const response = await this.getCachedData(`airportInfo_${airportCode}`, async () => {
        return await retryOperation(() => axios.get(url, {
          params: {
            access_key: this.config.apiKey,
            iata_code: airportCode
          }
        }), { retries: 3, context: 'aviationstack getAirportInfo' });
      });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching airport info:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieve historical flight data for a specific flight number and date range
   * @param {Object} params - Parameters for retrieving historical flight data
   * @param {string} params.flightNumber - The flight number to retrieve data for
   * @param {string} params.startDate - The start date for the historical data range
   * @param {string} params.endDate - The end date for the historical data range
   * @returns {Promise<Object>} - The result of the API call
   */
  async getHistoricalFlightData({ flightNumber, startDate, endDate }) {
    if (!flightNumber) {
      return { success: false, error: 'flightNumber parameter is required' };
    }
    if (!startDate || !endDate) {
      return { success: false, error: 'Both startDate and endDate parameters are required' };
    }

    const url = `${this.config.baseUrl}/flights`;
    try {
      const params = {
        access_key: this.config.apiKey,
        flight_iata: flightNumber,
        date_from: startDate,
        date_to: endDate
      };

      const response = await retryOperation(() => axios.get(url, { params }), {
        retries: 3,
        context: 'aviationstack getHistoricalFlightData'
      });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching historical flight data:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Flights filtered by route (departure + arrival IATA codes).
   */
  async getFlightsByRoute({ depIata, arrIata, date, limit, offset }) {
    if (!depIata || !arrIata) return { success: false, error: 'depIata and arrIata parameters are required' };
    const url = `${this.config.baseUrl}/flights`;
    try {
      const params = { access_key: this.config.apiKey, dep_iata: depIata, arr_iata: arrIata };
      if (date) params.flight_date = date;
      if (typeof limit !== 'undefined') params.limit = limit;
      if (typeof offset !== 'undefined') params.offset = offset;
      const response = await retryOperation(() => axios.get(url, { params }), { retries: 3, context: 'aviationstack getFlightsByRoute' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching flights by route:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Flights filtered by airline IATA code.
   */
  async getAirlineFlights({ airlineCode, date, limit, offset }) {
    if (!airlineCode) return { success: false, error: 'airlineCode parameter is required' };
    const url = `${this.config.baseUrl}/flights`;
    try {
      const params = { access_key: this.config.apiKey, airline_iata: airlineCode };
      if (date) params.flight_date = date;
      if (typeof limit !== 'undefined') params.limit = limit;
      if (typeof offset !== 'undefined') params.offset = offset;
      const response = await retryOperation(() => axios.get(url, { params }), { retries: 3, context: 'aviationstack getAirlineFlights' });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching airline flights:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Slimmed live position object for the first matching flight, when available.
   */
  async getLiveFlightPosition({ flightNumber, date }) {
    if (!flightNumber) return { success: false, error: 'flightNumber parameter is required' };
    const url = `${this.config.baseUrl}/flights`;
    try {
      const params = { access_key: this.config.apiKey, flight_iata: flightNumber };
      if (date) params.flight_date = date;
      const response = await retryOperation(() => axios.get(url, { params }), { retries: 3, context: 'aviationstack getLiveFlightPosition' });
      const data = Array.isArray(response?.data?.data) ? response.data.data : [];
      if (!data.length) return { success: true, data: null };
      const first = data[0];
      const live = first?.live || first?.data?.live || null;
      if (!live) return { success: true, data: null };
      return {
        success: true,
        data: {
          latitude: live.latitude ?? null,
          longitude: live.longitude ?? null,
          altitude: live.altitude ?? null,
          direction: live.direction ?? null,
          speed: live.speed_horizontal ?? live.speed ?? null,
          updated: live.updated ?? null
        }
      };
    } catch (error) {
      this.logger.error('Error fetching live flight position:', error);
      return { success: false, error: error.message };
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