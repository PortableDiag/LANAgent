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

  /**
   * Conservative token estimate for OpenAI embedding models (no tokenizer
   * dependency). Takes the larger of two heuristics so it errs HIGH:
   *   - word/number/punctuation pieces (each is at least one BPE token)
   *   - ~3 ASCII chars per token, and one token per non-ASCII char (CJK,
   *     emoji and accented text tokenize far denser than English)
   * @param {string} text - The text to estimate
   * @returns {number} Estimated token count (0 for non-strings)
   */
  estimateTokenCount(text) {
    if (typeof text !== 'string' || !text) return 0;
    const pieces = (text.match(/[\w']+|[^\w\s]/g) || []).length;
    let ascii = 0;
    let nonAscii = 0;
    for (const ch of text) {
      if (ch.codePointAt(0) < 128) ascii++;
      else nonAscii++;
    }
    return Math.max(pieces, Math.ceil(ascii / 3) + nonAscii);
  }

  /**
   * Truncate text so its estimated token count fits the model's maxTokens.
   * Returns a PREFIX of the original string (whitespace and punctuation
   * preserved, cut at a word boundary when one is near), so text within the
   * limit is returned unchanged and embeds exactly as before.
   * @param {string} text - The text to truncate
   * @param {string} modelId - The model identifier to get maxTokens from
   * @returns {string} Truncated text (or the original if within limit)
   */
  truncateToTokenLimit(text, modelId) {
    const modelConfig = this.models[modelId];
    if (!modelConfig) {
      throw new Error(`Model ${modelId} not found`);
    }
    if (typeof text !== 'string') return text;
    const maxTokens = modelConfig.maxTokens;
    const tokenCount = this.estimateTokenCount(text);
    if (tokenCount <= maxTokens) {
      return text;
    }

    // Binary-search the longest prefix (by code point) that fits.
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.estimateTokenCount(chars.slice(0, mid).join('')) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    let cut = chars.slice(0, lo).join('');
    // Prefer ending on whitespace rather than mid-word, if one is close.
    const ws = cut.search(/\s\S*$/);
    if (ws > cut.length * 0.9) cut = cut.slice(0, ws);

    logger.warn(`Truncating embedding input from ~${tokenCount} to ~${this.estimateTokenCount(cut)} estimated tokens (limit ${maxTokens}) for model ${modelId}`);
    return cut;
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

      // Truncate text to model's token limit to avoid API errors
      const truncatedText = this.truncateToTokenLimit(text, modelId);

      const cacheDimensions = options.dimensions || modelConfig.dimension;
      const cacheKey = `embedding:${modelId}:${cacheDimensions}:${truncatedText}`;
      const cachedEmbedding = this.cache.get(cacheKey);
      if (cachedEmbedding) {
        return cachedEmbedding;
      }

      let response;
      switch (modelConfig.provider) {
        case 'openai':
          const createOpts = { input: truncatedText, model: modelConfig.model };
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

      // Truncate each text to model's token limit
      const truncatedTexts = texts.map(t => this.truncateToTokenLimit(t, modelId));

      const batchSize = 100;
      const promises = [];
      
      for (let i = 0; i < truncatedTexts.length; i += batchSize) {
        const batch = truncatedTexts.slice(i, i + batchSize);
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
   * Calculate cosine similarity between two vectors.
   * @param {Array<number>} vectorA - The first vector
   * @param {Array<number>} vectorB - The second vector
   * @returns {number} Similarity in the range [-1, 1]
   */
  cosineSimilarity(vectorA, vectorB) {
    const isVector = vector =>
      Array.isArray(vector) ||
      (ArrayBuffer.isView(vector) && !(vector instanceof DataView));

    if (!isVector(vectorA) || !isVector(vectorB)) {
      throw new TypeError('Both vectors must be arrays or typed arrays');
    }

    if (vectorA.length === 0 || vectorB.length === 0) {
      throw new Error('Vectors must not be empty');
    }

    if (vectorA.length !== vectorB.length) {
      throw new Error(`Vector dimensions must match: ${vectorA.length} !== ${vectorB.length}`);
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let index = 0; index < vectorA.length; index += 1) {
      const valueA = vectorA[index];
      const valueB = vectorB[index];

      if (!Number.isFinite(valueA) || !Number.isFinite(valueB)) {
        throw new TypeError('Vectors must contain only finite numbers');
      }

      dotProduct += valueA * valueB;
      magnitudeA += valueA * valueA;
      magnitudeB += valueB * valueB;
    }

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
  }

  /**
   * Generate embeddings for two texts and compare them using cosine similarity.
   * Both texts are embedded with the same selected model and dimensions.
   * @param {string} textA - The first text
   * @param {string} textB - The second text
   * @param {Object} options - Embedding options, including model and dimensions
   * @returns {Promise<number>} Cosine similarity between the generated embeddings
   */
  async compareEmbedding(textA, textB, options = {}) {
    if (typeof textA !== 'string' || typeof textB !== 'string') {
      throw new TypeError('Both texts must be strings');
    }

    const model = this.selectOptimalModel(textA, options);
    const sharedOptions = { ...options, model };
    const [embeddingA, embeddingB] = await Promise.all([
      this.generateEmbedding(textA, sharedOptions),
      this.generateEmbedding(textB, sharedOptions)
    ]);

    return this.cosineSimilarity(embeddingA, embeddingB);
  }

  /**
   * Rank candidate vectors by cosine similarity to a query vector.
   * Candidates may be vectors or records containing an embedding field.
   * @param {Array<number>} queryVector - The query embedding
   * @param {Array<Array<number>|Object>} candidates - Vectors or embedding records
   * @param {Object} options - Ranking options
   * @param {number} [options.topK] - Maximum number of results to return
   * @returns {Array<Object>} Results sorted by descending score
   */
  rankBySimilarity(queryVector, candidates, options = {}) {
    if (!Array.isArray(candidates)) {
      throw new TypeError('Candidates must be an array');
    }

    if (
      options.topK !== undefined &&
      (!Number.isInteger(options.topK) || options.topK < 0)
    ) {
      throw new TypeError('topK must be a non-negative integer');
    }

    const results = candidates.map((candidate, index) => {
      const embedding = Array.isArray(candidate) ||
        (ArrayBuffer.isView(candidate) && !(candidate instanceof DataView))
        ? candidate
        : candidate && candidate.embedding;

      if (!embedding) {
        throw new TypeError(`Candidate at index ${index} must be a vector or contain an embedding field`);
      }

      return {
        candidate,
        score: this.cosineSimilarity(queryVector, embedding)
      };
    });

    results.sort((left, right) => right.score - left.score);

    if (options.topK !== undefined) {
      return results.slice(0, options.topK);
    }

    return results;
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
