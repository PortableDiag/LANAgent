import { logger } from '../utils/logger.js';
import { DEPLOY_PATH, WAKE_WORD_MODELS_PATH, VENV_PATH, SCRIPTS_PATH } from '../utils/paths.js';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const execAsync = promisify(exec);

/**
 * Voice Interaction Service
 * Handles wake word detection, speech recognition, and voice responses
 * for hands-free interaction with the agent via speaker/microphone
 *
 * Uses sox for audio recording with silence detection and the agent's
 * existing STT service for transcription.
 */
export class VoiceInteractionService {
  constructor(agent) {
    this.agent = agent;
    this.recordProcess = null;
    this.isListening = false;
    this.isProcessingCommand = false;
    this.audioDevice = null;
    this.enabled = false;
    this.listeningLoop = null;

    // Buffer for incomplete sentences (voice commands split across recording chunks)
    this.pendingTranscription = null;
    this.pendingTimeout = null;

    // Configuration
    this.config = {
      wakeWord: (process.env.AGENT_NAME || 'alice').toLowerCase(),
      sampleRate: 16000,
      recordDuration: 5, // Listen in 5 second chunks
      silenceThreshold: '1%',
      silenceDuration: '1.5',
      maxRecordTime: 30, // Max recording time for commands
      audioDevice: process.env.VOICE_AUDIO_DEVICE || null,
      outputDevice: process.env.VOICE_OUTPUT_DEVICE || null,
      // Local wake word detection (OpenWakeWord)
      localWakeWordModel: process.env.VOICE_WAKEWORD_MODEL || 'alexa',
      localWakeWordThreshold: parseFloat(process.env.VOICE_WAKEWORD_THRESHOLD) || 0.5
    };

    logger.info(`[VoiceInteraction] Initialized with wake word: "${this.config.wakeWord}"`);
  }

  /**
   * Initialize the voice interaction service
   */
  async initialize() {
    try {
      // Check if sox is available
      try {
        await execAsync('which sox');
        await execAsync('which arecord');
      } catch {
        logger.warn('[VoiceInteraction] sox or arecord not found, trying to continue anyway');
      }

      // Detect available audio devices
      await this.detectAudioDevices();

      // Check for custom wake word model and use it if available
      await this.detectCustomWakeWordModel();

      logger.info('[VoiceInteraction] Service initialized successfully');

      // Note: Auto-start is now handled by agent.js checkVoiceInteractionAutoStart()
      // which checks the persisted database state before falling back to VOICE_AUTOSTART env var

      return true;
    } catch (error) {
      logger.error('[VoiceInteraction] Initialization failed:', error);
      return false;
    }
  }

  /**
   * Detect available audio input devices using ALSA
   * Prefers eMeet speakerphone, then USB devices, then built-in
   */
  async detectAudioDevices() {
    try {
      // List ALSA capture devices
      const { stdout } = await execAsync('arecord -l 2>/dev/null || true');
      logger.info('[VoiceInteraction] Available audio devices:\n' + stdout);

      // Parse device list - prioritize eMeet, then USB, then any
      let emeetDevice = null;
      let usbDevice = null;
      let anyDevice = null;

      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/card (\d+):.*\[(.*?)\]/i);
        if (match) {
          const cardNum = match[1];
          const deviceName = match[2];
          const lowerName = deviceName.toLowerCase();

          // Prefer eMeet specifically
          if (lowerName.includes('emeet') || lowerName.includes('m0 plus')) {
            emeetDevice = { cardNum, deviceName };
            logger.info(`[VoiceInteraction] Found eMeet device: card ${cardNum} (${deviceName})`);
          }
          // USB audio devices as second preference
          else if (lowerName.includes('usb')) {
            if (!usbDevice) {
              usbDevice = { cardNum, deviceName };
              logger.info(`[VoiceInteraction] Found USB device: card ${cardNum} (${deviceName})`);
            }
          }
          // Any capture device as fallback
          else if (!anyDevice) {
            anyDevice = { cardNum, deviceName };
          }
        }
      }

      // Select best device: eMeet > USB > any
      const selectedDevice = emeetDevice || usbDevice || anyDevice;

      if (selectedDevice) {
        this.audioDevice = selectedDevice.cardNum;
        this.config.audioDevice = selectedDevice.cardNum;
        logger.info(`[VoiceInteraction] Selected audio device: card ${selectedDevice.cardNum} (${selectedDevice.deviceName})`);
      } else {
        logger.warn('[VoiceInteraction] No audio capture devices found');
      }

      return stdout;
    } catch (error) {
      logger.error('[VoiceInteraction] Failed to detect audio devices:', error);
      return '';
    }
  }

  /**
   * Detect and use custom wake word model if available
   */
  async detectCustomWakeWordModel() {
    const wakeWord = this.config.wakeWord;
    const wakeWordSafe = wakeWord.replace(/\s+/g, '_');

    // Check for custom model in wake word models directory
    const customModelPaths = [
      path.join(WAKE_WORD_MODELS_PATH, `models/${wakeWordSafe}_v0.1.onnx`),
      path.join(VENV_PATH, `lib/python3.13/site-packages/openwakeword/resources/models/${wakeWordSafe}_v0.1.onnx`)
    ];

    for (const modelPath of customModelPaths) {
      try {
        await fs.access(modelPath);
        // Custom model exists, use it
        this.config.localWakeWordModel = modelPath;
        logger.info(`[VoiceInteraction] Found custom wake word model: ${modelPath}`);
        return true;
      } catch {
        // Model not found at this path, try next
      }
    }

    logger.info(`[VoiceInteraction] No custom model found for "${wakeWord}", using default: ${this.config.localWakeWordModel}`);
    return false;
  }

  /**
   * Start the voice interaction service - begins continuous listening
   */
  async start() {
    if (this.isListening) {
      logger.warn('[VoiceInteraction] Already listening');
      return false;
    }

    try {
      // Re-detect audio devices each time we start (USB devices may have changed)
      await this.detectAudioDevices();
      await this.detectCustomWakeWordModel();

      this.isListening = true;
      this.enabled = true;

      logger.info(`[VoiceInteraction] Started listening for wake word: "${this.config.wakeWord}" on device hw:${this.audioDevice}`);

      // Notify via Telegram
      if (this.agent?.telegram) {
        this.agent.telegram.sendMessage(
          `Voice interaction started. Say "${this.config.wakeWord}" to activate.`
        ).catch(() => {});
      }

      // Start the listening loop
      this.startListeningLoop();

      return true;
    } catch (error) {
      logger.error('[VoiceInteraction] Failed to start:', error);
      this.isListening = false;
      return false;
    }
  }

  /**
   * Start continuous listening loop
   */
  startListeningLoop() {
    const listenCycle = async () => {
      if (!this.enabled || this.isProcessingCommand) {
        // Schedule next cycle
        if (this.enabled) {
          this.listeningLoop = setTimeout(listenCycle, 500);
        }
        return;
      }

      try {
        // Record a short audio segment
        const audioBuffer = await this.recordShortSegment();

        if (audioBuffer && audioBuffer.length > 1000) {
          // Check if audio has actual speech (voice activity detection)
          const hasVoice = this.detectVoiceActivity(audioBuffer);
          if (!hasVoice) {
            // Skip detection for silence
            if (this.enabled) {
              this.listeningLoop = setTimeout(listenCycle, 100);
            }
            return;
          }

          // Use local wake word detection first (no API call)
          const localDetection = await this.detectWakeWordLocally(audioBuffer);

          if (localDetection.detected) {
            logger.info(`[VoiceInteraction] Local wake word detected (score: ${localDetection.score.toFixed(2)})`);

            // Wake word detected locally - now transcribe for the full command
            logger.info(`[VoiceInteraction] Transcribing for command...`);
            const transcription = await this.transcribeAudio(audioBuffer);

            if (transcription && transcription.trim().length > 0) {
              logger.info(`[VoiceInteraction] Heard: "${transcription}"`);

              // Extract command (remove wake word if present in transcription)
              let command = this.extractCommandFromTranscription(transcription);

              // Check if there's a pending incomplete transcription to combine
              if (this.pendingTranscription) {
                command = this.pendingTranscription + ' ' + command;
                this.pendingTranscription = null;
                if (this.pendingTimeout) {
                  clearTimeout(this.pendingTimeout);
                  this.pendingTimeout = null;
                }
                logger.info(`[VoiceInteraction] Combined with pending: "${command}"`);
              }

              if (command && command.length > 2) {
                // Check if the sentence seems incomplete
                if (this.isIncompleteSentence(command)) {
                  logger.info(`[VoiceInteraction] Incomplete sentence detected, waiting for more: "${command}"`);
                  this.pendingTranscription = command;
                  // Set a timeout to process anyway if no continuation comes
                  this.pendingTimeout = setTimeout(async () => {
                    if (this.pendingTranscription) {
                      logger.info(`[VoiceInteraction] Timeout, processing incomplete: "${this.pendingTranscription}"`);
                      const pending = this.pendingTranscription;
                      this.pendingTranscription = null;
                      await this.processCommand(pending);
                    }
                  }, 8000); // Wait 8 seconds for continuation
                } else {
                  // Command is complete, process it
                  await this.processCommand(command);
                }
              } else {
                // Just wake word, listen for command
                await this.onWakeWordDetected();
              }
            } else {
              // Wake word detected but no clear transcription - listen for command
              await this.onWakeWordDetected();
            }
          } else if (this.pendingTranscription) {
            // No wake word but we have pending transcription - try to get continuation
            const transcription = await this.transcribeAudio(audioBuffer);
            if (transcription && transcription.trim().length > 2) {
              // Filter out hallucinations before combining
              const filtered = this.filterHallucinations(transcription);
              if (filtered) {
                const command = this.pendingTranscription + ' ' + filtered;
                this.pendingTranscription = null;
                if (this.pendingTimeout) {
                  clearTimeout(this.pendingTimeout);
                  this.pendingTimeout = null;
                }
                logger.info(`[VoiceInteraction] Continuation received: "${command}"`);

                // Check if still incomplete
                if (this.isIncompleteSentence(command)) {
                  this.pendingTranscription = command;
                  this.pendingTimeout = setTimeout(async () => {
                    if (this.pendingTranscription) {
                      const pending = this.pendingTranscription;
                      this.pendingTranscription = null;
                      await this.processCommand(pending);
                    }
                  }, 8000);
                } else {
                  await this.processCommand(command);
                }
              }
            }
          }
          // If no local wake word detected and no pending, skip entirely (no API call!)
        }
      } catch (error) {
        logger.error('[VoiceInteraction] Error in listening loop:', error);
      }

      // Schedule next cycle if still enabled
      if (this.enabled) {
        this.listeningLoop = setTimeout(listenCycle, 100);
      }
    };

    // Start the loop
    listenCycle();
  }

  /**
   * Apply noise reduction to audio file using ffmpeg
   * Uses highpass filter (cuts fan noise) and afftdn (FFT-based denoiser)
   */
  async applyNoiseReduction(inputFile, outputFile) {
    try {
      // ffmpeg noise reduction pipeline:
      // - highpass=f=200: Cut frequencies below 200Hz (fan/HVAC noise)
      // - afftdn=nf=-20: FFT-based denoiser with -20dB noise floor
      // - volume=1.5: Boost volume slightly after noise reduction
      await execAsync(
        `ffmpeg -y -i "${inputFile}" -af "highpass=f=200, afftdn=nf=-20, volume=1.5" -ar ${this.config.sampleRate} -ac 1 "${outputFile}" 2>/dev/null`
      );
      return true;
    } catch (error) {
      logger.debug('[VoiceInteraction] Noise reduction failed, using original:', error.message);
      return false;
    }
  }

  /**
   * Record a short audio segment for wake word detection
   */
  async recordShortSegment() {
    return new Promise((resolve) => {
      const tempFile = path.join(os.tmpdir(), `voice_segment_${Date.now()}.wav`);
      const monoFile = path.join(os.tmpdir(), `voice_segment_mono_${Date.now()}.wav`);
      const cleanFile = path.join(os.tmpdir(), `voice_segment_clean_${Date.now()}.wav`);

      // Build arecord command - use stereo as required by USB devices like eMeet
      const deviceArg = this.audioDevice ? `-D hw:${this.audioDevice},0` : '';
      const recordCmd = `arecord ${deviceArg} -f S16_LE -r ${this.config.sampleRate} -c 2 -d ${this.config.recordDuration} "${tempFile}" 2>/dev/null`;

      exec(recordCmd, { timeout: (this.config.recordDuration + 2) * 1000 }, async (error) => {
        try {
          const stats = await fs.stat(tempFile).catch(() => null);
          if (stats && stats.size > 1000) {
            // Convert stereo to mono for STT (most APIs expect mono)
            await execAsync(`sox "${tempFile}" -c 1 "${monoFile}" 2>/dev/null`).catch(() => {});

            // Apply noise reduction
            let buffer;
            const monoStats = await fs.stat(monoFile).catch(() => null);
            if (monoStats && monoStats.size > 500) {
              // Try to apply noise reduction
              const noiseReduced = await this.applyNoiseReduction(monoFile, cleanFile);
              const cleanStats = await fs.stat(cleanFile).catch(() => null);

              if (noiseReduced && cleanStats && cleanStats.size > 500) {
                buffer = await fs.readFile(cleanFile);
              } else {
                buffer = await fs.readFile(monoFile);
              }
            } else {
              buffer = await fs.readFile(tempFile);
            }

            await fs.unlink(tempFile).catch(() => {});
            await fs.unlink(monoFile).catch(() => {});
            await fs.unlink(cleanFile).catch(() => {});
            resolve(buffer);
          } else {
            await fs.unlink(tempFile).catch(() => {});
            resolve(null);
          }
        } catch {
          await fs.unlink(tempFile).catch(() => {});
          await fs.unlink(monoFile).catch(() => {});
          await fs.unlink(cleanFile).catch(() => {});
          resolve(null);
        }
      });
    });
  }

  /**
   * Stop the voice interaction service
   */
  stop() {
    this.enabled = false;

    if (this.listeningLoop) {
      clearTimeout(this.listeningLoop);
      this.listeningLoop = null;
    }

    if (this.recordProcess) {
      this.recordProcess.kill();
      this.recordProcess = null;
    }

    this.isListening = false;
    logger.info('[VoiceInteraction] Stopped');
  }

  /**
   * Called when wake word is detected
   */
  async onWakeWordDetected() {
    if (this.isProcessingCommand) return;
    this.isProcessingCommand = true;

    logger.info('[VoiceInteraction] Wake word detected, listening for command...');

    // Play acknowledgment sound
    await this.playAcknowledgment();

    // Record full command with silence detection
    try {
      const audioBuffer = await this.recordCommand();
      if (audioBuffer) {
        await this.processAudioCommand(audioBuffer);
      } else {
        await this.speak("I didn't catch that. Please try again.");
      }
    } catch (error) {
      logger.error('[VoiceInteraction] Error recording command:', error);
      await this.speak("Sorry, I couldn't hear you clearly. Please try again.");
    }

    this.isProcessingCommand = false;
  }

  /**
   * Record audio command with silence detection
   */
  async recordCommand() {
    return new Promise((resolve, reject) => {
      const tempFile = path.join(os.tmpdir(), `voice_cmd_${Date.now()}.wav`);
      const monoFile = path.join(os.tmpdir(), `voice_cmd_mono_${Date.now()}.wav`);
      const cleanFile = path.join(os.tmpdir(), `voice_cmd_clean_${Date.now()}.wav`);

      // Use arecord for stereo recording (USB mics often require stereo)
      const deviceArg = this.audioDevice ? `-D hw:${this.audioDevice},0` : '';

      // Record with arecord in stereo, then use sox for silence trimming
      const recordCmd = `arecord ${deviceArg} -f S16_LE -r ${this.config.sampleRate} -c 2 -d ${this.config.maxRecordTime} "${tempFile}" 2>/dev/null`;

      logger.debug(`[VoiceInteraction] Recording command...`);

      const timeout = setTimeout(() => {
        exec(`pkill -f "arecord.*${tempFile}"`, () => {});
      }, (this.config.maxRecordTime + 2) * 1000);

      exec(recordCmd, { timeout: (this.config.maxRecordTime + 5) * 1000 }, async (error) => {
        clearTimeout(timeout);

        try {
          const stats = await fs.stat(tempFile).catch(() => null);
          if (stats && stats.size > 1000) {
            // Convert to mono and trim silence
            await execAsync(
              `sox "${tempFile}" -c 1 "${monoFile}" silence 1 0.1 ${this.config.silenceThreshold} 1 ${this.config.silenceDuration} ${this.config.silenceThreshold} 2>/dev/null`
            ).catch(() => {});

            let buffer;
            const monoStats = await fs.stat(monoFile).catch(() => null);
            if (monoStats && monoStats.size > 500) {
              // Apply noise reduction to command audio
              const noiseReduced = await this.applyNoiseReduction(monoFile, cleanFile);
              const cleanStats = await fs.stat(cleanFile).catch(() => null);

              if (noiseReduced && cleanStats && cleanStats.size > 500) {
                buffer = await fs.readFile(cleanFile);
              } else {
                buffer = await fs.readFile(monoFile);
              }
            } else {
              buffer = await fs.readFile(tempFile);
            }

            await fs.unlink(tempFile).catch(() => {});
            await fs.unlink(monoFile).catch(() => {});
            await fs.unlink(cleanFile).catch(() => {});
            resolve(buffer);
          } else {
            await fs.unlink(tempFile).catch(() => {});
            resolve(null);
          }
        } catch (err) {
          await fs.unlink(tempFile).catch(() => {});
          await fs.unlink(monoFile).catch(() => {});
          await fs.unlink(cleanFile).catch(() => {});
          reject(err);
        }
      });
    });
  }

  /**
   * Process recorded audio command
   */
  async processAudioCommand(audioBuffer) {
    try {
      // Transcribe audio
      const transcription = await this.transcribeAudio(audioBuffer);

      if (!transcription || transcription.trim().length < 2) {
        logger.info('[VoiceInteraction] No speech detected');
        await this.speak("I didn't catch that. Please say your command again.");
        return;
      }

      logger.info(`[VoiceInteraction] Command transcribed: "${transcription}"`);

      // Process command via agent
      await this.processCommand(transcription);
    } catch (error) {
      logger.error('[VoiceInteraction] Error processing audio command:', error);
      await this.speak("Sorry, I encountered an error.");
    }
  }

  /**
   * Transcribe audio buffer to text using the agent's STT service
   */
  async transcribeAudio(audioBuffer) {
    try {
      // Use the agent's provider manager for transcription
      if (this.agent?.providerManager) {
        const result = await this.agent.providerManager.transcribeAudio(audioBuffer);
        return result;
      }

      logger.error('[VoiceInteraction] No provider available for transcription');
      return null;
    } catch (error) {
      logger.error('[VoiceInteraction] Transcription error:', error);
      return null;
    }
  }

  /**
   * Detect wake word locally using OpenWakeWord (no API call)
   * Returns { detected: boolean, score: number }
   */
  async detectWakeWordLocally(audioBuffer) {
    try {
      // Save audio to temp file for Python script
      const tempFile = path.join(os.tmpdir(), `wakeword_${Date.now()}.wav`);
      await fs.writeFile(tempFile, audioBuffer);

      // Run Python wake word detector
      const pythonPath = process.env.PYTHON_PATH || path.join(VENV_PATH, 'bin/python3');
      const scriptPath = path.join(SCRIPTS_PATH, 'wake_word_detector.py');
      const model = this.config.localWakeWordModel || 'alexa';
      const threshold = this.config.localWakeWordThreshold || 0.5;

      // Use --model-path for full paths, --model for model names
      const modelArg = model.includes('/') ? `--model-path "${model}" --custom` : `--model ${model}`;
      const cmd = `${pythonPath} ${scriptPath} ${modelArg} --threshold ${threshold} --audio-file "${tempFile}"`;

      try {
        const { stdout } = await execAsync(cmd, { timeout: 5000 });
        await fs.unlink(tempFile).catch(() => {});

        const result = JSON.parse(stdout.trim());
        return {
          detected: result.detected || false,
          score: result.score || 0,
          model: result.model
        };
      } catch (execError) {
        // Python script exits with code 1 if wake word not detected (expected)
        await fs.unlink(tempFile).catch(() => {});

        // Try to parse output even on non-zero exit
        if (execError.stdout) {
          try {
            const result = JSON.parse(execError.stdout.trim());
            return {
              detected: result.detected || false,
              score: result.score || 0,
              model: result.model
            };
          } catch {
            // Parse failed, no wake word
          }
        }

        return { detected: false, score: 0 };
      }
    } catch (error) {
      logger.warn('[VoiceInteraction] Local wake word detection error:', error.message);
      // Fall back to assuming no wake word on error
      return { detected: false, score: 0 };
    }
  }

  /**
   * Extract command from transcription by removing wake word
   */
  extractCommandFromTranscription(transcription) {
    if (!transcription) return null;

    const lower = transcription.toLowerCase();
    const wakeWord = this.config.wakeWord;
    const variations = this.getWakeWordVariations(wakeWord);

    // Also check for "alexa" since that's our local wake word model
    variations.push('alexa', 'hey alexa', 'ok alexa');

    for (const variation of variations) {
      const idx = lower.indexOf(variation);
      if (idx !== -1) {
        // Extract everything after the wake word
        const afterWakeWord = transcription.substring(idx + variation.length).trim();
        // Remove leading punctuation/comma
        return afterWakeWord.replace(/^[,.\s]+/, '').trim();
      }
    }

    // No wake word found in transcription, return as-is
    return transcription.trim();
  }

  /**
   * Detect if a sentence appears incomplete and needs continuation
   * This helps prevent processing fragments when the user pauses mid-sentence
   */
  isIncompleteSentence(text) {
    if (!text) return false;

    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // Very short fragments are likely incomplete
    if (trimmed.length < 8) return true;

    // Sentences ending with incomplete indicators
    const incompleteEndings = [
      ' is', ' is.', ' are', ' are.', ' the', ' a', ' an', ' my', ' your',
      ' that', ' which', ' who', ' what', ' where', ' when', ' how',
      ' with', ' for', ' to', ' from', ' by', ' at', ' in', ' on',
      ' and', ' or', ' but', ' because', ' since', ' if', ' unless',
      ' about', ' like', ' such', ' very', ' really', ' just',
      ' remember that', ' know that', ' think that', ' said that',
      ' specter is', ' it is', ' she is', ' he is', ' they are'
    ];

    for (const ending of incompleteEndings) {
      if (lower.endsWith(ending)) {
        return true;
      }
    }

    // Check for trailing punctuation that suggests completion
    const completeEndings = ['.', '!', '?', '"', "'"];
    const lastChar = trimmed.slice(-1);
    if (completeEndings.includes(lastChar) && trimmed.length > 15) {
      // Ends with sentence punctuation and is reasonably long
      return false;
    }

    // If it's moderately long without obvious incomplete markers, consider it complete
    if (trimmed.length > 30) return false;

    return false;
  }

  /**
   * Handle simple voice commands directly without going through full AI intent detection
   * Returns response string if handled, null if should pass to agent
   */
  handleSimpleCommand(command) {
    const lower = command.toLowerCase().trim();

    // Time queries
    if (lower.includes('what time') || lower.includes('current time') || lower.match(/^,?\s*time\??$/)) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      return `It's ${timeStr}.`;
    }

    // Date queries
    if (lower.includes('what date') || lower.includes("today's date") || lower.includes('what day')) {
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      return `Today is ${dateStr}.`;
    }

    // Hello/greeting
    if (lower.match(/^,?\s*(hello|hi|hey)\s*\.?$/)) {
      return "Hello! How can I help you?";
    }

    // How are you
    if (lower.includes('how are you')) {
      return "I'm doing well, thank you for asking! How can I assist you?";
    }

    // What can you do
    if (lower.includes('what can you do') || lower.includes('what are you capable')) {
      return "I can help with system tasks, check the time, manage your calendar, control smart devices, and much more. Just ask!";
    }

    return null; // Not a simple command, pass to agent
  }

  /**
   * Process a text command through the agent
   */
  async processCommand(command) {
    this.isProcessingCommand = true;

    try {
      logger.info(`[VoiceInteraction] Processing command: "${command}"`);

      // Try simple command handler first
      const simpleResponse = this.handleSimpleCommand(command);
      if (simpleResponse) {
        logger.info(`[VoiceInteraction] Handled as simple command`);
        await this.speak(simpleResponse);
        return;
      }

      // Process via agent for complex commands
      if (this.agent) {
        const response = await this.agent.processNaturalLanguage(command, {
          userId: 'voice_interaction',
          userName: 'Voice User',
          source: 'voice'
        });

        // Speak the response
        if (response) {
          const cleanResponse = this.cleanForSpeech(response);
          await this.speak(cleanResponse);
        }
      }
    } catch (error) {
      logger.error('[VoiceInteraction] Command processing error:', error);
      await this.speak("Sorry, I encountered an error processing your request.");
    } finally {
      this.isProcessingCommand = false;
    }
  }

  /**
   * Clean text for speech output (remove markdown, etc.)
   */
  cleanForSpeech(text) {
    if (!text) return '';

    // Handle object responses (extract text content)
    if (typeof text === 'object') {
      text = text.response || text.message || text.text || text.content || JSON.stringify(text);
    }

    // Ensure we have a string
    if (typeof text !== 'string') {
      text = String(text);
    }

    let clean = text
      .replace(/```[\s\S]*?```/g, 'code block omitted')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#{1,6}\s?/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, 'image')
      .replace(/^\s*[-*+]\s/gm, '')
      .replace(/^\s*\d+\.\s/gm, '')
      .replace(/\n{3,}/g, '\n\n');

    // Truncate if too long
    if (clean.length > 1000) {
      clean = clean.substring(0, 1000) + '... Response truncated.';
    }

    return clean.trim();
  }

  /**
   * Get variations of the wake word that Whisper might transcribe
   * This helps catch misheard versions of the wake word
   */
  getWakeWordVariations(wakeWord) {
    const lower = wakeWord.toLowerCase();
    const variations = [lower];

    // Add common variations for specific wake words
    // Only include variations that are unlikely to match common words
    if (lower === 'alice') {
      variations.push(
        'hey alice', 'hi alice', 'ok alice', 'okay alice',
        'alice,',  // Often transcribed with comma
        'ellis', 'elise', 'elice', 'alyss',
        'allice', 'allis', 'allas'
      );
    }

    // Generic phonetic variations
    variations.push(
      `hey ${lower}`,
      `hi ${lower}`,
      `ok ${lower}`,
      `okay ${lower}`
    );

    return variations;
  }

  /**
   * Detect if audio buffer contains voice activity (not just silence/noise)
   * Uses RMS energy calculation on the raw PCM data
   */
  detectVoiceActivity(audioBuffer) {
    try {
      // WAV header is 44 bytes, PCM data starts after
      const pcmData = audioBuffer.slice(44);

      // Calculate RMS energy of the audio
      let sum = 0;
      const samples = pcmData.length / 2; // 16-bit samples

      for (let i = 0; i < pcmData.length - 1; i += 2) {
        // Read 16-bit signed integer (little endian)
        const sample = pcmData.readInt16LE(i);
        sum += sample * sample;
      }

      const rms = Math.sqrt(sum / samples);
      const normalizedRms = rms / 32768; // Normalize to 0-1

      // Threshold for voice detection - higher threshold for noisy environments
      const threshold = 0.015; // ~1.5% of max amplitude (raised for server room with fans)
      const hasVoice = normalizedRms > threshold;

      logger.debug(`[VoiceInteraction] Audio RMS: ${normalizedRms.toFixed(4)}, threshold: ${threshold}, hasVoice: ${hasVoice}`);

      return hasVoice;
    } catch (error) {
      logger.warn('[VoiceInteraction] VAD error:', error.message);
      return true; // Assume voice on error
    }
  }

  /**
   * Filter out common Whisper hallucinations that occur on silence/noise
   */
  filterHallucinations(text) {
    if (!text) return null;

    const hallucinations = [
      'thank you for watching',
      'thanks for watching',
      'thank you so much for joining',
      'thank you for joining',
      "we'll see you next time",
      'please subscribe',
      'like and subscribe',
      'like, comment and subscribe',
      "don't forget to like",
      'comment and subscribe',
      'see you next time',
      'take care',
      'thank you',
      'oh yeah',
      'bye bye',
      'goodbye',
      'bra-bra',
      'yum-yum',
      'la la la',
      'na na na',
      'do do do',
      'mm-hmm',
      'uh-huh',
      'and and',
      '...',
      '♪',
      '🙏',
      'music',
      'applause',
      'silence',
      'inaudible',
      'choking',
      'coughing',
      'sighing',
      'breathing',
      // Japanese hallucinations
      'ご視聴ありがとうございました',
      'チャンネル登録',
      'よろしくお願いします',
      // Chinese hallucinations
      '谢谢观看',
      '订阅',
      // Korean hallucinations
      '시청해주셔서',
      '구독'
    ];

    const lower = text.toLowerCase().trim();

    // Check if it's a known hallucination
    for (const h of hallucinations) {
      if (lower.includes(h)) {
        return null;
      }
    }

    // Filter emoji-only responses (Whisper sometimes outputs these on noise)
    if (/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+$/u.test(text)) {
      return null;
    }

    // Filter very short or repetitive text
    if (lower.length < 3) return null;
    if (/^(.)\1+$/.test(lower.replace(/\s/g, ''))) return null; // All same char

    // Filter responses that are just single repeated words
    const words = lower.split(/\s+/);
    if (words.length <= 3 && new Set(words).size === 1) return null;

    return text.trim();
  }

  /**
   * Play acknowledgment sound when wake word is detected
   */
  async playAcknowledgment() {
    try {
      const deviceNum = this.audioDevice || this.config.outputDevice;
      const beepFile = path.join(os.tmpdir(), 'ack_beep.wav');

      // Generate beep and convert to 48kHz stereo for USB speaker
      await execAsync(
        `sox -n -r 48000 -c 2 "${beepFile}" synth 0.15 sine 800 vol 0.5 2>/dev/null`
      );

      if (deviceNum) {
        await execAsync(`aplay -D hw:${deviceNum},0 "${beepFile}" 2>/dev/null`);
      } else {
        await execAsync(`aplay "${beepFile}" 2>/dev/null || play "${beepFile}" 2>/dev/null`);
      }

      await fs.unlink(beepFile).catch(() => {});
    } catch {
      // Ignore errors - not critical
    }
  }

  /**
   * Speak text using TTS and play through speakers
   */
  async speak(text) {
    if (!text) return;

    try {
      logger.info(`[VoiceInteraction] Speaking: "${text.substring(0, 100)}..."`);

      // Use agent's TTS service
      if (this.agent?.ttsService) {
        // Pass source: 'voice' to prevent double playback when speakThroughServer is enabled
        const result = await this.agent.ttsService.generateSpeech(text, { source: 'voice' });

        if (result?.buffer) {
          await this.playAudio(result.buffer, result.format || 'mp3');
        }
      } else {
        logger.warn('[VoiceInteraction] TTS service not available');
      }
    } catch (error) {
      logger.error('[VoiceInteraction] TTS error:', error);
    }
  }

  /**
   * Play audio buffer through speakers
   * Converts to stereo 48kHz WAV for USB speakers like eMeet
   */
  async playAudio(audioBuffer, format = 'mp3') {
    const tempFile = path.join(os.tmpdir(), `voice_response_${Date.now()}.${format}`);
    const stereoFile = path.join(os.tmpdir(), `voice_response_stereo_${Date.now()}.wav`);

    try {
      await fs.writeFile(tempFile, audioBuffer);

      // Convert to stereo 48kHz WAV for USB speaker compatibility
      const deviceNum = this.audioDevice || this.config.outputDevice;
      if (deviceNum) {
        // Convert for USB device (stereo, 48kHz)
        await execAsync(`sox "${tempFile}" -r 48000 -c 2 "${stereoFile}" 2>/dev/null`).catch(() => {});

        const stereoStats = await fs.stat(stereoFile).catch(() => null);
        if (stereoStats && stereoStats.size > 1000) {
          // Play through specific device
          await execAsync(`aplay -D hw:${deviceNum},0 "${stereoFile}" 2>/dev/null`).catch((e) => {
            logger.debug('[VoiceInteraction] aplay error, trying ffplay:', e.message);
            return execAsync(`ffplay -nodisp -autoexit "${stereoFile}" 2>/dev/null`);
          });
        } else {
          // Fallback to ffplay
          await execAsync(`ffplay -nodisp -autoexit "${tempFile}" 2>/dev/null`).catch(() => {});
        }
      } else {
        // No specific device, use default playback
        await execAsync(
          `ffplay -nodisp -autoexit "${tempFile}" 2>/dev/null || ` +
          `play "${tempFile}" 2>/dev/null`
        ).catch(() => {});
      }
    } catch (error) {
      logger.error('[VoiceInteraction] Playback error:', error);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
      await fs.unlink(stereoFile).catch(() => {});
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };

    // Update wake word if changed
    if (newConfig.wakeWord) {
      this.config.wakeWord = newConfig.wakeWord.toLowerCase();
    }

    // Update audio device if changed
    if (newConfig.audioDevice !== undefined) {
      this.audioDevice = newConfig.audioDevice;
    }

    logger.info('[VoiceInteraction] Config updated:', this.config);
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      isListening: this.isListening,
      isProcessingCommand: this.isProcessingCommand,
      wakeWord: this.config.wakeWord,
      audioDevice: this.audioDevice,
      config: this.config
    };
  }
}

export default VoiceInteractionService;
