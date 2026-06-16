import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';

const BASE_URL = 'https://mkstqjtsujvcaobdksxs.functions.supabase.co/functions/v1/uncensoredlm-api';

export class UncensoredProvider extends BaseProvider {
  constructor(config = {}) {
    super('Uncensored', config);
    this.apiKey = null;
    this.models = {
      chat: config.chatModel || config.model || 'uncensored-lm'
    };
    this.cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
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

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();

    try {
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
}
