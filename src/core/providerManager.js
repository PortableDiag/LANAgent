import { EventEmitter } from "events";
import { logger } from "../utils/logger.js";
import { OpenAIProvider } from "../providers/openai.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { GabProvider } from "../providers/gab.js";
import { HuggingFaceProvider } from "../providers/huggingface.js";
import { OllamaProvider } from "../providers/ollama.js";
import { BitNetProvider } from "../providers/bitnet.js";
import { UncensoredProvider } from "../providers/uncensored.js";
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';

export class ProviderManager extends EventEmitter {
  constructor() {
    super();
    this.providers = new Map();
    this.activeProvider = null;
    this.fallbackProviders = [];
    this.providerMetricsCache = new NodeCache({ stdTTL: 300 });
    this.commands = [
      { command: 'adjustProviderPriority', description: 'Adjust provider priority based on performance metrics', usage: 'adjustProviderPriority()' }
    ];
  }

  async initialize() {
    logger.info("Initializing AI providers...");
    
    let savedConfigs = {};
    try {
      const { Agent } = await import('../models/Agent.js');
      const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      const aiProviders = agentData?.aiProviders || {};
      
      if (aiProviders.configurations) {
        savedConfigs = aiProviders.configurations;
      } else {
        savedConfigs = aiProviders;
      }
      
      for (const [providerKey, providerConfig] of Object.entries(aiProviders)) {
        if (providerKey !== 'current' && providerKey !== 'configurations') {
          if (!savedConfigs[providerKey]) savedConfigs[providerKey] = {};
          if (providerConfig.chatModel && !savedConfigs[providerKey].model) {
            savedConfigs[providerKey].chatModel = providerConfig.chatModel;
          }
        }
      }
      
      logger.info("Loaded saved AI provider configurations:", savedConfigs);
    } catch (error) {
      logger.debug("Could not load saved AI provider configurations:", error.message);
    }
    
    if (process.env.OPENAI_API_KEY) {
      const config = {
        apiKey: process.env.OPENAI_API_KEY,
        ...savedConfigs.openai
      };
      const openai = new OpenAIProvider(config);
      await this.registerProvider("openai", openai);
    }

    if (process.env.ANTHROPIC_API_KEY) {
      const config = {
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...savedConfigs.anthropic
      };
      const anthropic = new AnthropicProvider(config);
      await this.registerProvider("anthropic", anthropic);
    }

    if (process.env.GAB_AI_API_KEY) {
      const config = {
        apiKey: process.env.GAB_AI_API_KEY,
        ...savedConfigs.gab
      };
      const gab = new GabProvider(config);
      await this.registerProvider("gab", gab);
    }

    if (process.env.HUGGINGFACE_TOKEN) {
      const config = {
        apiKey: process.env.HUGGINGFACE_TOKEN,
        ...savedConfigs.huggingface
      };
      const huggingface = new HuggingFaceProvider(config);
      await this.registerProvider("huggingface", huggingface);
    }

    // Ollama - Local LLM provider (no API key required)
    if (process.env.OLLAMA_BASE_URL || process.env.ENABLE_OLLAMA === 'true') {
      try {
        const config = {
          baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
          chatModel: process.env.OLLAMA_CHAT_MODEL,
          embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL,
          visionModel: process.env.OLLAMA_VISION_MODEL,
          ...savedConfigs.ollama
        };
        const ollama = new OllamaProvider(config);
        await this.registerProvider("ollama", ollama);
      } catch (error) {
        logger.warn(`Ollama provider not available: ${error.message}`);
      }
    }

    // BitNet - Local CPU-optimized 1-bit LLM inference (no API key required)
    if (process.env.BITNET_BASE_URL || process.env.ENABLE_BITNET === 'true') {
      try {
        const config = {
          baseUrl: process.env.BITNET_BASE_URL || 'http://localhost:8080',
          chatModel: process.env.BITNET_CHAT_MODEL,
          contextLength: parseInt(process.env.BITNET_CONTEXT_LENGTH) || 2048,
          ...savedConfigs.bitnet
        };
        const bitnet = new BitNetProvider(config);
        await this.registerProvider("bitnet", bitnet);
      } catch (error) {
        logger.warn(`BitNet provider not available: ${error.message}`);
      }
    }

    // Uncensored AI - OpenAI-compatible uncensored LLM
    if (process.env.UNCENSORED_API_KEY) {
      try {
        const config = {
          apiKey: process.env.UNCENSORED_API_KEY,
          ...savedConfigs.uncensored
        };
        const uncensored = new UncensoredProvider(config);
        await this.registerProvider("uncensored", uncensored);
      } catch (error) {
        logger.warn(`Uncensored AI provider not available: ${error.message}`);
      }
    }

    await this.syncModelsWithDatabase();

    if (this.providers.size > 0) {
      let defaultProvider = process.env.DEFAULT_AI_PROVIDER;
      
      try {
        const { Agent } = await import('../models/Agent.js');
        const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
        if (agentData?.aiProviders?.current && this.providers.has(agentData.aiProviders.current)) {
          defaultProvider = agentData.aiProviders.current;
          logger.info(`Loading saved AI provider preference: ${defaultProvider}`);
        }
      } catch (error) {
        logger.debug("Could not load saved AI provider preference:", error.message);
      }
      
      if (!defaultProvider || !this.providers.has(defaultProvider)) {
        const priorityOrder = ["openai", "anthropic", "gab", "huggingface", "ollama", "bitnet"];
        for (const provider of priorityOrder) {
          if (this.providers.has(provider)) {
            defaultProvider = provider;
            break;
          }
        }
        
        if (!defaultProvider) {
          defaultProvider = this.providers.keys().next().value;
        }
      }
      
      logger.info(`Setting default provider to: ${defaultProvider}`);
      await this.switchProvider(defaultProvider);
    } else {
      logger.warn("No AI providers available!");
    }
  }

  async registerProvider(name, provider) {
    try {
      await provider.initialize();
      this.providers.set(name, provider);
      logger.info(`Registered AI provider: ${name}`);
      
      provider.on("error", (error) => {
        logger.error(`Provider ${name} error:`, error);
        this.handleProviderError(name, error);
      });
    } catch (error) {
      logger.error(`Failed to register provider ${name}:`, error);
    }
  }

  async syncModelsWithDatabase() {
    logger.info("🔄 SYNC METHOD CALLED - Starting model sync with database...");
    try {
      const { Agent } = await import('../models/Agent.js');
      const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      
      logger.info("Starting model sync with database...");
      logger.info("Agent data found:", !!agentData);
      logger.info("AI providers config:", JSON.stringify(agentData?.aiProviders, null, 2));
      
      if (!agentData?.aiProviders?.configurations) {
        logger.warn("No aiProviders.configurations found in database");
        return;
      }
      
      for (const [providerKey, provider] of this.providers.entries()) {
        const savedConfig = agentData.aiProviders.configurations[providerKey];
        logger.info(`Checking provider ${providerKey}:`, {
          hasProvider: !!provider,
          hasModels: !!provider.models,
          currentModel: provider.models?.chat,
          savedConfig: savedConfig
        });
        
        if (savedConfig?.model && provider.models) {
          const oldModel = provider.models.chat;
          provider.models.chat = savedConfig.model;
          if (provider.models.vision === oldModel) {
            provider.models.vision = savedConfig.model;
          }
          logger.info(`✓ Synced ${providerKey} model: ${oldModel} → ${savedConfig.model}`);
        } else {
          logger.warn(`✗ No sync for ${providerKey}: savedModel=${savedConfig?.model}, hasProviderModels=${!!provider.models}`);
        }
      }
    } catch (error) {
      logger.error("Failed to sync models with database:", error);
    }
  }

  async switchProvider(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider ${name} not found`);
    }

    if (this.activeProvider) {
      this.activeProvider.deactivate();
    }

    provider.activate();
    this.activeProvider = provider;
    logger.info(`Switched to AI provider: ${name}`);
    
    await this.syncModelsWithDatabase();
    
    try {
      const { Agent } = await import('../models/Agent.js');
      const agentName = process.env.AGENT_NAME || 'LANAgent';
      const result = await Agent.updateOne({ name: agentName }, {
        $set: { 'aiProviders.current': name }
      }, { upsert: true });
      logger.info(`Saved AI provider preference: ${name}`, result);
      
      const saved = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" }, { aiProviders: 1 });
      logger.info(`Verified saved preference:`, saved?.aiProviders?.current);
    } catch (error) {
      logger.error("Failed to save AI provider preference:", error);
    }
    
    this.emit("provider-switched", name);
  }

  async getCurrentProvider() {
    if (!this.activeProvider) {
      if (this.providers.size > 0) {
        const firstProvider = this.providers.keys().next().value;
        logger.warn(`No active provider, attempting to use ${firstProvider}`);
        await this.switchProvider(firstProvider);
        return this.activeProvider;
      }
      throw new Error("No active AI provider");
    }
    return this.activeProvider;
  }

  getProviderList() {
    return Array.from(this.providers.keys()).map(key => {
      const provider = this.providers.get(key);
      return {
        name: provider.name,
        key: key,
        active: this.activeProvider === provider,
        metrics: provider.getMetrics()
      };
    });
  }

  async generateResponse(prompt, options = {}) {
    const provider = await this.getCurrentProvider();
    
    const providerName = Array.from(this.providers.entries()).find(([key, prov]) => prov === provider)?.[0] || 'unknown';
    const model = provider.models?.chat || provider.model || 'unknown';
    logger.info(`🤖 Generating response using provider: ${providerName}, model: ${model}`);
    logger.info(`Active provider check: ${this.activeProvider?.name || 'none'}, Provider count: ${this.providers.size}`);
    
    try {
      return await retryOperation(() => provider.generateResponse(prompt, options), { retries: 3 });
    } catch (error) {
      logger.error("Primary provider failed, trying fallback...", error);
      return await this.tryFallbackProviders(prompt, options);
    }
  }

  async generateStreamingResponse(prompt, options = {}, onChunk) {
    const provider = await this.getCurrentProvider();
    const providerName = Array.from(this.providers.entries()).find(([key, prov]) => prov === provider)?.[0] || 'unknown';

    if (typeof provider.generateStreamingResponse !== 'function') {
      logger.info(`Provider ${providerName} does not support streaming, falling back to non-streaming`);
      const result = await this.generateResponse(prompt, options);
      if (onChunk) {
        try { await onChunk(result.content, result.content); } catch (e) {}
      }
      return result;
    }

    logger.info(`Streaming response using provider: ${providerName}`);
    try {
      return await provider.generateStreamingResponse(prompt, options, onChunk);
    } catch (error) {
      logger.error("Primary provider streaming failed, falling back to non-streaming:", error.message);
      const result = await this.generateResponse(prompt, options);
      if (onChunk) {
        try { await onChunk(result.content, result.content); } catch (e) {}
      }
      return result;
    }
  }

  async generateEmbedding(text) {
    const embeddingProviders = ["openai", "huggingface", "ollama"];
    
    for (const providerName of embeddingProviders) {
      const provider = this.providers.get(providerName);
      if (provider) {
        try {
          const embedding = await retryOperation(() => provider.generateEmbedding(text), { retries: 3 });
          if (embedding) return embedding;
        } catch (error) {
          logger.warn(`Embedding generation failed with ${providerName}:`, error);
        }
      }
    }
    
    throw new Error("No provider available for embedding generation");
  }

  async transcribeAudio(audioBuffer) {
    const audioProviders = ["openai", "huggingface"];
    
    for (const providerName of audioProviders) {
      const provider = this.providers.get(providerName);
      if (provider) {
        try {
          const transcription = await retryOperation(() => provider.transcribeAudio(audioBuffer), { retries: 3 });
          if (transcription) return transcription;
        } catch (error) {
          logger.warn(`Audio transcription failed with ${providerName}:`, error);
        }
      }
    }
    
    throw new Error("No provider available for audio transcription");
  }

  async generateSpeech(text, options = {}) {
    const ttsProviders = ["openai", "huggingface"];
    
    for (const providerName of ttsProviders) {
      const provider = this.providers.get(providerName);
      if (provider) {
        try {
          const speech = await retryOperation(() => provider.generateSpeech(text, options), { retries: 3 });
          if (speech) return speech;
        } catch (error) {
          logger.warn(`Speech generation failed with ${providerName}:`, error);
        }
      }
    }
    
    throw new Error("No provider available for speech generation");
  }

  async analyzeImage(imageBuffer, prompt) {
    const provider = await this.getCurrentProvider();
    return await retryOperation(() => provider.analyzeImage(imageBuffer, prompt), { retries: 3 });
  }

  async tryFallbackProviders(prompt, options) {
    for (const [name, provider] of this.providers) {
      if (provider !== this.activeProvider) {
        try {
          logger.info(`Trying fallback provider: ${name}`);
          return await retryOperation(() => provider.generateResponse(prompt, options), { retries: 3 });
        } catch (error) {
          logger.warn(`Fallback provider ${name} also failed:`, error);
        }
      }
    }
    
    throw new Error("All AI providers failed");
  }

  handleProviderError(providerName, error) {
    this.emit("provider-error", { provider: providerName, error });
  }

  getMetrics() {
    const metrics = {};
    for (const [name, provider] of this.providers) {
      metrics[name] = provider.getMetrics();
    }
    return metrics;
  }

  /**
   * Adjust provider priority based on performance metrics
   */
  async adjustProviderPriority() {
    const metrics = this.getMetrics();
    const sortedProviders = Object.entries(metrics).sort((a, b) => {
      const aMetrics = a[1];
      const bMetrics = b[1];
      return (aMetrics.responseTime + aMetrics.errorRate) - (bMetrics.responseTime + bMetrics.errorRate);
    });

    this.fallbackProviders = sortedProviders.map(([name]) => name);
    logger.info("Adjusted provider priority based on metrics:", this.fallbackProviders);
  }

  async execute(command, params) {
    switch (command) {
      case 'adjustProviderPriority':
        return await this.adjustProviderPriority();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}