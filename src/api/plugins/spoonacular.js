import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

export default class SpoonacularPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'spoonacular';
    this.version = '1.0.0';
    this.description = 'Access recipe and nutrition data through the Spoonacular API';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'SPOONACULAR_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'searchRecipes',
        description: 'Search for recipes by query terms',
        usage: 'searchRecipes({ query: "pasta", number: 5 })',
        examples: [
          'find pasta recipes',
          'search for healthy dinner ideas',
          'look up vegetarian meals',
          'show me quick lunch recipes'
        ]
      },
      {
        command: 'getRecipeInformation',
        description: 'Get detailed information about a specific recipe including ingredients and instructions',
        usage: 'getRecipeInformation({ id: 12345 })',
        examples: [
          'show details for recipe 716429',
          'get ingredients for spaghetti carbonara',
          'how do I make this dish?',
          'what are the steps to prepare this meal?'
        ]
      },
      {
        command: 'autocompleteRecipeSearch',
        description: 'Autocomplete recipe search queries',
        usage: 'autocompleteRecipeSearch({ query: "chick", number: 10 })',
        examples: [
          'suggest recipes starting with chick',
          'complete my search for chicken',
          'auto-complete recipe names with broc',
          'find recipe suggestions for past'
        ]
      },
      {
        command: 'getRandomRecipes',
        description: 'Get random recipes',
        usage: 'getRandomRecipes({ limit: 3 })',
        examples: [
          'give me some random recipes',
          'surprise me with dinner ideas',
          'show random meal suggestions',
          'find unexpected cooking inspiration'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'https://api.spoonacular.com'
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 minute cache
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.apiKey = credentials.apiKey;
        this.logger.info('Loaded API credentials');
      } catch (credError) {
        this.logger.warn(`Credentials not configured: ${credError.message}`);
      }

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
        case 'searchRecipes':
          return await this.searchRecipes(data);
        case 'getRecipeInformation':
          return await this.getRecipeInformation(data);
        case 'autocompleteRecipeSearch':
          return await this.autocompleteRecipeSearch(data);
        case 'getRandomRecipes':
          return await this.getRandomRecipes(data);
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

    const parsed = JSON.parse(response.content || '{}');
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
  
  async searchRecipes(params) {
    this.validateParams(params, {
      query: { required: true, type: 'string' },
      number: { required: false, type: 'number', default: 5 }
    });
    params.number = params.number ?? 5;

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    const cacheKey = `search_${params.query}_${params.number}`;
    let cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = `${this.config.baseUrl}/recipes/complexSearch`;
    const config = {
      params: {
        apiKey: this.config.apiKey,
        query: params.query,
        number: params.number
      }
    };

    const response = await retryOperation(() => axios.get(url, config), { 
      retries: 3, 
      context: 'Spoonacular searchRecipes' 
    });

    this.cache.set(cacheKey, response.data);
    return { success: true, data: response.data };
  }

  async getRecipeInformation(params) {
    this.validateParams(params, {
      id: { required: true, type: 'number' }
    });

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    const cacheKey = `recipe_info_${params.id}`;
    let cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = `${this.config.baseUrl}/recipes/${params.id}/information`;
    const config = {
      params: {
        apiKey: this.config.apiKey,
        includeNutrition: true
      }
    };

    const response = await retryOperation(() => axios.get(url, config), { 
      retries: 3, 
      context: 'Spoonacular getRecipeInformation' 
    });

    this.cache.set(cacheKey, response.data);
    return { success: true, data: response.data };
  }

  async autocompleteRecipeSearch(params) {
    this.validateParams(params, {
      query: { required: true, type: 'string' },
      number: { required: false, type: 'number', default: 10 }
    });
    params.number = params.number ?? 10;

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    const cacheKey = `autocomplete_${params.query}_${params.number}`;
    let cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = `${this.config.baseUrl}/recipes/autocomplete`;
    const config = {
      params: {
        apiKey: this.config.apiKey,
        query: params.query,
        number: params.number
      }
    };

    const response = await retryOperation(() => axios.get(url, config), { 
      retries: 3, 
      context: 'Spoonacular autocompleteRecipeSearch' 
    });

    this.cache.set(cacheKey, response.data);
    return { success: true, data: response.data };
  }

  async getRandomRecipes(params) {
    this.validateParams(params, {
      limit: { required: false, type: 'number', default: 1 }
    });
    params.limit = params.limit ?? 1;

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    const cacheKey = `random_${params.limit}`;
    let cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = `${this.config.baseUrl}/recipes/random`;
    const config = {
      params: {
        apiKey: this.config.apiKey,
        number: params.limit
      }
    };

    const response = await retryOperation(() => axios.get(url, config), { 
      retries: 3, 
      context: 'Spoonacular getRandomRecipes' 
    });

    this.cache.set(cacheKey, response.data);
    return { success: true, data: response.data };
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