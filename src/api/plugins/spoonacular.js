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
    // Works without the key since 2.25.785 (TheMealDB answers), so it loads enabled; the key, when added in Settings, is used first.
    this.worksWithoutCredentials = true;

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
      return await this.viaMealDB('search', params);
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
      return await this.viaMealDB('ingredients', { ingredients: uniqueIngredients, number });
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
      return await this.viaMealDB('info', params);
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
      return await this.viaMealDB('ingredient', params);
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
      return await this.viaMealDB('autocomplete', params);
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
    const askedLimit = params.limit;
    this.validateParams(params, {
      limit: { required: false, type: 'number', default: 1 }
    });
    params.limit = params.limit ?? 1;

    if (!this.config.apiKey) {
      return await this.viaMealDB('random', { ...params, limit: askedLimit });
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
  
  /**
   * TheMealDB (free, no key) when there is no Spoonacular key. ALICE had none on 2026-11-09, so every recipe request
   * failed. Answers keep Spoonacular's shapes (results[{id,title,image}], recipes[], extendedIngredients[{original}]).
   * TheMealDB searches by dish name and by one main ingredient; its recipe ids are its own.
   */
  async viaMealDB(kind, args = {}) {
    const base = 'https://www.themealdb.com/api/json/v1/1';
    const get = async (path, params) => (await axios.get(`${base}/${path}`, { params, timeout: 12000 })).data?.meals || [];
    const brief = (m) => ({ id: Number(m.idMeal), title: m.strMeal, image: m.strMealThumb, imageType: 'jpg' });
    const full = (m) => {
      const extendedIngredients = [];
      for (let i = 1; i <= 20; i++) {
        const name = (m[`strIngredient${i}`] || '').trim();
        if (name) extendedIngredients.push({ name, amount: (m[`strMeasure${i}`] || '').trim(), original: `${(m[`strMeasure${i}`] || '').trim()} ${name}`.trim() });
      }
      return { ...brief(m), instructions: m.strInstructions, extendedIngredients, cuisines: m.strArea ? [m.strArea] : [], dishTypes: m.strCategory ? [m.strCategory] : [],
        sourceUrl: m.strSource || null, video: m.strYoutube || null };
    };
    try {
      let data;
      const n = Math.max(1, Math.min(Number(args.number || args.limit) || 5, 25));
      if (kind === 'search') {
        const meals = await get('search.php', { s: args.query });
        data = { results: meals.slice(0, n).map(brief), offset: 0, number: n, totalResults: meals.length };
      } else if (kind === 'autocomplete') {
        data = (await get('search.php', { s: args.query })).slice(0, n).map(m => ({ id: Number(m.idMeal), title: m.strMeal, imageType: 'jpg' }));
      } else if (kind === 'ingredients') {
        const list = (args.ingredients || []).map(s => String(s).trim()).filter(Boolean);
        const seen = new Map();
        for (const ing of list.slice(0, 5)) {
          for (const m of await get('filter.php', { i: ing.replace(/\s+/g, '_') })) {
            const e = seen.get(m.idMeal) || { ...brief(m), usedIngredientCount: 0, usedIngredients: [] };
            e.usedIngredientCount++; e.usedIngredients.push({ name: ing }); seen.set(m.idMeal, e);
          }
        }
        data = [...seen.values()].sort((a, b) => b.usedIngredientCount - a.usedIngredientCount).slice(0, n);
      } else if (kind === 'info') {
        const m = (await get('lookup.php', { i: args.id }))[0];
        if (!m) return { success: false, error: `No recipe with id ${args.id} (without a Spoonacular key, ids are TheMealDB's)` };
        data = full(m);
      } else if (kind === 'random') {
        // "Give me three quick dinner ideas" comes with no limit: read the count and the kind of meal from the sentence.
        // TheMealDB's random is one meal of any kind, so draw extra and keep the ones that fit (a dessert was offered
        // as a dinner idea, 2026-11-09).
        const said = String(args.originalInput || args._context?.originalInput || args.query || args.tags || '').toLowerCase();
        const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3, some: 3 };
        const spoken = Number(/\b(\d{1,2})\b/.exec(said)?.[1]) || WORDS[Object.keys(WORDS).find(w => new RegExp(`\\b(a )?${w}\\b`).test(said))];
        const k = Math.max(1, Math.min(Number(args.limit || args.number) || spoken || (/\brecipes|ideas|meals|dishes\b/.test(said) ? 3 : 1), 10));
        const want = /dessert|sweet|cake|cookie|pudding/.test(said) ? ['Dessert'] : /breakfast|brunch/.test(said) ? ['Breakfast'] : null;
        const fits = (m) => (want ? want.includes(m.strCategory) : !['Dessert', 'Starter', 'Side'].includes(m.strCategory));
        const picked = new Map();
        for (let round = 0; round < 3 && picked.size < k; round++) {
          for (const r of await Promise.all(Array.from({ length: (k - picked.size) * 2 }, () => get('random.php')))) {
            if (r[0] && fits(r[0]) && picked.size < k) picked.set(r[0].idMeal, r[0]);
          }
        }
        data = { recipes: [...picked.values()].map(full) };
      } else {
        return { success: false, error: 'Ingredient details need a Spoonacular API key (set SPOONACULAR_API_KEY)' };
      }
      return { success: true, data, source: 'themealdb' };
    } catch (e) {
      return { success: false, error: `No Spoonacular key, and TheMealDB failed: ${e.message}` };
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
