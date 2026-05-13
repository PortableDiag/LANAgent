import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';

export default class NumbersapiPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'numbersapi';
    this.version = '1.0.0';
    this.description = 'Get interesting facts about numbers, dates, and years';

    this.commands = [
      {
        command: 'trivia',
        description: 'Get a trivia fact about a number',
        usage: 'trivia({ number: 42 })',
        examples: [
          'tell me something interesting about the number 42',
          'what\'s special about 7',
          'give me trivia about 1337',
          'fun fact about the number 100'
        ]
      },
      {
        command: 'math',
        description: 'Get a mathematical fact about a number',
        usage: 'math({ number: 3.14 })',
        examples: [
          'math fact about pi',
          'mathematical property of 17',
          'what\'s mathematically interesting about 0',
          'tell me math facts about 256'
        ]
      },
      {
        command: 'date',
        description: 'Get a historical fact about a specific date',
        usage: 'date({ month: 7, day: 4 })',
        examples: [
          'what happened on July 4th',
          'historical events on December 25',
          'tell me about January 1st in history',
          'what\'s special about March 15'
        ]
      },
      {
        command: 'year',
        description: 'Get a fact about what happened in a specific year',
        usage: 'year({ year: 1969 })',
        examples: [
          'what happened in 1969',
          'tell me about the year 2000',
          'historical facts about 1492',
          'what was significant about 1776'
        ]
      },
      {
        command: 'random',
        description: 'Get a random fact (number, date, year, or math)',
        usage: 'random({ type: "trivia" })',
        examples: [
          'give me a random number fact',
          'tell me a random date in history',
          'random math fact',
          'surprise me with a random fact'
        ]
      },
      {
        command: 'batch',
        description: 'Retrieve multiple facts in a single API call',
        usage: 'batch([{ action: "trivia", number: 42 }, { action: "year", year: 1969 }])',
        examples: [
          'get trivia for 42 and year fact for 1969',
          'batch request for multiple facts'
        ]
      }
    ];

    this.config = {
      baseUrl: 'http://numbersapi.com',
      defaultFormat: 'json',
      timeout: 5000,
      retryAttempts: 3,
      retryDelay: 1000
    };

    this.initialized = false;
    this.cache = new Map();
    this.cacheTimeout = 3600000;
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        Object.assign(this.config, savedConfig);
        this.logger.info('Loaded cached configuration');
      }

      await this.testConnection();

      await PluginSettings.setCached(this.name, 'config', this.config);

      const cachedFacts = await PluginSettings.getCached(this.name, 'facts', 86400);
      if (cachedFacts) {
        this.cache = new Map(Object.entries(cachedFacts));
        this.logger.info(`Loaded ${this.cache.size} cached facts`);
      }

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
        case 'trivia':
          return await this.getTrivia(data);
        case 'math':
          return await this.getMath(data);
        case 'date':
          return await this.getDate(data);
        case 'year':
          return await this.getYear(data);
        case 'random':
          return await this.getRandom(data);
        case 'batch':
          return await this.processBatch(data.requests);
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

    Based on the action, extract:
    - trivia/math: { number: <integer or float> }
    - date: { month: <1-12>, day: <1-31> }
    - year: { year: <4-digit year> }
    - random: { type: <"trivia"|"math"|"date"|"year"> }

    Return JSON with appropriate parameters.`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    try {
      return JSON.parse(response.content);
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

  async getTrivia(params) {
    this.validateParams(params, {
      number: { required: true, type: 'number' }
    });

    const { number } = params;
    const cacheKey = `trivia_${number}`;

    const cached = this.getCachedFact(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    try {
      const response = await this.makeRequest(`/${number}/trivia`);
      const result = {
        type: 'trivia',
        number,
        text: response.text,
        found: response.found,
        factType: response.type
      };

      this.setCachedFact(cacheKey, result);

      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to get trivia for ${number}: ${error.message}`);
    }
  }

  async getMath(params) {
    this.validateParams(params, {
      number: { required: true, type: 'number' }
    });

    const { number } = params;
    const cacheKey = `math_${number}`;

    const cached = this.getCachedFact(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    try {
      const response = await this.makeRequest(`/${number}/math`);
      const result = {
        type: 'math',
        number,
        text: response.text,
        found: response.found,
        factType: response.type
      };

      this.setCachedFact(cacheKey, result);

      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to get math fact for ${number}: ${error.message}`);
    }
  }

  async getDate(params) {
    this.validateParams(params, {
      month: { required: true, type: 'number', min: 1, max: 12 },
      day: { required: true, type: 'number', min: 1, max: 31 }
    });

    const { month, day } = params;
    const cacheKey = `date_${month}_${day}`;

    const cached = this.getCachedFact(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    try {
      const response = await this.makeRequest(`/${month}/${day}/date`);
      const result = {
        type: 'date',
        month,
        day,
        text: response.text,
        year: response.year,
        factType: response.type
      };

      this.setCachedFact(cacheKey, result);

      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to get date fact for ${month}/${day}: ${error.message}`);
    }
  }

  async getYear(params) {
    this.validateParams(params, {
      year: { required: true, type: 'number' }
    });

    const { year } = params;
    const cacheKey = `year_${year}`;

    const cached = this.getCachedFact(cacheKey);
    if (cached) {
      return { success: true, data: cached, cached: true };
    }

    try {
      const response = await this.makeRequest(`/${year}/year`);
      const result = {
        type: 'year',
        year,
        text: response.text,
        found: response.found,
        factType: response.type
      };

      this.setCachedFact(cacheKey, result);

      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to get year fact for ${year}: ${error.message}`);
    }
  }

  async getRandom(params) {
    const { type = 'trivia' } = params;

    this.validateParams({ type }, {
      type: {
        type: 'string',
        enum: ['trivia', 'math', 'date', 'year']
      }
    });

    try {
      let endpoint;
      switch (type) {
        case 'trivia': endpoint = '/random/trivia'; break;
        case 'math': endpoint = '/random/math'; break;
        case 'date': endpoint = '/random/date'; break;
        case 'year': endpoint = '/random/year'; break;
      }

      const response = await this.makeRequest(endpoint);
      const result = {
        type: 'random',
        category: type,
        text: response.text,
        number: response.number,
        year: response.year,
        date: response.date,
        factType: response.type
      };

      return { success: true, data: result };
    } catch (error) {
      throw new Error(`Failed to get random ${type} fact: ${error.message}`);
    }
  }

  async processBatch(requests) {
    if (!Array.isArray(requests)) {
      throw new Error('Requests must be an array');
    }

    const results = await Promise.all(requests.map(async (request) => {
      const { action, ...params } = request;
      try {
        switch (action) {
          case 'trivia': return await this.getTrivia(params);
          case 'math': return await this.getMath(params);
          case 'date': return await this.getDate(params);
          case 'year': return await this.getYear(params);
          case 'random': return await this.getRandom(params);
          default: throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        return { success: false, error: error.message };
      }
    }));

    return { success: true, data: results };
  }

  async makeRequest(endpoint, retries = 0) {
    try {
      const response = await axios.get(`${this.config.baseUrl}${endpoint}`, {
        params: { json: true },
        timeout: this.config.timeout,
        headers: {
          'User-Agent': 'LANAgent-NumbersAPI-Plugin/1.0.0'
        }
      });

      return response.data;
    } catch (error) {
      if (retries < this.config.retryAttempts) {
        this.logger.warn(`Request failed, retrying (${retries + 1}/${this.config.retryAttempts})...`);
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        return this.makeRequest(endpoint, retries + 1);
      }

      if (error.response) {
        throw new Error(`API returned ${error.response.status}: ${error.response.statusText}`);
      } else if (error.request) {
        throw new Error('No response from Numbers API');
      } else {
        throw error;
      }
    }
  }

  getCachedFact(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      this.logger.debug(`Cache hit for ${key}`);
      return cached.data;
    }
    return null;
  }

  setCachedFact(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    if (this.cache.size % 10 === 0) {
      this.persistCache();
    }
  }

  async persistCache() {
    const cacheData = {};
    for (const [key, value] of this.cache.entries()) {
      cacheData[key] = value;
    }
    await PluginSettings.setCached(this.name, 'facts', cacheData, 86400);
  }

  async testConnection() {
    try {
      const response = await this.makeRequest('/42/trivia');
      if (!response || !response.text) {
        throw new Error('Invalid response from Numbers API');
      }
      this.logger.info('Numbers API connection test successful');
    } catch (error) {
      throw new Error(`Numbers API connection test failed: ${error.message}`);
    }
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);

    if (this.cache.size > 0) {
      await this.persistCache();
    }

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
