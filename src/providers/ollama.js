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
    this.timeout = config.timeout || 600000; // 10 minutes — local CPU inference can be slow on modest hardware
    this.availableModels = [];
    // Tag name -> the `details` block /api/tags reports for it (family, families,
    // parameter_size, ...). Capabilities are read from here; the name hints below
    // are only a fallback for servers that report no details.
    this.modelDetails = new Map();
    this.metrics.usage = {}; // Per-model usage analytics (do not overwrite BaseProvider.metrics)
    this.commands = [
      { command: 'listmodels', description: 'List all available models', usage: 'listmodels' },
      { command: 'pullmodel', description: 'Pull a model from Ollama library', usage: 'pullmodel <modelName>' },
      { command: 'getmodelinfo', description: 'Get information about a specific model', usage: 'getmodelinfo <modelName>' },
      { command: 'switchmodelversion', description: 'Switch to a specific version of a model', usage: 'switchmodelversion <modelName> <version>' },
      { command: 'streamresponse', description: 'Stream response for real-time applications', usage: 'streamresponse <prompt>' },
      { command: 'getmodelusageanalytics', description: 'Get per-model usage analytics', usage: 'getmodelusageanalytics' },
      { command: 'getmodelcompatibility', description: 'Get model compatibility matrix', usage: 'getmodelcompatibility' },
      { command: 'routetask', description: 'Route task based on capability requirements', usage: 'routetask <taskType> [requirements]' }
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
        this.availableModels = this._ingestModelList(response.data.models);
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

  /**
   * Record an /api/tags model list: returns the tag names and keeps each entry's
   * `details` block so capabilities can be read from what the server reports
   * instead of guessed from the name.
   */
  _ingestModelList(models) {
    const list = Array.isArray(models) ? models : [];
    this.modelDetails = new Map(list.filter(m => m?.name).map(m => [m.name, m.details || null]));
    return list.map(m => m.name).filter(Boolean);
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

      this.availableModels = this._ingestModelList(response.data.models);
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
   * Normalise a tagged model name: "mistral:7b-instruct" -> "mistral".
   * /api/tags always reports a tag, configured models are usually written
   * without one, so every comparison between the two goes through here.
   */
  _baseName(modelName) {
    return String(modelName || '').split(':')[0];
  }

  /**
   * Families Ollama reports for a model, lower-cased. Empty when the server
   * gave us no details for it.
   */
  _familiesFor(modelName) {
    const details = this.modelDetails.get(modelName)
      || this.modelDetails.get(`${this._baseName(modelName)}:latest`);
    if (!details) return [];
    const families = Array.isArray(details.families) ? details.families : [];
    return [...families, details.family]
      .filter(Boolean)
      .map(f => String(f).toLowerCase());
  }

  /**
   * Get model compatibility matrix showing which models support which capabilities
   */
  getModelCompatibilityMatrix() {
    const compatibility = {};

    for (const modelName of this.availableModels) {
      compatibility[modelName] = {
        chat: this.isChatModel(modelName),
        embedding: this.isEmbeddingModel(modelName),
        vision: this.isVisionModel(modelName)
      };
    }

    return compatibility;
  }

  /**
   * Determine if a model supports chat capabilities.
   * Every generative model Ollama serves answers /api/chat — vision models
   * included — so the only non-chat models are the embedding-only ones. An
   * allowlist of known names would silently exclude every model not on it.
   */
  isChatModel(modelName) {
    return !this.isEmbeddingModel(modelName);
  }

  /**
   * Determine if a model supports embedding capabilities.
   * Ollama reports embedding models under a BERT-derived family
   * (bert, nomic-bert, ...); the name hints cover servers that report no
   * details block.
   */
  isEmbeddingModel(modelName) {
    if (this._familiesFor(modelName).some(family => family.includes('bert'))) {
      return true;
    }
    const embeddingNameHints = [
      'nomic-embed', 'mxbai-embed', 'all-minilm', 'snowflake-arctic-embed', 'embed'
    ];
    const baseName = this._baseName(modelName);
    return embeddingNameHints.some(hint => baseName.includes(hint));
  }

  /**
   * Determine if a model supports vision capabilities.
   * Multi-modal models carry an image-encoder family (clip, mllama, ...)
   * alongside their text family; the name hints are the no-details fallback.
   */
  isVisionModel(modelName) {
    const families = this._familiesFor(modelName);
    if (families.some(family => family.includes('clip') || family.includes('mllama'))) {
      return true;
    }
    const visionNameHints = ['llava', 'bakllava', 'moondream', 'nanollava'];
    const baseName = this._baseName(modelName);
    return visionNameHints.some(hint => baseName.includes(hint));
  }

  /**
   * Route a task to an appropriate model based on capability requirements
   * @param {string} taskType - 'chat' | 'embedding' | 'vision'
   * @param {Object} [requirements]
   * @param {boolean} [requirements.autoPull=false] - allow pulling a default
   *   model when nothing local can serve the task
   */
  async routeTaskByCapability(taskType, requirements = {}) {
    const task = String(taskType || '').toLowerCase();
    if (!['chat', 'embedding', 'vision'].includes(task)) {
      throw new Error(`Unsupported task type: ${taskType}`);
    }

    const compatibilityMatrix = this.getModelCompatibilityMatrix();
    let compatibleModels = Object.keys(compatibilityMatrix).filter(
      model => compatibilityMatrix[model][task]
    );

    // Pulling downloads gigabytes and can run for ten minutes, so a routing
    // question never triggers one unless the caller explicitly opted in.
    if (compatibleModels.length === 0 && requirements.autoPull) {
      const defaultModel = this.getDefaultModelForTask(task);
      if (defaultModel) {
        try {
          await this.pullModel(defaultModel); // pullModel refreshes the model list itself
          const updatedMatrix = this.getModelCompatibilityMatrix();
          // /api/tags reports the pull tagged ("mistral:latest"), never under the
          // bare name we asked for, so match on the base name.
          compatibleModels = Object.keys(updatedMatrix).filter(
            model => this._baseName(model) === this._baseName(defaultModel)
              && updatedMatrix[model][task]
          );
        } catch (error) {
          logger.warn(`Failed to pull default model ${defaultModel}:`, error.message);
        }
      }
    }

    if (compatibleModels.length === 0) {
      throw new Error(`No compatible models found for task type: ${taskType}`);
    }

    // Prefer the model configured for this task when it is one of the candidates.
    // The configured value is usually untagged, so fall back to a base-name match.
    let selectedModel = compatibleModels[0];
    const configuredModel = this.models[task];
    if (configuredModel) {
      const match = compatibleModels.find(model => model === configuredModel)
        || compatibleModels.find(model => this._baseName(model) === this._baseName(configuredModel));
      if (match) {
        selectedModel = match;
      }
    }

    return {
      model: selectedModel,
      taskType,
      availableModels: compatibleModels
    };
  }

  /**
   * Get default model for a specific task type
   */
  getDefaultModelForTask(taskType) {
    switch (String(taskType || '').toLowerCase()) {
      case 'chat':
        return 'mistral';
      case 'embedding':
        return 'nomic-embed-text';
      case 'vision':
        return 'llava';
      default:
        return null;
    }
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
      case 'getmodelcompatibility':
        return this.getModelCompatibilityMatrix();
      case 'routetask':
        return await this.routeTaskByCapability(params.taskType, params.requirements || {});
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}

export default OllamaProvider;
