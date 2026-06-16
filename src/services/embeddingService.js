import { logger } from '../utils/logger.js';
import OpenAI from 'openai';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';

/**
 * Service for generating text embeddings using multiple providers and models
 */
class EmbeddingService {
  constructor() {
    this.initialized = false;
    this.openai = null;
    this.models = {
      'openai:text-embedding-ada-002': {
        provider: 'openai',
        model: 'text-embedding-ada-002',
        dimension: 1536,
        maxTokens: 8191,
        languages: ['en', 'multi']
      },
      'openai:text-embedding-3-small': {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimension: 1536,
        maxTokens: 8191,
        languages: ['en', 'multi']
      },
      'openai:text-embedding-3-large': {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimension: 3072,
        maxTokens: 8191,
        languages: ['en', 'multi']
      }
    };
    this.defaultModel = process.env.DEFAULT_EMBEDDING_MODEL || 'openai:text-embedding-ada-002';
    this.cache = new NodeCache({ stdTTL: 3600 });
  }

  async initialize() {
    try {
      logger.info('Initializing EmbeddingService...');
      
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is required for embeddings');
      }
      
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
      
      await this.testConnection();
      
      this.initialized = true;
      logger.info('EmbeddingService initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize EmbeddingService:', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      const defaultModelConfig = this.models[this.defaultModel];
      if (!defaultModelConfig) {
        throw new Error(`Default model ${this.defaultModel} not found in model registry`);
      }

      const response = await retryOperation(() => this.openai.embeddings.create({
        input: 'test',
        model: defaultModelConfig.model
      }), { retries: 3 });
      
      if (!response.data || !response.data[0] || !response.data[0].embedding) {
        throw new Error('Invalid embedding response');
      }
      
      logger.info('EmbeddingService connection test successful');
      
    } catch (error) {
      logger.error('EmbeddingService connection test failed:', error);
      throw error;
    }
  }

  /**
   * Get list of available embedding models
   * @returns {Array} Array of model identifiers
   */
  getAvailableModels() {
    return Object.keys(this.models);
  }

  /**
   * Get capabilities of a specific model
   * @param {string} modelId - The model identifier
   * @returns {Object} Model capabilities
   */
  getModelCapabilities(modelId) {
    if (!this.models[modelId]) {
      throw new Error(`Model ${modelId} not found`);
    }
    return { ...this.models[modelId] };
  }

  /**
   * Select the optimal model based on input characteristics
   * @param {string} text - The text to be embedded
   * @param {Object} options - Selection options
   * @returns {string} The selected model identifier
   */
  selectOptimalModel(text, options = {}) {
    // If a specific model is requested, use it
    if (options.model && this.models[options.model]) {
      return options.model;
    }

    // If language is specified, find a model that supports it
    if (options.language) {
      const languageModels = Object.entries(this.models).filter(([id, model]) => 
        model.languages.includes(options.language) || model.languages.includes('multi')
      );
      if (languageModels.length > 0) {
        // Prefer the default model if it supports the language
        const defaultModelEntry = languageModels.find(([id]) => id === this.defaultModel);
        if (defaultModelEntry) {
          return defaultModelEntry[0];
        }
        // Otherwise return the first model that supports the language
        return languageModels[0][0];
      }
    }

    // For very long texts, use a model with higher token limit (all models have same limit currently)
    if (text.length > 1000) {
      return this.defaultModel;
    }

    // For short texts, use the default model
    return this.defaultModel;
  }

  async generateEmbedding(text, options = {}) {
    if (!this.initialized) {
      throw new Error('EmbeddingService not initialized');
    }

    try {
      const modelId = this.selectOptimalModel(text, options);
      const modelConfig = this.models[modelId];
      
      if (!modelConfig) {
        throw new Error(`Model configuration for ${modelId} not found`);
      }

      const cacheKey = `embedding:${modelId}:${text}`;
      const cachedEmbedding = this.cache.get(cacheKey);
      if (cachedEmbedding) {
        return cachedEmbedding;
      }

      let response;
      switch (modelConfig.provider) {
        case 'openai':
          const createOpts = { input: text, model: modelConfig.model };
          if (modelConfig.model !== 'text-embedding-ada-002' && (options.dimensions || modelConfig.dimension !== 1536)) {
            createOpts.dimensions = options.dimensions || modelConfig.dimension;
          }
          response = await retryOperation(() => this.openai.embeddings.create(createOpts), { retries: 3 });
          break;
        default:
          throw new Error(`Unsupported provider: ${modelConfig.provider}`);
      }
      
      const embedding = response.data[0].embedding;
      this.cache.set(cacheKey, embedding);
      return embedding;
      
    } catch (error) {
      logger.error('Failed to generate embedding:', error);
      throw error;
    }
  }

  async generateBatchEmbeddings(texts, options = {}) {
    if (!this.initialized) {
      throw new Error('EmbeddingService not initialized');
    }

    try {
      // For batch embeddings, we use the same model for all texts
      // In a more advanced implementation, we might group texts by optimal model
      const modelId = options.model || this.defaultModel;
      const modelConfig = this.models[modelId];
      
      if (!modelConfig) {
        throw new Error(`Model configuration for ${modelId} not found`);
      }

      const batchSize = 100;
      const promises = [];
      
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        let promise;
        
        switch (modelConfig.provider) {
          case 'openai':
            const batchOpts = { input: batch, model: modelConfig.model };
            if (modelConfig.model !== 'text-embedding-ada-002' && (options.dimensions || modelConfig.dimension !== 1536)) {
              batchOpts.dimensions = options.dimensions || modelConfig.dimension;
            }
            promise = retryOperation(() => this.openai.embeddings.create(batchOpts), { retries: 3 });
            break;
          default:
            throw new Error(`Unsupported provider: ${modelConfig.provider}`);
        }
        
        promises.push(promise);
      }
      
      const responses = await Promise.all(promises);
      const embeddings = responses.flatMap(response => response.data.map(d => d.embedding));
      
      return embeddings;
      
    } catch (error) {
      logger.error('Failed to generate batch embeddings:', error);
      throw error;
    }
  }

  /**
   * Get the dimension of embeddings for a specific model
   * @param {string} modelId - The model identifier
   * @returns {number} The embedding dimension
   */
  getEmbeddingDimension(modelId = null) {
    if (modelId) {
      const modelConfig = this.models[modelId];
      if (!modelConfig) {
        throw new Error(`Model ${modelId} not found`);
      }
      return modelConfig.dimension;
    }
    
    // Return dimension of default model if no model specified
    const defaultModelConfig = this.models[this.defaultModel];
    return defaultModelConfig ? defaultModelConfig.dimension : 1536;
  }

  /**
   * Health check for the embedding service
   * @returns {Object} Health status
   */
  async healthCheck() {
    try {
      await this.testConnection();
      return {
        status: 'healthy',
        initialized: this.initialized,
        defaultModel: this.defaultModel,
        availableModels: this.getAvailableModels()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        initialized: this.initialized
      };
    }
  }
}

// Export singleton
export const embeddingService = new EmbeddingService();
