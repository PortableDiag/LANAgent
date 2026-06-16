import OpenAI from "openai";
import { BaseProvider } from "./BaseProvider.js";
import { logger } from "../utils/logger.js";
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';

export class GabProvider extends BaseProvider {
  constructor(config = {}) {
    super("Gab", config);
    this.client = null;
    this.cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
    this.models = {
      chat: config.chatModel || config.model || "arya", // Default to Gab's native model
      alternativeChat: "gpt-4o" // Alternative model if available
    };
  }

  async initialize() {
    try {
      const apiKey = this.config.apiKey || process.env.GAB_AI_API_KEY;
      if (!apiKey) {
        throw new Error("Gab AI API key not found");
      }

      // Gab uses OpenAI SDK with custom baseURL
      this.client = new OpenAI({ 
        apiKey,
        baseURL: 'https://gab.ai/v1'
      });
      
      // Define cost calculation for Gab AI
      this.calculateCost = (metrics) => {
        // Gab AI pricing (estimated based on typical pricing)
        const pricing = {
          'arya': { input: 0.001, output: 0.002 },
          'gpt-4o': { input: 0.005, output: 0.015 }
        };
        
        let totalCost = 0;
        for (const [model, usage] of Object.entries(metrics.tokensByModel)) {
          const price = pricing[model] || pricing['arya'];
          totalCost += (usage.input / 1000) * price.input;
          totalCost += (usage.output / 1000) * price.output;
        }
        
        return totalCost;
      };
      
      await super.initialize();
      logger.info("Gab AI provider initialized successfully");
      
      // Optionally fetch available models
      try {
        const models = await this.client.models.list();
        logger.info("Available Gab models:", models.data.map(m => m.id));
      } catch (error) {
        logger.warn("Could not fetch Gab model list:", error.message);
      }
    } catch (error) {
      logger.error("Failed to initialize Gab provider:", error);
      throw error;
    }
  }

  /**
   * Categorize errors into network, authentication, and API-specific errors
   * @param {Error} error - The error object to categorize
   * @returns {string} - The category of the error
   */
  categorizeError(error) {
    if (error.message.includes('Network Error')) {
      return 'network';
    } else if (error.response && error.response.status === 401) {
      return 'authentication';
    } else {
      return 'api';
    }
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();
    
    try {
      const messages = options.messages || [
        { role: "system", content: options.systemPrompt || "You are a helpful AI assistant." },
        { role: "user", content: prompt }
      ];

      const completion = await retryOperation(() => 
        this.client.chat.completions.create({
          model: options.model || this.models.chat,
          messages,
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 1000,
          stream: options.stream || false,
          ...options.additionalParams
        }), { retries: 3 }
      );

      const responseTime = Date.now() - startTime;
      const response = completion.choices[0].message.content;

      // Pass full usage object with model info
      await this.updateMetrics(responseTime, { 
        ...completion.usage,
        model: completion.model 
      });

      return {
        content: response,
        model: completion.model,
        usage: completion.usage,
        provider: this.name
      };
    } catch (error) {
      const errorCategory = this.categorizeError(error);
      this.metrics.errors++;
      logger.error(`Gab generateResponse error [${errorCategory}]:`, error);
      throw error;
    }
  }

  async generateEmbedding(text) {
    logger.warn("Gab provider embeddings support is not confirmed");
    const startTime = Date.now();
    
    try {
      const response = await retryOperation(() => 
        this.client.embeddings.create({
          model: "text-embedding-ada-002",
          input: text
        }), { retries: 3 }
      );

      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
        model: "text-embedding-ada-002",
        requestType: 'embedding'
      });

      return response.data[0].embedding;
    } catch (error) {
      const errorCategory = this.categorizeError(error);
      this.metrics.errors++;
      logger.warn(`Gab does not support embeddings [${errorCategory}]:`, error.message);
      return null;
    }
  }

  async transcribeAudio(audioBuffer) {
    logger.warn("Gab provider does not support audio transcription");
    return null;
  }

  async generateSpeech(text, options = {}) {
    logger.warn("Gab provider does not support speech generation");
    return null;
  }

  async analyzeImage(imageBuffer, prompt) {
    const startTime = Date.now();
    
    try {
      const base64Image = imageBuffer.toString("base64");
      
      const response = await retryOperation(() => 
        this.client.chat.completions.create({
          model: this.models.chat,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt || "What is in this image?" },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
              ]
            }
          ],
          max_tokens: 1000
        }), { retries: 3 }
      );

      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, {
        ...response.usage,
        model: response.model,
        requestType: 'vision'
      });

      return {
        description: response.choices[0].message.content,
        model: response.model,
        usage: response.usage
      };
    } catch (error) {
      const errorCategory = this.categorizeError(error);
      this.metrics.errors++;
      logger.warn(`Gab image analysis failed, may not be supported [${errorCategory}]:`, error.message);
      throw error;
    }
  }
}
