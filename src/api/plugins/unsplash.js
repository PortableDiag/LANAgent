import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

export default class UnsplashPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'unsplash';
    this.version = '1.0.0';
    this.description = 'Access high-quality photos from talented photographers';

    // Define required credentials for this plugin
    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'UNSPLASH_API_KEY', required: true }
    ];

    // Commands array - CRITICAL for AI natural language support
    this.commands = [
      {
        command: 'searchPhotos',
        description: 'Search for high-quality photos by keyword',
        usage: 'searchPhotos({ query: "nature", per_page: 10, page: 1 })',
        examples: [
          'find nature photos',
          'search for beach images',
          'get pictures of mountains',
          'look up sunset photography'
        ]
      },
      {
        command: 'getRandomPhoto',
        description: 'Get a random photo, optionally filtered by topic',
        usage: 'getRandomPhoto({ query: "nature" })',
        examples: [
          'show me a random photo',
          'get a surprise image',
          'find a random landscape picture',
          'give me any cool photo'
        ]
      },
      {
        command: 'getPhotoById',
        description: 'Retrieve detailed information about a specific photo by its ID',
        usage: 'getPhotoById({ id: "photo_id_here" })',
        examples: [
          'get details for photo abc123',
          'show info for image xyz789',
          'find photo metadata for def456',
          'retrieve full details of this image'
        ]
      },
      {
        command: 'listCollections',
        description: 'Browse curated collections of photos',
        usage: 'listCollections({ page: 1, per_page: 10 })',
        examples: [
          'show me photo collections',
          'browse curated galleries',
          'find photography sets',
          'see featured photo albums'
        ]
      }
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null,
      baseUrl: 'https://api.unsplash.com',
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 minute cache
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
        case 'searchPhotos':
          return await this.searchPhotos(data);
        case 'getRandomPhoto':
          return await this.getRandomPhoto(data);
        case 'getPhotoById':
          return await this.getPhotoById(data);
        case 'listCollections':
          return await this.listCollections(data);
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

    // Use safeJsonParse to avoid throwing on malformed JSON
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
  async searchPhotos(params) {
    const { query, per_page = 10, page = 1 } = params;
    
    this.validateParams(params, {
      query: { required: true, type: 'string' },
      per_page: { required: false, type: 'number' },
      page: { required: false, type: 'number' }
    });

    if (!this.config.apiKey) {
      throw new Error('Unsplash API key not configured');
    }

    const cacheKey = `search_${query}_${page}_${per_page}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}/search/photos`, {
          headers: {
            Authorization: `Client-ID ${this.config.apiKey}`
          },
          params: {
            query,
            per_page,
            page
          }
        }), 
        { retries: 3, context: 'Unsplash search' }
      );

      const results = response.data.results.map(photo => ({
        id: photo.id,
        url: photo.urls.regular,
        thumb: photo.urls.thumb,
        description: photo.alt_description,
        photographer: {
          name: photo.user.name,
          profile: photo.user.links.html
        }
      }));

      this.cache.set(cacheKey, results);
      return { success: true, data: results };
    } catch (error) {
      throw new Error(`Failed to search photos: ${error.response?.data?.errors?.[0] || error.message}`);
    }
  }

  async getRandomPhoto(params) {
    const { query } = params;
    
    this.validateParams(params, {
      query: { required: false, type: 'string' }
    });

    if (!this.config.apiKey) {
      throw new Error('Unsplash API key not configured');
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}/photos/random`, {
          headers: {
            Authorization: `Client-ID ${this.config.apiKey}`
          },
          params: query ? { query } : {}
        }), 
        { retries: 3, context: 'Unsplash random photo' }
      );

      const photo = response.data;
      const result = {
        id: photo.id,
        url: photo.urls.regular,
        thumb: photo.urls.thumb,
        description: photo.alt_description,
        photographer: {
          name: photo.user.name,
          profile: photo.user.links.html
        }
      };

      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to get random photo: ${error.response?.data?.errors?.[0] || error.message}`);
    }
  }

  async getPhotoById(params) {
    const { id } = params;
    
    this.validateParams(params, {
      id: { required: true, type: 'string' }
    });

    if (!this.config.apiKey) {
      throw new Error('Unsplash API key not configured');
    }

    const cacheKey = `photo_${id}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}/photos/${id}`, {
          headers: {
            Authorization: `Client-ID ${this.config.apiKey}`
          }
        }), 
        { retries: 3, context: 'Unsplash photo by ID' }
      );

      const photo = response.data;
      const result = {
        id: photo.id,
        url: photo.urls.regular,
        thumb: photo.urls.thumb,
        description: photo.alt_description,
        width: photo.width,
        height: photo.height,
        likes: photo.likes,
        photographer: {
          name: photo.user.name,
          profile: photo.user.links.html,
          bio: photo.user.bio
        },
        EXIF: photo.exif,
        location: photo.location
      };

      this.cache.set(cacheKey, result);
      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to get photo: ${error.response?.data?.errors?.[0] || error.message}`);
    }
  }

  async listCollections(params) {
    const { page = 1, per_page = 10 } = params;
    
    this.validateParams(params, {
      page: { required: false, type: 'number' },
      per_page: { required: false, type: 'number' }
    });

    if (!this.config.apiKey) {
      throw new Error('Unsplash API key not configured');
    }

    const cacheKey = `collections_${page}_${per_page}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}/collections`, {
          headers: {
            Authorization: `Client-ID ${this.config.apiKey}`
          },
          params: {
            page,
            per_page
          }
        }), 
        { retries: 3, context: 'Unsplash collections' }
      );

      const results = response.data.map(collection => ({
        id: collection.id,
        title: collection.title,
        description: collection.description,
        cover_photo: collection.cover_photo ? {
          id: collection.cover_photo.id,
          url: collection.cover_photo.urls.regular
        } : null,
        total_photos: collection.total_photos,
        published_at: collection.published_at
      }));

      this.cache.set(cacheKey, results);
      return { success: true, data: results };
    } catch (error) {
      throw new Error(`Failed to list collections: ${error.response?.data?.errors?.[0] || error.message}`);
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