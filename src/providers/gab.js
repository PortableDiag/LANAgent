import OpenAI from "openai";
import { BaseProvider } from "./BaseProvider.js";
import { logger } from "../utils/logger.js";

export class GabProvider extends BaseProvider {
  constructor(config = {}) {
    super("Gab", config);
    this.client = null;
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
   * Retry logic with exponential backoff for API requests
   * @param {Function} fn - The function to execute with retry
   * @param {number} retries - Number of retry attempts
   * @param {number} delay - Initial delay in milliseconds
   * @returns {Promise<any>}
   */
  async retryWithExponentialBackoff(fn, retries = 3, delay = 1000) {
    try {
      return await fn();
    } catch (error) {
      if (retries > 0) {
        logger.warn(`Retrying after error: ${error.message}. Attempts left: ${retries}`);
        await new Promise(res => setTimeout(res, delay));
        return this.retryWithExponentialBackoff(fn, retries - 1, delay * 2);
      } else {
        logger.error("Max retries reached. Throwing error.");
        throw error;
      }
    }
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();
    
    try {
      const messages = options.messages || [
        { role: "system", content: options.systemPrompt || "You are a helpful AI assistant." },
        { role: "user", content: prompt }
      ];

      const completion = await this.retryWithExponentialBackoff(() => 
        this.client.chat.completions.create({
          model: options.model || this.models.chat,
          messages,
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 1000,
          stream: options.stream || false,
          ...options.additionalParams
        })
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
      this.metrics.errors++;
      logger.error("Gab generateResponse error:", error);
      throw error;
    }
  }

  async generateEmbedding(text) {
    logger.warn("Gab provider embeddings support is not confirmed");
    const startTime = Date.now();
    
    try {
      const response = await this.retryWithExponentialBackoff(() => 
        this.client.embeddings.create({
          model: "text-embedding-ada-002",
          input: text
        })
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
      this.metrics.errors++;
      logger.warn("Gab does not support embeddings:", error.message);
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
      
      const response = await this.retryWithExponentialBackoff(() => 
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
        })
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
      this.metrics.errors++;
      logger.warn("Gab image analysis failed, may not be supported:", error.message);
      throw error;
    }
  }
}