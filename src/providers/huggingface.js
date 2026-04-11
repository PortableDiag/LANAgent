import { InferenceClient } from "@huggingface/inference";
import { BaseProvider } from "./BaseProvider.js";
import { logger } from "../utils/logger.js";

export class HuggingFaceProvider extends BaseProvider {
  constructor(config = {}) {
    super("HuggingFace", config);
    this.client = null;
    this.models = {
      chat: config.chatModel || "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      embedding: config.embeddingModel || "sentence-transformers/all-MiniLM-L6-v2",
      vision: config.visionModel || "Salesforce/blip-image-captioning-large",
      whisper: config.whisperModel || "openai/whisper-large-v3",
      summarization: config.summarizationModel || "facebook/bart-large-cnn",
      translation: config.translationModel || "Helsinki-NLP/opus-mt-en-es"
    };
    
    // Provider selection policies
    this.providerPolicies = {
      fastest: ":fastest",
      cheapest: ":cheapest",
      default: ""
    };
    
    // Model-specific parameters
    this.modelParams = {
      chat: {
        temperature: config.chatTemperature || 0.7,
        maxTokens: config.chatMaxTokens || 1000,
        topP: config.chatTopP || 0.95,
        repetitionPenalty: config.chatRepetitionPenalty || 1.1,
        stopSequences: config.chatStopSequences || []
      },
      summarization: {
        maxLength: config.summarizationMaxLength || 150,
        minLength: config.summarizationMinLength || 30,
        doSample: config.summarizationDoSample !== false
      }
    };
  }

  async initialize() {
    try {
      const apiKey = this.config.apiKey || process.env.HUGGINGFACE_TOKEN;
      if (!apiKey) {
        throw new Error("HuggingFace API token not found");
      }

      // Store API key for direct API calls
      this.apiKey = apiKey;
      this.baseUrl = "https://router.huggingface.co/v1";

      // Initialize InferenceClient for image/video generation
      this.inferenceClient = new InferenceClient(apiKey);
      
      // Define cost calculation for HuggingFace
      this.calculateCost = (metrics) => {
        // HuggingFace pricing varies by model and usage type
        // Updated pricing to reflect actual usage patterns and model costs
        const pricing = {
          'openai/gpt-oss': { input: 0.0001, output: 0.0002 },
          'sentence-transformers': { input: 0.00001, output: 0 }, // Usually free tier
          'whisper': { input: 0.0006, output: 0 }, // Per minute of audio
          'Qwen': { input: 0.0002, output: 0.0004 }, // Updated for Qwen models
          'meta-llama': { input: 0.00015, output: 0.0003 },
          'deepseek-ai': { input: 0.00018, output: 0.00035 },
          'moonshotai': { input: 0.0002, output: 0.0004 },
          'zai-org': { input: 0.00016, output: 0.00032 },
          'MiniMaxAI': { input: 0.00015, output: 0.0003 },
          'agentica-org': { input: 0.0003, output: 0.0006 },
          'microsoft': { input: 0.00012, output: 0.00024 },
          'google': { input: 0.00025, output: 0.0005 },
          'facebook': { input: 0.00008, output: 0.00016 },
          'default': { input: 0.0002, output: 0.0004 } // Updated default to realistic pricing
        };
        
        let totalCost = 0;
        for (const [model, usage] of Object.entries(metrics.tokensByModel)) {
          const modelBase = model.split('/')[0];
          const price = pricing[modelBase] || pricing['default'];
          totalCost += (usage.input / 1000) * price.input;
          totalCost += (usage.output / 1000) * price.output;
        }
        
        return totalCost;
      };
      
      await super.initialize();
      logger.info("HuggingFace provider initialized successfully");
      logger.info("Available models:", this.models);
      logger.info("Model parameters:", this.modelParams);
    } catch (error) {
      logger.error("Failed to initialize HuggingFace provider:", error);
      throw error;
    }
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();
    
    try {
      // Build messages array
      const messages = options.messages || [
        { role: "system", content: options.systemPrompt || "You are a helpful AI assistant." },
        { role: "user", content: prompt }
      ];

      // Apply provider policy to model if specified
      const model = options.model || this.models.chat;
      const modelWithPolicy = options.providerPolicy ? 
        model.replace(/:.*$/, '') + this.providerPolicies[options.providerPolicy] : 
        model;

      // Make direct API call to HuggingFace router
      const requestBody = {
        model: modelWithPolicy,
        messages,
        temperature: options.temperature || this.modelParams.chat.temperature,
        max_tokens: options.maxTokens || this.modelParams.chat.maxTokens,
        top_p: options.topP || this.modelParams.chat.topP,
        stream: false,
        ...options.additionalParams
      };

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HuggingFace API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const completion = await response.json();
      const responseTime = Date.now() - startTime;
      const content = completion.choices[0].message.content;

      // Update metrics with usage info
      const usage = completion.usage || {
        prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
        completion_tokens: Math.ceil(content.length / 4),
        total_tokens: Math.ceil((JSON.stringify(messages).length + content.length) / 4)
      };

      await this.updateMetrics(responseTime, { 
        ...usage,
        model: modelWithPolicy 
      });

      return {
        content,
        model: modelWithPolicy,
        usage,
        provider: this.name
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace generateResponse error:", error);
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

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature || this.modelParams.chat.temperature,
          max_tokens: options.maxTokens || this.modelParams.chat.maxTokens,
          top_p: options.topP || this.modelParams.chat.topP,
          stream: true,
          ...options.additionalParams
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HuggingFace streaming error: ${response.status} - ${errorText}`);
      }

      let fullContent = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullContent += delta;
              if (onChunk) {
                try { await onChunk(delta, fullContent); } catch (e) { /* ignore */ }
              }
            }
          } catch (e) { /* skip malformed SSE lines */ }
        }
      }

      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, { model });
      return { content: fullContent, model, provider: this.name };
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace generateStreamingResponse error:", error);
      throw error;
    }
  }

  async generateEmbedding(text) {
    const startTime = Date.now();
    
    try {
      // Use feature extraction for embeddings
      const embeddings = await this.client.featureExtraction({
        model: this.models.embedding,
        inputs: text
      });

      // Update metrics for embedding generation
      const responseTime = Date.now() - startTime;
      // Estimate tokens for embeddings based on text length
      const estimatedTokens = Math.ceil(text.length / 4);
      await this.updateMetrics(responseTime, {
        prompt_tokens: estimatedTokens,
        total_tokens: estimatedTokens,
        model: this.models.embedding,
        requestType: 'embedding'
      });

      // HuggingFace returns embeddings in different formats depending on model
      // Handle both array and nested array responses
      if (Array.isArray(embeddings[0])) {
        // For sentence transformers, we might get [CLS] token embedding
        return embeddings[0];
      } else if (Array.isArray(embeddings)) {
        return embeddings;
      } else {
        throw new Error("Unexpected embedding format");
      }
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace generateEmbedding error:", error);
      throw error;
    }
  }

  async transcribeAudio(audioBuffer) {
    const startTime = Date.now();
    
    try {
      // HuggingFace automatic speech recognition
      const result = await this.client.automaticSpeechRecognition({
        model: this.models.whisper,
        data: audioBuffer
      });

      // Update metrics for transcription
      const responseTime = Date.now() - startTime;
      // Estimate tokens based on result text length
      const estimatedTokens = Math.ceil(result.text.length / 4);
      await this.updateMetrics(responseTime, {
        prompt_tokens: estimatedTokens,
        total_tokens: estimatedTokens,
        model: this.models.whisper,
        requestType: 'audio'
      });

      return result.text;
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace transcribeAudio error:", error);
      throw error;
    }
  }

  async generateSpeech(text, options = {}) {
    const startTime = Date.now();
    
    try {
      // HuggingFace text-to-speech
      const model = options.model || "microsoft/speecht5_tts";
      const audioData = await this.client.textToSpeech({
        model,
        inputs: text,
        parameters: {
          vocoder: "microsoft/speecht5_hifigan"
        }
      });

      // Update metrics for TTS
      const responseTime = Date.now() - startTime;
      const estimatedTokens = Math.ceil(text.length / 4);
      await this.updateMetrics(responseTime, {
        prompt_tokens: estimatedTokens,
        total_tokens: estimatedTokens,
        model,
        requestType: 'tts'
      });

      // Convert to Buffer if needed
      if (audioData instanceof ArrayBuffer) {
        return Buffer.from(audioData);
      } else if (audioData instanceof Blob) {
        const arrayBuffer = await audioData.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
      
      return audioData;
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace generateSpeech error:", error);
      throw error;
    }
  }

  async analyzeImage(imageBuffer, prompt) {
    const startTime = Date.now();
    
    try {
      // HuggingFace visual question answering or image captioning
      let result;
      let model;
      
      if (prompt && prompt !== "What is in this image?") {
        // Use visual question answering if a specific question is asked
        model = "dandelin/vilt-b32-finetuned-vqa";
        result = await this.client.visualQuestionAnswering({
          model,
          inputs: {
            image: imageBuffer,
            question: prompt
          }
        });

        // Update metrics for VQA
        const responseTime = Date.now() - startTime;
        const estimatedTokens = Math.ceil((prompt.length + result.answer.length) / 4);
        await this.updateMetrics(responseTime, {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(result.answer.length / 4),
          total_tokens: estimatedTokens,
          model,
          requestType: 'vision'
        });

        return {
          description: result.answer,
          model,
          confidence: result.score
        };
      } else {
        // Use image captioning for general descriptions
        model = this.models.vision;
        result = await this.client.imageToText({
          model,
          data: imageBuffer
        });

        // Handle different response formats
        const description = Array.isArray(result) ? 
          result.map(r => r.generated_text).join(". ") : 
          result.generated_text;

        // Update metrics for captioning
        const responseTime = Date.now() - startTime;
        const estimatedTokens = Math.ceil(description.length / 4);
        await this.updateMetrics(responseTime, {
          prompt_tokens: 10, // Rough estimate for image "prompt"
          completion_tokens: estimatedTokens,
          total_tokens: estimatedTokens + 10,
          model,
          requestType: 'vision'
        });

        return {
          description,
          model
        };
      }
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace analyzeImage error:", error);
      throw error;
    }
  }

  // Additional HuggingFace-specific methods
  async summarize(text, options = {}) {
    const startTime = Date.now();
    
    try {
      const model = options.model || this.models.summarization;
      const result = await this.client.summarization({
        model,
        inputs: text,
        parameters: {
          max_length: options.maxLength || this.modelParams.summarization.maxLength,
          min_length: options.minLength || this.modelParams.summarization.minLength,
          do_sample: options.doSample !== undefined ? options.doSample : this.modelParams.summarization.doSample
        }
      });

      // Update metrics for summarization
      const responseTime = Date.now() - startTime;
      const inputTokens = Math.ceil(text.length / 4);
      const outputTokens = Math.ceil(result.summary_text.length / 4);
      await this.updateMetrics(responseTime, {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        model,
        requestType: 'summarization'
      });

      return result.summary_text;
    } catch (error) {
      logger.error("HuggingFace summarization error:", error);
      throw error;
    }
  }

  async translate(text, options = {}) {
    const startTime = Date.now();
    
    try {
      const model = options.model || this.models.translation;
      const result = await this.client.translation({
        model,
        inputs: text
      });

      // Update metrics for translation
      const responseTime = Date.now() - startTime;
      const inputTokens = Math.ceil(text.length / 4);
      const outputTokens = Math.ceil(result.translation_text.length / 4);
      await this.updateMetrics(responseTime, {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        model,
        requestType: 'translation'
      });

      return result.translation_text;
    } catch (error) {
      logger.error("HuggingFace translation error:", error);
      throw error;
    }
  }

  async classifyText(text, options = {}) {
    const startTime = Date.now();
    
    try {
      const model = options.model || "distilbert-base-uncased-finetuned-sst-2-english";
      const result = await this.client.textClassification({
        model,
        inputs: text
      });

      // Update metrics for classification
      const responseTime = Date.now() - startTime;
      const estimatedTokens = Math.ceil(text.length / 4);
      await this.updateMetrics(responseTime, {
        prompt_tokens: estimatedTokens,
        total_tokens: estimatedTokens,
        model,
        requestType: 'classification'
      });

      return result;
    } catch (error) {
      logger.error("HuggingFace text classification error:", error);
      throw error;
    }
  }

  async generateImage(prompt, options = {}) {
    const startTime = Date.now();

    try {
      const model = options.model || 'black-forest-labs/FLUX.1-schnell';
      const numInferenceSteps = options.numInferenceSteps || 5;

      logger.info(`HuggingFace generating image with model: ${model}`);

      const blob = await this.inferenceClient.textToImage({
        provider: options.provider || 'auto',
        model,
        inputs: prompt,
        parameters: {
          num_inference_steps: numInferenceSteps
        }
      });

      // Convert blob to buffer
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Calculate image generation cost
      const imageCost = this.calculateImageCost(model, numInferenceSteps);
      const responseTime = Date.now() - startTime;

      // Update metrics for image generation
      await this.updateMetrics(responseTime, {
        prompt_tokens: 0,
        total_tokens: 0,
        model,
        requestType: 'image',
        directCost: imageCost,
        metadata: { numInferenceSteps }
      });

      logger.info(`HuggingFace image generated successfully (${buffer.length} bytes), cost: $${imageCost.toFixed(4)}`);

      return {
        success: true,
        images: [{
          buffer,
          blob
        }],
        model,
        cost: imageCost
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace generateImage error:", error);
      throw error;
    }
  }

  /**
   * Calculate cost for HuggingFace image generation
   * Pricing varies by model and inference provider
   */
  calculateImageCost(model, numInferenceSteps = 5) {
    // HuggingFace Inference API pricing (estimated based on compute)
    const pricing = {
      'black-forest-labs/FLUX.1-schnell': 0.003, // Fast model, lower cost
      'black-forest-labs/FLUX.1-dev': 0.01,      // Dev model, higher quality
      'stabilityai/stable-diffusion-3-medium': 0.008,
      'stabilityai/stable-diffusion-xl-base-1.0': 0.005
    };

    const baseCost = pricing[model] || 0.005;
    // Scale cost slightly with inference steps (more steps = more compute)
    const stepMultiplier = Math.min(numInferenceSteps / 5, 3);

    return baseCost * stepMultiplier;
  }

  async generateVideo(prompt, options = {}) {
    const startTime = Date.now();

    try {
      const model = options.model || 'Wan-AI/Wan2.1-T2V-14B';

      logger.info(`HuggingFace generating video with model: ${model}`);

      const blob = await this.inferenceClient.textToVideo({
        provider: options.provider || 'auto',
        model,
        inputs: prompt
      });

      // Convert blob to buffer
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Calculate video generation cost
      const videoCost = this.calculateVideoCost(model);
      const responseTime = Date.now() - startTime;

      // Update metrics for video generation
      await this.updateMetrics(responseTime, {
        prompt_tokens: 0,
        total_tokens: 0,
        model,
        requestType: 'video',
        directCost: videoCost,
        metadata: {}
      });

      logger.info(`HuggingFace video generated successfully (${buffer.length} bytes), cost: $${videoCost.toFixed(4)}`);

      return {
        success: true,
        video: {
          buffer,
          blob
        },
        model,
        cost: videoCost
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("HuggingFace generateVideo error:", error);
      throw error;
    }
  }

  /**
   * Calculate cost for HuggingFace video generation
   */
  calculateVideoCost(model) {
    // HuggingFace video generation pricing (estimated)
    const pricing = {
      'Wan-AI/Wan2.1-T2V-14B': 0.05  // Per generation cost
    };

    return pricing[model] || 0.05;
  }

  // Get current configuration
  getConfiguration() {
    return {
      models: this.models,
      modelParams: this.modelParams,
      providerPolicies: this.providerPolicies
    };
  }

  // Update model configuration
  updateConfiguration(config = {}) {
    if (config.models) {
      Object.assign(this.models, config.models);
    }
    
    if (config.modelParams) {
      if (config.modelParams.chat) {
        Object.assign(this.modelParams.chat, config.modelParams.chat);
      }
      if (config.modelParams.summarization) {
        Object.assign(this.modelParams.summarization, config.modelParams.summarization);
      }
    }
    
    logger.info("HuggingFace configuration updated:", this.getConfiguration());
  }

  // Get available models for a specific task
  getAvailableModels() {
    // If we have dynamically updated models, use those
    if (this.availableModels && typeof this.availableModels === 'object') {
      return this.availableModels;
    }
    
    // Otherwise return default models
    return {
      chat: [
        "meta-llama/Llama-3.2-1B-Instruct",
        "deepseek-ai/DeepSeek-V3.2",
        "moonshotai/Kimi-K2-Thinking",
        "zai-org/GLM-4.7",
        "MiniMaxAI/MiniMax-M2.1",
        "Qwen/Qwen2.5-1.5B-Instruct",
        "Qwen/Qwen2.5-Coder-32B-Instruct",
        "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "openai/gpt-oss-120b:fastest",
        "openai/gpt-oss-120b:cheapest",
        "microsoft/DialoGPT-large",
        "google/flan-t5-xxl",
        "agentica-org/DeepCoder-14B-Preview",
        "agentica-org/DeepSWE-Preview",
        "Nexusflow/Athene-V2-Chat",
        "Skywork/Skywork-SWE-32B"
      ],
      embedding: [
        "sentence-transformers/all-MiniLM-L6-v2",
        "sentence-transformers/all-mpnet-base-v2",
        "BAAI/bge-large-en-v1.5"
      ],
      vision: [
        "Salesforce/blip-image-captioning-large",
        "microsoft/git-base",
        "nlpconnect/vit-gpt2-image-captioning"
      ],
      whisper: [
        "openai/whisper-large-v3",
        "openai/whisper-medium",
        "openai/whisper-small"
      ],
      summarization: [
        "facebook/bart-large-cnn",
        "google/pegasus-xsum",
        "philschmid/bart-large-cnn-samsum"
      ],
      translation: [
        "Helsinki-NLP/opus-mt-en-es",
        "Helsinki-NLP/opus-mt-en-fr",
        "Helsinki-NLP/opus-mt-en-de",
        "facebook/mbart-large-50-many-to-many-mmt"
      ]
    };
  }
}
