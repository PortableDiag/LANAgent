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
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      apiKey: null,
      baseUrl: 'https://api.groq.com/openai/v1',
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

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
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

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      throw new Error(`Chat completion failed: ${error.response?.data?.error?.message || error.message}`);
    }
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