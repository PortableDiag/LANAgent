import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';

const BASE_URL = 'https://mkstqjtsujvcaobdksxs.functions.supabase.co/functions/v1/uncensoredlm-api';

export class UncensoredProvider extends BaseProvider {
  // Longest rate-limit window we'll sleep through in-band; longer windows
  // throw immediately so the caller/manager can fall back.
  static MAX_INBAND_WAIT_MS = 15_000;

  constructor(config = {}) {
    super('Uncensored', config);
    this.apiKey = null;
    this.models = {
      chat: config.chatModel || config.model || 'uncensored-lm'
    };
    this.cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
    // null = header never seen (unknown), NOT unlimited
    this.rateLimiter = {
      limit: null,
      remaining: null,
      resetTime: 0
    };
  }

  async initialize() {
    try {
      this.apiKey = this.config.apiKey || process.env.UNCENSORED_API_KEY;
      if (!this.apiKey) {
        throw new Error('Uncensored AI API key not found');
      }

      // Cost estimation (free tier or minimal cost)
      this.calculateCost = (metrics) => {
        const pricing = { 'uncensored-lm': { input: 0.001, output: 0.002 } };
        let totalCost = 0;
        for (const [model, usage] of Object.entries(metrics.tokensByModel || {})) {
          const price = pricing[model] || pricing['uncensored-lm'];
          totalCost += (usage.input / 1000) * price.input;
          totalCost += (usage.output / 1000) * price.output;
        }
        return totalCost;
      };

      await super.initialize();
      logger.info('Uncensored AI provider initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Uncensored provider:', error);
      throw error;
    }
  }

  /**
   * Update rate limiter state based on response headers.
   * Headers may be absent (the API doesn't guarantee them) — state is only
   * touched when at least one x-ratelimit-* header is present. A remaining
   * value of 0 MUST survive parsing (it's the whole point of the limiter),
   * so parse failures map to null, never to a default.
   * @param {Object} headers - Response headers (axios lowercases names)
   */
  _updateRateLimit(headers = {}) {
    const num = (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    const limit = num(headers['x-ratelimit-limit']);
    const remaining = num(headers['x-ratelimit-remaining']);
    const reset = num(headers['x-ratelimit-reset']);

    if (limit === null && remaining === null && reset === null) return;

    // Reset headers come in two dialects: delta seconds ("30") or epoch
    // seconds ("1754060000"). Anything over ~11 days is treated as epoch.
    let resetTime = 0;
    if (reset !== null) {
      resetTime = reset > 1_000_000 ? reset * 1000 : Date.now() + reset * 1000;
    }

    this.rateLimiter = { limit, remaining, resetTime };
    logger.debug(`Rate limit updated - Limit: ${limit}, Remaining: ${remaining}, ResetTime: ${resetTime}`);
  }

  /**
   * True when the quota is exhausted and the reset is still in the future.
   */
  _isRateLimited() {
    return this.rateLimiter.remaining !== null &&
           this.rateLimiter.remaining <= 0 &&
           this.rateLimiter.resetTime > Date.now();
  }

  /**
   * Ride out a short rate-limit window in-band; fail fast on a long one so
   * the provider manager can fall back to another provider instead of this
   * request hanging for minutes.
   */
  async _waitForRateLimitReset() {
    if (!this._isRateLimited()) return;
    const waitTime = this.rateLimiter.resetTime - Date.now();
    if (waitTime > UncensoredProvider.MAX_INBAND_WAIT_MS) {
      throw new Error(`Uncensored API rate limited — resets in ~${Math.ceil(waitTime / 1000)}s`);
    }
    logger.info(`Rate limit reached. Waiting ${Math.ceil(waitTime / 1000)}s until reset.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  /**
   * Check if we should throttle requests based on remaining quota
   * @returns {boolean} Whether to throttle
   */
  _shouldThrottle() {
    const { limit, remaining } = this.rateLimiter;
    if (limit === null || remaining === null || limit <= 0) return false;
    // Throttle if we're below 10% of our quota
    return remaining < limit * 0.1;
  }

  /**
   * Apply dynamic delay based on rate limit status
   */
  async _applyDynamicDelay() {
    if (this._shouldThrottle()) {
      // Increase delay proportionally to how close we are to the limit
      const usageRatio = 1 - (this.rateLimiter.remaining / this.rateLimiter.limit);
      const delay = Math.min(1000 * usageRatio * 10, 5000); // Max 5 second delay
      logger.debug(`Applying dynamic delay of ${delay}ms due to high usage`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();

    try {
      // Wait if we've hit rate limits
      await this._waitForRateLimitReset();
      
      // Apply dynamic throttling
      await this._applyDynamicDelay();

      const messages = options.messages || [
        { role: 'system', content: options.systemPrompt || 'You are a helpful AI assistant.' },
        { role: 'user', content: prompt }
      ];

      const model = options.model || this.models.chat;

      const response = await retryOperation(async () => {
        const res = await axios.post(BASE_URL, {
          model,
          messages,
          max_tokens: options.maxTokens || 1000,
          temperature: options.temperature || 0.7
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          timeout: 60000
        });
        
        // Update rate limit info from response headers
        this._updateRateLimit(res.headers);
        
        return res.data;
      }, { retries: 2, context: 'uncensored-generate' });

      const responseTime = Date.now() - startTime;
      const content = response.choices?.[0]?.message?.content || '';
      const usage = response.usage || {};

      await this.updateMetrics(responseTime, {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        model: response.model || model
      });

      return {
        content,
        model: response.model || model,
        usage,
        provider: this.name
      };
    } catch (error) {
      this.metrics.errors++;
      if (error.response) {
        // Update rate limit info even on errors if headers are present
        if (error.response.headers) {
          this._updateRateLimit(error.response.headers);
        }
        logger.error(`API error: ${error.response.status} - ${error.response.data}`);
      } else if (error.request) {
        logger.error('Network error: No response received');
      } else {
        logger.error('Unexpected error:', error.message);
      }
      throw error;
    }
  }

  async generateEmbedding(text) {
    logger.warn('Uncensored AI does not support embeddings');
    return null;
  }

  async transcribeAudio(audioBuffer) {
    logger.warn('Uncensored AI does not support audio transcription');
    return null;
  }

  async generateSpeech(text, options = {}) {
    logger.warn('Uncensored AI does not support speech generation');
    return null;
  }

  async analyzeImage(imageBuffer, prompt) {
    logger.warn('Uncensored AI does not support image analysis');
    return null;
  }

  /**
   * Health check — extends the BaseProvider shape (sync, metrics fields)
   * with rate-limit visibility rather than replacing it.
   * @returns {Object} Health status
   */
  healthCheck() {
    const isRateLimited = this._isRateLimited();
    return {
      ...super.healthCheck(),
      configured: !!this.apiKey,
      rateLimit: {
        limit: this.rateLimiter.limit,
        remaining: this.rateLimiter.remaining,
        resetTime: this.rateLimiter.resetTime ? new Date(this.rateLimiter.resetTime).toISOString() : null,
        isRateLimited
      }
    };
  }
}
