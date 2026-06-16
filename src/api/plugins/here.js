/**
 * HERE API Plugin
 *
 * Provides location services including geocoding, reverse geocoding,
 * and routing/directions using the HERE Maps API.
 *
 * API Documentation: https://developer.here.com/documentation
 *
 * Required Environment Variable: HERE_API_KEY
 */

import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import axios from 'axios';

export default class HerePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'here';
    this.version = '1.0.0';
    this.description = 'Location services: geocoding, reverse geocoding, and routing via HERE Maps API';
    this.category = 'location';

    // Define required credentials for this plugin
    // Used by the credentials API and loadCredentials() helper
    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'HERE_API_KEY', required: true }
    ];

    // Commands array for vector intent detection
    // Each command includes examples for better natural language matching
    this.commands = [
      {
        command: 'geocode',
        description: 'Convert an address or place name to geographic coordinates (latitude/longitude)',
        usage: 'geocode({ address: "1600 Pennsylvania Avenue, Washington DC" })',
        examples: [
          'get coordinates for the Eiffel Tower',
          'find the location of 123 Main Street, New York',
          'geocode the White House address',
          'what are the coordinates of Big Ben in London',
          'convert this address to lat/long: 1 Infinite Loop, Cupertino'
        ]
      },
      {
        command: 'reverseGeocode',
        description: 'Convert geographic coordinates (latitude/longitude) to a human-readable address',
        usage: 'reverseGeocode({ lat: 40.748817, lng: -73.985428 })',
        examples: [
          'what address is at coordinates 40.7128, -74.0060',
          'reverse geocode 51.5074, -0.1278',
          'find the address for latitude 48.8584 longitude 2.2945',
          'what location is at these GPS coordinates: 34.0522, -118.2437',
          'get the street address for coords 37.7749, -122.4194'
        ]
      },
      {
        command: 'route',
        description: 'Calculate driving directions and route information between two locations',
        usage: 'route({ origin: "New York, NY", destination: "Boston, MA", mode: "car" })',
        examples: [
          'get directions from Los Angeles to San Francisco',
          'how do I drive from Chicago to Detroit',
          'calculate route from Seattle to Portland',
          'find the best way to drive from Miami to Orlando',
          'driving directions from London to Manchester'
        ]
      },
      {
        command: 'discover',
        description: 'Search for places and points of interest near a location',
        usage: 'discover({ query: "restaurants", near: "Times Square, NYC", limit: 10 })',
        examples: [
          'find restaurants near Times Square',
          'search for coffee shops in downtown Seattle',
          'discover hotels near the airport in Denver',
          'what gas stations are near 90210',
          'find pharmacies close to Central Park'
        ]
      }
    ];

    // Plugin configuration - apiKey loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null,
      geocodeUrl: 'https://geocode.search.hereapi.com/v1',
      routingUrl: 'https://router.hereapi.com/v8',
      discoverUrl: 'https://discover.search.hereapi.com/v1'
    };

    this.initialized = false;
    this.cache = new Map();
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      // Load credentials using the new BasePlugin helper
      // This checks DB first (encrypted), then falls back to env var
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.apiKey = credentials.apiKey;
        this.logger.info('Loaded API key from credentials store');
      } catch (credError) {
        // Not a fatal error - plugin can still work, just with limited functionality
        this.logger.warn(`Credentials not configured: ${credError.message}`);
      }

      // Load other cached configuration
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        // Don't overwrite apiKey from credentials
        const { apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      // Check for API key
      if (!this.config.apiKey) {
        this.logger.warn('HERE API key not configured - plugin will have limited functionality');
      }

      // Save non-credential configuration to cache
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

    // Handle AI parameter extraction for vector-matched intents
    if (params.needsParameterExtraction && this.agent?.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }

    try {
      switch (action) {
        case 'geocode':
          return await this.geocode(data);
        case 'reverseGeocode':
          return await this.reverseGeocode(data);
        case 'route':
          return await this.calculateRoute(data);
        case 'discover':
          return await this.discoverPlaces(data);
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
    For HERE Maps plugin action: ${action}

    Actions and their parameters:
    - geocode: { address: "full address string" }
    - reverseGeocode: { lat: number, lng: number }
    - route: { origin: "start location", destination: "end location", mode: "car|pedestrian|truck" }
    - discover: { query: "what to search", near: "location or address", limit: number }

    Return JSON with the appropriate parameters.`;

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

  /**
   * Geocode an address to coordinates
   */
  async geocode({ address }) {
    if (!address) {
      return { success: false, error: 'Address is required' };
    }

    if (!this.config.apiKey) {
      return { success: false, error: 'HERE API key not configured. Please configure it in plugin settings.' };
    }

    // Check cache first
    const cacheKey = `geocode:${address.toLowerCase()}`;
    if (this.cache.has(cacheKey)) {
      return { success: true, data: this.cache.get(cacheKey), cached: true };
    }

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.geocodeUrl}/geocode`, {
          params: {
            q: address,
            apiKey: this.config.apiKey
          }
        }),
        { retries: 3, context: 'HERE Geocode API' }
      );

      if (!response.data.items || response.data.items.length === 0) {
        return { success: false, error: 'No results found for this address' };
      }

      const result = response.data.items[0];
      const data = {
        address: result.address?.label || address,
        position: result.position,
        type: result.resultType,
        confidence: result.scoring?.queryScore || 0,
        mapView: result.mapView
      };

      // Cache the result
      this.cache.set(cacheKey, data);

      return { success: true, data };
    } catch (error) {
      this.logger.error('Geocode failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Reverse geocode coordinates to an address
   */
  async reverseGeocode({ lat, lng, latitude, longitude }) {
    // Support both lat/lng and latitude/longitude parameter names
    const latValue = lat || latitude;
    const lngValue = lng || longitude;

    if (latValue === undefined || lngValue === undefined) {
      return { success: false, error: 'Latitude and longitude are required' };
    }

    if (!this.config.apiKey) {
      return { success: false, error: 'HERE API key not configured. Please configure it in plugin settings.' };
    }

    // Check cache
    const cacheKey = `reverse:${latValue},${lngValue}`;
    if (this.cache.has(cacheKey)) {
      return { success: true, data: this.cache.get(cacheKey), cached: true };
    }

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.geocodeUrl}/revgeocode`, {
          params: {
            at: `${latValue},${lngValue}`,
            apiKey: this.config.apiKey
          }
        }),
        { retries: 3, context: 'HERE Reverse Geocode API' }
      );

      if (!response.data.items || response.data.items.length === 0) {
        return { success: false, error: 'No address found for these coordinates' };
      }

      const result = response.data.items[0];
      const data = {
        address: result.address?.label,
        street: result.address?.street,
        city: result.address?.city,
        state: result.address?.state,
        country: result.address?.countryName,
        postalCode: result.address?.postalCode,
        position: result.position,
        distance: result.distance
      };

      // Cache the result
      this.cache.set(cacheKey, data);

      return { success: true, data };
    } catch (error) {
      this.logger.error('Reverse geocode failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Calculate a route between two locations
   */
  async calculateRoute({ origin, destination, mode = 'car' }) {
    if (!origin || !destination) {
      return { success: false, error: 'Origin and destination are required' };
    }

    if (!this.config.apiKey) {
      return { success: false, error: 'HERE API key not configured. Please configure it in plugin settings.' };
    }

    try {
      // First, geocode the origin and destination if they're not coordinates
      let originCoords, destCoords;

      if (typeof origin === 'string') {
        const geocoded = await this.geocode({ address: origin });
        if (!geocoded.success) {
          return { success: false, error: `Could not geocode origin: ${geocoded.error}` };
        }
        originCoords = geocoded.data.position;
      } else {
        originCoords = origin;
      }

      if (typeof destination === 'string') {
        const geocoded = await this.geocode({ address: destination });
        if (!geocoded.success) {
          return { success: false, error: `Could not geocode destination: ${geocoded.error}` };
        }
        destCoords = geocoded.data.position;
      } else {
        destCoords = destination;
      }

      // Map mode to HERE transport mode
      const transportModes = {
        car: 'car',
        drive: 'car',
        driving: 'car',
        walk: 'pedestrian',
        walking: 'pedestrian',
        pedestrian: 'pedestrian',
        truck: 'truck',
        bicycle: 'bicycle',
        bike: 'bicycle'
      };

      const transportMode = transportModes[mode.toLowerCase()] || 'car';

      const response = await retryOperation(
        () => axios.get(`${this.config.routingUrl}/routes`, {
          params: {
            transportMode,
            origin: `${originCoords.lat},${originCoords.lng}`,
            destination: `${destCoords.lat},${destCoords.lng}`,
            return: 'summary,polyline,instructions',
            apiKey: this.config.apiKey
          }
        }),
        { retries: 3, context: 'HERE Routing API' }
      );

      if (!response.data.routes || response.data.routes.length === 0) {
        return { success: false, error: 'No route found between these locations' };
      }

      const route = response.data.routes[0];
      const section = route.sections[0];

      const data = {
        origin: typeof origin === 'string' ? origin : `${originCoords.lat},${originCoords.lng}`,
        destination: typeof destination === 'string' ? destination : `${destCoords.lat},${destCoords.lng}`,
        mode: transportMode,
        distance: {
          meters: section.summary.length,
          text: this.formatDistance(section.summary.length)
        },
        duration: {
          seconds: section.summary.duration,
          text: this.formatDuration(section.summary.duration)
        },
        instructions: section.actions?.map(action => ({
          instruction: action.instruction,
          duration: action.duration,
          length: action.length
        })) || []
      };

      return { success: true, data };
    } catch (error) {
      this.logger.error('Route calculation failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Discover places near a location
   */
  async discoverPlaces({ query, near, limit = 10 }) {
    if (!query) {
      return { success: false, error: 'Search query is required' };
    }

    if (!near) {
      return { success: false, error: 'Location (near) is required' };
    }

    if (!this.config.apiKey) {
      return { success: false, error: 'HERE API key not configured. Please configure it in plugin settings.' };
    }

    try {
      // Geocode the 'near' location if it's an address
      let atCoords;
      if (typeof near === 'string') {
        const geocoded = await this.geocode({ address: near });
        if (!geocoded.success) {
          return { success: false, error: `Could not geocode location: ${geocoded.error}` };
        }
        atCoords = geocoded.data.position;
      } else {
        atCoords = near;
      }

      const response = await retryOperation(
        () => axios.get(`${this.config.discoverUrl}/discover`, {
          params: {
            q: query,
            at: `${atCoords.lat},${atCoords.lng}`,
            limit: Math.min(limit, 100),
            apiKey: this.config.apiKey
          }
        }),
        { retries: 3, context: 'HERE Discover API' }
      );

      if (!response.data.items || response.data.items.length === 0) {
        return { success: false, error: 'No places found matching your search' };
      }

      const places = response.data.items.map(item => ({
        title: item.title,
        address: item.address?.label,
        position: item.position,
        distance: item.distance,
        categories: item.categories?.map(c => c.name) || [],
        contacts: item.contacts?.[0]?.phone?.[0]?.value,
        openingHours: item.openingHours?.[0]?.text?.[0],
        id: item.id
      }));

      return {
        success: true,
        data: {
          query,
          near: typeof near === 'string' ? near : `${atCoords.lat},${atCoords.lng}`,
          count: places.length,
          places
        }
      };
    } catch (error) {
      this.logger.error('Place discovery failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Format distance in human-readable form
   */
  formatDistance(meters) {
    if (meters < 1000) {
      return `${meters} m`;
    }
    const km = meters / 1000;
    const miles = km * 0.621371;
    return `${km.toFixed(1)} km (${miles.toFixed(1)} mi)`;
  }

  /**
   * Format duration in human-readable form
   */
  formatDuration(seconds) {
    if (seconds < 60) {
      return `${seconds} seconds`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} min`;
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

  formatResponse(response) {
    if (!response.success) {
      return `Error: ${response.error}`;
    }

    const data = response.data;

    // Format geocode response
    if (data.position && !data.places && !data.distance) {
      return `Location: ${data.address}\nCoordinates: ${data.position.lat}, ${data.position.lng}\nType: ${data.type || 'address'}`;
    }

    // Format reverse geocode response
    if (data.street !== undefined) {
      return `Address: ${data.address}\nCity: ${data.city || 'N/A'}\nState: ${data.state || 'N/A'}\nCountry: ${data.country || 'N/A'}\nPostal Code: ${data.postalCode || 'N/A'}`;
    }

    // Format route response
    if (data.distance && data.duration) {
      let result = `Route from ${data.origin} to ${data.destination}\n`;
      result += `Mode: ${data.mode}\n`;
      result += `Distance: ${data.distance.text}\n`;
      result += `Duration: ${data.duration.text}\n`;

      if (data.instructions && data.instructions.length > 0) {
        result += `\nDirections:\n`;
        data.instructions.slice(0, 10).forEach((step, i) => {
          result += `${i + 1}. ${step.instruction}\n`;
        });
        if (data.instructions.length > 10) {
          result += `... and ${data.instructions.length - 10} more steps`;
        }
      }
      return result;
    }

    // Format discover response
    if (data.places) {
      let result = `Found ${data.count} places for "${data.query}" near ${data.near}:\n\n`;
      data.places.forEach((place, i) => {
        result += `${i + 1}. ${place.title}\n`;
        result += `   Address: ${place.address || 'N/A'}\n`;
        if (place.distance) {
          result += `   Distance: ${this.formatDistance(place.distance)}\n`;
        }
        if (place.categories && place.categories.length > 0) {
          result += `   Categories: ${place.categories.join(', ')}\n`;
        }
        result += '\n';
      });
      return result;
    }

    return JSON.stringify(data, null, 2);
  }
}
