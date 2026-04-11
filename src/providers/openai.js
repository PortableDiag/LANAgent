import OpenAI from "openai";
import { BaseProvider } from "./BaseProvider.js";
import { logger } from "../utils/logger.js";

export class OpenAIProvider extends BaseProvider {
  constructor(config = {}) {
    super("OpenAI", config);
    this.client = null;
    this.models = {
      chat: config.chatModel || config.model || "gpt-5.2-chat-latest",
      embedding: config.embeddingModel || "text-embedding-3-small",
      tts: config.ttsModel || "tts-1",
      whisper: config.whisperModel || "whisper-1",
      vision: config.visionModel || "gpt-5.2-chat-latest"
    };
  }

  async initialize() {
    try {
      const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key not found");
      }

      this.client = new OpenAI({ apiKey });
      
      // Define cost calculation
      this.calculateCost = (metrics) => {
        // OpenAI pricing per 1K tokens (December 2025) - Standard tier
        const pricing = {
          'gpt-5.2': { input: 0.00175, output: 0.014 },
          'gpt-5.2-chat-latest': { input: 0.00175, output: 0.014 },
          'gpt-5.2-pro': { input: 0.021, output: 0.168 },
          'gpt-5.1': { input: 0.00125, output: 0.01 },
          'gpt-5.1-chat-latest': { input: 0.00125, output: 0.01 },
          'gpt-5.1-codex-max': { input: 0.00125, output: 0.01 },
          'gpt-5.1-codex': { input: 0.00125, output: 0.01 },
          'gpt-5': { input: 0.00125, output: 0.01 },
          'gpt-5-chat-latest': { input: 0.00125, output: 0.01 },
          'gpt-5-codex': { input: 0.00125, output: 0.01 },
          'gpt-5-mini': { input: 0.00025, output: 0.002 },
          'gpt-5-nano': { input: 0.00005, output: 0.0004 },
          'gpt-5-pro': { input: 0.015, output: 0.12 },
          'gpt-4.1': { input: 0.002, output: 0.008 },
          'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
          'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
          'gpt-4o': { input: 0.0025, output: 0.01 },
          'gpt-4o-2024-05-13': { input: 0.005, output: 0.015 },
          'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
          'gpt-4o-realtime-preview': { input: 0.005, output: 0.02 },
          'gpt-4o-mini-realtime-preview': { input: 0.0006, output: 0.0024 },
          'gpt-realtime': { input: 0.004, output: 0.016 },
          'gpt-realtime-mini': { input: 0.0006, output: 0.0024 },
          'gpt-audio': { input: 0.0025, output: 0.01 },
          'gpt-audio-mini': { input: 0.0006, output: 0.0024 },
          'gpt-4o-audio-preview': { input: 0.0025, output: 0.01 },
          'gpt-4o-mini-audio-preview': { input: 0.00015, output: 0.0006 },
          'o1': { input: 0.015, output: 0.06 },
          'o1-pro': { input: 0.15, output: 0.6 },
          'o1-mini': { input: 0.0011, output: 0.0044 },
          'o3': { input: 0.002, output: 0.008 },
          'o3-pro': { input: 0.02, output: 0.08 },
          'o3-mini': { input: 0.0011, output: 0.0044 },
          'o3-deep-research': { input: 0.01, output: 0.04 },
          'o4-mini': { input: 0.0011, output: 0.0044 },
          'o4-mini-deep-research': { input: 0.002, output: 0.008 },
          'computer-use-preview': { input: 0.003, output: 0.012 },
          'gpt-image-1.5': { input: 0.005, output: 0.01 },
          'chatgpt-image-latest': { input: 0.005, output: 0.01 },
          'gpt-image-1': { input: 0.005, output: null },
          'gpt-image-1-mini': { input: 0.002, output: null },
          // Legacy models
          'gpt-4-turbo': { input: 0.01, output: 0.03 },
          'gpt-4': { input: 0.03, output: 0.06 },
          'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
          'chatgpt-4o-latest': { input: 0.005, output: 0.015 }
        };
        
        let totalCost = 0;
        for (const [model, usage] of Object.entries(metrics.tokensByModel)) {
          // Try exact match first, then try base model name
          let price = pricing[model];
          if (!price) {
            const modelBase = model.split('-').slice(0, 2).join('-');
            price = pricing[modelBase];
          }
          // Default fallback to gpt-4o-mini (most common/affordable)
          if (!price) {
            price = pricing['gpt-4o-mini'];
          }
          
          totalCost += (usage.input / 1000) * price.input;
          if (price.output && usage.output) {
            totalCost += (usage.output / 1000) * price.output;
          }
        }
        
        return totalCost;
      };
      
      await super.initialize();
      logger.info("OpenAI provider initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize OpenAI provider:", error);
      throw error;
    }
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();

    try {
      const messages = options.messages || [
        { role: "system", content: options.systemPrompt || "You are a helpful AI assistant." },
        { role: "user", content: prompt }
      ];

      // Use max_completion_tokens for GPT-5 models, max_tokens for others
      const model = options.model || this.models.chat;
      const isGPT5Model = model.includes('gpt-5') || model.includes('o1') || model.includes('o3') || model.includes('o4');

      // Check if web search is requested
      const enableWebSearch = options.enableWebSearch === true;

      // Use Responses API with web search if enabled
      if (enableWebSearch) {
        return await this.generateResponseWithWebSearch(prompt, options, startTime);
      }

      const completionParams = {
        model,
        messages,
        stream: options.stream || false,
        ...options.additionalParams
      };

      // GPT-5 models only support temperature = 1 (default), don't include it
      if (!isGPT5Model) {
        completionParams.temperature = options.temperature || 0.7;
      }

      // Set appropriate token limit parameter based on model
      if (isGPT5Model) {
        completionParams.max_completion_tokens = options.maxTokens || 1000;
      } else {
        completionParams.max_tokens = options.maxTokens || 1000;
      }

      const completion = await this.client.chat.completions.create(completionParams);

      const responseTime = Date.now() - startTime;
      const response = completion.choices[0].message.content;

      // Log actual model used for debugging
      logger.info(`OpenAI API call used model: ${completion.model} (requested: ${model})`);

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
      logger.error("OpenAI generateResponse error:", error);
      throw error;
    }
  }

  async generateStreamingResponse(prompt, options = {}, onChunk) {
    const startTime = Date.now();
    try {
      const messages = options.messages || [
        { role: "system", content: options.systemPrompt || "You are a helpful AI assistant." },
        { role: "user", content: prompt }
      ];
      const model = options.model || this.models.chat;
      const isGPT5Model = model.includes('gpt-5') || model.includes('o1') || model.includes('o3') || model.includes('o4');

      const completionParams = { model, messages, stream: true, ...options.additionalParams };
      if (!isGPT5Model) completionParams.temperature = options.temperature || 0.7;
      if (isGPT5Model) {
        completionParams.max_completion_tokens = options.maxTokens || 1000;
      } else {
        completionParams.max_tokens = options.maxTokens || 1000;
      }

      const stream = await this.client.chat.completions.create(completionParams);
      let fullContent = '';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;
          if (onChunk) {
            try { await onChunk(delta, fullContent); } catch (e) { /* ignore callback errors */ }
          }
        }
      }

      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, { model });

      return { content: fullContent, model, provider: this.name };
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenAI generateStreamingResponse error:", error);
      throw error;
    }
  }

  async generateResponseWithWebSearch(prompt, options, startTime) {
    try {
      const model = options.model || this.models.chat;
      const maxSearches = options.maxSearches || 5;

      logger.info(`OpenAI web search enabled with max_uses: ${maxSearches}`);

      // Use the Responses API with web_search_preview tool
      const response = await this.client.responses.create({
        model: model,
        tools: [{
          type: "web_search_preview",
          search_context_size: options.searchContextSize || "medium",
          user_location: options.userLocation || undefined
        }],
        input: prompt,
        instructions: options.systemPrompt || "You are a helpful AI assistant. Use web search to find current, accurate information.",
        ...options.additionalParams
      });

      const responseTime = Date.now() - startTime;

      // Extract text content from response
      let textContent = '';
      let webSearchCount = 0;

      if (response.output) {
        for (const item of response.output) {
          if (item.type === 'message' && item.content) {
            for (const content of item.content) {
              if (content.type === 'output_text') {
                textContent += content.text;
              }
            }
          } else if (item.type === 'web_search_call') {
            webSearchCount++;
          }
        }
      }

      if (webSearchCount > 0) {
        logger.info(`OpenAI performed ${webSearchCount} web searches`);
      }

      // Log actual model used
      logger.info(`OpenAI API call used model: ${response.model} (requested: ${model})`);

      // Update metrics
      await this.updateMetrics(responseTime, {
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0,
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0,
        model: response.model
      });

      return {
        content: textContent,
        model: response.model,
        usage: response.usage,
        provider: this.name,
        webSearchUsed: webSearchCount > 0
      };
    } catch (error) {
      // If Responses API fails, fall back to standard completion without web search
      logger.warn(`OpenAI web search failed, falling back to standard completion: ${error.message}`);

      const model = options.model || this.models.chat;
      const isGPT5Model = model.includes('gpt-5') || model.includes('o1') || model.includes('o3') || model.includes('o4');

      const messages = options.messages || [
        { role: "system", content: options.systemPrompt || "You are a helpful AI assistant." },
        { role: "user", content: prompt }
      ];

      const completionParams = {
        model,
        messages,
        stream: false
      };

      if (!isGPT5Model) {
        completionParams.temperature = options.temperature || 0.7;
      }

      if (isGPT5Model) {
        completionParams.max_completion_tokens = options.maxTokens || 1000;
      } else {
        completionParams.max_tokens = options.maxTokens || 1000;
      }

      const completion = await this.client.chat.completions.create(completionParams);
      const responseTime = Date.now() - startTime;

      await this.updateMetrics(responseTime, {
        ...completion.usage,
        model: completion.model
      });

      return {
        content: completion.choices[0].message.content,
        model: completion.model,
        usage: completion.usage,
        provider: this.name,
        webSearchUsed: false
      };
    }
  }

  async generateEmbedding(text) {
    const startTime = Date.now();
    
    // Validate input
    if (!text || typeof text !== 'string' || text.trim() === '') {
      logger.warn('OpenAI generateEmbedding called with invalid input:', text);
      throw new Error('Input text for embedding must be a non-empty string');
    }
    
    try {
      const response = await this.client.embeddings.create({
        model: this.models.embedding,
        input: text.trim()
      });

      // Update metrics for embedding generation
      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
        model: this.models.embedding,
        requestType: 'embedding'
      });

      return response.data[0].embedding;
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenAI generateEmbedding error:", error);
      throw error;
    }
  }

  async transcribeAudio(audioBuffer) {
    const startTime = Date.now();
    
    try {
      const file = new File([audioBuffer], "audio.ogg", { type: "audio/ogg" });
      
      const transcription = await this.client.audio.transcriptions.create({
        model: this.models.whisper,
        file,
        response_format: "text"
      });

      // Update metrics for audio transcription
      const responseTime = Date.now() - startTime;
      // Estimate tokens based on audio duration and transcription length
      // Whisper pricing is per second of audio, but we track as tokens for consistency
      const estimatedTokens = Math.ceil(transcription.length / 4); // Rough estimate: 4 chars per token
      await this.updateMetrics(responseTime, {
        prompt_tokens: estimatedTokens,
        total_tokens: estimatedTokens,
        model: this.models.whisper,
        requestType: 'audio'
      });

      return transcription;
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenAI transcribeAudio error:", error);
      throw error;
    }
  }

  async generateSpeech(text, options = {}) {
    const startTime = Date.now();
    
    try {
      const response = await this.client.audio.speech.create({
        model: options.model || this.models.tts,
        voice: options.voice || "nova",
        input: text,
        response_format: options.format || "mp3",
        speed: options.speed || 1.0
      });

      const buffer = Buffer.from(await response.arrayBuffer());
      
      // Update metrics for speech generation
      const responseTime = Date.now() - startTime;
      // TTS pricing is per character, but we track as tokens for consistency
      const estimatedTokens = Math.ceil(text.length / 4); // Rough estimate: 4 chars per token
      await this.updateMetrics(responseTime, {
        prompt_tokens: estimatedTokens,
        total_tokens: estimatedTokens,
        model: options.model || this.models.tts,
        requestType: 'tts'
      });
      
      return buffer;
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenAI generateSpeech error:", error);
      throw error;
    }
  }

  async analyzeImage(imageBuffer, prompt) {
    const startTime = Date.now();
    
    try {
      const base64Image = imageBuffer.toString("base64");
      
      const model = this.models.vision;
      const isGPT5Model = model.includes('gpt-5') || model.includes('o1');
      
      const completionParams = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt || "What is in this image?" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }
        ]
      };
      
      // Set appropriate token limit parameter based on model
      if (isGPT5Model) {
        completionParams.max_completion_tokens = 1000;
      } else {
        completionParams.max_tokens = 1000;
      }
      
      const response = await this.client.chat.completions.create(completionParams);

      // Update metrics for image analysis
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
      logger.error("OpenAI analyzeImage error:", error);
      throw error;
    }
  }

  async generateImage(prompt, options = {}) {
    const startTime = Date.now();

    try {
      const model = options.model || 'gpt-image-1';
      const size = options.size || '1024x1024';
      const quality = options.quality || 'auto';
      const n = options.n || 1;

      // Build request parameters - gpt-image models don't support response_format
      const requestParams = {
        model,
        prompt,
        n,
        size
      };

      // Only add response_format for DALL-E models (not gpt-image-*)
      if (!model.startsWith('gpt-image')) {
        requestParams.response_format = 'b64_json';
      }

      // Add quality for models that support it
      if (model === 'dall-e-3' || model.startsWith('gpt-image')) {
        requestParams.quality = quality;
      }

      const response = await this.client.images.generate(requestParams);

      // Handle different response formats
      const images = [];
      for (const img of response.data) {
        if (img.b64_json) {
          images.push({
            base64: img.b64_json,
            buffer: Buffer.from(img.b64_json, 'base64')
          });
        } else if (img.url) {
          // For gpt-image models that return URLs, fetch the image
          try {
            const imageResponse = await fetch(img.url);
            const arrayBuffer = await imageResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const base64 = buffer.toString('base64');
            images.push({
              base64,
              buffer,
              url: img.url
            });
          } catch (fetchError) {
            logger.warn('Failed to fetch image from URL, returning URL only:', fetchError.message);
            images.push({
              url: img.url,
              base64: null,
              buffer: null
            });
          }
        }
      }

      // Calculate image generation cost (per-image pricing)
      const imageCost = this.calculateImageCost(model, size, quality, n);

      // Update metrics for image generation
      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, {
        prompt_tokens: 0,
        total_tokens: 0,
        model,
        requestType: 'image',
        directCost: imageCost,
        metadata: { size, quality, count: n }
      });

      logger.info(`OpenAI image generated using model: ${model}, cost: $${imageCost.toFixed(4)}`);

      return {
        success: true,
        images,
        model,
        cost: imageCost,
        usage: { images: n, size, quality }
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenAI generateImage error:", error);
      throw error;
    }
  }

  /**
   * Calculate cost for image generation based on model, size, and quality
   * OpenAI pricing as of January 2026
   */
  calculateImageCost(model, size, quality, count = 1) {
    // Per-image pricing by model and size
    const pricing = {
      'gpt-image-1': {
        '1024x1024': 0.04,
        '1792x1024': 0.08,
        '1024x1792': 0.08,
        '512x512': 0.02,
        '256x256': 0.01
      },
      'gpt-image-1.5': {
        '1024x1024': 0.06,
        '1792x1024': 0.12,
        '1024x1792': 0.12,
        '512x512': 0.03,
        '256x256': 0.015
      },
      'dall-e-3': {
        '1024x1024': 0.04,
        '1792x1024': 0.08,
        '1024x1792': 0.08
      },
      'dall-e-2': {
        '1024x1024': 0.02,
        '512x512': 0.018,
        '256x256': 0.016
      }
    };

    const modelPricing = pricing[model] || pricing['gpt-image-1'];
    const baseCost = modelPricing[size] || modelPricing['1024x1024'] || 0.04;

    // Apply quality multiplier for high quality
    let qualityMultiplier = 1.0;
    if (quality === 'high' || quality === 'hd') {
      qualityMultiplier = 1.5;
    }

    return baseCost * qualityMultiplier * count;
  }

  async generateVideo(prompt, options = {}) {
    const startTime = Date.now();

    try {
      const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
      const model = options.model || 'sora-2';
      const size = options.size || '1280x720';
      const duration = String(options.duration || '8');

      // OpenAI Sora API - POST /v1/videos
      const response = await fetch('https://api.openai.com/v1/videos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          prompt,
          size,
          seconds: duration
        })
      });

      if (!response.ok) {
        let errorMsg = `Video API error: ${response.status}`;
        try {
          const errorData = await response.json();
          errorMsg = errorData.error?.message || errorMsg;
        } catch { /* non-JSON error body */ }
        throw new Error(errorMsg);
      }

      const result = await response.json();

      // Calculate video generation cost (per-second pricing)
      const videoCost = this.calculateVideoCost(model, size, duration, 'standard');

      // Update metrics for video generation request
      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, {
        prompt_tokens: 0,
        total_tokens: 0,
        model,
        requestType: 'video',
        directCost: videoCost,
        metadata: { size, duration }
      });

      logger.info(`OpenAI video job submitted: ${result.id}, status: ${result.status}, cost: $${videoCost.toFixed(4)}`);

      // Return job info - caller will poll for completion
      return {
        success: true,
        jobId: result.id,
        status: result.status,
        model: result.model || model,
        progress: result.progress || 0,
        cost: videoCost
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenAI generateVideo error:", error);
      throw error;
    }
  }

  /**
   * Calculate cost for video generation based on model, resolution, duration, and quality
   * OpenAI Sora pricing as of January 2026
   */
  calculateVideoCost(model, size, durationSeconds, quality) {
    // Per-second pricing by model and resolution
    const pricing = {
      'sora-2': {
        '1080p': { standard: 0.20, high: 0.40 },
        '720p': { standard: 0.15, high: 0.30 },
        '480p': { standard: 0.10, high: 0.20 },
        // Size-based fallbacks
        '1920x1080': { standard: 0.20, high: 0.40 },
        '1024x1792': { standard: 0.20, high: 0.40 },
        '1792x1024': { standard: 0.20, high: 0.40 },
        '1024x1024': { standard: 0.15, high: 0.30 }
      }
    };

    const modelPricing = pricing[model] || pricing['sora-2'];
    const sizePricing = modelPricing[size] || modelPricing['1080p'] || { standard: 0.20, high: 0.40 };
    const qualityKey = quality === 'high' ? 'high' : 'standard';
    const perSecondCost = sizePricing[qualityKey] || 0.20;

    return perSecondCost * durationSeconds;
  }

  async getVideoStatus(jobId) {
    try {
      const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;

      const response = await fetch(`https://api.openai.com/v1/videos/${jobId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `Video status error: ${response.status}`);
      }

      const result = await response.json();

      return {
        success: true,
        jobId: result.id,
        status: result.status,
        progress: result.progress,
        // Sora API: download via GET /v1/videos/{id}/content, not a URL field
        url: result.status === 'completed' ? `https://api.openai.com/v1/videos/${result.id}/content` : null,
        model: result.model
      };
    } catch (error) {
      logger.error("OpenAI getVideoStatus error:", error);
      throw error;
    }
  }

  async downloadVideo(url) {
    try {
      const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer;
    } catch (error) {
      logger.error("OpenAI downloadVideo error:", error);
      throw error;
    }
  }
}