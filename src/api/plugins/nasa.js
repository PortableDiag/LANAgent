import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

export default class NASAPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'nasa';
    this.version = '1.3.0';
    this.description = 'Space and astronomy data API with caching';
    this.commands = [
      {
        command: 'apod',
        description: 'Get Astronomy Picture of the Day',
        usage: 'apod'
      },
      {
        command: 'marsRoverPhotos',
        description: 'Get photos from Mars Rover (supports batch sols)',
        usage: 'marsRoverPhotos [roverName] [sols] (sols can be a single number or array)'
      },
      {
        command: 'neo',
        description: 'Get Near Earth Object data',
        usage: 'neo [startDate] [endDate]'
      },
      {
        command: 'earthImagery',
        description: 'Get Earth imagery based on latitude and longitude',
        usage: 'earthImagery [lat] [lon]'
      },
      {
        command: 'epic',
        description: 'Get daily images of Earth from EPIC',
        usage: 'epic'
      },
      {
        command: 'adsSearch',
        description: 'Search for research papers in NASA ADS',
        usage: 'adsSearch [keywords|author]'
      },
      {
        command: 'launchSchedule',
        description: 'Get NASA\'s upcoming launch schedule',
        usage: 'launchSchedule'
      },
      {
        command: 'marsRoverPhotosHistory',
        description: 'Get historical photos from Mars Rover within a date range',
        usage: 'marsRoverPhotosHistory [roverName] [startDate] [endDate]'
      }
    ];
    
    this.requiredCredentials = [
      { key: 'apiKey', label: 'NASA API Key', envVar: 'NASA_API_KEY', required: true }
    ];
    this.apiKey = null;
    this.adsApiKey = process.env.ADS_API_KEY;
    this.baseUrl = 'https://api.nasa.gov/';
    this.adsBaseUrl = 'https://api.adsabs.harvard.edu/v1/search/query';
    this.cache = new NodeCache({ stdTTL: 3600 });
  }

  async initialize() {
    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.apiKey = credentials.apiKey || process.env.NASA_API_KEY;
      if (this.apiKey) {
        this.logger.info('NASA plugin initialized with API key');
      }
    } catch (err) {
      this.logger.warn('NASA plugin init:', err.message);
      this.apiKey = process.env.NASA_API_KEY;
    }
  }

  async execute(params) {
    const { action, roverName, sol, sols, startDate, endDate, lat, lon, query } = params;

    try {
      switch (action) {
        case 'apod':
          return await this.getApod();

        case 'marsRoverPhotos':
          return await this.getMarsRoverPhotos(roverName, sols || (sol !== undefined ? [sol] : undefined));
          
        case 'neo':
          return await this.getNeo(startDate, endDate);

        case 'earthImagery':
          return await this.getEarthImagery(lat, lon);

        case 'epic':
          return await this.getEpicImages();

        case 'adsSearch':
          return await this.searchAds(query);

        case 'launchSchedule':
          return await this.getLaunchSchedule();

        case 'marsRoverPhotosHistory':
          return await this.getMarsRoverPhotosHistory(roverName, startDate, endDate);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('NASA plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fetches the Astronomy Picture of the Day with caching.
   */
  async getApod() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const cacheKey = 'apod';
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      logger.info('Returning cached APOD data');
      return { success: true, data: cachedData };
    }

    try {
      logger.info('Fetching Astronomy Picture of the Day');
      const response = await retryOperation(
        () => axios.get(`${this.baseUrl}planetary/apod?api_key=${this.apiKey}`),
        { retries: 3, context: 'apod' }
      );
      this.cache.set(cacheKey, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching APOD:', error.message);
      return { success: false, error: 'Failed to fetch Astronomy Picture of the Day' };
    }
  }

  /**
   * Fetches photos from Mars Rover with caching and batch sol support.
   * @param {string} roverName - The name of the Mars rover.
   * @param {number|number[]} sols - The Mars sol(s) (Martian day). Single number or array.
   */
  async getMarsRoverPhotos(roverName, sols) {
    const solArray = Array.isArray(sols) ? sols : [sols];
    this.validateParams({ roverName, sols: solArray }, {
      roverName: { required: true, type: 'string' },
      sols: { required: true, type: 'object' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const fetchPhotosForSol = async (sol) => {
      const cacheKey = `marsRoverPhotos_${roverName}_${sol}`;
      const cachedData = this.cache.get(cacheKey);
      if (cachedData) {
        logger.info(`Returning cached Mars Rover Photos for sol ${sol}`);
        return cachedData;
      }

      logger.info(`Fetching Mars Rover Photos for ${roverName} on sol ${sol}`);
      const response = await retryOperation(
        () => axios.get(`${this.baseUrl}mars-photos/api/v1/rovers/${roverName}/photos`, {
          params: { sol, api_key: this.apiKey }
        }),
        { retries: 3, context: `marsRoverPhotos_${roverName}_sol${sol}` }
      );
      const photos = response.data.photos;
      this.cache.set(cacheKey, photos);
      return photos;
    };

    try {
      const allPhotos = await Promise.all(solArray.map(sol => fetchPhotosForSol(sol)));
      return { success: true, data: allPhotos.flat() };
    } catch (error) {
      logger.error('Error fetching Mars Rover Photos:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fetches historical photos from Mars Rover within a date range.
   * Iterates over each date in the range since the NASA API only supports single earth_date queries.
   * @param {string} roverName - The name of the Mars rover.
   * @param {string} startDate - The start date in YYYY-MM-DD format.
   * @param {string} endDate - The end date in YYYY-MM-DD format.
   */
  async getMarsRoverPhotosHistory(roverName, startDate, endDate) {
    this.validateParams({ roverName, startDate, endDate }, {
      roverName: { required: true, type: 'string' },
      startDate: { required: true, type: 'string' },
      endDate: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const cacheKey = `marsRoverPhotosHistory_${roverName}_${startDate}_${endDate}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      logger.info('Returning cached Mars Rover Photos history data');
      return { success: true, data: cachedData };
    }

    try {
      logger.info(`Fetching Mars Rover Photos for ${roverName} from ${startDate} to ${endDate}`);

      // NASA API only supports single earth_date, so iterate over the range
      const start = new Date(startDate);
      const end = new Date(endDate);
      const maxDays = 30; // Cap at 30 days to avoid excessive API calls
      const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

      if (daysDiff < 0) {
        return { success: false, error: 'startDate must be before endDate' };
      }
      if (daysDiff > maxDays) {
        return { success: false, error: `Date range too large (${daysDiff} days). Maximum is ${maxDays} days.` };
      }

      const allPhotos = [];
      const current = new Date(start);

      while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        const response = await retryOperation(
          () => axios.get(`${this.baseUrl}mars-photos/api/v1/rovers/${roverName}/photos`, {
            params: { earth_date: dateStr, api_key: this.apiKey }
          }),
          { retries: 3, context: `marsRoverPhotosHistory_${roverName}_${dateStr}` }
        );

        if (response.data.photos?.length > 0) {
          allPhotos.push(...response.data.photos);
        }

        current.setDate(current.getDate() + 1);
      }

      this.cache.set(cacheKey, allPhotos);
      return { success: true, data: allPhotos };
    } catch (error) {
      logger.error('Error fetching Mars Rover Photos history:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fetches Near Earth Object data with caching.
   * @param {string} startDate - The start date in YYYY-MM-DD format.
   * @param {string} endDate - The end date in YYYY-MM-DD format.
   */
  async getNeo(startDate, endDate) {
    this.validateParams({ startDate, endDate }, {
      startDate: { required: true, type: 'string' },
      endDate: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const cacheKey = `neo_${startDate}_${endDate}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      logger.info('Returning cached NEO data');
      return { success: true, data: cachedData };
    }

    try {
      logger.info(`Fetching Near Earth Objects from ${startDate} to ${endDate}`);
      const response = await retryOperation(
        () => axios.get(`${this.baseUrl}neo/rest/v1/feed`, {
          params: { start_date: startDate, end_date: endDate, api_key: this.apiKey }
        }),
        { retries: 3, context: 'neo' }
      );
      this.cache.set(cacheKey, response.data.near_earth_objects);
      return { success: true, data: response.data.near_earth_objects };
    } catch (error) {
      logger.error('Error fetching NEO data:', error.message);
      return { success: false, error: 'Failed to fetch Near Earth Object data' };
    }
  }

  /**
   * Fetches Earth imagery based on latitude and longitude with caching.
   * @param {number} lat - The latitude of the location.
   * @param {number} lon - The longitude of the location.
   */
  async getEarthImagery(lat, lon) {
    this.validateParams({ lat, lon }, {
      lat: { required: true, type: 'number' },
      lon: { required: true, type: 'number' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const cacheKey = `earthImagery_${lat}_${lon}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      logger.info('Returning cached Earth imagery data');
      return { success: true, data: cachedData };
    }

    try {
      logger.info(`Fetching Earth imagery for coordinates: (${lat}, ${lon})`);
      const response = await retryOperation(
        () => axios.get(`${this.baseUrl}planetary/earth/imagery`, {
          params: { lat, lon, api_key: this.apiKey }
        }),
        { retries: 3, context: 'earthImagery' }
      );
      this.cache.set(cacheKey, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching Earth imagery:', error.message);
      return { success: false, error: 'Failed to fetch Earth imagery' };
    }
  }

  /**
   * Fetches daily images of Earth from the EPIC API with caching.
   */
  async getEpicImages() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const cacheKey = 'epic';
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      logger.info('Returning cached EPIC data');
      return { success: true, data: cachedData };
    }

    try {
      logger.info('Fetching daily images of Earth from EPIC');
      const response = await retryOperation(
        () => axios.get(`${this.baseUrl}EPIC/api/natural/images`, {
          params: { api_key: this.apiKey }
        }),
        { retries: 3, context: 'epic' }
      );
      this.cache.set(cacheKey, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching EPIC data:', error.message);
      return { success: false, error: 'Failed to fetch EPIC images' };
    }
  }

  /**
   * Searches for research papers in NASA's Astrophysics Data System (ADS) with caching.
   * @param {string} query - The search query, either keywords or author name.
   */
  async searchAds(query) {
    if (!this.adsApiKey) {
      return { success: false, error: 'ADS API key not configured' };
    }

    const cacheKey = `adsSearch_${query}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      logger.info('Returning cached ADS search data');
      return { success: true, data: cachedData };
    }

    try {
      logger.info(`Searching ADS for query: ${query}`);
      const response = await retryOperation(
        () => axios.get(this.adsBaseUrl, {
          headers: { Authorization: `Bearer ${this.adsApiKey}` },
          params: { q: query, fl: 'title,author,abstract', rows: 10 }
        }),
        { retries: 3, context: 'adsSearch' }
      );
      this.cache.set(cacheKey, response.data.response.docs);
      return { success: true, data: response.data.response.docs };
    } catch (error) {
      logger.error('Error searching ADS:', error.message);
      return { success: false, error: 'Failed to search ADS' };
    }
  }

  /**
   * Fetches NASA's upcoming launch schedule with caching.
   */
  async getLaunchSchedule() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    const cacheKey = 'launchSchedule';
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      logger.info('Returning cached launch schedule data');
      return { success: true, data: cachedData };
    }

    try {
      logger.info('Fetching NASA\'s upcoming launch schedule');
      const response = await retryOperation(
        () => axios.get(`${this.baseUrl}launches/upcoming`, {
          params: { api_key: this.apiKey }
        }),
        { retries: 3, context: 'launchSchedule' }
      );
      this.cache.set(cacheKey, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching launch schedule:', error.message);
      return { success: false, error: 'Failed to fetch launch schedule' };
    }
  }
}