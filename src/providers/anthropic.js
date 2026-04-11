import Anthropic from "@anthropic-ai/sdk";
import { BaseProvider } from "./BaseProvider.js";
import { logger } from "../utils/logger.js";
import { retryOperation, isRetryableError } from '../utils/retryUtils.js';

export class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super("Anthropic", config);
    this.client = null;
    this.models = {
      chat: config.chatModel || config.model || "claude-sonnet-4-5-20250929",
      vision: config.visionModel || "claude-sonnet-4-5-20250929"
    };
  }

  async initialize() {
    try {
      const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("Anthropic API key not found");
      }

      this.client = new Anthropic({ apiKey });
      
      // Define cost calculation for Anthropic
      this.calculateCost = (metrics) => {
        // Anthropic pricing per 1K tokens (December 2025)
        const pricing = {
          'claude-opus-4-5': { input: 0.005, output: 0.025 },
          'claude-sonnet-4-5': { input: 0.003, output: 0.015 },
          'claude-haiku-4-5': { input: 0.001, output: 0.005 },
          'claude-opus-4-1': { input: 0.015, output: 0.075 },
          'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
          'claude-3-5-haiku': { input: 0.001, output: 0.005 },
          'claude-3-opus': { input: 0.015, output: 0.075 },
          'claude-3-sonnet': { input: 0.003, output: 0.015 },
          'claude-3-haiku': { input: 0.00025, output: 0.00125 },
          'claude-2.1': { input: 0.008, output: 0.024 },
          'claude-2': { input: 0.008, output: 0.024 },
          'claude-instant': { input: 0.0008, output: 0.0024 }
        };
        
        let totalCost = 0;
        for (const [model, usage] of Object.entries(metrics.tokensByModel)) {
          // Try exact match first, then try base model name  
          let price = pricing[model];
          if (!price) {
            const modelBase = model.split('-20')[0]; // Remove date suffix
            price = pricing[modelBase];
          }
          // Default fallback to claude-3-haiku (most affordable)
          if (!price) {
            price = pricing['claude-3-haiku'];
          }
          
          totalCost += (usage.input / 1000) * price.input;
          totalCost += (usage.output / 1000) * price.output;
        }
        
        return totalCost;
      };
      
      await super.initialize();
      logger.info("Anthropic provider initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize Anthropic provider:", error);
      throw error;
    }
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();
    
    try {
      const systemPrompt = options.systemPrompt || "You are Claude, a helpful AI assistant.";
      
      // Build the request parameters
      const requestParams = {
        model: options.model || this.models.chat,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
        system: systemPrompt,
        messages: options.messages || [{ role: "user", content: prompt }]
      };

      // Add web search tool if enabled (can be configured via options or environment)
      const enableWebSearch = options.enableWebSearch !== false && 
                            (process.env.ANTHROPIC_ENABLE_WEB_SEARCH !== 'false');
      
      if (enableWebSearch) {
        requestParams.tools = [{
          type: "web_search_20250305",
          name: "web_search",
          max_uses: options.maxSearches || 5
        }];
        
        // Add optional search parameters if provided
        if (options.searchConfig) {
          const tool = requestParams.tools[0];
          if (options.searchConfig.allowedDomains) {
            tool.allowed_domains = options.searchConfig.allowedDomains;
          }
          if (options.searchConfig.blockedDomains) {
            tool.blocked_domains = options.searchConfig.blockedDomains;
          }
          if (options.searchConfig.userLocation) {
            tool.user_location = options.searchConfig.userLocation;
          }
        }
        
        logger.info(`Anthropic web search enabled with max_uses: ${requestParams.tools[0].max_uses}`);
      }
      
      const message = await retryOperation(
        () => this.client.messages.create(requestParams),
        { retries: 3, minTimeout: 1000, factor: 2, context: 'Anthropic.generateResponse', onRetry: (error, attempt) => {
          logger.warn(`Retry attempt ${attempt} for generateResponse due to error:`, error.message);
        }, customErrorClassifier: isRetryableError }
      );

      const responseTime = Date.now() - startTime;
      
      // Process the response to handle different content types
      let responseText = '';
      let citations = [];
      let searchResults = [];
      
      for (const content of message.content) {
        if (content.type === 'text') {
          responseText += content.text;
          // Collect citations if present
          if (content.citations) {
            citations.push(...content.citations);
          }
        } else if (content.type === 'server_tool_use') {
          // Log tool usage
          logger.info(`Anthropic used tool: ${content.name} with query: ${content.input?.query}`);
        } else if (content.type === 'web_search_tool_result') {
          // Collect search results
          if (content.content) {
            searchResults.push(...content.content);
          }
        }
      }
      
      // Log actual model used for debugging
      const requestedModel = options.model || this.models.chat;
      logger.info(`Anthropic API call used model: ${message.model} (requested: ${requestedModel})`);
      
      // Log web search usage if present
      if (message.usage?.server_tool_use?.web_search_requests) {
        logger.info(`Anthropic performed ${message.usage.server_tool_use.web_search_requests} web searches`);
      }

      // Pass full usage object with model info
      await this.updateMetrics(responseTime, { 
        ...message.usage,
        model: message.model 
      });

      return {
        content: responseText,
        model: message.model,
        usage: message.usage,
        provider: this.name,
        citations: citations.length > 0 ? citations : undefined,
        searchResults: searchResults.length > 0 ? searchResults : undefined,
        webSearchUsed: message.usage?.server_tool_use?.web_search_requests > 0
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("Anthropic generateResponse error:", error);
      throw error;
    }
  }

  async generateStreamingResponse(prompt, options = {}, onChunk) {
    const startTime = Date.now();
    try {
      const systemPrompt = options.systemPrompt || "You are Claude, a helpful AI assistant.";
      const requestParams = {
        model: options.model || this.models.chat,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
        system: systemPrompt,
        messages: options.messages || [{ role: "user", content: prompt }]
      };

      const stream = this.client.messages.stream(requestParams);
      let fullContent = '';

      stream.on('text', (text) => {
        fullContent += text;
        if (onChunk) {
          onChunk(text, fullContent).catch(() => {});
        }
      });

      const finalMessage = await stream.finalMessage();
      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, { ...finalMessage.usage, model: finalMessage.model });

      return {
        content: fullContent,
        model: finalMessage.model,
        usage: finalMessage.usage,
        provider: this.name
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("Anthropic generateStreamingResponse error:", error);
      throw error;
    }
  }

  async generateEmbedding(text) {
    // Anthropic doesn't provide embeddings directly
    // You could use a different service or return null
    logger.warn("Anthropic provider does not support embeddings");
    return null;
  }

  async transcribeAudio(audioBuffer) {
    logger.warn("Anthropic provider does not support audio transcription");
    return null;
  }

  async generateSpeech(text, options = {}) {
    logger.warn("Anthropic provider does not support speech generation");
    return null;
  }

  async analyzeImage(imageBuffer, prompt) {
    const startTime = Date.now();
    
    try {
      const base64Image = imageBuffer.toString("base64");
      
      const message = await retryOperation(
        () => this.client.messages.create({
          model: this.models.vision,
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: base64Image
                  }
                },
                {
                  type: "text",
                  text: prompt || "What is in this image?"
                }
              ]
            }
          ]
        }),
        { retries: 3, minTimeout: 1000, factor: 2, context: 'Anthropic.analyzeImage', onRetry: (error, attempt) => {
          logger.warn(`Retry attempt ${attempt} for analyzeImage due to error:`, error.message);
        }, customErrorClassifier: isRetryableError }
      );

      // Update metrics for image analysis
      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, {
        ...message.usage,
        model: message.model,
        requestType: 'vision'
      });

      return {
        description: message.content[0].text,
        model: message.model,
        usage: message.usage
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("Anthropic analyzeImage error:", error);
      throw error;
    }
  }

  getAvailableModels() {
    // Return available Anthropic models
    // Current models only — retired models cause 404 errors
    // This list is refreshed by the model-update scheduler job (daily 3 AM)
    return [
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5-20251101",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022"
    ];
  }
}