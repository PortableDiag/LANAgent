import { BaseProvider } from './BaseProvider.js';
import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * Ollama Provider
 * Enables local LLM inference using Ollama (https://ollama.ai)
 * Supports chat, embeddings, and vision capabilities
 */
export class OllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super('Ollama', config);
    this.baseUrl = config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.models = {
      chat: config.chatModel || process.env.OLLAMA_CHAT_MODEL || 'mistral',
      embedding: config.embeddingModel || process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
      vision: config.visionModel || process.env.OLLAMA_VISION_MODEL || 'llava'
    };
    this.contextLength = config.contextLength || 4096;
    this.timeout = config.timeout || 120000; // 2 minutes default for local inference
    this.availableModels = [];
    this.metrics.usage = {}; // Per-model usage analytics (do not overwrite BaseProvider.metrics)
    this.commands = [
      { command: 'listmodels', description: 'List all available models', usage: 'listmodels' },
      { command: 'pullmodel', description: 'Pull a model from Ollama library', usage: 'pullmodel <modelName>' },
      { command: 'getmodelinfo', description: 'Get information about a specific model', usage: 'getmodelinfo <modelName>' },
      { command: 'switchmodelversion', description: 'Switch to a specific version of a model', usage: 'switchmodelversion <modelName> <version>' },
      { command: 'streamresponse', description: 'Stream response for real-time applications', usage: 'streamresponse <prompt>' },
      { command: 'getmodelusageanalytics', description: 'Get per-model usage analytics', usage: 'getmodelusageanalytics' }
    ];
  }

  async initialize() {
    logger.info(`Initializing Ollama provider at ${this.baseUrl}`);

    try {
      // Check if Ollama is running and list available models
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 10000
      });

      if (response.data && response.data.models) {
        this.availableModels = response.data.models.map(m => m.name);
        logger.info(`Ollama connected. Available models: ${this.availableModels.join(', ')}`);

        // Check if configured models are available
        this.validateConfiguredModels();
      }

      this.isActive = true;
      logger.info('Ollama provider initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Ollama provider:', error.message);
      throw new Error(`Ollama initialization failed: ${error.message}`);
    }
  }

  validateConfiguredModels() {
    const modelNames = this.availableModels.map(m => m.split(':')[0]);

    for (const [type, model] of Object.entries(this.models)) {
      const baseName = model.split(':')[0];
      if (!modelNames.includes(baseName) && !this.availableModels.includes(model)) {
        logger.warn(`Ollama ${type} model "${model}" not found. Available: ${this.availableModels.join(', ')}`);
      }
    }
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();
    const model = options.model || this.models.chat;

    try {
      logger.debug(`Ollama generating response with model: ${model}`);

      // Build messages array
      const messages = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }

      // Handle conversation history if provided
      if (options.conversationHistory && Array.isArray(options.conversationHistory)) {
        messages.push(...options.conversationHistory);
      }

      // Handle prompt as string or structured
      if (typeof prompt === 'string') {
        messages.push({ role: 'user', content: prompt });
      } else if (prompt.messages) {
        messages.push(...prompt.messages);
      } else {
        messages.push({ role: 'user', content: String(prompt) });
      }

      const requestBody = {
        model,
        messages,
        stream: options.stream || false,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens || this.config.maxTokens || 2048,
          top_p: options.topP ?? 0.9,
          stop: options.stop || []
        }
      };

      const response = await axios.post(`${this.baseUrl}/api/chat`, requestBody, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' },
        responseType: options.stream ? 'stream' : 'json'
      });

      if (options.stream) {
        return this.handleStreamedResponse(response);
      }

      const responseTime = Date.now() - startTime;
      const result = response.data;

      // Calculate token usage (Ollama provides this in the response)
      const usage = {
        prompt_tokens: result.prompt_eval_count || 0,
        completion_tokens: result.eval_count || 0,
        total_tokens: (result.prompt_eval_count || 0) + (result.eval_count || 0),
        model
      };

      await this.updateMetrics(responseTime, usage);
      this.recordModelUsage(model, responseTime, usage.total_tokens);

      return {
        content: result.message?.content || '',
        model,
        usage,
        responseTime
      };

    } catch (error) {
      this.metrics.errors++;
      logger.error('Ollama generateResponse error:', error.message);

      if (error.code === 'ECONNREFUSED') {
        throw new Error('Ollama server not running. Start with: ollama serve');
      }

      throw error;
    }
  }

  async handleStreamedResponse(response) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      response.data.on('data', (chunk) => {
        chunks.push(chunk.toString());
      });

      response.data.on('end', () => {
        const content = chunks.join('');
        resolve({ content });
      });

      response.data.on('error', (error) => {
        logger.error('Stream error:', error.message);
        reject(error);
      });
    });
  }

  async generateEmbedding(text) {
    const startTime = Date.now();
    const model = this.models.embedding;

    try {
      logger.debug(`Ollama generating embedding with model: ${model}`);

      const response = await axios.post(`${this.baseUrl}/api/embeddings`, {
        model,
        prompt: text
      }, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      const responseTime = Date.now() - startTime;

      // Update metrics (embedding requests don't have traditional token counts)
      await this.updateMetrics(responseTime, {
        model,
        requestType: 'embedding'
      });

      return response.data.embedding;

    } catch (error) {
      this.metrics.errors++;
      logger.error('Ollama generateEmbedding error:', error.message);

      if (error.response?.status === 404) {
        logger.warn(`Embedding model "${model}" not found. Pull with: ollama pull ${model}`);
      }

      throw error;
    }
  }

  async analyzeImage(imageBuffer, prompt) {
    const startTime = Date.now();
    const model = this.models.vision;

    try {
      logger.debug(`Ollama analyzing image with model: ${model}`);

      // Convert buffer to base64
      const base64Image = imageBuffer.toString('base64');

      const response = await axios.post(`${this.baseUrl}/api/chat`, {
        model,
        messages: [
          {
            role: 'user',
            content: prompt || 'Describe this image in detail.',
            images: [base64Image]
          }
        ],
        stream: false
      }, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      const responseTime = Date.now() - startTime;
      const result = response.data;

      const usage = {
        prompt_tokens: result.prompt_eval_count || 0,
        completion_tokens: result.eval_count || 0,
        model,
        requestType: 'vision'
      };

      await this.updateMetrics(responseTime, usage);

      return {
        content: result.message?.content || '',
        model,
        usage,
        responseTime
      };

    } catch (error) {
      this.metrics.errors++;
      logger.error('Ollama analyzeImage error:', error.message);
      throw error;
    }
  }

  async transcribeAudio() {
    // Ollama doesn't support audio transcription natively
    logger.warn('Ollama does not support audio transcription');
    return null;
  }

  async generateSpeech() {
    // Ollama doesn't support TTS natively
    logger.warn('Ollama does not support text-to-speech');
    return null;
  }

  /**
   * List all available models on the Ollama server
   */
  async listModels() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 10000
      });

      this.availableModels = response.data.models?.map(m => m.name) || [];
      return this.availableModels;
    } catch (error) {
      logger.error('Failed to list Ollama models:', error.message);
      throw error;
    }
  }

  /**
   * Pull a model from Ollama library
   */
  async pullModel(modelName) {
    try {
      logger.info(`Pulling Ollama model: ${modelName}`);

      const response = await axios.post(`${this.baseUrl}/api/pull`, {
        name: modelName,
        stream: false
      }, {
        timeout: 600000 // 10 minutes for large models
      });

      logger.info(`Successfully pulled model: ${modelName}`);

      // Refresh available models
      await this.listModels();

      return response.data;
    } catch (error) {
      logger.error(`Failed to pull model ${modelName}:`, error.message);
      throw error;
    }
  }

  /**
   * Get information about a specific model
   */
  async getModelInfo(modelName) {
    try {
      const response = await axios.post(`${this.baseUrl}/api/show`, {
        name: modelName
      }, {
        timeout: 10000
      });

      return response.data;
    } catch (error) {
      logger.error(`Failed to get info for model ${modelName}:`, error.message);
      throw error;
    }
  }

  /**
   * Switch to a specific version of a model
   */
  async switchModelVersion(modelName, version) {
    try {
      const fullModelName = `${modelName}:${version}`;
      if (!this.availableModels.includes(fullModelName)) {
        throw new Error(`Model version ${fullModelName} not available. Available models: ${this.availableModels.join(', ')}`);
      }
      this.models.chat = fullModelName;
      logger.info(`Switched to model version: ${fullModelName}`);
      return { success: true, model: fullModelName };
    } catch (error) {
      logger.error(`Failed to switch model version for ${modelName}:`, error.message);
      throw error;
    }
  }

  /**
   * Stream response for real-time applications
   */
  async streamResponse(prompt) {
    return await this.generateResponse(prompt, { stream: true });
  }

  /**
   * Record per-model usage analytics
   */
  recordModelUsage(model, responseTime, tokenCount) {
    if (!this.metrics.usage[model]) {
      this.metrics.usage[model] = {
        requests: 0,
        totalTokens: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        averageTokens: 0,
        lastUsed: null
      };
    }
    const entry = this.metrics.usage[model];
    entry.requests++;
    entry.totalTokens += tokenCount || 0;
    entry.totalResponseTime += responseTime || 0;
    entry.averageResponseTime = entry.totalResponseTime / entry.requests;
    entry.averageTokens = entry.totalTokens / entry.requests;
    entry.lastUsed = new Date().toISOString();
  }

  /**
   * Get per-model usage analytics
   */
  getModelUsageAnalytics() {
    return {
      models: { ...this.metrics.usage },
      summary: {
        totalModelsUsed: Object.keys(this.metrics.usage).length,
        totalRequests: Object.values(this.metrics.usage).reduce((sum, m) => sum + m.requests, 0),
        totalTokens: Object.values(this.metrics.usage).reduce((sum, m) => sum + m.totalTokens, 0)
      }
    };
  }

  /**
   * Cost calculation - Ollama is local so cost is $0
   */
  calculateCost() {
    return 0;
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      chat: true,
      embedding: true,
      vision: true,
      audio: false,
      tts: false,
      imageGeneration: false,
      videoGeneration: false,
      webSearch: false,
      local: true,
      cost: 0
    };
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async execute(command, params) {
    switch (command) {
      case 'listmodels':
        return await this.listModels();
      case 'pullmodel':
        return await this.pullModel(params.modelName);
      case 'getmodelinfo':
        return await this.getModelInfo(params.modelName);
      case 'switchmodelversion':
        return await this.switchModelVersion(params.modelName, params.version);
      case 'streamresponse':
        return await this.streamResponse(params.prompt);
      case 'getmodelusageanalytics':
        return this.getModelUsageAnalytics();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}

export default OllamaProvider;