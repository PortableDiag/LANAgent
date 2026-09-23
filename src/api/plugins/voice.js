import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class VoicePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'voice';
    this.description = 'Voice and TTS configuration management';
    this.version = '1.3.0'; // Updated version for provider support
    this.commands = [
      {
        command: 'settings',
        description: 'Get current voice and TTS settings',
        usage: 'settings()'
      },
      {
        command: 'set-voice',
        description: 'Change the default voice',
        usage: 'set-voice({ voice: "nova", provider: "openai" })'
      },
      {
        command: 'set-provider',
        description: 'Set TTS provider (openai, elevenlabs, edge)',
        usage: 'set-provider({ provider: "elevenlabs" })'
      },
      {
        command: 'toggle',
        description: 'Enable or disable voice functionality',
        usage: 'toggle({ enabled: true })',
        examples: ['enable voice mode', 'disable voice functionality', 'toggle voice on', 'toggle voice off']
      },
      {
        command: 'list-voices',
        description: 'List available voices for current provider',
        usage: 'list-voices({ provider: "openai" })'
      },
      {
        command: 'test',
        description: 'Test a voice with sample text',
        usage: 'test({ voice: "nova", text: "Hello world", language: "en" })'
      },
      {
        command: 'create-profile',
        description: 'Create a voice profile with custom settings',
        usage: 'create-profile({ name: "myProfile", voice: "nova", speed: 1.0, pitch: 1.0 })'
      },
      {
        command: 'switch-profile',
        description: 'Switch to a different voice profile',
        usage: 'switch-profile({ name: "myProfile" })'
      },
      {
        command: 'list-profiles',
        description: 'List all voice profiles',
        usage: 'list-profiles()'
      },
      {
        command: 'telegram-voice',
        description: 'Configure Telegram voice messages',
        usage: 'telegram-voice({ enabled: true, autoConvert: true })'
      }
    ];
    this.voiceProfiles = {}; // Store voice profiles in memory for simplicity
  }

  getCommands() {
    return [
      {
        command: 'voice settings',
        description: 'Get current voice settings',
        examples: ['api voice settings']
      },
      {
        command: 'voice test <voice> [text] [language]',
        description: 'Test a specific voice with optional language',
        examples: ['api voice test nova', 'api voice test alloy "Hello world" en']
      },
      {
        command: 'voice enable|disable',
        description: 'Enable or disable voice functionality',
        examples: ['api voice enable', 'api voice disable']
      },
      {
        command: 'voice profile create <name>',
        description: 'Create a new voice profile',
        examples: ['api voice profile create myProfile']
      },
      {
        command: 'voice profile switch <name>',
        description: 'Switch to a different voice profile',
        examples: ['api voice profile switch myProfile']
      },
      {
        command: 'voice profile update <name>',
        description: 'Update an existing voice profile',
        examples: ['api voice profile update myProfile']
      }
    ];
  }

  async execute(params) {
    const { action } = params;
    
    switch (action) {
      case 'settings':
        return this.getVoiceSettings();
      
      case 'set-voice':
        return this.setDefaultVoice(params);
        
      case 'set-provider':
        return this.setTTSProvider(params);
        
      case 'toggle':
        return this.toggleVoice(params);
        
      case 'list-voices':
        return this.listAvailableVoices(params);
        
      case 'test':
        return this.testVoice(params);
        
      case 'create-profile':
        return this.createVoiceProfile(params);
        
      case 'switch-profile':
        return this.switchVoiceProfile(params);
        
      case 'list-profiles':
        return this.listVoiceProfiles();
        
      case 'telegram-voice':
        return this.configureTelegramVoice(params);
        
      default:
        throw new Error(`Unknown voice action: ${action}`);
    }
  }

  getRoutes() {
    return [
      {
        method: 'GET',
        path: '/settings',
        handler: this.getVoiceSettings.bind(this),
        description: 'Get voice configuration settings'
      },
      {
        method: 'POST',
        path: '/settings',
        handler: this.updateVoiceSettings.bind(this),
        description: 'Update voice configuration settings'
      },
      {
        method: 'POST',
        path: '/reset',
        handler: this.resetVoiceSettings.bind(this),
        description: 'Reset voice settings to defaults'
      },
      {
        method: 'POST',
        path: '/test',
        handler: this.testVoice.bind(this),
        description: 'Test voice synthesis'
      },
      {
        method: 'GET',
        path: '/stats',
        handler: this.getVoiceStats.bind(this),
        description: 'Get voice usage statistics'
      },
      {
        method: 'GET',
        path: '/models',
        handler: this.getAvailableModels.bind(this),
        description: 'Get available TTS models'
      },
      {
        method: 'GET',
        path: '/voices',
        handler: this.getAvailableVoices.bind(this),
        description: 'Get available voice options'
      },
      {
        method: 'GET',
        path: '/providers',
        handler: this.getProviders.bind(this),
        description: 'Get available TTS providers'
      },
      {
        method: 'GET',
        path: '/audio/:filename',
        handler: this.serveAudioFile.bind(this),
        description: 'Serve generated audio files'
      },
      {
        method: 'GET',
        path: '/languages',
        handler: this.getSupportedLanguages.bind(this),
        description: 'Get supported languages for TTS'
      },
      {
        method: 'POST',
        path: '/profile',
        handler: this.createOrUpdateVoiceProfile.bind(this),
        description: 'Create or update a voice profile'
      },
      {
        method: 'POST',
        path: '/profile/switch',
        handler: this.switchVoiceProfile.bind(this),
        description: 'Switch to a different voice profile'
      },
      {
        method: 'GET',
        path: '/interaction/status',
        handler: this.getVoiceInteractionStatus.bind(this),
        description: 'Get voice interaction service status'
      },
      {
        method: 'POST',
        path: '/interaction/start',
        handler: this.startVoiceInteraction.bind(this),
        description: 'Start voice interaction (wake word listening)'
      },
      {
        method: 'POST',
        path: '/interaction/stop',
        handler: this.stopVoiceInteraction.bind(this),
        description: 'Stop voice interaction service'
      },
      {
        method: 'POST',
        path: '/interaction/config',
        handler: this.updateVoiceInteractionConfig.bind(this),
        description: 'Update voice interaction configuration'
      }
    ];
  }

  async getVoiceSettings() {
    try {
      const settings = await this.agent.ttsService.getVoiceSettings();
      return {
        success: true,
        data: settings
      };
    } catch (error) {
      logger.error('Error getting voice settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateVoiceSettings(data) {
    try {
      await this.agent.ttsService.updateVoiceSettings(data);
      return {
        success: true,
        message: 'Voice settings updated successfully'
      };
    } catch (error) {
      logger.error('Error updating voice settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async resetVoiceSettings() {
    try {
      const defaultSettings = {
        enabled: false,
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        voice: 'nova',
        speed: 1.0,
        format: 'mp3',
        telegramResponses: false,
        instructions: '',
        language: 'en' // Default language
      };
      
      await this.agent.ttsService.updateVoiceSettings(defaultSettings);
      return {
        success: true,
        message: 'Voice settings reset to defaults'
      };
    } catch (error) {
      logger.error('Error resetting voice settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async testVoice(data) {
    try {
      const { voice = 'nova', text, model, speed, format, instructions, language = 'en', provider } = data;
      
      const result = await this.agent.ttsService.generateSpeech(text || 
        `Hello! This is a test of the ${voice} voice.`, {
        voice,
        model,
        speed,
        format,
        instructions,
        language,
        provider
      });

      const tempDir = path.join(__dirname, '../../../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const filename = `voice-test-${voice}-${Date.now()}.${result.format}`;
      const filepath = path.join(tempDir, filename);
      await fs.promises.writeFile(filepath, result.buffer);

      this.cleanupOldTestFiles(tempDir);

      return {
        success: true,
        data: {
          voice: result.voice,
          model: result.model,
          cost: result.cost,
          duration: result.duration,
          size: result.size,
          audioUrl: `/api/voice/audio/${filename}`
        }
      };
    } catch (error) {
      logger.error('Error testing voice:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getVoiceStats() {
    try {
      const { MongoClient } = await import('mongodb');
      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
      const client = new MongoClient(mongoUri);
      
      await client.connect();
      const db = client.db('lanagent');
      const collection = db.collection('tokenusages');
      
      const allTtsRecords = await collection.find({ requestType: 'tts' }).toArray();
      await client.close();
      
      let totalRequests = allTtsRecords.length;
      let totalCost = 0;
      let monthlyCost = 0;
      let monthlyRequests = 0;
      
      // Get first day of current month
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const firstDayOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      
      for (const record of allTtsRecords) {
        totalCost += record.cost || 0;
        
        // Check if record is from this month
        if (record.createdAt >= firstDayOfMonth && record.createdAt < firstDayOfNextMonth) {
          monthlyCost += record.cost || 0;
          monthlyRequests++;
        }
      }

      const stats = {
        totalRequests,
        totalCost,
        monthlyCost,
        monthlyRequests,
        currentMonth: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      };

      return {
        success: true,
        data: stats
      };
    } catch (error) {
      logger.error('Error getting voice stats:', error);
      return {
        success: false,
        error: error.message
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

  async getAvailableModels() {
    try {
      const models = this.agent.ttsService.getAvailableModels();
      return {
        success: true,
        data: models
      };
    } catch (error) {
      logger.error('Error getting available models:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAvailableVoices() {
    try {
      const voices = this.agent.ttsService.getAvailableVoices();
      return {
        success: true,
        data: voices
      };
    } catch (error) {
      logger.error('Error getting available voices:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getProviders() {
    try {
      const providers = this.agent.ttsService.providers;
      return {
        success: true,
        data: providers
      };
    } catch (error) {
      logger.error('Error getting providers:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getSupportedLanguages() {
    try {
      const languages = await this.agent.ttsService.getSupportedLanguages();
      return {
        success: true,
        data: languages
      };
    } catch (error) {
      logger.error('Error getting supported languages:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async serveAudioFile(data, req, res) {
    try {
      const { filename } = req.params;
      
      if (!filename || !/^voice-test-[\w-]+-\d+\.(mp3|wav|ogg|aac|flac|opus)$/.test(filename)) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      const tempDir = path.join(__dirname, '../../../temp');
      const filepath = path.join(tempDir, filename);

      if (!fs.existsSync(filepath)) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      const stats = fs.statSync(filepath);
      
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.opus': 'audio/opus'
      };

      res.setHeader('Content-Type', mimeTypes[ext] || 'audio/mpeg');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const stream = fs.createReadStream(filepath);
      stream.pipe(res);

      return;
    } catch (error) {
      logger.error('Error serving audio file:', error);
      res.status(500).json({ error: 'Error serving audio file' });
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

  async settings() {
    const result = await this.getVoiceSettings();
    if (result.success) {
      const settings = result.data;
      return `Voice Settings:
- Enabled: ${settings.enabled}
- Provider: ${settings.provider || 'openai'}
- Telegram Responses: ${settings.telegramResponses}
- Model: ${settings.model}
- Voice: ${settings.voice}
- Speed: ${settings.speed}x
- Format: ${settings.format}
- Language: ${settings.language || 'en'}
- Instructions: ${settings.instructions || '(none)'}`;
    } else {
      return `Error: ${result.error}`;
    }
  }

  async test(voice = 'nova', ...textParts) {
    const language = textParts.pop() || 'en';
    const text = textParts.join(' ') || `Hello! This is a test of the ${voice} voice.`;
    
    const result = await this.testVoice({ voice, text, language });
    if (result.success) {
      return `Voice test successful!
- Voice: ${result.data.voice}
- Model: ${result.data.model}
- Cost: $${result.data.cost.toFixed(4)}
- Duration: ${result.data.duration.toFixed(1)}s
- Audio URL: ${result.data.audioUrl}`;
    } else {
      return `Voice test failed: ${result.error}`;
    }
  }

  async enable() {
    try {
      await this.agent.ttsService.updateVoiceSettings({ enabled: true });
      return 'Voice functionality enabled';
    } catch (error) {
      return `Error enabling voice: ${error.message}`;
    }
  }

  async disable() {
    try {
      await this.agent.ttsService.updateVoiceSettings({ enabled: false });
      return 'Voice functionality disabled';
    } catch (error) {
      return `Error disabling voice: ${error.message}`;
    }
  }

  /**
   * Create or update a voice profile
   * @param {Object} data - The data for the voice profile
   * @param {string} data.name - The name of the profile
   * @param {Object} [data.settings] - The settings for the profile
   */
  async createOrUpdateVoiceProfile(data) {
    try {
      const { name, settings } = data;
      if (!name) {
        throw new Error('Profile name is required');
      }
      this.voiceProfiles[name] = settings || {};
      return {
        success: true,
        message: `Voice profile '${name}' created/updated successfully`
      };
    } catch (error) {
      logger.error('Error creating/updating voice profile:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Switch to a different voice profile
   * @param {Object} data - The data for switching profiles
   * @param {string} data.name - The name of the profile to switch to
   */
  async switchVoiceProfile(data) {
    try {
      const { name } = data;
      if (!name || !this.voiceProfiles[name]) {
        throw new Error('Profile not found');
      }
      await this.agent.ttsService.updateVoiceSettings(this.voiceProfiles[name]);
      return {
        success: true,
        message: `Switched to voice profile '${name}'`
      };
    } catch (error) {
      logger.error('Error switching voice profile:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Create a voice profile (wrapper for createOrUpdateVoiceProfile)
   */
  async createVoiceProfile(data) {
    return this.createOrUpdateVoiceProfile(data);
  }

  /**
   * List all available voice profiles
   */
  async listVoiceProfiles() {
    try {
      const profiles = Object.entries(this.voiceProfiles).map(([name, settings]) => ({
        name,
        settings
      }));
      return {
        success: true,
        data: {
          profiles,
          count: profiles.length
        }
      };
    } catch (error) {
      logger.error('Error listing voice profiles:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get voice interaction service status
   */
  async getVoiceInteractionStatus() {
    try {
      if (!this.agent.voiceInteraction) {
        return {
          success: false,
          error: 'Voice interaction service not available'
        };
      }
      return {
        success: true,
        data: this.agent.voiceInteraction.getStatus()
      };
    } catch (error) {
      logger.error('Error getting voice interaction status:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Start voice interaction service
   */
  async startVoiceInteraction() {
    try {
      if (!this.agent.voiceInteraction) {
        return {
          success: false,
          error: 'Voice interaction service not available'
        };
      }
      const result = await this.agent.voiceInteraction.start();
      return {
        success: result,
        message: result ? 'Voice interaction started' : 'Failed to start voice interaction'
      };
    } catch (error) {
      logger.error('Error starting voice interaction:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Stop voice interaction service
   */
  async stopVoiceInteraction() {
    try {
      if (!this.agent.voiceInteraction) {
        return {
          success: false,
          error: 'Voice interaction service not available'
        };
      }
      this.agent.voiceInteraction.stop();
      return {
        success: true,
        message: 'Voice interaction stopped'
      };
    } catch (error) {
      logger.error('Error stopping voice interaction:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update voice interaction configuration
   */
  async updateVoiceInteractionConfig(data) {
    try {
      if (!this.agent.voiceInteraction) {
        return {
          success: false,
          error: 'Voice interaction service not available'
        };
      }
      this.agent.voiceInteraction.updateConfig(data);
      return {
        success: true,
        message: 'Voice interaction config updated',
        data: this.agent.voiceInteraction.getStatus()
      };
    } catch (error) {
      logger.error('Error updating voice interaction config:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Configure Telegram voice settings
   */
  async configureTelegramVoice(data) {
    try {
      const { enabled, autoConvert, respondWithVoice } = data;
      const updates = {};

      if (typeof enabled === 'boolean') {
        updates.telegramVoiceEnabled = enabled;
      }
      if (typeof autoConvert === 'boolean') {
        updates.telegramAutoConvert = autoConvert;
      }
      if (typeof respondWithVoice === 'boolean') {
        updates.telegramResponses = respondWithVoice;
      }

      if (Object.keys(updates).length === 0) {
        return {
          success: false,
          error: 'No valid settings provided. Available: enabled, autoConvert, respondWithVoice'
        };
      }

      await this.agent.ttsService.updateVoiceSettings(updates);

      return {
        success: true,
        message: 'Telegram voice settings updated',
        data: updates
      };
    } catch (error) {
      logger.error('Error configuring Telegram voice:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}