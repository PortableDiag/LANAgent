import { Telegraf, Markup, session } from 'telegraf';
import { message } from 'telegraf/filters';
import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';

export class TelegramInterface extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.bot = null;
    this.authorizedUserId = process.env.TELEGRAM_USER_ID;
    this.isRunning = false;
  }

  async initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN not found in environment');
    }

    this.bot = new Telegraf(token);
    
    // Use session middleware
    this.bot.use(session());

    // Authorization middleware
    this.bot.use(async (ctx, next) => {
      if (ctx.from && ctx.from.id.toString() === this.authorizedUserId) {
        return next();
      }
      logger.warn(`Unauthorized access attempt from user: ${ctx.from?.id}`);
      return await ctx.reply('❌ Unauthorized. This bot is private.');
    });

    // Error handling
    this.bot.catch(async (err, ctx) => {
      logger.error('Telegram bot error:', err);
      await ctx.reply('❌ An error occurred while processing your request.');
    });

    this.setupCommands();
    this.setupTextHandler();
    this.setupCallbackHandlers();
  }

  setupCommands() {
    // Start command
    this.bot.command('start', async (ctx) => {
      const agentName = this.agent.config.name;
      await ctx.reply(
        `🤖 Hello! I'm ${agentName}, your personal AI assistant.\n\n` +
        `I'm here to help you with:\n` +
        `• 🖥️ System administration\n` +
        `• 🔧 Development tasks\n` +
        `• 📊 Network monitoring\n` +
        `• 🤖 Microcontroller projects\n` +
        `• 🔍 Research and automation\n\n` +
        `Type /help for available commands or just tell me what you need!`
      );
    });

    // Help command
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        `📚 *Available Commands:*\n\n` +
        `/status - System and agent status\n` +
        `/tasks - View current tasks\n` +
        `/update - Update system packages\n` +
        `/backup - Create system backup\n` +
        `/monitor - Network monitoring\n` +
        `/develop - Development mode\n` +
        `/arduino - Microcontroller control\n` +
        `/ai - AI provider settings\n` +
        `/vpn - VPN management\n` +
        `/services - Manage services\n` +
        `/logs - View recent logs\n` +
        `/journal - Start/stop journal mode\n` +
        `/cancel - Cancel current operation\n` +
        `/newchat - Clear chat context and start fresh\n` +
        `/clearall - Clear chat context and start fresh\n\n` +
        `Or just send me a message with what you need!`,
        { parse_mode: 'Markdown' }
      );
    });

    // Status command
    this.bot.command('status', async (ctx) => {
      await ctx.reply('🔄 Checking system status...');
      try {
        const status = await this.agent.getSystemStatus();
        const statusMessage = this.formatStatusMessage(status);
        await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Failed to get status:', error);
        await ctx.reply('❌ Failed to retrieve system status');
      }
    });

    // Tasks command
    this.bot.command('tasks', async (ctx) => {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📋 View Tasks', 'view_tasks')],
        [Markup.button.callback('➕ Add Task', 'add_task')],
        [Markup.button.callback('🏃 Running Tasks', 'running_tasks')]
      ]);
      await ctx.reply('📋 Task Management:', keyboard);
    });

    // AI provider command
    this.bot.command('ai', async (ctx) => {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🤖 OpenAI', 'ai_openai')],
        [Markup.button.callback('🧠 Anthropic', 'ai_anthropic')],
        [Markup.button.callback('🌟 X.AI', 'ai_xai')],
        [Markup.button.callback('💬 Gab AI', 'ai_gab')],
        [Markup.button.callback('🤗 HuggingFace', 'ai_huggingface')],
        [Markup.button.callback('⚡ BitNet (Local)', 'ai_bitnet')],
        [Markup.button.callback('⚙️ Current Provider', 'ai_current')]
      ]);
      await ctx.reply('🤖 Select AI Provider:', keyboard);
    });

    // Services command
    this.bot.command('services', async (ctx) => {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 List Services', 'services_list')],
        [Markup.button.callback('▶️ Start Service', 'services_start')],
        [Markup.button.callback('⏹️ Stop Service', 'services_stop')],
        [Markup.button.callback('🔄 Restart Service', 'services_restart')]
      ]);
      await ctx.reply('🛠️ Service Management:', keyboard);
    });

    // Logs command
    this.bot.command('logs', async (ctx) => {
      try {
        await ctx.reply('📜 Fetching recent logs...');
        
        const history = this.agent.systemExecutor?.getHistory(10) || [];
        
        if (history.length === 0) {
          await ctx.reply('📜 No recent commands in history.');
          return;
        }
        
        let message = '📜 *Recent Command History:*\n\n';
        history.forEach((entry, index) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const status = entry.result.success ? '✅' : '❌';
          message += `${status} *[${time}]* \`${entry.command}\`\n`;
        });
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Logs command error:', error);
        await ctx.reply('❌ Failed to fetch logs.');
      }
    });

    // Cancel command
    this.bot.command('cancel', async (ctx) => {
      if (ctx.session?.currentOperation) {
        // Close journal session properly if in journal mode
        if (ctx.session.currentOperation === 'journal') {
          try {
            const journalPlugin = this.agent.apiManager?.apis?.get('journal');
            if (journalPlugin?.instance) {
              const result = await journalPlugin.instance.execute({
                action: 'stop',
                userId: ctx.from.id.toString()
              });
              ctx.session.currentOperation = null;
              ctx.session.journalId = null;
              await ctx.reply(result.result || 'Journal session saved and closed.');
              return;
            }
          } catch (error) {
            logger.error('Error closing journal on cancel:', error);
          }
        }
        ctx.session.currentOperation = null;
        await ctx.reply('Operation cancelled.');
      } else {
        await ctx.reply('No active operation to cancel.');
      }
    });

    // AI content detection command
    this.bot.command('aidetect', async (ctx) => {
      if (ctx.session?.currentOperation === 'ai_detect') {
        ctx.session.currentOperation = null;
        await ctx.reply('🔍 AI detection mode ended.');
        return;
      }
      ctx.session = ctx.session || {};
      ctx.session.currentOperation = 'ai_detect';
      await ctx.reply(
        '🔍 *AI Content Detection Mode*\n\n' +
        'Send me content to analyze:\n' +
        '• 📝 Paste text to check if it was AI-written\n' +
        '• 🖼️ Send an image to check if it was AI-generated\n' +
        '• 🎤 Send a voice message or audio file\n' +
        '• 📹 Send a video as a document\n\n' +
        'Type "done" or /cancel to exit.',
        { parse_mode: 'Markdown' }
      );
    });

    // Journal command
    this.bot.command('journal', async (ctx) => {
      try {
        const journalPlugin = this.agent.apiManager?.apis?.get('journal');
        if (!journalPlugin?.instance) {
          await ctx.reply('Journal plugin not available.');
          return;
        }

        // Check if already in journal mode
        if (ctx.session?.currentOperation === 'journal') {
          // Stop the journal
          const result = await journalPlugin.instance.execute({
            action: 'stop',
            userId: ctx.from.id.toString()
          });
          ctx.session.currentOperation = null;
          ctx.session.journalId = null;
          await ctx.reply(result.result || 'Journal session closed.');
          return;
        }

        const result = await journalPlugin.instance.execute({
          action: 'start',
          userId: ctx.from.id.toString()
        });

        if (result.success && result.enterMode) {
          ctx.session.currentOperation = 'journal';
          ctx.session.journalId = result.journalId;
          await ctx.reply(
            '*Journal Mode Active*\n\n' +
            'Everything you type or say will be recorded.\n' +
            'Use voice messages for hands-free recording.\n\n' +
            'Say "done journaling" or use /journal again to stop.',
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.reply(result.result || 'Could not start journal.');
        }
      } catch (error) {
        logger.error('Error with journal command:', error);
        await ctx.reply('Failed to manage journal mode.');
      }
    });

    // New chat / clear all command
    this.bot.command(['newchat', 'clearall'], async (ctx) => {
      const userId = ctx.from.id;

      // Clear conversation history from memory
      try {
        await this.agent.memoryManager.clearConversationHistory(userId);

        // Reset session
        ctx.session = {};

        await ctx.reply('🔄 Chat context cleared! Starting fresh conversation.');
      } catch (error) {
        logger.error('Failed to clear chat:', error);
        await ctx.reply('❌ Failed to clear chat context.');
      }
    });

    // Wake word training command
    this.bot.command('train_wakeword', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`[Telegram] train_wakeword command received from user ${userId}`);

        if (!this.agent.wakeWordTraining) {
          await ctx.reply('❌ Wake word training service not available.');
          return;
        }

        const result = await this.agent.wakeWordTraining.startCollection(userId, 'telegram');

        if (result.success) {
          await ctx.reply(result.message, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`❌ ${result.message}`);
        }
      } catch (error) {
        logger.error('[Telegram] Error in train_wakeword command:', error);
        await ctx.reply(`❌ Error starting training: ${error.message}`);
      }
    });

    // Cancel wake word training
    this.bot.command('cancel_training', async (ctx) => {
      if (!this.agent.wakeWordTraining) {
        await ctx.reply('❌ Wake word training service not available.');
        return;
      }

      const result = await this.agent.wakeWordTraining.cancelCollection();
      await ctx.reply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
    });

    // Wake word training status
    this.bot.command('training_status', async (ctx) => {
      if (!this.agent.wakeWordTraining) {
        await ctx.reply('❌ Wake word training service not available.');
        return;
      }

      const status = this.agent.wakeWordTraining.getStatus();
      const modelInfo = await this.agent.wakeWordTraining.getModelInfo();

      let message = `**Wake Word Training Status**\n\n`;
      message += `Wake Word: "${status.wakeWord}"\n`;
      message += `Custom Model: ${modelInfo.exists ? '✅ Trained' : '❌ Not trained'}\n`;

      if (modelInfo.exists) {
        message += `Last trained: ${modelInfo.modifiedAt.toLocaleString()}\n`;
      }

      if (status.isCollecting) {
        message += `\n**Currently Collecting Samples**\n`;
        message += `Phase: ${status.collectionPhase === 'positive' ? 'Positive (wake word)' : 'Negative (other phrases)'}\n`;
        message += `Positive: ${status.positiveSamples}/${status.targetPositive}\n`;
        message += `Negative: ${status.negativeSamples}/${status.targetNegative}\n`;
      } else if (status.isTraining) {
        message += `\n⏳ Training in progress...`;
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    });
  }

  setupTextHandler() {
    this.bot.on(message('text'), async (ctx) => {
      const text = ctx.message.text;
      
      // Skip if it's a command
      if (text.startsWith('/')) return;

      // Check if we're in a special mode
      if (ctx.session?.currentOperation) {
        // AI detect mode: analyze pasted text
        if (ctx.session.currentOperation === 'ai_detect') {
          return this.handleAIDetectText(ctx, text);
        }
        return this.handleOperationInput(ctx, text);
      }

      // Build input with reply context if this is a reply to a previous message
      let input = text;
      const repliedMsg = ctx.message.reply_to_message;
      if (repliedMsg) {
        const replyText = repliedMsg.text || repliedMsg.caption || '';
        if (replyText) {
          const replyFrom = repliedMsg.from?.is_bot ? 'ALICE' : (repliedMsg.from?.first_name || 'User');
          input = `[Replying to ${replyFrom}'s message: "${replyText}"]\n\n${text}`;
        }
      }

      // Process as natural language request
      await ctx.reply('🤔 Processing your request...');

      try {
        const response = await this.agent.processNaturalLanguage(input, {
          userId: ctx.from.id,
          userName: ctx.from.first_name,
          chatId: ctx.chat.id
        });

        // Log response for debugging
        logger.info('About to send Telegram response:', {
          hasResponse: !!response,
          responseType: response?.type,
          contentLength: response?.content?.length,
          firstChars: response?.content?.substring(0, 50)
        });

        // Send response (handle different types)
        if (!response || !response.type) {
          await this.sendLargeMessage(ctx, "I'm not sure how to respond to that. Try asking me to help with tasks, system status, or other commands.");
        } else if (response.type === 'text') {
          const content = response.content || "Response received but no content provided.";
          logger.info(`Sending text response: ${content.substring(0, 100)}...`);
          await this.sendLargeMessage(ctx, content);
          
          // Generate voice response if enabled
          const hasTtsService = !!this.agent.ttsService;
          const telegramEnabled = hasTtsService ? await this.agent.ttsService.isTelegramEnabled() : false;
          
          logger.info(`Telegram voice check - TTS Service exists: ${hasTtsService}, Telegram enabled: ${telegramEnabled}`);
          
          if (hasTtsService && telegramEnabled) {
            try {
              logger.info('Generating Telegram voice response...');
              // Send typing indicator for voice generation
              await ctx.sendChatAction('record_voice');

              // Clean markdown from content before TTS (prevents speaking asterisks, brackets, etc.)
              const cleanedContent = this.cleanForSpeech(content);
              logger.info(`Generating speech for text: ${cleanedContent.length} characters (cleaned from ${content.length})`);

              const voiceResult = await this.agent.ttsService.generateSpeech(cleanedContent);
              
              // Summarize the response for the voice caption
              const cleaned = content
                .replace(/[*_`#\[\]]/g, '')
                .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
                .trim();
              const firstLine = cleaned.split(/[.!?\n]/)[0].trim();
              const caption = firstLine.length > 3 && firstLine.length <= 50
                ? `🎤 ${firstLine}`
                : firstLine.length > 50
                  ? `🎤 ${firstLine.substring(0, 47)}...`
                  : '🎤 Voice response';
              
              // Send voice message
              logger.info(`Sending voice message - size: ${voiceResult.size} bytes`);
              await ctx.replyWithVoice(
                { source: voiceResult.buffer },
                { 
                  caption: caption
                }
              );
              
              logger.info(`Voice response sent: ${voiceResult.size} bytes, cost: $${voiceResult.cost.toFixed(4)}`);
            } catch (error) {
              logger.error('Failed to generate voice response:', error);
              // Don't send error to user, just log it
            }
          } else {
            logger.info(`Voice response skipped - TTS: ${hasTtsService}, Telegram: ${telegramEnabled}`);
          }
        } else if (response.type === 'approval_required') {
          // Store command for approval
          const approvalId = `approve_${Date.now()}`;
          ctx.session.pendingApprovals = ctx.session.pendingApprovals || {};
          ctx.session.pendingApprovals[approvalId] = response.command;
          
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Approve', `${approvalId}_yes`),
              Markup.button.callback('❌ Cancel', `${approvalId}_no`)
            ]
          ]);
          
          await ctx.reply(response.content, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup
          });
        } else if (response.type === 'image') {
          await ctx.replyWithPhoto({ source: response.path }, {
            caption: response.caption
          });
        } else if (response.type === 'document') {
          await ctx.replyWithDocument({ source: response.path }, {
            caption: response.caption
          });
        } else if (response.type === 'voice') {
          await ctx.replyWithVoice({ source: response.path });
        }

        // Handle session mode transitions from NLP (e.g., "enter journal mode")
        if (response.metadata?.enterJournalMode) {
          ctx.session.currentOperation = 'journal';
          ctx.session.journalId = response.metadata.journalId;
        }
        if (response.metadata?.exitJournalMode) {
          ctx.session.currentOperation = null;
          ctx.session.journalId = null;
        }

        // Handle generic setOperation from plugins (e.g., shazam waiting for audio)
        if (response.metadata?.setOperation) {
          ctx.session.currentOperation = response.metadata.setOperation;
        }

        // Handle actions
        if (response.actions && response.actions.length > 0) {
          const keyboard = this.createActionKeyboard(response.actions);
          await ctx.reply('What would you like me to do next?', keyboard);
        }
      } catch (error) {
        logger.error('Error processing natural language:', error);
        // If the agent returned an error response, show it. Otherwise show a generic message.
        const errorMessage = error.response?.content || 
                           error.message || 
                           '❌ Sorry, I encountered an error processing your request.';
        await ctx.reply(errorMessage);
      }
    });

    // Handle voice messages
    this.bot.on(message('voice'), async (ctx) => {
      const userId = ctx.from.id.toString();

      // Check if wake word training is in progress for this user
      if (this.agent.wakeWordTraining?.isCollecting &&
          this.agent.wakeWordTraining.userId === userId) {
        await ctx.reply('🎤 Processing training sample...');
        try {
          // Download voice file
          const fileId = ctx.message.voice.file_id;
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const response = await fetch(fileLink.href);
          const audioBuffer = Buffer.from(await response.arrayBuffer());

          // Process as training sample
          const result = await this.agent.wakeWordTraining.processVoiceSample(audioBuffer, userId);

          if (result.success) {
            await ctx.reply(result.message, { parse_mode: 'Markdown' });
          } else {
            await ctx.reply(`❌ ${result.message}`);
          }
        } catch (error) {
          logger.error('Error processing training sample:', error);
          await ctx.reply('❌ Failed to process training sample. Please try again.');
        }
        return;
      }

      // AI detect mode: check if audio is AI-generated speech
      if (ctx.session?.currentOperation === 'ai_detect') {
        return this.handleAIDetectAudio(ctx, ctx.message.voice.file_id, 'voice.ogg');
      }

      // Journal mode: transcribe voice and record as journal entry
      if (ctx.session?.currentOperation === 'journal') {
        try {
          const fileId = ctx.message.voice.file_id;
          const transcription = await this.agent.transcribeVoice(fileId);
          ctx.session.lastInputWasVoice = true;
          return this.handleOperationInput(ctx, transcription);
        } catch (error) {
          logger.error('Error transcribing voice for journal:', error);
          await ctx.reply('Failed to transcribe voice message for journal.');
        }
        return;
      }

      // Shazam mode: send raw audio for song identification (don't transcribe)
      if (ctx.session?.currentOperation === 'shazam') {
        try {
          await ctx.reply('🎵 Identifying song...');
          const fileId = ctx.message.voice.file_id;
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const audioResponse = await fetch(fileLink.href);
          const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

          // Save to temp file
          const os = await import('os');
          const path = await import('path');
          const fs = await import('fs');
          const tmpFile = path.join(os.tmpdir(), `shazam_${Date.now()}.ogg`);
          fs.writeFileSync(tmpFile, audioBuffer);

          // Call shazam plugin
          const shazamPlugin = this.agent.apiManager?.apis?.get('shazam');
          if (shazamPlugin?.instance) {
            const result = await shazamPlugin.instance.execute({
              action: 'identify',
              filePath: tmpFile
            });
            ctx.session.currentOperation = null;
            await ctx.reply(result.result || result.error || 'Could not identify song.', { parse_mode: 'Markdown' });
          } else {
            ctx.session.currentOperation = null;
            await ctx.reply('❌ Shazam plugin not available.');
          }
        } catch (error) {
          logger.error('Error in shazam voice identification:', error);
          ctx.session.currentOperation = null;
          await ctx.reply('❌ Failed to identify song. Please try again.');
        }
        return;
      }

      // Normal voice message processing
      await ctx.reply('🎤 Processing voice message...');
      try {
        const fileId = ctx.message.voice.file_id;
        const transcription = await this.agent.transcribeVoice(fileId);

        // Process the transcribed text
        const response = await this.agent.processNaturalLanguage(transcription, {
          userId: ctx.from.id,
          userName: ctx.from.first_name,
          chatId: ctx.chat.id,
          isVoice: true
        });

        // Send response as voice if original was voice
        if (response.voicePath) {
          await ctx.replyWithVoice({ source: response.voicePath });
        } else {
          await ctx.reply(response.content, { parse_mode: 'Markdown' });
        }
      } catch (error) {
        logger.error('Error processing voice message:', error);
        await ctx.reply('❌ Failed to process voice message.');
      }
    });

    // Handle audio files (MP3, M4A, etc. sent as audio messages)
    this.bot.on(message('audio'), async (ctx) => {
      // AI detect mode: check if audio is AI-generated speech
      if (ctx.session?.currentOperation === 'ai_detect') {
        const ext = ctx.message.audio.mime_type?.split('/')?.[1] || 'mp3';
        return this.handleAIDetectAudio(ctx, ctx.message.audio.file_id, `audio.${ext}`);
      }

      // Shazam mode: identify the audio file
      if (ctx.session?.currentOperation === 'shazam') {
        try {
          await ctx.reply('🎵 Identifying song...');
          const fileId = ctx.message.audio.file_id;
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const audioResponse = await fetch(fileLink.href);
          const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

          const os = await import('os');
          const path = await import('path');
          const fs = await import('fs');
          const ext = ctx.message.audio.mime_type?.split('/')?.[1] || 'mp3';
          const tmpFile = path.join(os.tmpdir(), `shazam_${Date.now()}.${ext}`);
          fs.writeFileSync(tmpFile, audioBuffer);

          const shazamPlugin = this.agent.apiManager?.apis?.get('shazam');
          if (shazamPlugin?.instance) {
            const result = await shazamPlugin.instance.execute({
              action: 'identify',
              filePath: tmpFile
            });
            ctx.session.currentOperation = null;
            await ctx.reply(result.result || result.error || 'Could not identify song.', { parse_mode: 'Markdown' });
          } else {
            ctx.session.currentOperation = null;
            await ctx.reply('❌ Shazam plugin not available.');
          }
        } catch (error) {
          logger.error('Error in shazam audio identification:', error);
          ctx.session.currentOperation = null;
          await ctx.reply('❌ Failed to identify song. Please try again.');
        }
        return;
      }

      // Non-shazam audio: inform user about the shazam command
      const fileName = ctx.message.audio.title || ctx.message.audio.file_name || 'audio file';
      await ctx.reply(`🎵 Received audio: ${fileName}\nTip: Say "shazam" first, then send audio to identify a song.`);
    });

    // Handle photos
    this.bot.on(message('photo'), async (ctx) => {
      // AI detect mode: check if image is AI-generated
      if (ctx.session?.currentOperation === 'ai_detect') {
        return this.handleAIDetectPhoto(ctx);
      }

      await ctx.reply('🖼️ Analyzing image...');
      try {
        const photos = ctx.message.photo;
        const largestPhoto = photos[photos.length - 1];
        const analysis = await this.agent.analyzeImage(largestPhoto.file_id);

        await ctx.reply(
          `📸 *Image Analysis:*\n\n${analysis.description}\n\n` +
          `Detected: ${analysis.labels.join(', ')}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        logger.error('Error analyzing image:', error);
        await ctx.reply('❌ Failed to analyze image.');
      }
    });

    // Handle documents
    this.bot.on(message('document'), async (ctx) => {
      const doc = ctx.message.document;

      // AI detect mode: route by mime type
      if (ctx.session?.currentOperation === 'ai_detect') {
        const mime = doc.mime_type || '';
        if (mime.startsWith('image/')) {
          return this.handleAIDetectDocument(ctx, doc, 'image');
        } else if (mime.startsWith('video/')) {
          return this.handleAIDetectDocument(ctx, doc, 'video');
        } else if (mime.startsWith('audio/')) {
          return this.handleAIDetectAudio(ctx, doc.file_id, doc.file_name || 'audio.mp3');
        } else {
          ctx.session.currentOperation = null;
          await ctx.reply('❌ Unsupported file type for AI detection. Send an image, video, audio, or text.');
        }
        return;
      }

      // Check if it's a strategy file
      if (doc.file_name?.endsWith('.strategy.json') || doc.file_name?.endsWith('.strategies.json')) {
        await this.handleStrategyFileUpload(ctx, doc);
        return;
      }

      await ctx.reply(`📄 Received document: ${doc.file_name}\nProcessing...`);

      try {
        const result = await this.agent.processDocument(doc.file_id, doc.file_name);
        await ctx.reply(result.summary, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Error processing document:', error);
        await ctx.reply('❌ Failed to process document.');
      }
    });
  }

  /**
   * Handle strategy file upload for import
   */
  async handleStrategyFileUpload(ctx, doc) {
    const { Markup } = await import('telegraf');

    await ctx.reply(`📊 Strategy file detected: ${doc.file_name}\nValidating...`);

    try {
      // Download and parse the file
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await fetch(fileLink.href);
      const strategyData = await response.json();

      // Import the strategy exporter
      const strategyExporter = (await import('../../services/crypto/strategyExporter.js')).default;

      // Validate the strategy
      const validation = strategyExporter.validateStrategy(strategyData);

      if (!validation.valid) {
        await ctx.reply(
          `❌ *Strategy Validation Failed*\n\n` +
          `Errors:\n${validation.errors.map(e => `• ${e}`).join('\n')}` +
          (validation.warnings.length > 0 ? `\n\nWarnings:\n${validation.warnings.map(w => `• ${w}`).join('\n')}` : ''),
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Check if it's a bundle or single strategy
      const isBundle = !!strategyData.strategies;
      const strategyCount = isBundle ? strategyData.strategies.length : 1;
      const strategyName = isBundle
        ? strategyData.metadata?.name || 'Strategy Bundle'
        : strategyData.metadata?.name || strategyData.strategy?.type || 'Unknown';
      const strategyType = isBundle ? 'bundle' : strategyData.strategy?.type;

      // Store for callback
      if (!ctx.session) ctx.session = {};
      ctx.session.pendingStrategyImport = {
        data: strategyData,
        fileName: doc.file_name,
        isBundle,
        strategyCount
      };

      // Build preview message
      let preview = `📊 *Strategy Import Preview*\n\n`;
      preview += `*Name:* ${strategyName}\n`;
      preview += `*Type:* ${strategyType}\n`;

      if (isBundle) {
        preview += `*Strategies:* ${strategyCount}\n`;
        const names = strategyData.strategies.slice(0, 5).map(s => s.metadata?.name || s.strategy?.type).join(', ');
        preview += `*Includes:* ${names}${strategyCount > 5 ? '...' : ''}\n`;
      } else {
        if (strategyData.strategy?.config?.tokenSymbol) {
          preview += `*Token:* ${strategyData.strategy.config.tokenSymbol}\n`;
        }
        if (strategyData.strategy?.config?.networks) {
          preview += `*Networks:* ${strategyData.strategy.config.networks.join(', ')}\n`;
        }
      }

      if (validation.warnings.length > 0) {
        preview += `\n⚠️ *Warnings:*\n${validation.warnings.slice(0, 3).map(w => `• ${w}`).join('\n')}`;
      }

      preview += `\n\nHow would you like to import?`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📥 Import (Merge)', 'strategy_import_merge'),
          Markup.button.callback('🔄 Import (Replace)', 'strategy_import_replace')
        ],
        [
          Markup.button.callback('❌ Cancel', 'strategy_import_cancel')
        ]
      ]);

      await ctx.reply(preview, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      logger.error('Error handling strategy file:', error);
      await ctx.reply(`❌ Failed to process strategy file: ${error.message}`);
    }
  }

  // --- AI Content Detection Handlers ---

  async handleAIDetectText(ctx, text) {
    const exitPhrases = ['done', 'stop', 'exit', 'cancel', 'quit'];
    if (exitPhrases.includes(text.toLowerCase().trim())) {
      ctx.session.currentOperation = null;
      await ctx.reply('🔍 AI detection mode ended.');
      return;
    }

    await ctx.reply('🔍 Analyzing text for AI generation...');
    try {
      const plugin = this.agent.apiManager?.apis?.get('aiDetector');
      if (!plugin?.instance) {
        ctx.session.currentOperation = null;
        await ctx.reply('❌ AI Detector plugin not available.');
        return;
      }
      const result = await plugin.instance.execute({ action: 'detectText', text });
      await ctx.reply(this.formatAIDetectResult('Text', result), { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('AI detect text error:', error);
      await ctx.reply('❌ Failed to analyze text.');
    }
  }

  async handleAIDetectPhoto(ctx) {
    await ctx.reply('🔍 Analyzing image for AI generation...');
    try {
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];
      const fileLink = await ctx.telegram.getFileLink(largestPhoto.file_id);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());

      const plugin = this.agent.apiManager?.apis?.get('aiDetector');
      if (!plugin?.instance) {
        ctx.session.currentOperation = null;
        await ctx.reply('❌ AI Detector plugin not available.');
        return;
      }
      const result = await plugin.instance.execute({
        action: 'detectImage',
        buffer,
        filename: 'photo.jpg'
      });
      await ctx.reply(this.formatAIDetectResult('Image', result), { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('AI detect photo error:', error);
      await ctx.reply('❌ Failed to analyze image.');
    }
  }

  async handleAIDetectAudio(ctx, fileId, filename) {
    await ctx.reply('🔍 Analyzing audio for AI-generated speech...');
    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());

      const plugin = this.agent.apiManager?.apis?.get('aiDetector');
      if (!plugin?.instance) {
        ctx.session.currentOperation = null;
        await ctx.reply('❌ AI Detector plugin not available.');
        return;
      }
      const result = await plugin.instance.execute({
        action: 'detectAudio',
        buffer,
        filename
      });
      let reply = this.formatAIDetectResult('Audio', result);
      if (result.transcript) {
        reply += `\n\n📝 *Transcript:* ${result.transcript.substring(0, 300)}${result.transcript.length > 300 ? '...' : ''}`;
      }
      await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('AI detect audio error:', error);
      await ctx.reply('❌ Failed to analyze audio.');
    }
  }

  async handleAIDetectDocument(ctx, doc, type) {
    await ctx.reply(`🔍 Analyzing ${type} for AI generation...`);
    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());

      const plugin = this.agent.apiManager?.apis?.get('aiDetector');
      if (!plugin?.instance) {
        ctx.session.currentOperation = null;
        await ctx.reply('❌ AI Detector plugin not available.');
        return;
      }

      const action = type === 'video' ? 'detectVideo' : 'detectImage';
      const result = await plugin.instance.execute({
        action,
        buffer,
        filename: doc.file_name || `file.${type === 'video' ? 'mp4' : 'jpg'}`
      });
      await ctx.reply(this.formatAIDetectResult(type.charAt(0).toUpperCase() + type.slice(1), result), { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error(`AI detect ${type} error:`, error);
      await ctx.reply(`❌ Failed to analyze ${type}.`);
    }
  }

  formatAIDetectResult(type, result) {
    if (!result.success) {
      return `❌ Detection failed: ${result.error}`;
    }
    const emoji = result.verdict === 'ai_generated' ? '🤖' : result.verdict === 'human' ? '✅' : '❓';
    const verdictText = result.verdict === 'ai_generated' ? 'AI-Generated'
      : result.verdict === 'human' ? 'Human/Real'
      : 'Uncertain';
    const confidence = result.confidence ? `${(result.confidence * 100).toFixed(0)}%` : 'N/A';

    let msg = `${emoji} *${type} Analysis Result*\n\n`;
    msg += `*Verdict:* ${verdictText}\n`;
    msg += `*Confidence:* ${confidence}\n`;
    if (result.reasoning) msg += `\n_${result.reasoning}_\n`;
    if (result.details?.framesAnalyzed) {
      msg += `\n📊 *Frames:* ${result.details.framesAI} AI / ${result.details.framesHuman} human / ${result.details.framesUncertain} uncertain (${result.details.framesAnalyzed} total)`;
    }
    msg += `\n\n_Send more content to analyze, or type "done" to exit._`;
    return msg;
  }

  setupCallbackHandlers() {
    // Task callbacks
    this.bot.action('view_tasks', async (ctx) => {
      ctx.answerCbQuery();
      const tasks = await this.agent.getTasks();
      const message = this.formatTasksMessage(tasks);
      ctx.editMessageText(message, { parse_mode: 'Markdown' });
    });

    this.bot.action('add_task', async (ctx) => {
      ctx.answerCbQuery();
      ctx.session = { currentOperation: 'add_task' };
      await ctx.reply('📝 Please describe the task you want to add:');
    });

    // AI provider callbacks
    this.bot.action(/^ai_(.+)$/, async (ctx) => {
      const provider = ctx.match[1];
      ctx.answerCbQuery();
      
      if (provider === 'current') {
        const current = this.agent.getCurrentAIProvider();
        ctx.editMessageText(`Current AI Provider: *${current.name}*`, {
          parse_mode: 'Markdown'
        });
      } else {
        try {
          await this.agent.switchAIProvider(provider);
          ctx.editMessageText(`✅ Switched to *${provider}*`, {
            parse_mode: 'Markdown'
          });
        } catch (error) {
          ctx.editMessageText(`❌ Failed to switch to ${provider}`);
        }
      }
    });

    // Service callbacks
    this.bot.action('services_list', async (ctx) => {
      ctx.answerCbQuery();
      const services = await this.agent.getServices();
      const message = this.formatServicesMessage(services);
      ctx.editMessageText(message, { parse_mode: 'Markdown' });
    });

    // Approval callbacks
    this.bot.action(/^approve_(.+)_(yes|no)$/, async (ctx) => {
      ctx.answerCbQuery();
      const [, approvalId, decision] = ctx.match;
      
      if (!ctx.session.pendingApprovals || !ctx.session.pendingApprovals[`approve_${approvalId}`]) {
        await ctx.editMessageText('❌ Approval request expired or not found.');
        return;
      }
      
      const command = ctx.session.pendingApprovals[`approve_${approvalId}`];
      delete ctx.session.pendingApprovals[`approve_${approvalId}`];
      
      if (decision === 'yes') {
        await ctx.editMessageText('✅ Command approved. Executing...');
        
        try {
          const result = await this.agent.systemExecutor.execute(command, { approved: true });
          
          if (result.success) {
            await ctx.reply(`✅ Command executed successfully:\n\`\`\`\n${result.stdout || 'Command completed'}\n\`\`\``, {
              parse_mode: 'Markdown'
            });
          } else {
            await ctx.reply(`❌ Command failed:\n\`\`\`\n${result.stderr || result.error || 'Unknown error'}\n\`\`\``, {
              parse_mode: 'Markdown'
            });
          }
        } catch (error) {
          await ctx.reply(`❌ Error executing command: ${error.message}`);
        }
      } else {
        await ctx.editMessageText('❌ Command cancelled.');
      }
    });

    // Strategy import callbacks
    this.bot.action(/^strategy_import_(merge|replace|cancel)$/, async (ctx) => {
      ctx.answerCbQuery();
      const action = ctx.match[1];

      if (action === 'cancel') {
        if (ctx.session?.pendingStrategyImport) {
          delete ctx.session.pendingStrategyImport;
        }
        await ctx.editMessageText('❌ Strategy import cancelled.');
        return;
      }

      const pending = ctx.session?.pendingStrategyImport;
      if (!pending) {
        await ctx.editMessageText('❌ Import session expired. Please upload the file again.');
        return;
      }

      try {
        const strategyExporter = (await import('../../services/crypto/strategyExporter.js')).default;
        const mode = action; // 'merge' or 'replace'

        const result = strategyExporter.importStrategy(pending.data, { mode, activate: false });

        delete ctx.session.pendingStrategyImport;

        if (result.success) {
          let message = `✅ *Strategy Import Successful*\n\n`;
          message += `*Imported:* ${result.imported.length} strategy(ies)\n`;

          for (const imp of result.imported) {
            message += `• ${imp.displayName || imp.name} (${imp.type}) - ${imp.status}\n`;
          }

          if (result.warnings.length > 0) {
            message += `\n⚠️ *Warnings:*\n${result.warnings.slice(0, 3).map(w => `• ${w}`).join('\n')}`;
          }

          message += `\n\n*Note:* Strategy is imported but not activated. Use the trading dashboard or ask me to "activate [strategy name]" to enable trading.`;

          await ctx.editMessageText(message, { parse_mode: 'Markdown' });
        } else {
          await ctx.editMessageText(
            `❌ *Import Failed*\n\n${result.errors?.join('\n') || 'Unknown error'}`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (error) {
        logger.error('Strategy import callback error:', error);
        await ctx.editMessageText(`❌ Import failed: ${error.message}`);
      }
    });
  }

  async handleOperationInput(ctx, input) {
    const operation = ctx.session.currentOperation;
    
    switch (operation) {
      case 'add_task':
        try {
          const task = await this.agent.addTask(input);
          await ctx.reply(`✅ Task added: *${task.title}*`, { parse_mode: 'Markdown' });
          ctx.session.currentOperation = null;
        } catch (error) {
          await ctx.reply('❌ Failed to add task.');
        }
        break;

      case 'journal': {
        // Check for exit phrases
        const inputLower = input.toLowerCase().trim();
        const exitPhrases = ['done journaling', 'stop journal', 'end journal',
          'close journal', 'exit journal', 'finish journal',
          'save journal', 'done recording', 'stop recording'];

        if (exitPhrases.some(phrase => inputLower.includes(phrase))) {
          try {
            const journalPlugin = this.agent.apiManager?.apis?.get('journal');
            if (journalPlugin?.instance) {
              const result = await journalPlugin.instance.execute({
                action: 'stop',
                userId: ctx.from.id.toString()
              });
              ctx.session.currentOperation = null;
              ctx.session.journalId = null;
              await ctx.reply(result.result || 'Journal session closed.');
            }
          } catch (error) {
            logger.error('Error stopping journal:', error);
            await ctx.reply('Error closing journal session.');
            ctx.session.currentOperation = null;
          }
          return;
        }

        // Record as journal entry
        try {
          const journalPlugin = this.agent.apiManager?.apis?.get('journal');
          if (journalPlugin?.instance) {
            const source = ctx.session?.lastInputWasVoice ? 'voice' : 'text';
            ctx.session.lastInputWasVoice = false;
            const result = await journalPlugin.instance.execute({
              action: 'add',
              content: input,
              source,
              userId: ctx.from.id.toString()
            });
            if (result.success) {
              await ctx.reply(`Entry #${result.entryNumber} recorded (${result.wordCount} words total)`);
            } else {
              await ctx.reply(result.result || 'Could not record entry.');
            }
          }
        } catch (error) {
          logger.error('Error adding journal entry:', error);
          await ctx.reply('Failed to record journal entry.');
        }
        break;
      }

      case 'eufy_2fa': {
        const eufyPlugin = this.agent.apiManager?.apis?.get('eufy');
        if (eufyPlugin?.instance) {
          const code = input.trim();
          if (!/^\d{4,6}$/.test(code)) {
            await ctx.reply('Please enter a valid 4-6 digit code, or /cancel to abort.');
            return;
          }
          await ctx.reply('Verifying code...');
          const result = await eufyPlugin.instance.submit2FACode(code);
          ctx.session.currentOperation = null;
          await ctx.reply(result.success
            ? 'Eufy connected! Try "show me the cameras" or "take a snapshot".'
            : `${result.error}\n\nRetry with "setup eufy".`);
        } else {
          ctx.session.currentOperation = null;
          await ctx.reply('Eufy plugin not available.');
        }
        break;
      }

      default:
        await ctx.reply('Unknown operation.');
        ctx.session.currentOperation = null;
    }
  }

  formatStatusMessage(status) {
    return `📊 *System Status*\n\n` +
           `🤖 *Agent:* ${status.agent.name} v${status.agent.version}\n` +
           `⏱️ *Uptime:* ${status.agent.uptime}\n` +
           `💾 *Memory:* ${status.system.memory.used}/${status.system.memory.total} GB\n` +
           `💽 *CPU:* ${status.system.cpu.usage}% (${status.system.cpu.cores} cores)\n` +
           `🌡️ *Temperature:* ${status.system.temperature !== "N/A" && status.system.temperature !== undefined ? `${status.system.temperature}°C / ${Math.round((status.system.temperature * 9/5) + 32)}°F` : "N/A"}\n` +
           `📁 *Storage:* ${status.system.disk?.used || "N/A"}/${status.system.disk?.total || "N/A"} GB\n` +
           `🌐 *Network:* ${status.network.status}\n` +
           `🔧 *Services:* ${status.services.running}/${status.services.total} running`;
  }

  formatTasksMessage(tasks) {
    if (tasks.length === 0) {
      return '📋 *No tasks found*';
    }
    
    let message = '📋 *Current Tasks:*\n\n';
    tasks.forEach((task, index) => {
      const status = task.completed ? '✅' : (task.running ? '🔄' : '⏸️');
      message += `${status} *${index + 1}.* ${task.title}\n`;
      if (task.description) {
        message += `   _${task.description}_\n`;
      }
      message += '\n';
    });
    
    return message;
  }

  formatServicesMessage(services) {
    let message = '🛠️ *Services Status:*\n\n';
    services.forEach(service => {
      const status = service.running ? '🟢' : '🔴';
      message += `${status} *${service.name}*\n`;
      message += `   Status: ${service.status}\n`;
      if (service.memory) {
        message += `   Memory: ${service.memory}\n`;
      }
      message += '\n';
    });
    return message;
  }

  createActionKeyboard(actions) {
    const buttons = actions.map(action => [
      Markup.button.callback(action.label, `action_${action.id}`)
    ]);
    return Markup.inlineKeyboard(buttons);
  }

  async sendNotification(message, options = {}) {
    try {
      if (!this.authorizedUserId) {
        logger.warn('Cannot send notification: No authorized user ID');
        return;
      }

      // Ensure options is an object (defensive programming)
      const safeOptions = options && typeof options === 'object' ? options : {};

      const defaultOptions = {
        parse_mode: 'Markdown',
        disable_notification: false
      };

      const finalOptions = { ...defaultOptions, ...safeOptions };

      if (safeOptions.photo) {
        await this.bot.telegram.sendPhoto(
          this.authorizedUserId, 
          safeOptions.photo,
          { caption: message, ...finalOptions }
        );
      } else if (safeOptions.document) {
        await this.bot.telegram.sendDocument(
          this.authorizedUserId,
          safeOptions.document,
          { caption: message, ...finalOptions }
        );
      } else if (safeOptions.audio) {
        await this.bot.telegram.sendAudio(
          this.authorizedUserId,
          safeOptions.audio,
          { caption: message, ...finalOptions }
        );
      } else if (safeOptions.voice) {
        await this.bot.telegram.sendVoice(
          this.authorizedUserId,
          safeOptions.voice,
          finalOptions
        );
      } else if (safeOptions.animation) {
        await this.bot.telegram.sendAnimation(
          this.authorizedUserId,
          safeOptions.animation,
          { caption: message, ...finalOptions }
        );
      } else {
        await this.bot.telegram.sendMessage(
          this.authorizedUserId,
          message,
          finalOptions
        );
      }

      logger.info('Telegram notification sent successfully');
    } catch (error) {
      logger.error('Failed to send Telegram notification:', error);
    }
  }

  /**
   * Clean text for speech output (remove markdown formatting)
   * Prevents TTS from speaking asterisks, brackets, and other markdown syntax
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

    return text
      .replace(/```[\s\S]*?```/g, 'code block omitted')  // Code blocks
      .replace(/`([^`]+)`/g, '$1')                        // Inline code
      .replace(/\*\*([^*]+)\*\*/g, '$1')                  // Bold
      .replace(/\*([^*]+)\*/g, '$1')                      // Italic
      .replace(/_{2}([^_]+)_{2}/g, '$1')                  // Underscore bold
      .replace(/_([^_]+)_/g, '$1')                        // Underscore italic
      .replace(/#{1,6}\s?/g, '')                          // Headers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')           // Links - keep text, remove URL
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, 'image')       // Images
      .replace(/^\s*[-*+]\s/gm, '')                       // Bullet points
      .replace(/^\s*\d+\.\s/gm, '')                       // Numbered lists
      .replace(/\n{3,}/g, '\n\n')                         // Multiple newlines
      .replace(/[<>]/g, '')                               // Remove angle brackets
      .trim();
  }

  // Smart message splitting for Telegram's 4096 character limit
  async sendLargeMessage(ctx, outStr) {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    if (outStr.length >= 4096) {
      let remainingString = outStr;
      while (remainingString.length > 0) {
        let splitIndex = Math.min(remainingString.length, 4096);

        // Search backwards for the last complete markdown link before the split index
        let lastLinkEndIndex = remainingString.lastIndexOf('\n', splitIndex - 1);

        // If a newline is found and it's not the first character, adjust the split index to just before the newline
        if (lastLinkEndIndex > 0) {
          splitIndex = lastLinkEndIndex;
        } else if (lastLinkEndIndex === -1 && splitIndex === 4096) {
          // If no newline is found and we're at the character limit, find the last space to avoid splitting a URL
          lastLinkEndIndex = remainingString.lastIndexOf(' ', splitIndex - 1);
          if (lastLinkEndIndex > 0) {
            splitIndex = lastLinkEndIndex;
          }
        }

        // Get the message part up to the split index
        let arrMsg = remainingString.substring(0, splitIndex);

        // Send the message part
        try {
          await ctx.reply(arrMsg, { disable_web_page_preview: true, parse_mode: 'Markdown' });
          await sleep(500); // Wait for half a second before sending the next part to avoid hitting rate limits
        } catch (error) {
          // If Markdown parsing fails, try without parse_mode
          logger.warn('Markdown parsing failed, sending as plain text:', error.message);
          await ctx.reply(arrMsg, { disable_web_page_preview: true });
          await sleep(500);
        }

        // Get the remaining part of the string starting from the next character after the split index
        remainingString = remainingString.substring(splitIndex).trimStart();
      }
    } else {
      try {
        await ctx.reply(outStr, { disable_web_page_preview: true, parse_mode: 'Markdown' });
      } catch (error) {
        // If Markdown parsing fails, try without parse_mode
        logger.warn('Markdown parsing failed, sending as plain text:', error.message);
        await ctx.reply(outStr, { disable_web_page_preview: true });
      }
    }
  }

  // Send direct message to specific user ID (for notifications)
  async sendDirectMessage(userId, message) {
    try {
      await this.sendLargeMessageToUser(userId, message);
    } catch (error) {
      logger.error('Failed to send direct message:', error);
      throw error;
    }
  }

  // Smart message splitting for direct messages
  async sendLargeMessageToUser(userId, outStr) {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    if (outStr.length >= 4096) {
      let remainingString = outStr;
      while (remainingString.length > 0) {
        let splitIndex = Math.min(remainingString.length, 4096);
        let lastLinkEndIndex = remainingString.lastIndexOf('\n', splitIndex - 1);

        if (lastLinkEndIndex > 0) {
          splitIndex = lastLinkEndIndex;
        } else if (lastLinkEndIndex === -1 && splitIndex === 4096) {
          lastLinkEndIndex = remainingString.lastIndexOf(' ', splitIndex - 1);
          if (lastLinkEndIndex > 0) {
            splitIndex = lastLinkEndIndex;
          }
        }

        let arrMsg = remainingString.substring(0, splitIndex);

        try {
          await this.bot.telegram.sendMessage(userId, arrMsg, { 
            disable_web_page_preview: true, 
            parse_mode: 'Markdown' 
          });
          await sleep(500);
        } catch (error) {
          logger.warn('Markdown parsing failed for direct message, sending as plain text:', error.message);
          await this.bot.telegram.sendMessage(userId, arrMsg, { disable_web_page_preview: true });
          await sleep(500);
        }

        remainingString = remainingString.substring(splitIndex).trimStart();
      }
    } else {
      try {
        await this.bot.telegram.sendMessage(userId, outStr, { 
          disable_web_page_preview: true, 
          parse_mode: 'Markdown' 
        });
      } catch (error) {
        logger.warn('Markdown parsing failed for direct message, sending as plain text:', error.message);
        await this.bot.telegram.sendMessage(userId, outStr, { disable_web_page_preview: true });
      }
    }
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Telegram interface already running');
      return;
    }
    
    // Check if token exists before attempting to start
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.warn('TELEGRAM_BOT_TOKEN not configured in .env file');
      logger.warn('To enable Telegram notifications, add TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID to .env');
      logger.warn('Telegram interface will be disabled for this session');
      throw new Error('Telegram bot token not configured - add TELEGRAM_BOT_TOKEN to .env file');
    }

    try {
      // First validate the bot token
      logger.info('Validating Telegram bot token...');
      const botInfo = await this.bot.telegram.getMe();
      logger.info(`Bot validation successful: ${botInfo.username} (${botInfo.first_name})`);
      
      // Add configurable timeout to bot.launch() to prevent hanging
      logger.info('Launching Telegram bot...');
      const launchTimeout = parseInt(process.env.TELEGRAM_LAUNCH_TIMEOUT) || 120000; // 2 minutes default
      
      // Mark as running after successful validation — bot.launch() long-polling
      // promise may not resolve for minutes, but the bot IS functional at this point
      this.isRunning = true;

      const launchPromise = this.bot.launch({
        dropPendingUpdates: true, // Don't process old messages on startup
        allowedUpdates: [], // Get all update types
      }).catch(err => {
        logger.error('Bot launch error details:', err);
        this.isRunning = false;
      });

      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => {
          logger.info('Telegram bot launch timed out but bot is functional (long-polling delay)');
          resolve('timeout');
        }, launchTimeout)
      );

      await Promise.race([launchPromise, timeoutPromise]);
      logger.info('Telegram bot started successfully');

      // Sync bot profile description (non-blocking)
      this.syncBotProfile().catch(err => logger.warn('Could not sync bot profile:', err.message));

      // Send startup notification (non-blocking)
      this.sendNotification(
        `🚀 *${this.agent.config.name} is online!*\n\n` +
        `I'm ready to assist you. Type /help to see available commands.`
      ).catch(error => {
        logger.error('Failed to send startup notification:', error);
      });
    } catch (error) {
      this.isRunning = false;
      if (error.message.includes('401')) {
        logger.error('Telegram bot token is invalid or unauthorized');
      } else if (error.message.includes('404')) {
        logger.error('Telegram bot not found - token may be invalid or bot deleted');
      } else {
        logger.error('Failed to start Telegram bot:', error);
      }
      // Don't throw error - allow other interfaces to start
      logger.warn('Telegram interface will be disabled for this session');
    }
  }

  async syncBotProfile() {
    const name = this.agent.config.name || 'ALICE';
    await this.bot.telegram.setMyDescription(
      `${name} - AI-powered personal assistant for home server management. ` +
      `Manages system, network, tasks, media, crypto, and more via natural language.`
    );
    await this.bot.telegram.setMyShortDescription(
      `${name} - Your AI home server assistant`
    );
    logger.info('Telegram bot profile description synced');
  }

  /**
   * Update the bot's profile photo from a file path.
   * Tries Bot API setMyProfilePhoto (7.3+), falls back to sending photo to owner.
   */
  async syncBotPhoto(imagePath) {
    if (!this.bot || !this.isRunning) {
      throw new Error('Telegram bot is not running');
    }
    const fs = await import('fs');

    // Try the newer Bot API method first
    try {
      const photoStream = fs.createReadStream(imagePath);
      await this.bot.telegram.callApi('setMyProfilePhoto', {
        photo: { source: photoStream }
      });
      logger.info('Telegram bot profile photo updated via API');
      return { success: true };
    } catch (apiErr) {
      logger.debug('setMyProfilePhoto not available:', apiErr.message);
    }

    // Fallback: send the photo to the bot owner so they can set it via BotFather
    const userId = process.env.TELEGRAM_USER_ID;
    if (userId) {
      const photoStream = fs.createReadStream(imagePath);
      await this.bot.telegram.sendPhoto(userId, { source: photoStream }, {
        caption: '📸 New avatar rendered from VRM model.\n\nTo set as bot profile photo:\n1. Open @BotFather\n2. Send /setuserpic\n3. Select this bot\n4. Forward this image'
      });
      logger.info('Telegram avatar sent to owner for manual BotFather update');
      return { success: true, note: 'Photo sent to owner — set via @BotFather' };
    }

    return { success: false, error: 'Bot API setMyProfilePhoto not supported, no TELEGRAM_USER_ID for fallback' };
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.bot.stop();
      this.isRunning = false;
      logger.info('Telegram bot stopped');
    } catch (error) {
      logger.error('Error stopping Telegram bot:', error);
    }
  }
}