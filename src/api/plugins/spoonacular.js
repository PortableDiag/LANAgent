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
        command: 'findRecipesByIngredients',
        description: 'Find recipes that can be made with a list of available ingredients',
        usage: 'findRecipesByIngredients({ ingredients: ["tomato", "basil", "pasta"], number: 5, ranking: 1, ignorePantry: false })',
        examples: [
          'find recipes using chicken, rice, and broccoli',
          'what can I make with eggs and potatoes?',
          'show meals from my pantry ingredients',
          'find recipes using only the ingredients I have'
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
        command: 'getIngredientInformation',
        description: 'Get nutrition and serving information for a specific ingredient',
        usage: 'getIngredientInformation({ ingredientId: 9266, amount: 1, unit: "banana" })',
        examples: [
          'show nutrition information for ingredient 9266',
          'get nutrition facts for spoonacular ingredient 9266, 100 grams',
          'show serving information for ingredient id 11124'
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
        case 'findRecipesByIngredients':
          return await this.findRecipesByIngredients(data);
        case 'getRecipeInformation':
          return await this.getRecipeInformation(data);
        case 'getIngredientInformation':
          return await this.getIngredientInformation(data);
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

  /**
   * Find recipes using a bounded, normalized list of available ingredients.
   */
  async findRecipesByIngredients(params) {
    // Chat extraction usually yields "chicken, rice, broccoli" rather than an
    // array; accept that form (and a single ingredient) before validating.
    if (typeof params.ingredients === 'string') {
      params = { ...params, ingredients: params.ingredients.split(/,|\band\b/i).map(s => s.trim()).filter(Boolean) };
    }
    if (typeof params.number === 'string' && params.number.trim() !== '') {
      params = { ...params, number: Number(params.number) };
    }
    this.validateParams(params, {
      ingredients: { required: true, type: 'array' },
      number: { required: false, type: 'number', default: 5 },
      ranking: { required: false, type: 'number', default: 1 },
      ignorePantry: { required: false, type: 'boolean', default: false }
    });

    if (!Array.isArray(params.ingredients) || params.ingredients.length === 0) {
      throw new Error('ingredients must be a non-empty array');
    }

    if (params.ingredients.length > 20) {
      throw new Error('ingredients cannot contain more than 20 items');
    }

    const ingredients = params.ingredients.map((ingredient) => {
      if (typeof ingredient !== 'string') {
        throw new Error('each ingredient must be a string');
      }

      const normalizedIngredient = ingredient.trim().replace(/\s+/g, ' ');
      if (!normalizedIngredient) {
        throw new Error('ingredients cannot contain empty values');
      }
      if (normalizedIngredient.length > 100) {
        throw new Error('each ingredient cannot exceed 100 characters');
      }

      return normalizedIngredient.toLowerCase();
    });

    const uniqueIngredients = [...new Set(ingredients)].sort();

    const number = params.number ?? 5;
    if (!Number.isInteger(number) || number < 1 || number > 100) {
      throw new Error('number must be an integer between 1 and 100');
    }

    const ranking = params.ranking ?? 1;
    if (!Number.isInteger(ranking) || ![1, 2].includes(ranking)) {
      throw new Error('ranking must be either 1 or 2');
    }

    const ignorePantry = params.ignorePantry ?? false;
    if (typeof ignorePantry !== 'boolean') {
      throw new Error('ignorePantry must be a boolean');
    }

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    const ingredientList = uniqueIngredients.join(',');
    const cacheKey = `ingredients_${ingredientList}_${number}_${ranking}_${ignorePantry}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = `${this.config.baseUrl}/recipes/findByIngredients`;
    const config = {
      params: {
        apiKey: this.config.apiKey,
        ingredients: ingredientList,
        number,
        ranking,
        ignorePantry
      }
    };

    const response = await retryOperation(() => axios.get(url, config), {
      retries: 3,
      context: 'Spoonacular findRecipesByIngredients'
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

  /**
   * Get nutrition and serving information for an ingredient.
   *
   * @param {Object} params - Ingredient lookup parameters.
   * @param {number} params.ingredientId - Spoonacular ingredient identifier.
   * @param {number} [params.amount] - Amount for which to calculate nutrition.
   * @param {string} [params.unit] - Unit associated with the requested amount.
   * @returns {Promise<{success: boolean, data: Object}>} Ingredient information.
   */
  async getIngredientInformation(params) {
    this.validateParams(params, {
      ingredientId: { required: true, type: 'number' },
      amount: { required: false, type: 'number' },
      unit: { required: false, type: 'string' }
    });

    if (!Number.isFinite(params.ingredientId) || params.ingredientId <= 0) {
      throw new Error('ingredientId must be a positive number');
    }

    if (params.amount !== undefined &&
      (!Number.isFinite(params.amount) || params.amount <= 0)) {
      throw new Error('amount must be a positive number');
    }

    if (params.unit !== undefined && !params.unit.trim()) {
      throw new Error('unit must not be empty');
    }

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    const amountKey = params.amount ?? '';
    const unitKey = params.unit?.trim() ?? '';
    const cacheKey = `ingredient_info_${params.ingredientId}_${amountKey}_${unitKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = `${this.config.baseUrl}/food/ingredients/${params.ingredientId}/information`;
    const queryParams = {
      apiKey: this.config.apiKey
    };

    if (params.amount !== undefined) {
      queryParams.amount = params.amount;
    }
    if (params.unit !== undefined) {
      queryParams.unit = params.unit.trim();
    }

    const response = await retryOperation(() => axios.get(url, {
      params: queryParams
    }), {
      retries: 3,
      context: 'Spoonacular getIngredientInformation'
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
