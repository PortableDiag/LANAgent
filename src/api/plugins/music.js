import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { GeneratedSong } from '../../models/GeneratedSong.js';
import { getProvider } from './music-providers.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

export default class MusicPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'music';
    this.version = '1.0.0';
    this.description = 'AI music generation - create songs with Suno, Mubert, or Soundverse';

    this.commands = [
      {
        command: 'generate',
        description: 'Generate an AI song from a text prompt',
        usage: 'generate({ prompt: "a happy pop song about coding", genre: "pop", mood: "happy", provider: "suno" })',
        offerAsService: true,
        examples: [
          'generate a song about rainy days',
          'make me a lo-fi beat for studying',
          'create a happy pop song about coding at 3am',
          'sing me a song about the ocean',
          'compose an instrumental jazz piece'
        ]
      },
      {
        command: 'list',
        description: 'List previously generated songs',
        usage: 'list({ limit: 10, provider: "suno" })',
        offerAsService: true,
        examples: [
          'show my generated songs',
          'list recent music',
          'what songs have I made'
        ]
      },
      {
        command: 'status',
        description: 'Check the status of a song generation task',
        usage: 'status({ taskId: "task_abc123" })',
        offerAsService: true,
        examples: [
          'check song status',
          'is my song ready'
        ]
      },
      {
        command: 'settings',
        description: 'View or update music generation settings',
        usage: 'settings({ operation: "set", provider: "suno", defaultGenre: "pop", deliveryMethod: "telegram" })',
        offerAsService: false,
        examples: [
          'show music settings',
          'set default music provider to suno',
          'change delivery method to email'
        ]
      }
    ];

    this.requiredCredentials = [
      { key: 'sunoApiKey', label: 'Suno API Key (AIML API)', envVar: 'SUNO_API_KEY', required: false },
      { key: 'mubertApiKey', label: 'Mubert API Key', envVar: 'MUBERT_API_KEY', required: false },
      { key: 'soundverseApiKey', label: 'Soundverse API Key', envVar: 'SOUNDVERSE_API_KEY', required: false },
      { key: 'huggingfaceApiKey', label: 'HuggingFace API Key', envVar: 'HUGGING_FACE_API_KEY', required: false }
    ];

    this.credentials = {};
    this.defaultSettings = {
      provider: 'suno',
      defaultGenre: 'pop',
      defaultDuration: 60,
      deliveryMethod: 'telegram'
    };
  }

  async initialize() {
    try {
      // Load credentials (any available)
      const creds = await this.loadCredentials(this.requiredCredentials);
      this.credentials = creds;

      const available = [];
      if (creds.sunoApiKey) available.push('suno');
      if (creds.mubertApiKey) available.push('mubert');
      if (creds.soundverseApiKey) available.push('soundverse');

      if (available.length === 0) {
        this.logger.warn('Music plugin: No API keys configured. Configure at least one provider.');
      } else {
        this.logger.info(`Music plugin initialized with providers: ${available.join(', ')}`);
      }
    } catch (error) {
      this.logger.warn('Music plugin: Could not load credentials:', error.message);
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['generate', 'list', 'status', 'settings']
      }
    });

    switch (action) {
      case 'generate':
        return await this.generateSong(data);
      case 'list':
        return await this.listSongs(data);
      case 'status':
        return await this.checkStatus(data);
      case 'settings':
        return await this.manageSettings(data);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async generateSong(data) {
    const { prompt, genre, mood, style, duration, provider, instrumental, deliveryMethod } = data;

    if (!prompt) {
      throw new Error('A prompt is required to generate a song. Example: "a happy pop song about coding"');
    }

    // Guard against NLP misrouting: reject prompts that are clearly not music requests
    const musicKeywords = /\b(song|music|melody|beat|tune|compose|instrumental|sing|singing|remix|track|album|lyric|chord|rhythm)\b/i;
    if (!musicKeywords.test(prompt) && !genre && !mood && !style && !instrumental) {
      throw new Error(`This doesn't appear to be a music request. The music plugin generates songs from prompts like "a happy pop song about coding". Your request may have been misrouted.`);
    }

    // Determine provider
    const settings = await this.getSettings();
    const selectedProvider = provider || settings.provider || 'suno';
    const selectedDuration = duration || settings.defaultDuration || 60;
    const selectedDelivery = deliveryMethod || settings.deliveryMethod || 'telegram';

    // Get API key for selected provider
    const apiKey = this.getApiKeyForProvider(selectedProvider);
    if (!apiKey) {
      return {
        success: false,
        error: `No API key configured for provider "${selectedProvider}". Configure it in plugin settings or set the environment variable.`,
        availableProviders: this.getAvailableProviders()
      };
    }

    // Create song record
    const song = await GeneratedSong.create({
      prompt,
      provider: selectedProvider,
      genre: genre || settings.defaultGenre,
      mood,
      style,
      instrumental: instrumental || false,
      status: 'generating',
      requestedBy: data.userId || 'unknown'
    });

    this.logger.info(`Generating song with ${selectedProvider}: "${prompt}"`);

    try {
      const providerInstance = getProvider(selectedProvider, apiKey);
      const result = await providerInstance.generate({
        prompt,
        genre: genre || settings.defaultGenre,
        mood,
        style,
        duration: selectedDuration,
        instrumental: instrumental || false
      });

      // Update song record
      song.taskId = result.taskId;
      song.title = result.title || 'Generated Song';
      song.audioUrl = result.audioUrl;
      song.duration = result.duration;
      song.lyrics = result.lyrics;
      song.status = result.status === 'completed' ? 'completed' : 'generating';
      song.metadata = result.metadata;
      if (result.status === 'completed') {
        song.completedAt = new Date();
      }
      await song.save();

      // If completed immediately, deliver
      if (result.status === 'completed' && (result.audioUrl || result.audioFile)) {
        await this.deliverSong(song, selectedDelivery, result.audioFile || null);
        return {
          success: true,
          message: `Song generated and delivered via ${selectedDelivery}!`,
          song: this.formatSongResponse(song),
          delivered: true
        };
      }

      // If async, start polling
      if (result.taskId && result.status !== 'completed') {
        this.pollForCompletion(song, providerInstance, selectedDelivery);
        return {
          success: true,
          message: `Song generation started with ${selectedProvider}. I'll deliver it via ${selectedDelivery} when it's ready.`,
          song: this.formatSongResponse(song),
          delivered: false,
          taskId: result.taskId
        };
      }

      return {
        success: true,
        message: 'Song generation initiated.',
        song: this.formatSongResponse(song)
      };

    } catch (error) {
      song.status = 'failed';
      song.error = error.message;
      await song.save();

      this.logger.error(`Song generation failed (${selectedProvider}):`, error);
      return {
        success: false,
        error: `Song generation failed: ${error.message}`,
        songId: song._id.toString()
      };
    }
  }

  async pollForCompletion(song, providerInstance, deliveryMethod, maxAttempts = 30) {
    const pollInterval = 10000; // 10 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      try {
        const status = await providerInstance.checkStatus(song.taskId);

        if (status.status === 'completed' && status.audioUrl) {
          song.status = 'completed';
          song.audioUrl = status.audioUrl;
          song.title = status.title || song.title;
          song.duration = status.duration || song.duration;
          song.lyrics = status.lyrics || song.lyrics;
          song.completedAt = new Date();
          await song.save();

          this.logger.info(`Song completed: "${song.title}" (${song.provider})`);
          await this.deliverSong(song, deliveryMethod);
          return;
        }

        if (status.status === 'failed') {
          song.status = 'failed';
          song.error = 'Generation failed on provider side';
          await song.save();
          this.logger.error(`Song generation failed: ${song.taskId}`);

          // Notify user of failure
          await this.notify(`Song generation failed for: "${song.prompt}"`);
          return;
        }

        this.logger.info(`Song ${song.taskId} still generating (attempt ${attempt + 1}/${maxAttempts}, status: ${status.status})`);

      } catch (error) {
        this.logger.info(`Poll attempt ${attempt + 1} failed for ${song.taskId}:`, error.message);
      }
    }

    // Timed out
    song.status = 'failed';
    song.error = 'Generation timed out after polling';
    await song.save();
    this.logger.error(`Song generation timed out: ${song.taskId}`);
    await this.notify(`Song generation timed out for: "${song.prompt}". You can check status with the task ID: ${song.taskId}`);
  }

  async deliverSong(song, deliveryMethod, preDownloadedFile = null) {
    const methods = deliveryMethod === 'both' ? ['telegram', 'email'] : [deliveryMethod];
    let tempFile = preDownloadedFile || null;

    try {
      // Use pre-downloaded file if available, otherwise download from URL
      if (!tempFile && song.audioUrl) {
        tempFile = path.join(os.tmpdir(), `lanagent-song-${song._id}.mp3`);
        const response = await axios.get(song.audioUrl, {
          responseType: 'stream',
          timeout: 60000
        });
        const writer = fs.createWriteStream(tempFile);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        this.logger.info(`Downloaded song to: ${tempFile}`);
      }

      for (const method of methods) {
        try {
          if (method === 'telegram') {
            await this.deliverViaTelegram(song, tempFile);
            song.deliveredVia.push('telegram');
          } else if (method === 'email') {
            await this.deliverViaEmail(song, tempFile);
            song.deliveredVia.push('email');
          }
        } catch (error) {
          this.logger.error(`Failed to deliver via ${method}:`, error);
        }
      }

      song.status = 'delivered';
      await song.save();

    } finally {
      // Clean up temp file
      if (tempFile && fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
          this.logger.debug(`Cleaned up temp file: ${tempFile}`);
        } catch (e) {
          this.logger.warn(`Failed to clean up temp file: ${e.message}`);
        }
      }
    }
  }

  async deliverViaTelegram(song, filePath) {
    const caption = `🎵 *${song.title}*\n` +
      `Provider: ${song.provider}\n` +
      (song.genre ? `Genre: ${song.genre}\n` : '') +
      (song.duration ? `Duration: ${song.duration}s\n` : '') +
      `Prompt: "${song.prompt}"`;

    if (filePath && fs.existsSync(filePath)) {
      // Send as audio file via Telegram
      const telegramInterface = this.getInterface('telegram');
      if (telegramInterface) {
        await telegramInterface.notify(caption, {
          audio: { source: filePath },
          parse_mode: 'Markdown'
        });
        this.logger.info('Song delivered via Telegram audio');
      } else {
        // Fallback: use agent's notify with audio URL
        await this.notify(`${caption}\n\n🔗 ${song.audioUrl}`, {
          parse_mode: 'Markdown'
        });
      }
    } else if (song.audioUrl) {
      // Send URL if no file available
      await this.notify(`${caption}\n\n🔗 Listen: ${song.audioUrl}`, {
        parse_mode: 'Markdown'
      });
    }
  }

  async deliverViaEmail(song, filePath) {
    const emailPlugin = this.agent.apiManager.getPlugin('email');
    if (!emailPlugin) {
      this.logger.warn('Email plugin not available for song delivery');
      return;
    }

    const masterEmail = process.env.EMAIL_OF_MASTER;
    if (!masterEmail) {
      this.logger.warn('No master email configured for song delivery');
      return;
    }

    const emailData = {
      action: 'send',
      to: masterEmail,
      subject: `AI Generated Song: ${song.title}`,
      text: `Here's your AI-generated song!\n\n` +
        `Title: ${song.title}\n` +
        `Provider: ${song.provider}\n` +
        (song.genre ? `Genre: ${song.genre}\n` : '') +
        (song.duration ? `Duration: ${song.duration}s\n` : '') +
        `Prompt: "${song.prompt}"\n\n` +
        (song.audioUrl ? `Listen online: ${song.audioUrl}\n\n` : '') +
        (song.lyrics ? `Lyrics:\n${song.lyrics}\n\n` : '') +
        `Generated by ALICE Music Plugin`
    };

    if (filePath && fs.existsSync(filePath)) {
      emailData.attachments = [{ filename: `${song.title || 'song'}.mp3`, path: filePath }];
    }

    try {
      await emailPlugin.execute(emailData);
      this.logger.info('Song delivered via email');
    } catch (error) {
      this.logger.error('Email delivery failed:', error);
      throw error;
    }
  }

  async listSongs(data) {
    const { limit = 10, provider, genre, status } = data;

    const query = {};
    if (provider) query.provider = provider;
    if (genre) query.genre = genre;
    if (status) query.status = status;

    const songs = await GeneratedSong.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return {
      success: true,
      count: songs.length,
      songs: songs.map(s => this.formatSongResponse(s))
    };
  }

  async checkStatus(data) {
    const { taskId, songId } = data;

    if (!taskId && !songId) {
      // Get the most recent generating song
      const recentSong = await GeneratedSong.findOne({ status: { $in: ['generating', 'pending'] } })
        .sort({ createdAt: -1 });

      if (!recentSong) {
        return {
          success: true,
          message: 'No pending song generations found.'
        };
      }

      return {
        success: true,
        song: this.formatSongResponse(recentSong)
      };
    }

    // Find by taskId or songId
    const query = taskId ? { taskId } : { _id: songId };
    const song = await GeneratedSong.findOne(query);

    if (!song) {
      return { success: false, error: 'Song not found' };
    }

    // If still generating, check with provider
    if (song.status === 'generating' && song.taskId) {
      const apiKey = this.getApiKeyForProvider(song.provider);
      if (apiKey) {
        try {
          const providerInstance = getProvider(song.provider, apiKey);
          const providerStatus = await providerInstance.checkStatus(song.taskId);

          if (providerStatus.status === 'completed' && providerStatus.audioUrl) {
            song.status = 'completed';
            song.audioUrl = providerStatus.audioUrl;
            song.title = providerStatus.title || song.title;
            song.completedAt = new Date();
            await song.save();
          }
        } catch (error) {
          this.logger.warn('Provider status check failed:', error.message);
        }
      }
    }

    return {
      success: true,
      song: this.formatSongResponse(song)
    };
  }

  async manageSettings(data) {
    const { operation = 'get' } = data;

    if (operation === 'get') {
      const settings = await this.getSettings();
      const available = this.getAvailableProviders();
      return {
        success: true,
        settings,
        availableProviders: available,
        configuredProviders: available.filter(p => p.configured).map(p => p.name)
      };
    }

    if (operation === 'set') {
      const updates = {};
      if (data.provider) {
        const validProviders = ['suno', 'mubert', 'soundverse'];
        if (!validProviders.includes(data.provider)) {
          throw new Error(`Invalid provider. Choose from: ${validProviders.join(', ')}`);
        }
        updates.provider = data.provider;
      }
      if (data.defaultGenre) updates.defaultGenre = data.defaultGenre;
      if (data.defaultDuration) updates.defaultDuration = parseInt(data.defaultDuration);
      if (data.deliveryMethod) {
        const validMethods = ['telegram', 'email', 'both'];
        if (!validMethods.includes(data.deliveryMethod)) {
          throw new Error(`Invalid delivery method. Choose from: ${validMethods.join(', ')}`);
        }
        updates.deliveryMethod = data.deliveryMethod;
      }

      const current = await this.getSettings();
      const merged = { ...current, ...updates };

      await PluginSettings.setCached('music', 'settings', merged);

      return {
        success: true,
        message: 'Music settings updated',
        settings: merged
      };
    }

    throw new Error(`Unknown operation: ${operation}. Use "get" or "set".`);
  }

  async getSettings() {
    try {
      const saved = await PluginSettings.getCached('music', 'settings');
      if (saved) return { ...this.defaultSettings, ...saved };
    } catch (error) {
      this.logger.debug('Could not load music settings:', error.message);
    }
    return { ...this.defaultSettings };
  }

  getApiKeyForProvider(providerName) {
    switch (providerName) {
      case 'suno': return this.credentials.sunoApiKey || process.env.SUNO_API_KEY;
      case 'mubert': return this.credentials.mubertApiKey || process.env.MUBERT_API_KEY;
      case 'soundverse': return this.credentials.soundverseApiKey || process.env.SOUNDVERSE_API_KEY;
      case 'huggingface': return this.credentials.huggingfaceApiKey || process.env.HUGGING_FACE_API_KEY || process.env.HUGGINGFACE_TOKEN;
      default: return null;
    }
  }

  getAvailableProviders() {
    return [
      {
        name: 'suno',
        label: 'Suno (via AIML API)',
        description: 'Full songs with vocals and lyrics',
        configured: !!(this.credentials.sunoApiKey || process.env.SUNO_API_KEY)
      },
      {
        name: 'mubert',
        label: 'Mubert',
        description: 'Real-time ambient and instrumental music',
        configured: !!(this.credentials.mubertApiKey || process.env.MUBERT_API_KEY)
      },
      {
        name: 'soundverse',
        label: 'Soundverse',
        description: 'AI songs with ethical licensing',
        configured: !!(this.credentials.soundverseApiKey || process.env.SOUNDVERSE_API_KEY)
      },
      {
        name: 'huggingface',
        label: 'HuggingFace MusicGen',
        description: 'Open-source AI music generation (Meta MusicGen)',
        configured: !!(this.credentials.huggingfaceApiKey || process.env.HUGGING_FACE_API_KEY || process.env.HUGGINGFACE_TOKEN)
      }
    ];
  }

  formatSongResponse(song) {
    return {
      id: song._id?.toString(),
      title: song.title,
      prompt: song.prompt,
      provider: song.provider,
      genre: song.genre,
      mood: song.mood,
      status: song.status,
      audioUrl: song.audioUrl,
      duration: song.duration,
      instrumental: song.instrumental,
      lyrics: song.lyrics,
      deliveredVia: song.deliveredVia,
      taskId: song.taskId,
      createdAt: song.createdAt,
      completedAt: song.completedAt
    };
  }
}
