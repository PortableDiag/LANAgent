import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation, isRetryableError } from '../../utils/retryUtils.js';

export default class IpgeolocationPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'ipgeolocation';
    this.version = '1.0.0';
    this.description = 'IP address geolocation and timezone information service';

    this.commands = [
      {
        command: 'lookup_ip',
        description: 'Get geolocation data for an IP address',
        usage: 'lookup_ip({ ip: "8.8.8.8", fields: "city,country_name,time_zone" })',
        examples: [
          'lookup IP address 8.8.8.8',
          'get location for IP 1.1.1.1',
          'where is IP address 192.168.1.1 located',
          'find geolocation of my IP',
          'check location of IP 8.8.4.4'
        ]
      },
      {
        command: 'timezone_info',
        description: 'Get timezone information for a location',
        usage: 'timezone_info({ tz: "America/New_York" }) or timezone_info({ lat: 40.7128, long: -74.0060 })',
        examples: [
          'what time is it in New York',
          'get timezone for London',
          'timezone info for coordinates 40.7128, -74.0060',
          'current time in Tokyo timezone',
          'what is the timezone at latitude 51.5074 longitude -0.1278'
        ]
      },
      {
        command: 'astronomy',
        description: 'Get astronomy data like sunrise and sunset times',
        usage: 'astronomy({ lat: 40.7128, long: -74.0060 })',
        examples: [
          'when is sunset at 40.7128, -74.0060',
          'sunrise time for New York coordinates',
          'get astronomy data for latitude 51.5074 longitude -0.1278',
          'what time does the sun rise in London',
          'sunset and sunrise times for Paris'
        ]
      },
      {
        command: 'my_location',
        description: 'Get geolocation data for your current IP address',
        usage: 'my_location()',
        examples: [
          'what is my location',
          'where am I',
          'get my IP location',
          'show my current location',
          'what is my IP address and location'
        ]
      },
      {
        command: 'historical_ip_lookup',
        description: 'Get historical geolocation data for an IP address over a date range',
        usage: 'historical_ip_lookup({ ip: "8.8.8.8", startDate: "2023-01-01", endDate: "2023-01-31" })',
        examples: [
          'get historical location for IP 8.8.8.8 from January 2023',
          'historical geolocation data for IP 1.1.1.1 between 2023-01-01 and 2023-01-31',
          'where was IP 192.168.1.1 located last month'
        ]
      },
      {
        command: 'batch_lookup_ip',
        description: 'Get geolocation data for a batch of IP addresses',
        usage: 'batch_lookup_ip({ ips: ["8.8.8.8", "1.1.1.1"], fields: "city,country_name" })',
        examples: [
          'batch lookup IP addresses 8.8.8.8 and 1.1.1.1',
          'get locations for multiple IPs',
          'find geolocations for IPs 192.168.1.1, 8.8.4.4'
        ]
      }
    ];

    this.config = {
      apiKey: process.env.IPGEOLOCATION_API_KEY,
      baseUrl: 'https://api.ipgeolocation.io',
      cacheTimeout: 3600,
      defaultFields: 'ip,country_name,country_code2,state_prov,city,zipcode,latitude,longitude,time_zone,currency'
    };

    this.initialized = false;
    this.cache = new Map();
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        Object.assign(this.config, savedConfig);
        this.logger.info('Loaded cached configuration');
      }

      if (!this.config.apiKey) {
        throw new Error('IPGEOLOCATION_API_KEY environment variable is required');
      }

      try {
        const testResponse = await axios.get(`${this.config.baseUrl}/ipgeo`, {
          params: {
            apiKey: this.config.apiKey,
            ip: '8.8.8.8',
            fields: 'ip,country_name'
          },
          timeout: 5000
        });

        if (testResponse.data && testResponse.data.ip) {
          this.logger.info('API connection test successful');
        }
      } catch (error) {
        this.logger.warn('API connection test failed:', error.message);
        throw new Error(`Failed to connect to IPGeolocation API: ${error.message}`);
      }

      await PluginSettings.setCached(this.name, 'config', this.config);

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
        case 'lookup_ip':
          return await this.lookupIP(data);
        case 'timezone_info':
          return await this.getTimezoneInfo(data);
        case 'astronomy':
          return await this.getAstronomyData(data);
        case 'my_location':
          return await this.getMyLocation(data);
        case 'historical_ip_lookup':
          return await this.historicalIPLookup(data);
        case 'batch_lookup_ip':
          return await this.batchLookupIP(data);
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

  async lookupIP(params) {
    this.validateParams(params, {
      ip: {
        required: false,
        type: 'string',
        pattern: /^(\d{1,3}\.){3}\d{1,3}$/
      },
      fields: {
        required: false,
        type: 'string'
      },
      excludes: {
        required: false,
        type: 'string'
      }
    });

    const { ip, fields = this.config.defaultFields, excludes } = params;

    const cacheKey = `ip_${ip || 'current'}_${fields}_${excludes || ''}`;
    const cached = await PluginSettings.getCached(this.name, cacheKey, this.config.cacheTimeout);
    if (cached) {
      this.logger.debug('Returning cached IP lookup result');
      return { success: true, data: cached };
    }

    try {
      const queryParams = {
        apiKey: this.config.apiKey,
        fields
      };

      if (ip) queryParams.ip = ip;
      if (excludes) queryParams.excludes = excludes;

      const response = await axios.get(`${this.config.baseUrl}/ipgeo`, {
        params: queryParams,
        timeout: 10000
      });

      if (response.data) {
        await PluginSettings.setCached(this.name, cacheKey, response.data);

        return {
          success: true,
          data: response.data
        };
      } else {
        throw new Error('No data received from API');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`API error: ${error.response.data.message || error.response.statusText}`);
      }
      throw error;
    }
  }

  async getTimezoneInfo(params) {
    this.validateParams(params, {
      tz: { required: false, type: 'string' },
      lat: { required: false, type: 'number' },
      long: { required: false, type: 'number' },
      ip: { required: false, type: 'string' }
    });

    const { tz, lat, long, ip } = params;

    if (!tz && !lat && !ip) {
      throw new Error('At least one parameter (tz, lat/long, or ip) is required');
    }

    if (lat && !long) {
      throw new Error('Longitude is required when latitude is provided');
    }

    const cacheKey = `tz_${tz || ''}_${lat || ''}_${long || ''}_${ip || ''}`;
    const cached = await PluginSettings.getCached(this.name, cacheKey, this.config.cacheTimeout);
    if (cached) {
      this.logger.debug('Returning cached timezone result');
      return { success: true, data: cached };
    }

    try {
      const queryParams = { apiKey: this.config.apiKey };

      if (tz) queryParams.tz = tz;
      if (lat) queryParams.lat = lat;
      if (long) queryParams.long = long;
      if (ip) queryParams.ip = ip;

      const response = await axios.get(`${this.config.baseUrl}/timezone`, {
        params: queryParams,
        timeout: 10000
      });

      if (response.data) {
        await PluginSettings.setCached(this.name, cacheKey, response.data);
        return { success: true, data: response.data };
      } else {
        throw new Error('No data received from API');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`API error: ${error.response.data.message || error.response.statusText}`);
      }
      throw error;
    }
  }

  async getAstronomyData(params) {
    this.validateParams(params, {
      lat: { required: true, type: 'number', min: -90, max: 90 },
      long: { required: true, type: 'number', min: -180, max: 180 }
    });

    const { lat, long } = params;

    const cacheKey = `astro_${lat}_${long}`;
    const cached = await PluginSettings.getCached(this.name, cacheKey, this.config.cacheTimeout);
    if (cached) {
      this.logger.debug('Returning cached astronomy result');
      return { success: true, data: cached };
    }

    try {
      const response = await axios.get(`${this.config.baseUrl}/astronomy`, {
        params: { apiKey: this.config.apiKey, lat, long },
        timeout: 10000
      });

      if (response.data) {
        await PluginSettings.setCached(this.name, cacheKey, response.data);
        return { success: true, data: response.data };
      } else {
        throw new Error('No data received from API');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`API error: ${error.response.data.message || error.response.statusText}`);
      }
      throw error;
    }
  }

  async getMyLocation() {
    return await this.lookupIP({ fields: this.config.defaultFields });
  }

  async historicalIPLookup(params) {
    this.validateParams(params, {
      ip: { required: true, type: 'string', pattern: /^(\d{1,3}\.){3}\d{1,3}$/ },
      startDate: { required: true, type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ },
      endDate: { required: true, type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ }
    });

    const { ip, startDate, endDate } = params;
    const cacheKey = `historical_ip_${ip}_${startDate}_${endDate}`;
    const cached = await PluginSettings.getCached(this.name, cacheKey, this.config.cacheTimeout);
    if (cached) {
      this.logger.debug('Returning cached historical IP lookup result');
      return { success: true, data: cached };
    }

    try {
      const response = await retryOperation(() => axios.get(`${this.config.baseUrl}/historical-ipgeo`, {
        params: { apiKey: this.config.apiKey, ip, startDate, endDate },
        timeout: 10000
      }), {
        retries: 3,
        shouldRetry: isRetryableError
      });

      if (response.data) {
        await PluginSettings.setCached(this.name, cacheKey, response.data);
        return { success: true, data: response.data };
      } else {
        throw new Error('No data received from API');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`API error: ${error.response.data.message || error.response.statusText}`);
      }
      throw error;
    }
  }

  async batchLookupIP(params) {
    this.validateParams(params, {
      ips: { required: true, type: 'object' },
      fields: { required: false, type: 'string' }
    });

    const { ips, fields = this.config.defaultFields } = params;

    if (!Array.isArray(ips) || ips.length === 0) {
      return { success: false, error: 'ips must be a non-empty array of IP addresses' };
    }

    const results = [];
    for (const ip of ips) {
      const cacheKey = `ip_${ip}_${fields}`;
      const cached = await PluginSettings.getCached(this.name, cacheKey, this.config.cacheTimeout);
      if (cached) {
        this.logger.debug(`Returning cached result for IP: ${ip}`);
        results.push({ ip, data: cached });
        continue;
      }

      try {
        const response = await axios.get(`${this.config.baseUrl}/ipgeo`, {
          params: { apiKey: this.config.apiKey, ip, fields },
          timeout: 10000
        });

        if (response.data) {
          await PluginSettings.setCached(this.name, cacheKey, response.data);
          results.push({ ip, data: response.data });
        } else {
          results.push({ ip, error: 'No data received from API' });
        }
      } catch (error) {
        const msg = error.response?.data?.message || error.message;
        this.logger.error(`Error for IP ${ip}: ${msg}`);
        results.push({ ip, error: msg });
      }
    }

    return { success: true, results };
  }

  async extractParameters(input, action) {
    const prompts = {
      lookup_ip: `Extract IP address and optional fields from: "${input}"
        Return JSON with:
        - ip: the IP address if mentioned (optional)
        - fields: comma-separated fields if specific data requested (optional)
        Example: {"ip": "8.8.8.8", "fields": "city,country_name"}`,

      timezone_info: `Extract timezone or location parameters from: "${input}"
        Return JSON with ONE of:
        - tz: timezone name like "America/New_York" if mentioned
        - lat and long: coordinates if mentioned
        - ip: IP address if mentioned
        Example: {"tz": "Europe/London"} or {"lat": 40.7128, "long": -74.0060}`,

      astronomy: `Extract coordinates from: "${input}"
        Return JSON with:
        - lat: latitude (required)
        - long: longitude (required)
        Example: {"lat": 51.5074, "long": -0.1278}`,

      my_location: `No parameters needed for my_location. Return: {}`,

      historical_ip_lookup: `Extract IP address and date range from: "${input}"
        Return JSON with:
        - ip: the IP address (required)
        - startDate: start date in YYYY-MM-DD format (required)
        - endDate: end date in YYYY-MM-DD format (required)
        Example: {"ip": "8.8.8.8", "startDate": "2023-01-01", "endDate": "2023-01-31"}`,

      batch_lookup_ip: `Extract array of IP addresses and optional fields from: "${input}"
        Return JSON with:
        - ips: array of IP addresses (required)
        - fields: comma-separated fields if specific data requested (optional)
        Example: {"ips": ["8.8.8.8", "1.1.1.1"], "fields": "city,country_name"}`
    };

    const prompt = prompts[action] || `Extract parameters for ${action} from: "${input}"`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    try {
      const parsed = JSON.parse(response.content);
      this.logger.debug(`Extracted parameters for ${action}:`, parsed);
      return parsed;
    } catch (error) {
      this.logger.warn('Failed to parse AI parameters:', error);
      return {};
    }
  }

  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
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
