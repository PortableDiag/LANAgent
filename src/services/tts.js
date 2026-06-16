import { logger } from '../utils/logger.js';
import OpenAI from 'openai';
import { InferenceClient } from '@huggingface/inference';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TTSService {
  constructor(agent) {
    this.agent = agent;
    this.openai = null;
    this.huggingface = null;
    
    // Available providers
    this.providers = {
      openai: {
        name: 'OpenAI',
        description: 'High-quality TTS with multiple voices',
        requiresKey: 'OPENAI_API_KEY',
        models: {
          'tts-1': { name: 'TTS-1 (Standard)', description: 'Fast, standard quality' },
          'tts-1-hd': { name: 'TTS-1-HD', description: 'High definition quality' },
          'gpt-4o-mini-tts': { name: 'GPT-4o-mini-TTS', description: 'Advanced model with instructions support' },
          'gpt-4o-mini-tts-2025-12-15': { name: 'GPT-4o-mini-TTS (2025-12-15)', description: 'Latest version with instructions' }
        }
      },
      huggingface: {
        name: 'HuggingFace',
        description: 'Open-source models',
        requiresKey: 'HF_TOKEN',
        models: {
          'hexgrad/Kokoro-82M': { name: 'Kokoro-82M', description: 'High-quality multilingual TTS model' },
          'ResembleAI/chatterbox': { name: 'Chatterbox', description: 'Fast and natural TTS model' }
        }
      }
    };
    
    // Available voices by provider
    this.availableVoices = {
      openai: {
        alloy: { name: 'Alloy', description: 'Balanced, neutral voice' },
        echo: { name: 'Echo', description: 'Deep, resonant voice' },
        fable: { name: 'Fable', description: 'Warm, storytelling voice' },
        onyx: { name: 'Onyx', description: 'Strong, authoritative voice' },
        nova: { name: 'Nova', description: 'Clear, professional voice' },
        shimmer: { name: 'Shimmer', description: 'Bright, energetic voice' },
        ash: { name: 'Ash', description: 'Smooth, refined voice' },
        ballad: { name: 'Ballad', description: 'Musical, expressive voice' },
        coral: { name: 'Coral', description: 'Gentle, melodic voice' },
        sage: { name: 'Sage', description: 'Wise, thoughtful voice' },
        verse: { name: 'Verse', description: 'Poetic, rhythmic voice' },
        marin: { name: 'Marin', description: 'Fresh, lively voice' },
        cedar: { name: 'Cedar', description: 'Rich, warm voice' }
      },
      huggingface: {
        // Kokoro-82M American English voices (Female)
        'af_heart': { name: 'Heart', description: 'American female - Grade A' },
        'af_bella': { name: 'Bella', description: 'American female - Grade A-' },
        'af_nicole': { name: 'Nicole', description: 'American female - Grade B-' },
        'af_aoede': { name: 'Aoede', description: 'American female - Grade C+' },
        'af_kore': { name: 'Kore', description: 'American female - Grade C+' },
        'af_sarah': { name: 'Sarah', description: 'American female - Grade C+' },
        // Kokoro-82M American English voices (Male)
        'am_fenrir': { name: 'Fenrir', description: 'American male - Grade C+' },
        'am_michael': { name: 'Michael', description: 'American male - Grade C+' },
        'am_puck': { name: 'Puck', description: 'American male - Grade C+' },
        // Kokoro-82M British English voices (Female)
        'bf_emma': { name: 'Emma', description: 'British female - Grade B-' },
        'bf_isabella': { name: 'Isabella', description: 'British female - Grade C' },
        // Kokoro-82M British English voices (Male)
        'bm_fable': { name: 'Fable', description: 'British male - Grade C' },
        'bm_george': { name: 'George', description: 'British male - Grade C' },
        // Chatterbox voice presets with different parameters
        'chatterbox-default': { name: 'Default', description: 'Standard male voice' },
        'chatterbox-soft': { name: 'Soft', description: 'Softer, less masculine voice (lower CFG)' },
        'chatterbox-expressive': { name: 'Expressive', description: 'More emotional and varied (higher exaggeration)' },
        'chatterbox-neutral': { name: 'Neutral', description: 'Balanced, professional voice' }
      }
    };

    // Available models
    this.availableModels = [
      'tts-1',
      'tts-1-hd', 
      'gpt-4o-mini-tts',
      'gpt-4o-mini-tts-2025-12-15',
      'hexgrad/Kokoro-82M',
      'ResembleAI/chatterbox'
    ];

    // TTS pricing per character (approximate)
    this.pricing = {
      // OpenAI models
      'tts-1': 0.000015, // $15 per 1M characters
      'tts-1-hd': 0.00003, // $30 per 1M characters
      'gpt-4o-mini-tts': 0.00002, // $20 per 1M characters
      'gpt-4o-mini-tts-2025-12-15': 0.00002,
      // HuggingFace models
      'hexgrad/Kokoro-82M': 0.000001, // $1.00 per 1M characters
      'ResembleAI/chatterbox': 0.000001 // $1.00 per 1M characters
    };
  }

  async initialize() {
    try {
      // Initialize OpenAI if API key is available
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        this.openai = new OpenAI({ apiKey: openaiKey });
        logger.info('OpenAI TTS provider initialized successfully');
      } else {
        logger.warn('OpenAI API key not found');
      }

      // Initialize HuggingFace if token is available
      const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
      logger.info(`Checking for HuggingFace token: HF_TOKEN=${!!process.env.HF_TOKEN}, HUGGINGFACE_TOKEN=${!!process.env.HUGGINGFACE_TOKEN}`);
      if (hfToken) {
        this.huggingface = new InferenceClient(hfToken);
        logger.info(`HuggingFace TTS provider initialized successfully with token (first 10 chars): ${hfToken.substring(0, 10)}...`);
      } else {
        logger.warn('HuggingFace token not found - TTS will not be available');
      }

      // Check if at least one provider is available
      if (!this.openai && !this.huggingface) {
        logger.warn('No TTS providers available. TTS functionality will be disabled.');
      }
    } catch (error) {
      logger.error('Failed to initialize TTS Service:', error);
    }
  }

  async generateSpeech(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('Text input is required');
    }

    // Get voice settings from agent model
    const voiceSettings = await this.getVoiceSettings();
    const provider = options.provider || voiceSettings.provider || 'openai';

    logger.info(`TTS generateSpeech called - provider: ${provider}, speakThroughServer: ${voiceSettings.speakThroughServer}, source: ${options.source || 'none'}`);

    // Route to appropriate provider
    let result;
    if (provider === 'huggingface') {
      result = await this.generateSpeechHuggingFace(text, options);
    } else {
      result = await this.generateSpeechOpenAI(text, options);
    }

    // If speakThroughServer is enabled, also play through the server speaker
    // Skip if this request came from voice interaction itself (to avoid double playback)
    if (voiceSettings.speakThroughServer && options.source !== 'voice' && result?.buffer) {
      logger.info('[TTS] speakThroughServer is enabled, playing through server speaker...');
      await this.playThroughServerSpeaker(result.buffer, result.format);
    } else if (!voiceSettings.speakThroughServer) {
      logger.info('[TTS] speakThroughServer is disabled, skipping server speaker playback');
    }

    return result;
  }

  /**
   * Play audio through the server's local speaker (e.g., eMeet device)
   */
  async playThroughServerSpeaker(audioBuffer, format = 'mp3') {
    try {
      // Use voiceInteraction service if available
      if (this.agent?.voiceInteraction) {
        logger.info('[TTS] Playing response through server speaker');
        await this.agent.voiceInteraction.playAudio(audioBuffer, format);
      } else {
        logger.warn('[TTS] Voice interaction service not available for server speaker playback');
      }
    } catch (error) {
      logger.error('[TTS] Error playing through server speaker:', error.message);
      // Don't throw - this is a non-critical feature
    }
  }

  async generateSpeechOpenAI(text, options = {}) {
    if (!this.openai) {
      throw new Error('OpenAI TTS provider not initialized or API key missing');
    }

    // For longer texts, use chunking and concatenation
    if (text.length > 4096) {
      return this.generateSpeechChunked(text, { ...options, provider: 'openai' });
    }

    const startTime = Date.now();

    try {
      const voiceSettings = await this.getVoiceSettings();
      
      const model = options.model || voiceSettings.model || 'gpt-4o-mini-tts';
      const voice = options.voice || voiceSettings.voice || 'nova';
      const speed = options.speed || voiceSettings.speed || 1.0;
      const format = options.format || voiceSettings.format || 'mp3';
      const instructions = options.instructions || voiceSettings.instructions;

      // Build request parameters
      const requestParams = {
        model,
        voice,
        input: text,
        response_format: format,
        speed: Math.max(0.25, Math.min(4.0, speed))
      };

      // Add instructions for advanced models (not tts-1 or tts-1-hd)
      if (instructions && !model.includes('tts-1')) {
        requestParams.instructions = instructions;
      }

      logger.info(`Generating speech with model: ${model}, voice: ${voice}, format: ${format}`);

      const response = await this.openai.audio.speech.create(requestParams);
      
      // Get the audio buffer
      const buffer = Buffer.from(await response.arrayBuffer());
      
      // Calculate cost and update stats
      const cost = this.calculateCost(model, text.length);
      const duration = this.estimateDuration(text.length);
      const responseTime = Date.now() - startTime;
      
      await this.updateUsageStats(cost, responseTime, model, text.length, 'openai');
      
      logger.info(`TTS generated ${buffer.length} bytes in ${responseTime}ms, cost: $${cost.toFixed(4)}`);

      return {
        buffer,
        format,
        model,
        voice,
        cost,
        duration,
        responseTime,
        size: buffer.length
      };

    } catch (error) {
      logger.error('TTS generation error:', error);
      throw error;
    }
  }

  async testVoice(voice = 'nova', text = null) {
    const testText = text || `Hello! I am ${this.agent.config.name}, your personal assistant. I can now speak to you with realistic voice synthesis. How does this sound?`;
    
    try {
      const result = await this.generateSpeech(testText, { voice });
      
      // Save to temporary file for testing
      const tempDir = path.join(__dirname, '../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const tempFile = path.join(tempDir, `voice-test-${voice}-${Date.now()}.${result.format}`);
      await fs.promises.writeFile(tempFile, result.buffer);
      
      // Clean up old test files (older than 1 hour)
      this.cleanupOldTestFiles(tempDir);
      
      return {
        ...result,
        tempFile
      };
    } catch (error) {
      logger.error(`Voice test failed for ${voice}:`, error);
      throw error;
    }
  }

  calculateCost(model, characterCount) {
    const pricePerChar = this.pricing[model] || this.pricing['gpt-4o-mini-tts'];
    return characterCount * pricePerChar;
  }

  estimateDuration(characterCount) {
    // Rough estimate: ~150 words per minute, ~5 characters per word
    const wordsPerMinute = 150;
    const charactersPerWord = 5;
    const words = characterCount / charactersPerWord;
    return (words / wordsPerMinute) * 60; // duration in seconds
  }

  getVoiceSettings() {
    try {
      if (this.agent.agentModel && this.agent.agentModel.voice) {
        return this.agent.agentModel.voice;
      }
      
      // Return defaults if no settings found
      return {
        enabled: false,
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        voice: 'nova',
        speed: 1.0,
        format: 'mp3',
        telegramResponses: false,
        speakThroughServer: false,
        instructions: ''
      };
    } catch (error) {
      logger.error('Error getting voice settings:', error);
      return {};
    }
  }

  async updateVoiceSettings(settings) {
    try {
      if (!this.agent.agentModel) {
        throw new Error('Agent model not available');
      }

      // Validate settings
      const provider = settings.provider || this.agent.agentModel.voice?.provider || 'openai';
      if (settings.voice && !this.availableVoices[provider]?.[settings.voice]) {
        throw new Error(`Invalid voice selection for ${provider} provider`);
      }

      if (settings.model) {
        // Validate model based on provider
        if (provider === 'huggingface') {
          const validHfModels = Object.keys(this.providers.huggingface.models);
          if (!validHfModels.includes(settings.model)) {
            throw new Error(`Invalid model selection for HuggingFace provider`);
          }
        } else {
          const validOpenAIModels = Object.keys(this.providers.openai.models);
          if (!validOpenAIModels.includes(settings.model)) {
            throw new Error(`Invalid model selection for OpenAI provider`);
          }
        }
      }

      if (settings.speed && (settings.speed < 0.25 || settings.speed > 4.0)) {
        throw new Error('Speed must be between 0.25 and 4.0');
      }

      // Update agent model
      this.agent.agentModel.voice = {
        ...this.agent.agentModel.voice,
        ...settings
      };

      // Validate provider if specified
      if (settings.provider && !this.providers[settings.provider]) {
        throw new Error('Invalid provider selection');
      }

      await this.agent.agentModel.save();
      logger.info('Voice settings updated successfully');

      return true;
    } catch (error) {
      logger.error('Error updating voice settings:', error);
      throw error;
    }
  }

  async updateUsageStats(cost, responseTime, model, textLength, provider = null) {
    try {
      // Calculate estimated duration for metadata
      const estimatedDuration = this.estimateDuration(textLength);
      
      // Determine provider from model if not specified
      if (!provider) {
        // Check if it's a HuggingFace model
        const hfModels = ['hexgrad/Kokoro-82M', 'parler-tts/parler-tts-large-v1', 'collabora/whisperspeech', 
                         'lucasdt/chatterbox-48k', 'hex:Kokoro-large', 'Kokoro-82M-ONNX-CPU', 'ResembleAI/chatterbox'];
        provider = hfModels.some(hfModel => model.includes(hfModel)) ? 'huggingface' : 'openai';
      }
      
      // Save usage stats directly to database
      const { TokenUsage } = await import('../models/TokenUsage.js');
      await TokenUsage.create({
        provider,
        model,
        promptTokens: 0, // TTS doesn't have traditional prompt tokens
        completionTokens: textLength, // Use character count as completion tokens for TTS
        totalTokens: textLength,
        cost: cost,
        responseTime: responseTime, // Already in milliseconds
        requestType: 'tts',
        success: true,
        metadata: {
          textLength,
          estimatedDuration,
          service: 'tts'
        }
      });

      logger.info(`TTS usage saved to database: cost=$${cost.toFixed(4)}, characters=${textLength}, model=${model}, responseTime=${responseTime}ms`);

    } catch (error) {
      logger.error('Error saving TTS usage stats:', error);
    }
  }

  async generateSpeechHuggingFace(text, options = {}) {
    if (!this.huggingface) {
      logger.error('HuggingFace not initialized. Check HF_TOKEN or HUGGINGFACE_TOKEN environment variable.');
      throw new Error('HuggingFace TTS provider not initialized or token missing');
    }

    const startTime = Date.now();
    
    // Get voice settings from agent model
    const voiceSettings = await this.getVoiceSettings();
    
    // HuggingFace specific options
    const model = options.model || voiceSettings.model || 'hexgrad/Kokoro-82M';
    // Map voice to appropriate model if Kokoro voices are selected
    let actualModel = model;
    const requestedVoice = options.voice || voiceSettings.voice || 'default';

    // For Kokoro voices, the voice ID contains the voice variant info
    // but the API doesn't support voice selection, so we note it for future use
    const voice = requestedVoice;
    const format = options.format || voiceSettings.format || 'mp3';
    const speed = options.speed || voiceSettings.speed || 1.0;

    try {

      logger.info(`Generating speech with HuggingFace ${model}, voice: ${voice}, format: ${format}, speed: ${speed}`);

      // Generate speech using HuggingFace
      logger.info(`HuggingFace API call with model: ${model}, text: ${text}`);
      
      // Call the API using InferenceClient
      logger.info(`Calling InferenceClient.textToSpeech with model: ${model}`);
      
      // Build parameters based on model
      const params = {
        provider: "auto",
        model: model,
        inputs: text
      };

      // Note: HuggingFace Inference API for Kokoro does not currently support
      // custom parameters like speed/voice through the API. These would need
      // to be implemented server-side or via a custom endpoint.
      // Speed setting is stored but not applied to Kokoro model via Inference API.
      if (model.toLowerCase().includes('kokoro')) {
        logger.info(`Kokoro TTS requested with speed=${speed}, voice=${voice} (parameters not supported via Inference API)`);
      }

      // Add Chatterbox-specific parameters based on voice selection
      if (model.toLowerCase().includes('chatterbox')) {
        let cfg = 0.5;
        let exaggeration = 0.5;
        
        // Adjust parameters based on voice preset
        switch (voice) {
          case 'chatterbox-soft':
            cfg = 0.3;
            exaggeration = 0.4;
            logger.info('Using Chatterbox soft voice preset (lower CFG for softer sound)');
            break;
          case 'chatterbox-expressive':
            cfg = 0.6;
            exaggeration = 0.7;
            logger.info('Using Chatterbox expressive voice preset');
            break;
          case 'chatterbox-neutral':
            cfg = 0.4;
            exaggeration = 0.3;
            logger.info('Using Chatterbox neutral voice preset');
            break;
          default:
            logger.info('Using Chatterbox default voice preset');
            break;
        }
        
        params.parameters = {
          cfg: cfg,
          exaggeration: exaggeration
        };
      }
      
      const audioBlob = await this.huggingface.textToSpeech(params);
      
      // Convert Blob to Buffer
      const buffer = Buffer.from(await audioBlob.arrayBuffer());
      
      // Calculate cost for HuggingFace models
      const cost = this.calculateCost(model, text.length);
      const duration = this.estimateDuration(text.length);
      const responseTime = Date.now() - startTime;
      
      await this.updateUsageStats(cost, responseTime, model, text.length, 'huggingface');
      
      logger.info(`HuggingFace TTS generated ${buffer.length} bytes in ${responseTime}ms`);

      return {
        buffer,
        format,
        model,
        voice,
        cost,
        duration,
        responseTime,
        size: buffer.length,
        provider: 'huggingface'
      };

    } catch (error) {
      logger.error('HuggingFace TTS generation error:', error);
      logger.error('Error details:', {
        model: model,
        voice: voice,
        textLength: text.length,
        errorMessage: error.message,
        errorResponse: error.response?.data
      });
      throw error;
    }
  }

  async getUsageStats() {
    try {
      // Access TokenUsage through the agent's database connection
      let TokenUsage;
      if (this.agent.models && this.agent.models.TokenUsage) {
        TokenUsage = this.agent.models.TokenUsage;
      } else {
        const { TokenUsage: ImportedTokenUsage } = await import('../models/TokenUsage.js');
        TokenUsage = ImportedTokenUsage;
      }
      
      // Use simpler queries instead of aggregation to avoid timeout issues
      const allTtsRecords = await TokenUsage.find({ requestType: 'tts' }).lean();
      
      // Calculate totals manually
      let totalRequests = allTtsRecords.length;
      let totalCost = 0;
      let totalDuration = 0;
      let monthlyCost = 0;
      let monthlyRequests = 0;
      
      // Get first day of current month
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const firstDayOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      
      for (const record of allTtsRecords) {
        totalCost += record.cost || 0;
        totalDuration += (record.metadata?.estimatedDuration || 0);
        
        // Check if record is from this month
        if (record.createdAt >= firstDayOfMonth && record.createdAt < firstDayOfNextMonth) {
          monthlyCost += record.cost || 0;
          monthlyRequests++;
        }
      }

      return {
        totalRequests,
        totalCost,
        totalDuration,
        totalDurationFormatted: this.formatDuration(totalDuration),
        monthlyCost,
        monthlyRequests,
        currentMonth: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      };

    } catch (error) {
      logger.error('Error loading voice usage stats:', error);
      return {
        totalRequests: 0,
        totalCost: 0,
        totalDuration: 0,
        totalDurationFormatted: '0s',
        monthlyCost: 0,
        monthlyRequests: 0,
        currentMonth: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      };
    }
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      return `${remainingSeconds}s`;
    }
  }

  async cleanupOldTestFiles(tempDir) {
    try {
      const files = await fs.promises.readdir(tempDir);
      const oneHourAgo = Date.now() - (60 * 60 * 1000);

      for (const file of files) {
        if (file.startsWith('voice-test-')) {
          const filePath = path.join(tempDir, file);
          const stats = await fs.promises.stat(filePath);
          
          if (stats.mtime.getTime() < oneHourAgo) {
            await fs.promises.unlink(filePath);
            logger.debug(`Cleaned up old test file: ${file}`);
          }
        }
      }
    } catch (error) {
      logger.warn('Error cleaning up test files:', error);
    }
  }

  getAvailableVoices(provider = null) {
    if (provider) {
      return this.availableVoices[provider] || {};
    }
    return this.availableVoices;
  }

  getAvailableModels() {
    return this.availableModels;
  }

  isEnabled() {
    try {
      const settings = this.getVoiceSettings();
      return settings.enabled === true;
    } catch {
      return false;
    }
  }

  async isTelegramEnabled() {
    try {
      const settings = this.getVoiceSettings();
      const enabled = settings.enabled === true;
      const telegramResponses = settings.telegramResponses === true;
      
      logger.info(`TTS Telegram check - Voice enabled: ${enabled}, Telegram responses: ${telegramResponses}, Settings:`, settings);
      
      return enabled && telegramResponses;
    } catch (error) {
      logger.error('Error checking Telegram enabled status:', error);
      return false;
    }
  }

  /**
   * Generate speech for long text using chunking and concatenation
   */
  async generateSpeechChunked(text, options = {}) {
    logger.info(`Generating chunked speech for ${text.length} characters`);
    
    try {
      // Split text into manageable chunks at sentence boundaries
      const chunks = this.splitTextIntoChunks(text, 3800); // Leave buffer under 4096 limit
      logger.info(`Split text into ${chunks.length} chunks`);
      
      const audioBuffers = [];
      let totalCost = 0;
      
      // Generate audio for each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        logger.info(`Processing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);
        
        // Generate speech for this chunk (recursive call, but won't trigger chunking again)
        // Ensure provider is passed through for chunked generation
        const chunkOptions = { ...options };
        const chunkResult = await this.generateSpeech(chunk, chunkOptions);
        
        if (chunkResult && chunkResult.buffer) {
          audioBuffers.push(chunkResult.buffer);
          totalCost += chunkResult.cost || 0;
        }
      }
      
      if (audioBuffers.length === 0) {
        throw new Error('No audio generated from chunks');
      }
      
      // Concatenate all audio buffers
      const concatenatedBuffer = await this.concatenateAudioBuffers(audioBuffers);
      
      return {
        buffer: concatenatedBuffer,
        size: concatenatedBuffer.length,
        cost: totalCost,
        chunks: chunks.length,
        duration: this.estimateDuration(text)
      };
      
    } catch (error) {
      logger.error('Error generating chunked speech:', error);
      throw error;
    }
  }

  /**
   * Split text into chunks at sentence boundaries, respecting character limit
   */
  splitTextIntoChunks(text, maxChars = 3800) {
    const chunks = [];
    let currentChunk = '';
    
    // Split by sentences first
    const sentences = text.match(/[^\.!?]+[\.!?]+/g) || [text];
    
    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      
      // If a single sentence is too long, split by paragraphs/lines
      if (trimmedSentence.length > maxChars) {
        // First, save any current chunk
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // Split long sentence by paragraphs/lines
        const lines = trimmedSentence.split(/\n+/);
        let lineChunk = '';
        
        for (const line of lines) {
          if (lineChunk.length + line.length > maxChars) {
            if (lineChunk.trim()) {
              chunks.push(lineChunk.trim());
            }
            lineChunk = line + ' ';
          } else {
            lineChunk += line + ' ';
          }
        }
        
        if (lineChunk.trim()) {
          currentChunk = lineChunk;
        }
      } else {
        // Normal sentence processing
        if (currentChunk.length + trimmedSentence.length > maxChars) {
          // Current chunk would be too big, save it and start new one
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = trimmedSentence + ' ';
        } else {
          // Add sentence to current chunk
          currentChunk += trimmedSentence + ' ';
        }
      }
    }
    
    // Don't forget the last chunk
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks.filter(chunk => chunk.length > 0);
  }

  /**
   * Concatenate audio buffers (simple concatenation for MP3)
   */
  async concatenateAudioBuffers(buffers) {
    if (buffers.length === 1) {
      return buffers[0];
    }
    
    // Simple concatenation for MP3 files - they can be concatenated directly
    const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const result = Buffer.alloc(totalLength);
    
    let offset = 0;
    for (const buffer of buffers) {
      buffer.copy(result, offset);
      offset += buffer.length;
    }
    
    return result;
  }

  /**
   * Estimate duration of text in seconds (for chunked audio)
   */
  estimateDuration(text) {
    const wordsPerMinute = 150; // Average speaking rate
    const charactersPerWord = 5; // Average characters per word
    const wordsCount = text.length / charactersPerWord;
    const minutes = wordsCount / wordsPerMinute;
    return Math.round(minutes * 60); // Return seconds
  }

  /**
   * Get supported languages for TTS
   * OpenAI TTS supports multiple languages with automatic detection
   */
  async getSupportedLanguages() {
    // OpenAI TTS models support these languages with automatic detection
    // The model will automatically detect the language from the input text
    return [
      { code: 'en', name: 'English', native: 'English' },
      { code: 'es', name: 'Spanish', native: 'Español' },
      { code: 'fr', name: 'French', native: 'Français' },
      { code: 'de', name: 'German', native: 'Deutsch' },
      { code: 'it', name: 'Italian', native: 'Italiano' },
      { code: 'pt', name: 'Portuguese', native: 'Português' },
      { code: 'nl', name: 'Dutch', native: 'Nederlands' },
      { code: 'ru', name: 'Russian', native: 'Русский' },
      { code: 'zh', name: 'Chinese', native: '中文' },
      { code: 'ja', name: 'Japanese', native: '日本語' },
      { code: 'ko', name: 'Korean', native: '한국어' },
      { code: 'ar', name: 'Arabic', native: 'العربية' },
      { code: 'tr', name: 'Turkish', native: 'Türkçe' },
      { code: 'pl', name: 'Polish', native: 'Polski' },
      { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
      { code: 'sv', name: 'Swedish', native: 'Svenska' },
      { code: 'no', name: 'Norwegian', native: 'Norsk' },
      { code: 'da', name: 'Danish', native: 'Dansk' },
      { code: 'fi', name: 'Finnish', native: 'Suomi' },
      { code: 'he', name: 'Hebrew', native: 'עברית' },
      { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
      { code: 'ms', name: 'Malay', native: 'Bahasa Melayu' },
      { code: 'th', name: 'Thai', native: 'ไทย' },
      { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
      { code: 'cs', name: 'Czech', native: 'Čeština' },
      { code: 'el', name: 'Greek', native: 'Ελληνικά' },
      { code: 'ro', name: 'Romanian', native: 'Română' },
      { code: 'hu', name: 'Hungarian', native: 'Magyar' },
      { code: 'uk', name: 'Ukrainian', native: 'Українська' },
      { code: 'bg', name: 'Bulgarian', native: 'Български' },
      { code: 'hr', name: 'Croatian', native: 'Hrvatski' },
      { code: 'sk', name: 'Slovak', native: 'Slovenčina' }
    ];
  }
}