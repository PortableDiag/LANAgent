import { logger } from '../utils/logger.js';
import { DEPLOY_PATH, WAKE_WORD_MODELS_PATH, WAKE_WORD_SAMPLES_PATH, VENV_PATH, SCRIPTS_PATH } from '../utils/paths.js';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const execAsync = promisify(exec);

/**
 * Wake Word Training Service
 * Manages the collection of voice samples and training of custom wake word models
 *
 * Training flow:
 * 1. User triggers training (via WebUI or Telegram command)
 * 2. Agent requests positive samples (user says wake word)
 * 3. Agent requests negative samples (user says other phrases)
 * 4. Training runs with collected samples
 * 5. Model is deployed and tested
 */
export class WakeWordTrainingService {
  constructor(agent) {
    this.agent = agent;

    // Training state
    this.isCollecting = false;
    this.isTraining = false;
    this.collectionPhase = null; // 'positive' or 'negative'
    this.userId = null; // Telegram user ID collecting from

    // Collected samples
    this.positiveSamples = [];
    this.negativeSamples = [];

    // Configuration
    this.config = {
      minPositiveSamples: 15,
      minNegativeSamples: 10,
      targetPositiveSamples: 25,
      targetNegativeSamples: 15,
      sampleDir: WAKE_WORD_SAMPLES_PATH,
      modelDir: WAKE_WORD_MODELS_PATH,
      pythonPath: process.env.PYTHON_PATH || path.join(VENV_PATH, 'bin/python3'),
      trainScript: path.join(SCRIPTS_PATH, 'train_wake_word.py')
    };

    // Training parameters
    this.trainingParams = {
      augmentationsPerSample: 8,
      epochs: 40,
      batchSize: 32,
      negativeHours: 0.5
    };

    logger.info('[WakeWordTraining] Service initialized');
  }

  /**
   * Get the current wake word from agent settings
   */
  getWakeWord() {
    return (process.env.AGENT_NAME || 'alice').toLowerCase();
  }

  /**
   * Get current training status
   */
  getStatus() {
    return {
      isCollecting: this.isCollecting,
      isTraining: this.isTraining,
      collectionPhase: this.collectionPhase,
      positiveSamples: this.positiveSamples.length,
      negativeSamples: this.negativeSamples.length,
      targetPositive: this.config.targetPositiveSamples,
      targetNegative: this.config.targetNegativeSamples,
      wakeWord: this.getWakeWord()
    };
  }

  /**
   * Start the training collection process
   * @param {string} userId - Telegram user ID to collect from
   * @param {string} source - 'telegram' or 'webui'
   */
  async startCollection(userId, source = 'telegram') {
    if (this.isCollecting || this.isTraining) {
      return {
        success: false,
        message: this.isTraining ?
          'Training is already in progress. Please wait.' :
          'Sample collection is already in progress.'
      };
    }

    const wakeWord = this.getWakeWord();

    // Reset state
    this.isCollecting = true;
    this.collectionPhase = 'positive';
    this.userId = userId;
    this.positiveSamples = [];
    this.negativeSamples = [];

    // Create sample directory
    const sampleDir = path.join(this.config.sampleDir, wakeWord, Date.now().toString());
    await fs.mkdir(path.join(sampleDir, 'positive'), { recursive: true });
    await fs.mkdir(path.join(sampleDir, 'negative'), { recursive: true });
    this.currentSampleDir = sampleDir;

    logger.info(`[WakeWordTraining] Started collection for wake word: "${wakeWord}" from user ${userId}`);

    const message = `Let's train a custom wake word model for "${wakeWord}"!\n\n` +
      `**Phase 1: Positive Samples**\n` +
      `Please send ${this.config.targetPositiveSamples} voice messages saying just "${wakeWord}".\n\n` +
      `Tips for best results:\n` +
      `- Vary your tone (normal, questioning, commanding)\n` +
      `- Vary your distance from the microphone\n` +
      `- Say it at different speeds\n` +
      `- Include some background noise variations\n\n` +
      `Send your first voice message when ready! (0/${this.config.targetPositiveSamples})`;

    return {
      success: true,
      message,
      status: this.getStatus()
    };
  }

  /**
   * Cancel the current collection/training
   */
  async cancelCollection() {
    if (!this.isCollecting && !this.isTraining) {
      return {
        success: false,
        message: 'No training in progress to cancel.'
      };
    }

    this.isCollecting = false;
    this.isTraining = false;
    this.collectionPhase = null;
    this.userId = null;
    this.positiveSamples = [];
    this.negativeSamples = [];

    logger.info('[WakeWordTraining] Collection cancelled');

    return {
      success: true,
      message: 'Wake word training cancelled.'
    };
  }

  /**
   * Process a voice sample from Telegram
   * @param {Buffer} audioBuffer - Audio data (OGG format from Telegram)
   * @param {string} oderId - Telegram user ID
   * @returns {Object} Response with next instructions
   */
  async processVoiceSample(audioBuffer, userId) {
    if (!this.isCollecting) {
      return {
        success: false,
        message: 'Not currently collecting samples. Use /train_wakeword to start.'
      };
    }

    if (userId !== this.userId) {
      return {
        success: false,
        message: 'Sample collection is in progress with another user.'
      };
    }

    const wakeWord = this.getWakeWord();

    try {
      // Convert OGG to WAV
      const wavBuffer = await this.convertToWav(audioBuffer);

      // Save sample
      const phase = this.collectionPhase;
      const samples = phase === 'positive' ? this.positiveSamples : this.negativeSamples;
      const targetCount = phase === 'positive' ?
        this.config.targetPositiveSamples :
        this.config.targetNegativeSamples;

      const samplePath = path.join(
        this.currentSampleDir,
        phase,
        `sample_${samples.length.toString().padStart(3, '0')}.wav`
      );

      await fs.writeFile(samplePath, wavBuffer);
      samples.push(samplePath);

      logger.info(`[WakeWordTraining] Saved ${phase} sample ${samples.length}/${targetCount}`);

      // Check if we have enough samples for this phase
      if (samples.length >= targetCount) {
        if (phase === 'positive') {
          // Move to negative phase
          this.collectionPhase = 'negative';

          const message = `Excellent! Got ${samples.length} positive samples.\n\n` +
            `**Phase 2: Negative Samples**\n` +
            `Now send ${this.config.targetNegativeSamples} voice messages saying ` +
            `phrases that DON'T contain "${wakeWord}".\n\n` +
            `Example phrases:\n` +
            `- "What's the weather today"\n` +
            `- "Turn on the lights"\n` +
            `- "Play some music"\n` +
            `- "Set a timer for five minutes"\n` +
            `- Any natural conversation\n\n` +
            `This helps the model learn what NOT to detect.\n` +
            `(0/${this.config.targetNegativeSamples})`;

          return {
            success: true,
            message,
            status: this.getStatus(),
            phaseComplete: true
          };
        } else {
          // Both phases complete - start training
          this.isCollecting = false;
          this.collectionPhase = null;

          const message = `Got all samples! Starting training...\n\n` +
            `- Positive samples: ${this.positiveSamples.length}\n` +
            `- Negative samples: ${this.negativeSamples.length}\n\n` +
            `Training will take a few minutes. I'll notify you when complete.`;

          // Start training in background
          this.startTraining().catch(err => {
            logger.error('[WakeWordTraining] Training failed:', err);
          });

          return {
            success: true,
            message,
            status: this.getStatus(),
            trainingStarted: true
          };
        }
      }

      // Need more samples
      const remaining = targetCount - samples.length;
      const phaseLabel = phase === 'positive' ?
        `"${wakeWord}"` :
        `phrases WITHOUT "${wakeWord}"`;

      return {
        success: true,
        message: `Got it! (${samples.length}/${targetCount})\n` +
          `Send ${remaining} more voice message${remaining > 1 ? 's' : ''} saying ${phaseLabel}.`,
        status: this.getStatus()
      };

    } catch (error) {
      logger.error('[WakeWordTraining] Error processing sample:', error);
      return {
        success: false,
        message: `Error processing voice sample: ${error.message}`
      };
    }
  }

  /**
   * Convert OGG audio to WAV format (16kHz mono)
   */
  async convertToWav(oggBuffer) {
    const tempOgg = path.join(os.tmpdir(), `wakeword_${Date.now()}.ogg`);
    const tempWav = path.join(os.tmpdir(), `wakeword_${Date.now()}.wav`);

    try {
      await fs.writeFile(tempOgg, oggBuffer);

      // Convert using ffmpeg
      await execAsync(
        `ffmpeg -y -i "${tempOgg}" -ar 16000 -ac 1 -f wav "${tempWav}" 2>/dev/null`
      );

      const wavBuffer = await fs.readFile(tempWav);

      // Cleanup
      await fs.unlink(tempOgg).catch(() => {});
      await fs.unlink(tempWav).catch(() => {});

      return wavBuffer;
    } catch (error) {
      // Cleanup on error
      await fs.unlink(tempOgg).catch(() => {});
      await fs.unlink(tempWav).catch(() => {});
      throw error;
    }
  }

  /**
   * Start the training process with collected samples
   */
  async startTraining() {
    if (this.isTraining) {
      return {
        success: false,
        message: 'Training is already in progress.'
      };
    }

    this.isTraining = true;
    const wakeWord = this.getWakeWord();

    logger.info(`[WakeWordTraining] Starting training for "${wakeWord}"`);

    // Notify user
    await this.notifyUser(`Training started for wake word "${wakeWord}"...`);

    try {
      // Run training script
      const result = await this.runTrainingScript();

      if (result.success) {
        // Deploy the model
        await this.deployModel(wakeWord);

        // Notify success
        await this.notifyUser(
          `Wake word training complete!\n\n` +
          `Model: ${wakeWord}_v0.1.onnx\n` +
          `Training accuracy: ${result.accuracy || 'N/A'}\n\n` +
          `The new model is now active. Try saying "${wakeWord}" to test!`
        );

        // Restart voice interaction to use new model
        if (this.agent?.voiceInteraction?.isListening) {
          await this.agent.voiceInteraction.stop();
          await this.agent.voiceInteraction.start();
        }
      } else {
        await this.notifyUser(
          `Wake word training failed: ${result.error}\n\n` +
          `Please try again with /train_wakeword`
        );
      }

      this.isTraining = false;
      return result;

    } catch (error) {
      this.isTraining = false;
      logger.error('[WakeWordTraining] Training error:', error);

      await this.notifyUser(
        `Wake word training failed: ${error.message}\n\n` +
        `Please try again with /train_wakeword`
      );

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Run the Python training script
   */
  async runTrainingScript() {
    const wakeWord = this.getWakeWord();
    const wakeWordSafe = wakeWord.replace(/\s+/g, '_');

    // Build command
    const args = [
      this.config.trainScript,
      '--wake-word', wakeWord,
      '--output-dir', this.config.modelDir,
      '--positive-dir', path.join(this.currentSampleDir, 'positive'),
      '--negative-dir', path.join(this.currentSampleDir, 'negative'),
      '--augmentations', this.trainingParams.augmentationsPerSample.toString(),
      '--epochs', this.trainingParams.epochs.toString(),
      '--batch-size', this.trainingParams.batchSize.toString(),
      '--use-real-samples'
    ];

    logger.info(`[WakeWordTraining] Running: ${this.config.pythonPath} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.pythonPath, args, {
        cwd: path.dirname(this.config.trainScript)
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          logger.info(`[WakeWordTraining] ${line}`);

          // Parse progress updates
          if (line.includes('Epoch')) {
            this.notifyUser(`Training progress: ${line}`).catch(() => {});
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        logger.warn(`[WakeWordTraining] stderr: ${data}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Parse accuracy from output
          const accuracyMatch = stdout.match(/Accuracy:\s*([\d.]+)/i);
          const accuracy = accuracyMatch ? parseFloat(accuracyMatch[1]) : null;

          resolve({
            success: true,
            accuracy,
            output: stdout
          });
        } else {
          resolve({
            success: false,
            error: stderr || `Training exited with code ${code}`,
            output: stdout
          });
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Deploy the trained model
   */
  async deployModel(wakeWord) {
    const wakeWordSafe = wakeWord.replace(/\s+/g, '_');
    const modelSource = path.join(
      this.config.modelDir,
      'models',
      `${wakeWordSafe}_v0.1.onnx`
    );

    // Copy to OpenWakeWord models directory
    const modelDest = path.join(VENV_PATH, `lib/python3.13/site-packages/openwakeword/resources/models/${wakeWordSafe}_v0.1.onnx`);

    try {
      await fs.copyFile(modelSource, modelDest);
      logger.info(`[WakeWordTraining] Deployed model to ${modelDest}`);

      // Update environment to use new model
      // The voice interaction service will pick this up on restart

      return true;
    } catch (error) {
      logger.error(`[WakeWordTraining] Failed to deploy model:`, error);
      throw error;
    }
  }

  /**
   * Send notification to user via Telegram
   */
  async notifyUser(message) {
    if (!this.userId) return;

    try {
      // Try the interfaces map first (TelegramDashboard)
      const telegramInterface = this.agent?.interfaces?.get('telegram');
      if (telegramInterface?.bot) {
        await telegramInterface.bot.telegram.sendMessage(this.userId, message, { parse_mode: 'Markdown' });
        return;
      }

      // Fallback to direct telegram property if it exists
      if (this.agent?.telegram?.sendMessage) {
        await this.agent.telegram.sendMessage(message, { chatId: this.userId });
      }
    } catch (error) {
      logger.error('[WakeWordTraining] Failed to notify user:', error);
    }
  }

  /**
   * Check if a custom model exists for the current wake word
   */
  async hasCustomModel() {
    const wakeWord = this.getWakeWord();
    const wakeWordSafe = wakeWord.replace(/\s+/g, '_');
    const modelPath = path.join(
      this.config.modelDir,
      'models',
      `${wakeWordSafe}_v0.1.onnx`
    );

    try {
      await fs.access(modelPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get info about existing models
   */
  async getModelInfo() {
    const wakeWord = this.getWakeWord();
    const wakeWordSafe = wakeWord.replace(/\s+/g, '_');
    const modelPath = path.join(
      this.config.modelDir,
      'models',
      `${wakeWordSafe}_v0.1.onnx`
    );

    try {
      const stats = await fs.stat(modelPath);
      return {
        exists: true,
        wakeWord,
        modelPath,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        size: stats.size
      };
    } catch {
      return {
        exists: false,
        wakeWord
      };
    }
  }
}

export default WakeWordTrainingService;
