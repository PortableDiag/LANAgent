import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class GroqPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'groq';
    this.version = '1.0.0';
    this.description = 'Specializes in ultra-fast inference using Groq\'s LPU technology for AI model execution';

    // Define required credentials for this plugin
    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'GROQ_API_KEY', required: true }
    ];

    // Commands array - CRITICAL for AI natural language support
    this.commands = [
      {
        command: 'list_models',
        description: 'Retrieve a list of available language models',
        usage: 'list_models()',
        examples: [
          'show me all available models',
          'what models does Groq support',
          'list all language models',
          'which models can I use'
        ]
      },
      {
        command: 'generate_completion',
        description: 'Generate text completions using a specified model',
        usage: 'generate_completion({ model: "llama3-8b-8192", prompt: "Explain quantum computing", maxTokens: 500 })',
        examples: [
          'generate a summary of climate change',
          'explain how neural networks work',
          'write a short story about space exploration',
          'create a poem about technology'
        ]
      },
      {
        command: 'chat_completion',
        description: 'Create conversational responses with a specified model',
        usage: 'chat_completion({ model: "llama3-8b-8192", messages: [{ role: "user", content: "Hello!" }], maxTokens: 500 })',
        examples: [
          'have a conversation about artificial intelligence',
          'chat with an AI assistant about programming',
          'discuss the future of renewable energy',
          'talk to an AI about cooking recipes'
        ]
      },
      {
        command: 'get_usage_stats',
        description: 'Retrieve usage statistics and cost estimates',
        usage: 'get_usage_stats()',
        examples: [
          'show me my token usage',
          'how much have I spent on Groq API calls',
          'what are my usage statistics',
          'give me a cost breakdown of my API usage'
        ]
      },
      {
        command: 'configure_fallback_chain',
        description: 'Configure model fallback chains for improved reliability',
        usage: 'configure_fallback_chain({ fallbackChain: { "primary-model": ["fallback1", "fallback2"] } })',
        examples: [
          'set up fallback models for llama3',
          'configure model fallback chains',
          'add backup models for primary models'
        ]
      },
      {
        command: 'get_fallback_model',
        description: 'Get the fallback model for a given primary model',
        usage: 'get_fallback_model({ primaryModel: "llama3-8b-8192" })',
        examples: [
          'what is the fallback for llama3-8b-8192',
          'get fallback model for primary model',
          'show me the backup model for mistral'
        ]
      }
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null,
      baseUrl: 'https://api.groq.com/openai/v1',
      fallbackChain: {} // New configuration for model fallback chains
    };

    // Usage tracking. Prompt and completion tokens are kept apart because they are
    // priced apart — a single blended rate over total_tokens cannot produce a correct
    // cost for any provider that charges differently for input and output.
    this.usageStats = {
      totalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCalls: 0,
      totalCost: 0,
      uncostedCalls: 0,
      modelUsage: {}
    };

    this.initialized = false;
    this.cache = new Map();
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

      // Load usage stats
      const savedUsageStats = await PluginSettings.getCached(this.name, 'usageStats');
      if (savedUsageStats) {
        this.usageStats = savedUsageStats;
        this.logger.info('Loaded cached usage statistics');
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
        case 'list_models':
          return await this.listModels();
        case 'generate_completion':
          return await this.generateCompletion(data);
        case 'chat_completion':
          return await this.chatCompletion(data);
        case 'get_usage_stats':
          return await this.getUsageStats();
        case 'configure_fallback_chain':
          return await this.configureFallbackChain(data);
        case 'get_fallback_model':
          return await this.getFallbackModel(data);
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
  
  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }
  
  // Implementation methods for each action
  async listModels() {
    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    try {
      const response = await retryOperation(() => 
        axios.get(`${this.config.baseUrl}/models`, {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          }
        }), 
        { retries: 3, context: 'List Models API call' }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      throw new Error(`Failed to retrieve models: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  async generateCompletion(params) {
    this.validateParams(params, {
      model: { required: true, type: 'string' },
      prompt: { required: true, type: 'string' },
      maxTokens: { required: false, type: 'number' }
    });

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    try {
      const requestBody = {
        model: params.model,
        prompt: params.prompt,
        max_tokens: params.maxTokens || 500
      };

      const response = await retryOperation(() => 
        axios.post(`${this.config.baseUrl}/completions`, requestBody, {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          }
        }), 
        { retries: 3, context: 'Generate Completion API call' }
      );

      this.trackTokenUsage(response.data.usage, params.model);

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      // Walk the primary model's configured fallback list in order. Each model is
      // tried at most once, so a cyclic chain (A -> B, B -> A) cannot recurse forever.
      // An auth failure is not model-specific — every fallback would fail the same way.
      const next = error.response?.status === 401 ? null : this.nextFallback(params);
      if (next) {
        this.logger.info(`Retrying generate_completion with fallback model: ${next.model}`);
        return await this.generateCompletion(next);
      }

      throw new Error(`Completion generation failed: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  async chatCompletion(params) {
    this.validateParams(params, {
      model: { required: true, type: 'string' },
      messages: { required: true, type: 'array' },
      maxTokens: { required: false, type: 'number' }
    });

    if (!this.config.apiKey) {
      throw new Error('API key not configured');
    }

    try {
      const requestBody = {
        model: params.model,
        messages: params.messages,
        max_tokens: params.maxTokens || 500
      };

      const response = await retryOperation(() => 
        axios.post(`${this.config.baseUrl}/chat/completions`, requestBody, {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          }
        }), 
        { retries: 3, context: 'Chat Completion API call' }
      );

      this.trackTokenUsage(response.data.usage, params.model);

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      // Walk the primary model's configured fallback list in order. Each model is
      // tried at most once, so a cyclic chain (A -> B, B -> A) cannot recurse forever.
      // An auth failure is not model-specific — every fallback would fail the same way.
      const next = error.response?.status === 401 ? null : this.nextFallback(params);
      if (next) {
        this.logger.info(`Retrying chat_completion with fallback model: ${next.model}`);
        return await this.chatCompletion(next);
      }

      throw new Error(`Chat completion failed: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Configure model fallback chains
   * @param {Object} params - Configuration parameters
   * @param {Object} params.fallbackChain - Object mapping model names to arrays of fallback models
   */
  async configureFallbackChain(params) {
    this.validateParams(params, {
      fallbackChain: { required: true, type: 'object' }
    });

    for (const [primary, fallbacks] of Object.entries(params.fallbackChain)) {
      if (!Array.isArray(fallbacks) || !fallbacks.every(m => typeof m === 'string' && m)) {
        throw new Error(`fallbackChain["${primary}"] must be an array of model names`);
      }
    }

    this.config.fallbackChain = params.fallbackChain;
    
    // Save to cache
    const { apiKey, ...configToCache } = this.config;
    await PluginSettings.setCached(this.name, 'config', configToCache);
    
    return {
      success: true,
      message: 'Fallback chain configured successfully',
      data: this.config.fallbackChain
    };
  }

  /**
   * Get fallback model for a primary model
   * @param {Object} params - Parameters
   * @param {string} params.primaryModel - Primary model name
   */
  async getFallbackModel(params) {
    this.validateParams(params, {
      primaryModel: { required: true, type: 'string' }
    });

    const fallbackModel = this.getFallbackModelSync(params.primaryModel);
    
    return {
      success: true,
      data: {
        primaryModel: params.primaryModel,
        fallbackModel: fallbackModel
      }
    };
  }

  /**
   * Synchronous helper to get fallback model
   * @param {string} primaryModel - Primary model name
   * @returns {string|null} Fallback model name or null if none configured
   */
  getFallbackModelSync(primaryModel) {
    const fallbacks = (this.config.fallbackChain || {})[primaryModel];
    if (Array.isArray(fallbacks) && fallbacks.length > 0) {
      return fallbacks[0]; // Return the first fallback model
    }
    return null;
  }

  /**
   * Next params to retry with after a failed call, or null when the chain is exhausted.
   * The chain is the ORIGINAL primary model's list; models already tried are skipped.
   */
  nextFallback(params) {
    const primary = params._fallbackPrimary || params.model;
    const tried = params._fallbackTried || [params.model];
    const chain = (this.config.fallbackChain || {})[primary];
    if (!Array.isArray(chain)) return null;
    const model = chain.find(m => typeof m === 'string' && m && !tried.includes(m));
    if (!model) return null;
    return { ...params, model, _fallbackPrimary: primary, _fallbackTried: [...tried, model] };
  }

  /**
   * Record what an API response reported it used.
   *
   * Fire-and-forget on the persist, with an explicit catch: this is telemetry, and a
   * settings write that fails must never surface as an unhandled rejection or fail the
   * completion the caller actually asked for. The original called setCached() without
   * awaiting it and without a catch, which is exactly that rejection.
   *
   * @param {object} usage - the `usage` block from the API response
   * @param {string} model - model identifier (required by both callers' validation)
   */
  trackTokenUsage(usage, model) {
    const prompt = Number(usage?.prompt_tokens) || 0;
    const completion = Number(usage?.completion_tokens) || 0;
    // Prefer the provider's own total; fall back to the parts if it is absent.
    const total = Number.isFinite(Number(usage?.total_tokens))
      ? Number(usage.total_tokens)
      : prompt + completion;

    this.usageStats.totalTokens += total;
    this.usageStats.totalPromptTokens += prompt;
    this.usageStats.totalCompletionTokens += completion;
    this.usageStats.totalCalls += 1;

    if (!this.usageStats.modelUsage[model]) {
      this.usageStats.modelUsage[model] = { tokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, cost: 0 };
    }
    const entry = this.usageStats.modelUsage[model];
    entry.tokens += total;
    entry.promptTokens += prompt;
    entry.completionTokens += completion;
    entry.calls += 1;

    const cost = this.calculateCost({ promptTokens: prompt, completionTokens: completion }, model);
    if (cost === null) {
      // No configured rate for this model. Counting it as $0 would understate the
      // total and read as "these calls were free", so it is counted separately and
      // the reported cost says how many calls it could not price.
      this.usageStats.uncostedCalls += 1;
    } else {
      this.usageStats.totalCost += cost;
      entry.cost += cost;
    }

    Promise.resolve(PluginSettings.setCached(this.name, 'usageStats', this.usageStats))
      .catch(err => this.logger.warn(`Could not persist Groq usage stats: ${err.message}`));
  }

  /**
   * Estimate cost from a configured rate table.
   *
   * Rates are NOT hardcoded. Provider prices change and input/output are charged at
   * different rates, so a built-in blended constant produces a dollar figure that is
   * wrong by construction and goes quietly staler every month — while being reported
   * as money spent. Configure `this.config.pricing` as
   * `{ '<model>': { inputPerMillion, outputPerMillion } }` to enable costing.
   *
   * @returns {number|null} USD, or null when this model has no configured rate
   */
  calculateCost({ promptTokens = 0, completionTokens = 0 } = {}, model) {
    const rate = this.config.pricing?.[model];
    const input = Number(rate?.inputPerMillion);
    const output = Number(rate?.outputPerMillion);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    return (promptTokens / 1e6) * input + (completionTokens / 1e6) * output;
  }

  /**
   * Usage statistics. Token counts are measured; cost is only reported when rates
   * are configured, and never presented as complete while some calls went unpriced.
   */
  async getUsageStats() {
    const priced = this.usageStats.totalCalls - this.usageStats.uncostedCalls;
    return {
      success: true,
      data: {
        ...this.usageStats,
        costEstimate: priced > 0 ? this.usageStats.totalCost : null,
        costComplete: this.usageStats.uncostedCalls === 0 && priced > 0,
        costNote: priced === 0
          ? 'No model pricing configured — token counts are measured, cost is not estimated.'
          : (this.usageStats.uncostedCalls > 0
            ? `${this.usageStats.uncostedCalls} of ${this.usageStats.totalCalls} calls used a model with no configured rate and are excluded from the cost.`
            : undefined)
      }
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
