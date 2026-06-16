import { BaseProvider } from './BaseProvider.js';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * BitNet Provider
 * Enables local CPU-only LLM inference using Microsoft's BitNet.cpp
 * Runs 1.58-bit quantized models via llama.cpp compatible server
 * https://github.com/microsoft/BitNet
 */
export class BitNetProvider extends BaseProvider {
  constructor(config = {}) {
    super('BitNet', config);
    this.baseUrl = config.baseUrl || process.env.BITNET_BASE_URL || 'http://localhost:8080';
    this.models = {
      chat: config.chatModel || process.env.BITNET_CHAT_MODEL || 'BitNet-b1.58-2B-4T'
    };
    this.contextLength = config.contextLength || 2048;
    this.timeout = config.timeout || 120000;
    this.availableModels = [];
    this.commands = [
      { command: 'healthcheck', description: 'Check if BitNet server is running', usage: 'healthcheck' },
      { command: 'getserverinfo', description: 'Get BitNet server status and model info', usage: 'getserverinfo' }
    ];
  }

  async initialize() {
    logger.info(`Initializing BitNet provider at ${this.baseUrl}`);

    this.availableModels = [this.models.chat];
    this.serverOnline = false;

    try {
      // llama.cpp server exposes /health
      const response = await axios.get(`${this.baseUrl}/health`, {
        timeout: 10000
      });

      if (response.data?.status === 'ok' || response.status === 200) {
        this.serverOnline = true;
        logger.info('BitNet server is running');
      }

      // Try to get model info from /v1/models (OpenAI-compatible endpoint)
      try {
        const modelsResponse = await axios.get(`${this.baseUrl}/v1/models`, {
          timeout: 10000
        });
        if (modelsResponse.data?.data) {
          this.availableModels = modelsResponse.data.data.map(m => m.id);
          logger.info(`BitNet models available: ${this.availableModels.join(', ')}`);
        }
      } catch {
        logger.debug('BitNet /v1/models not available, using configured model name');
      }

      this.isActive = true;
      logger.info('BitNet provider initialized successfully');
    } catch (error) {
      // Register anyway so it appears in the UI — users can start the server later
      this.isActive = true;
      logger.warn(`BitNet server not reachable at ${this.baseUrl} — provider registered but offline. Start the BitNet server to use it.`);
    }
  }

  async generateResponse(prompt, options = {}) {
    // Auto-reconnect: check server if previously offline
    if (!this.serverOnline) {
      try {
        await axios.get(`${this.baseUrl}/health`, { timeout: 5000 });
        this.serverOnline = true;
        logger.info('BitNet server is now online');
      } catch {
        throw new Error('BitNet server is offline. Start the server with: python run_inference_server.py -m <model_path>');
      }
    }

    const startTime = Date.now();
    const model = options.model || this.models.chat;

    try {
      logger.debug(`BitNet generating response with model: ${model}`);

      const messages = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }

      if (options.conversationHistory && Array.isArray(options.conversationHistory)) {
        messages.push(...options.conversationHistory);
      }

      if (typeof prompt === 'string') {
        messages.push({ role: 'user', content: prompt });
      } else if (prompt.messages) {
        messages.push(...prompt.messages);
      } else {
        messages.push({ role: 'user', content: String(prompt) });
      }

      // Use OpenAI-compatible /v1/chat/completions endpoint
      const requestBody = {
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || this.config.maxTokens || 2048,
        top_p: options.topP ?? 0.9,
        stream: false
      };

      if (options.stop) {
        requestBody.stop = options.stop;
      }

      const response = await retryOperation(() => axios.post(`${this.baseUrl}/v1/chat/completions`, requestBody, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      }), { retries: 3 });

      const responseTime = Date.now() - startTime;
      const result = response.data;
      const choice = result.choices?.[0];

      const usage = {
        prompt_tokens: result.usage?.prompt_tokens || 0,
        completion_tokens: result.usage?.completion_tokens || 0,
        total_tokens: result.usage?.total_tokens || 0,
        model
      };

      await this.updateMetrics(responseTime, usage);

      return {
        content: choice?.message?.content || '',
        model,
        usage,
        responseTime
      };

    } catch (error) {
      this.metrics.errors++;
      logger.error('BitNet generateResponse error:', error.message);

      if (error.code === 'ECONNREFUSED') {
        this.serverOnline = false;
        throw new Error('BitNet server not running. Start with: python run_inference_server.py -m <model_path>');
      }

      throw error;
    }
  }

  async generateStreamingResponse(prompt, options = {}, onChunk) {
    if (!this.serverOnline) {
      try {
        await axios.get(`${this.baseUrl}/health`, { timeout: 5000 });
        this.serverOnline = true;
      } catch {
        throw new Error('BitNet server is offline. Start the server first.');
      }
    }

    const startTime = Date.now();
    const model = options.model || this.models.chat;

    try {
      const messages = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }

      if (options.conversationHistory && Array.isArray(options.conversationHistory)) {
        messages.push(...options.conversationHistory);
      }

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
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || this.config.maxTokens || 2048,
        stream: true
      };

      const response = await retryOperation(() => axios.post(`${this.baseUrl}/v1/chat/completions`, requestBody, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream'
      }), { retries: 3 });

      return new Promise((resolve, reject) => {
        let fullContent = '';
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;

        response.data.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(line => line.startsWith('data: '));
          for (const line of lines) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullContent += delta;
                if (onChunk) {
                  try { onChunk(delta, fullContent); } catch (e) { /* ignore callback errors */ }
                }
              }
              if (parsed.usage) {
                totalPromptTokens = parsed.usage.prompt_tokens || 0;
                totalCompletionTokens = parsed.usage.completion_tokens || 0;
              }
            } catch {
              // skip malformed chunks
            }
          }
        });

        response.data.on('end', async () => {
          const responseTime = Date.now() - startTime;
          const usage = {
            prompt_tokens: totalPromptTokens,
            completion_tokens: totalCompletionTokens,
            total_tokens: totalPromptTokens + totalCompletionTokens,
            model
          };
          await this.updateMetrics(responseTime, usage);
          resolve({ content: fullContent, model, usage, responseTime });
        });

        response.data.on('error', (error) => {
          this.metrics.errors++;
          logger.error('BitNet stream error:', error.message);
          reject(error);
        });
      });

    } catch (error) {
      this.metrics.errors++;
      logger.error('BitNet streaming error:', error.message);
      // Fall back to non-streaming
      return this.generateResponse(prompt, options);
    }
  }

  async transcribeAudio() {
    logger.warn('BitNet does not support audio transcription');
    return null;
  }

  async generateSpeech() {
    logger.warn('BitNet does not support text-to-speech');
    return null;
  }

  async analyzeImage() {
    logger.warn('BitNet does not support image analysis (1-bit models are text-only)');
    return null;
  }

  async generateEmbedding(text) {
    const startTime = Date.now();

    try {
      // llama.cpp server supports /v1/embeddings if model has embedding capability
      const response = await axios.post(`${this.baseUrl}/v1/embeddings`, {
        input: text,
        model: this.models.chat
      }, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, { model: this.models.chat, requestType: 'embedding' });

      return response.data?.data?.[0]?.embedding || null;
    } catch (error) {
      logger.debug('BitNet embedding not supported by current model:', error.message);
      return null;
    }
  }

  /**
   * Check BitNet server health
   */
  async serverHealthCheck() {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, { timeout: 5000 });
      return {
        status: response.data?.status || 'ok',
        serverRunning: true
      };
    } catch (error) {
      return {
        status: 'offline',
        serverRunning: false,
        error: error.message
      };
    }
  }

  /**
   * Get server info including loaded model
   */
  async getServerInfo() {
    try {
      const [health, models] = await Promise.all([
        axios.get(`${this.baseUrl}/health`, { timeout: 5000 }).catch(() => null),
        axios.get(`${this.baseUrl}/v1/models`, { timeout: 5000 }).catch(() => null)
      ]);

      return {
        serverRunning: !!health,
        status: health?.data?.status || 'unknown',
        models: models?.data?.data || [],
        configuredModel: this.models.chat,
        baseUrl: this.baseUrl
      };
    } catch (error) {
      return { serverRunning: false, error: error.message };
    }
  }

  /**
   * Cost calculation - BitNet is local, $0 cost
   */
  calculateCost() {
    return 0;
  }

  getCapabilities() {
    return {
      chat: true,
      embedding: false, // Most 1-bit models don't support embeddings well
      vision: false,
      audio: false,
      tts: false,
      imageGeneration: false,
      videoGeneration: false,
      webSearch: false,
      local: true,
      cpuOptimized: true,
      cost: 0
    };
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async execute(command, params) {
    switch (command) {
      case 'healthcheck':
        return await this.serverHealthCheck();
      case 'getserverinfo':
        return await this.getServerInfo();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}

export default BitNetProvider;
