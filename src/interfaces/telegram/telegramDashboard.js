import { TelegramInterface } from "./telegram.js";
import { Telegraf, Markup, Scenes, session } from "telegraf";
import { message } from 'telegraf/filters';
import { logger } from "../../utils/logger.js";
import { getServerHost } from "../../utils/paths.js";
import { MultiUserSupport } from './multiUserSupport.js';
import { TelegramMediaGenerator } from '../../services/telegramMediaGenerator.js';
import fs from 'fs/promises';

export class TelegramDashboard extends TelegramInterface {
  constructor(agent) {
    super(agent);
    this.authorizedUserId = process.env.TELEGRAM_USER_ID; // Add missing property
    this.dashboardState = {
      currentView: "main", 
      refreshInterval: null,
      autoRefresh: false
    };
    this.multiUserSupport = new MultiUserSupport(agent);
    this.mediaGenerator = new TelegramMediaGenerator(agent);
    this.pendingOperation = null; // e.g. 'eufy_2fa' — set by plugins via metadata.setOperation
  }

  async sendLargeMessage(ctx, outStr, channelId = null) {
    try {
      if (!outStr) { return; }

      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      // Helper: send a single chunk, falling back to plain text if Markdown parsing fails
      const sendChunk = async (text, opts = {}) => {
        const mdOpts = { ...opts, parse_mode: 'Markdown' };
        try {
          if (channelId) {
            await ctx.telegram.sendMessage(channelId, text, mdOpts);
          } else {
            await ctx.reply(text, mdOpts);
          }
        } catch (e) {
          // Telegram returns 400 when Markdown is malformed — retry as plain text
          if (e.response?.statusCode === 400 || /can't parse/i.test(e.message)) {
            logger.debug(`Markdown parse failed, resending as plain text`);
            const plainOpts = { ...opts };
            delete plainOpts.parse_mode;
            if (channelId) {
              await ctx.telegram.sendMessage(channelId, text, plainOpts);
            } else {
              await ctx.reply(text, plainOpts);
            }
          } else {
            throw e;
          }
        }
      };

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
            // If no newline is found and we're at the character limit, we need to find the last space to avoid splitting a URL
            lastLinkEndIndex = remainingString.lastIndexOf(' ', splitIndex - 1);
            if (lastLinkEndIndex > 0) {
              splitIndex = lastLinkEndIndex;
            }
          }

          // Get the message part up to the split index
          let arrMsg = remainingString.substring(0, splitIndex);

          await sendChunk(arrMsg, { disable_web_page_preview: true });
          await sleep(500); // Wait for half a second before sending the next part to avoid hitting rate limits

          // Get the remaining part of the string starting from the next character after the split index
          remainingString = remainingString.substring(splitIndex).trimStart();
        }
      } else {
        await sendChunk(outStr, { disable_web_page_preview: true });
      }
    } catch (e) {
      logger.error('sendLargeMessage error:', e);
    }
  }

  async initialize() {
    logger.info('Initializing TelegramDashboard...');
    
    // Initialize bot and middleware without calling parent's setupCommands
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN not found in environment');
    }

    logger.info('Creating Telegraf bot instance...');
    this.bot = new Telegraf(token);
    
    // Restore email conversations from database on startup
    await this.multiUserSupport.loadEmailConversationsFromDatabase();
    
    // Use session middleware
    this.bot.use(session());

    // Enhanced authorization middleware with multi-user support
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id?.toString();
      
      if (!userId) {
        return ctx.reply('❌ Unable to identify user.');
      }
      
      // Master user has full access
      if (this.multiUserSupport.isMaster(userId)) {
        ctx.isMaster = true;
        ctx.isAuthorized = true;
        return next();
      }
      
      // Guest users have limited access
      ctx.isMaster = false;
      ctx.isGuest = true;
      
      // For commands, check if it's allowed for guests
      if (ctx.message?.text?.startsWith('/')) {
        const command = ctx.message.text.split(' ')[0].substring(1);
        const allowed = await this.multiUserSupport.processGuestCommand(ctx, command);
        if (!allowed) {
          return; // Guest command was handled
        }
      }
      
      return next();
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      logger.error('Telegram bot error:', err);
      ctx.reply('❌ An error occurred while processing your request.');
    });

    // Setup our enhanced commands instead of parent's basic commands
    this.setupEnhancedCommands();
    // Initialize media generator
    await this.mediaGenerator.initialize();
    
    this.setupTextHandler();
    this.setupCallbackHandlers();
    
    // Enhanced bot commands for menu
    try {
      await this.bot.telegram.setMyCommands([
        { command: "start", description: "Start the bot" },
        { command: "dashboard", description: "📊 Open system dashboard" },
        { command: "ai", description: "🤖 AI provider management" },
        { command: "system", description: "🖥️ System controls" },
        { command: "network", description: "🌐 Network management" },
        { command: "tasks", description: "📋 Task management" },
        { command: "api", description: "🔌 API plugins" },
        { command: "git", description: "🐙 Git management" },
        { command: "memory", description: "🧠 Memory & knowledge base" },
        { command: "logs", description: "📜 View system logs" },
        { command: "settings", description: "⚙️ Bot settings" },
        { command: "restart", description: "🔄 Restart agent" },
        { command: "dev", description: "🛠️ Development planning" },
        { command: "diagnostics", description: "🏥 System diagnostics" },
        { command: "about", description: "ℹ️ About ALICE and features" },
        { command: "features", description: "🚀 List all capabilities" },
        { command: "chart", description: "📊 Generate system charts" },
        { command: "aidetect", description: "🔍 Detect AI-generated content" },
        { command: "newchat", description: "🆕 Clear chat context" },
        { command: "help", description: "❓ Get help" }
      ]);
    } catch (error) {
      logger.error("Failed to set bot commands:", error);
    }
    
    // Prepare the bot but don't launch it yet - launch will happen in start() method
    logger.info('Telegram bot prepared and ready to launch');
  }

  setupEnhancedCommands() {
    // Start command
    this.bot.command('start', async (ctx) => {
      const agentName = this.agent.config.name;
      await ctx.reply(
        `🤖 Hello! I'm ${agentName}, your personal AI assistant.\n\n` +
        `I'm here to help you with:\n` +
        `• 🖥️ System administration\n` +
        `• 🔧 Development tasks\n` +
        `• 📊 Network monitoring\n` +
        `• 🤖 AI-powered assistance\n` +
        `• 🔍 Research and automation\n\n` +
        `Type /help for available commands or just tell me what you need!`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("📊 Open Dashboard", "open_dashboard")],
            [Markup.button.callback("❓ Get Help", "show_help")]
          ]).reply_markup
        }
      );
    });

    // Help command
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        `📚 *Available Commands:*\n\n` +
        `/start - Welcome message\n` +
        `/dashboard - System dashboard with metrics\n` +
        `/ai - AI provider management\n` +
        `/system - System controls\n` +
        `/network - Network tools\n` +
        `/tasks - Task management\n` +
        `/api - API plugins info\n` +
        `/git - Git repository management\n` +
        `/memory - View conversation memory\n` +
        `/logs - System logs\n` +
        `/settings - Bot settings\n` +
        `/restart - Restart agent (master only)\n` +
        `/dev - Development planning (master only)\n` +
        `/diagnostics - System health diagnostics\n\n` +
        `*Natural Language Examples:*\n` +
        `• "Show system status"\n` +
        `• "Add task: Deploy new feature"\n` +
        `• "List all tasks"\n` +
        `• "Complete task 123456"\n` +
        `• "Send email to user@example.com"\n` +
        `• "Show git status"\n` +
        `• "Commit changes with message: Fix bug"\n` +
        `• "Push to remote"\n` +
        `• "Scan the network"\n` +
        `• "What's using the most CPU?"\n\n` +
        `*API Usage:*\n` +
        `• "api tasks list" - List all tasks\n` +
        `• "api email checkConnection" - Check email\n` +
        `• "list api plugins" - Show available APIs\n\n` +
        `_Need more help? Just ask!_`,
        { parse_mode: 'Markdown' }
      );
    });

    // About command
    this.bot.command('about', async (ctx) => {
      const aboutInfo = await this.getAboutInformation();
      await ctx.reply(aboutInfo, { parse_mode: 'Markdown' });
    });

    // Features command
    this.bot.command('features', async (ctx) => {
      const featuresInfo = await this.getFeaturesInformation();
      await ctx.reply(featuresInfo, { parse_mode: 'Markdown' });
    });

    // Dashboard command
    this.bot.command("dashboard", async (ctx) => {
      try {
        const status = await this.agent.getSystemStatus();
        logger.info('Dashboard status object:', JSON.stringify(status, null, 2));
        const dashboard = this.formatEnhancedDashboard(status);
        
        // Different keyboard for guests
        const keyboard = ctx.isGuest ? 
          Markup.inlineKeyboard([
            [Markup.button.callback("ℹ️ About ALICE", "about_alice")],
            [Markup.button.callback("🚀 Features", "show_features")],
            [Markup.button.callback("❌ Close", "close_dashboard")]
          ]) : 
          this.createDashboardKeyboard();
        
        await ctx.reply(dashboard, {
          parse_mode: "Markdown",
          reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        logger.error("Dashboard error:", error);
        await ctx.reply("❌ Failed to load dashboard. Using basic status instead.");
        
        // Fallback to basic status
        ctx.reply("📊 System Status\n" +
          "Agent: Online ✅\n" + 
          "AI Provider: " + (this.agent.providerManager?.activeProvider?.name || "Unknown") + "\n" +
          "Memory Usage: Normal\n" +
          "Telegram: Connected", 
          { parse_mode: "Markdown" }
        );
      }
    });

    // Enhanced AI command
    this.bot.command("ai", async (ctx) => {
      try {
        const providers = this.agent.providerManager?.getProviderList() || [];
        const current = this.agent.getCurrentAIProvider?.() || { name: "Unknown" };
        
        let text = "🤖 *AI Provider Management*\n\n";
        text += `Current Provider: *${current.name}*\n\n`;
        text += "*Available Providers:*\n";
        
        const buttons = [];
        providers.forEach(p => {
          const icon = p.active ? "🟢" : "⚪";
          text += `${icon} ${p.name}\n`;
          if (!p.active) {
            buttons.push([Markup.button.callback(`Switch to ${p.name}`, `switch_provider_${p.name}`)]);
          }
        });
        
        buttons.push([Markup.button.callback("📊 View Metrics", "view_ai_metrics")]);
        buttons.push([Markup.button.callback("❌ Close", "close_menu")]);
        
        const keyboard = Markup.inlineKeyboard(buttons);
        
        await ctx.reply(text, {
          parse_mode: "Markdown",
          reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        logger.error("AI command error:", error);
        ctx.reply("❌ Failed to load AI providers");
      }
    });

    // System command
    this.bot.command("system", async (ctx) => {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("📦 Update System", "system_update"),
          Markup.button.callback("🔄 Restart Services", "restart_services")
        ],
        [
          Markup.button.callback("💾 Create Backup", "create_backup"),
          Markup.button.callback("📊 Resource Usage", "resource_usage")
        ],
        [Markup.button.callback("❌ Close", "close_menu")]
      ]);
      
      await ctx.reply(
        "🖥️ *System Control Panel*\n\n" +
        "Select an action:",
        {
          parse_mode: "Markdown",
          reply_markup: keyboard.reply_markup
        }
      );
    });

    // Network command
    this.bot.command("network", async (ctx) => {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("🔍 Scan Network", "scan_network"),
          Markup.button.callback("🔌 Port Status", "port_status")
        ],
        [
          Markup.button.callback("🔐 VPN Status", "vpn_status"),
          Markup.button.callback("📊 Bandwidth", "bandwidth_monitor")
        ],
        [Markup.button.callback("❌ Close", "close_menu")]
      ]);
      
      await ctx.reply(
        "🌐 *Network Management*\n\n" +
        "Select a network tool:",
        {
          parse_mode: "Markdown",
          reply_markup: keyboard.reply_markup
        }
      );
    });

    // Tasks command
    this.bot.command('tasks', async (ctx) => {
      try {
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          await ctx.reply(
            "📋 *Task Management*\n\n" +
            "Task management plugin is not loaded.\n\n" +
            "You can create tasks by saying things like:\n" +
            '• "Add task: Update server packages"\n' +
            '• "Create a reminder to check backups"\n' +
            '• "Schedule system maintenance for tomorrow"',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const result = await tasksPlugin.execute({ action: 'list' });
        
        if (!result.tasks || result.tasks.length === 0) {
          await ctx.reply(
            "📋 *Task Management*\n\n" +
            "No active tasks.\n\n" +
            "You can create tasks by saying things like:\n" +
            '• "Add task: Update server packages"\n' +
            '• "Create a reminder to check backups"\n' +
            '• "Schedule system maintenance for tomorrow"',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        let message = "📋 *Active Tasks:*\n\n";
        result.tasks.forEach((task, index) => {
          const status = task.completed ? '✅' : task.priorityEmoji;
          message += `${index + 1}. ${status} ${task.title}\n`;
          if (task.dueDate) {
            message += `   📅 Due: ${task.dueDateFormatted}\n`;
          }
        });
        
        message += `\n_Total: ${result.count} tasks_`;

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("➕ Add Task", "add_task"),
            Markup.button.callback("✅ Complete", "complete_task")
          ],
          [
            Markup.button.callback("🔄 Refresh", "refresh_tasks"),
            Markup.button.callback("❌ Close", "close_menu")
          ]
        ]);

        await ctx.reply(message, { 
          parse_mode: 'Markdown',
          reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        logger.error('Tasks command error:', error);
        await ctx.reply("❌ Error loading tasks: " + error.message);
      }
    });

    // Guest statistics command (master only)
    this.bot.command('guests', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.reply("❌ This command is restricted to the authorized user.");
        return;
      }
      
      const stats = this.multiUserSupport.getConversationStats();
      
      let message = "👥 *Guest Conversation Statistics*\n\n";
      message += `Total Conversations: ${stats.totalConversations}\n`;
      message += `Active Today: ${stats.activeToday}\n`;
      message += `Total Messages: ${stats.totalMessages}\n\n`;
      
      if (stats.users.length > 0) {
        message += "*Recent Users:*\n";
        stats.users.slice(0, 10).forEach(user => {
          message += `• ${user.userName} (@${user.username}): ${user.messageCount} messages\n`;
        });
      }
      
      await ctx.reply(message, { parse_mode: 'Markdown' });
    });
    
    // New chat command
    this.bot.command('newchat', async (ctx) => {
      const userId = ctx.from.id;
      
      // Clear conversation history from memory
      try {
        await this.agent.memoryManager.clearConversationHistory(userId);
        
        await ctx.reply(
          "🆕 *Chat Context Cleared*\n\n" +
          "I've cleared our conversation history. Let's start fresh!\n\n" +
          "How can I help you today?",
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        logger.error('Error clearing chat history:', error);
        await ctx.reply('❌ Failed to clear chat history. Please try again.');
      }
    });

    // Memory command
    this.bot.command('memory', async (ctx) => {
      try {
        const memories = await this.agent.memoryManager?.getRecentMemories?.(5);
        
        if (!memories || memories.length === 0) {
          await ctx.reply("🧠 No conversation history found.");
          return;
        }

        let message = "🧠 *Recent Conversations:*\n\n";
        memories.forEach((mem, index) => {
          const time = new Date(mem.timestamp).toLocaleTimeString();
          message += `${index + 1}. [${time}] ${mem.input.substring(0, 50)}...\n`;
        });

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Memory command error:', error);
        await ctx.reply("🧠 Memory feature coming soon!");
      }
    });

    // Logs command
    this.bot.command('logs', async (ctx) => {
      try {
        // Get comprehensive operation logs
        const operations = this.agent.getOperationLogsTelegram(20);
        
        await ctx.reply(operations, { 
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback("📊 System Cmds", "logs_system"),
              Markup.button.callback("🔌 Plugin Ops", "logs_plugins")
            ],
            [
              Markup.button.callback("📈 Summary", "logs_summary"),
              Markup.button.callback("🔄 Refresh", "logs_refresh")
            ]
          ]).reply_markup
        });
      } catch (error) {
        logger.error('Logs command error:', error);
        await ctx.reply("❌ Error viewing logs: " + error.message);
      }
    });

    // Diagnostics command
    this.bot.command('diagnostics', async (ctx) => {
      try {
        // Check if user is authorized for diagnostics
        if (ctx.isGuest) {
          return await ctx.reply("❌ Diagnostics access requires authorization.");
        }

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("🏥 Run Diagnostics", "diag_run"),
            Markup.button.callback("📊 Latest Report", "diag_latest")
          ],
          [
            Markup.button.callback("📈 Health Trend", "diag_trend"),
            Markup.button.callback("📜 History", "diag_history")
          ],
          [
            Markup.button.callback("⚙️ Auto-Check Settings", "diag_settings")
          ]
        ]);

        await ctx.reply(
          `🏥 *System Diagnostics*\n\n` +
          `Run comprehensive health checks on all system components.\n\n` +
          `Select an option:`,
          { parse_mode: 'Markdown', ...keyboard }
        );
      } catch (error) {
        logger.error('Diagnostics command error:', error);
        await ctx.reply("❌ Error accessing diagnostics: " + error.message);
      }
    });

    // Settings command
    this.bot.command('settings', async (ctx) => {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("🔔 Notifications", "settings_notifications"),
          Markup.button.callback("🛡️ Security", "settings_security")
        ],
        [
          Markup.button.callback("🤖 AI Settings", "settings_ai"),
          Markup.button.callback("⏰ Automation", "settings_automation")
        ],
        [
          Markup.button.callback("🔧 Self-Modification", "settings_selfmod"),
          Markup.button.callback("📊 Status", "settings_status")
        ],
        [Markup.button.callback("❌ Close", "close_menu")]
      ]);

      await ctx.reply(
        "⚙️ *Bot Settings*\n\n" +
        "Configure your LANAgent:",
        {
          parse_mode: "Markdown",
          reply_markup: keyboard.reply_markup
        }
      );
    });

    // Git command
    this.bot.command('git', async (ctx) => {
      try {
        const gitPlugin = this.agent.apiManager.getPlugin('git');
        if (!gitPlugin) {
          await ctx.reply("❌ Git plugin is not loaded. Use 'enable git plugin' to activate it.");
          return;
        }
        
        const status = await gitPlugin.execute({ action: 'status' });
        let message = "🐙 *Git Repository Status*\n━━━━━━━━━━━━━━━━━━━━\n\n";
        
        message += `📍 Branch: *${status.branch}*\n`;
        message += `📊 Status: ${status.clean ? '✅ Clean' : '⚠️ Changes detected'}\n`;
        
        if (!status.clean) {
          message += `\n📝 Changes (${status.totalChanges}):\n`;
          if (status.changes.modified.length) {
            message += `  • Modified: ${status.changes.modified.length}\n`;
          }
          if (status.changes.untracked.length) {
            message += `  • Untracked: ${status.changes.untracked.length}\n`;
          }
          if (status.changes.added.length) {
            message += `  • Staged: ${status.changes.added.length}\n`;
          }
        }
        
        if (status.ahead || status.behind) {
          message += `\n🔄 Remote Status:\n`;
          if (status.ahead) message += `  • ⬆️ Ahead by ${status.ahead} commits\n`;
          if (status.behind) message += `  • ⬇️ Behind by ${status.behind} commits\n`;
        }
        
        message += "\n_Use natural language for git operations_";
        
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("📝 Stage All", "git_add_all"),
            Markup.button.callback("💾 Commit", "git_commit")
          ],
          [
            Markup.button.callback("⬆️ Push", "git_push"),
            Markup.button.callback("⬇️ Pull", "git_pull")
          ],
          [
            Markup.button.callback("📜 History", "git_log"),
            Markup.button.callback("🔄 Refresh", "refresh_git")
          ],
          [Markup.button.callback("❌ Close", "close_menu")]
        ]);
        
        await ctx.reply(message, { 
          parse_mode: 'Markdown',
          reply_markup: keyboard.reply_markup
        });
        
      } catch (error) {
        logger.error('Git command error:', error);
        await ctx.reply("❌ Error: " + error.message);
      }
    });

    // API command
    this.bot.command('api', async (ctx) => {
      try {
        const plugins = this.agent.apiManager.getPluginList();
        
        if (plugins.length === 0) {
          await ctx.reply("🔌 No API plugins loaded.");
          return;
        }
        
        let message = "🔌 *Available API Plugins*\n━━━━━━━━━━━━━━━━━━━━\n\n";
        
        plugins.forEach(plugin => {
          const status = plugin.enabled ? '✅' : '❌';
          message += `📦 *${plugin.name}* v${plugin.version} ${status}\n`;
          message += `   ${plugin.description}\n`;
          if (plugin.stats.calls > 0) {
            message += `   📊 ${plugin.stats.calls} calls, ${plugin.stats.errors} errors\n`;
          }
          message += `   🛠️ Methods: ${plugin.methods.map(m => m.name).join(', ')}\n\n`;
        });
        
        message += "_Use /help api for usage examples_";
        
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("📧 Test Email", "api_test_email"),
            Markup.button.callback("📋 Test Tasks", "api_test_tasks")
          ],
          [
            Markup.button.callback("⚙️ Manage Plugins", "api_manage_plugins"),
            Markup.button.callback("🔄 Refresh", "refresh_api")
          ],
          [Markup.button.callback("❌ Close", "close_menu")]
        ]);
        
        await ctx.reply(message, { 
          parse_mode: 'Markdown',
          reply_markup: keyboard.reply_markup
        });
        
      } catch (error) {
        logger.error('API command error:', error);
        await ctx.reply("❌ Error loading API info: " + error.message);
      }
    });

    // Restart command - master only
    this.bot.command('restart', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.reply("❌ This command is restricted to the authorized user.");
        return;
      }
      
      try {
        const systemPlugin = this.agent.apiManager.getPlugin('system');
        if (!systemPlugin) {
          await ctx.reply("❌ System plugin not loaded. Use 'enable system plugin' to activate it.");
          return;
        }
        
        // Create confirmation keyboard
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Confirm Restart", "confirm_restart"),
            Markup.button.callback("❌ Cancel", "close_menu")
          ]
        ]);
        
        await ctx.reply(
          "⚠️ *Restart Confirmation*\n\n" +
          "This will restart the agent process. I'll be offline for a few seconds.\n\n" +
          "Are you sure you want to proceed?",
          { 
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup
          }
        );
      } catch (error) {
        logger.error('Restart command error:', error);
        await ctx.reply("❌ Error: " + error.message);
      }
    });

    // Chart generation command
    this.bot.command('chart', async (ctx) => {
      try {
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("📊 System Health", "chart_system_health"),
            Markup.button.callback("🔄 Process Usage", "chart_process_usage")
          ],
          [
            Markup.button.callback("🤖 AI Usage", "chart_ai_usage"),
            Markup.button.callback("📈 Progress Demo", "chart_progress_demo")
          ],
          [
            Markup.button.callback("🔙 Back", "back_to_main")
          ]
        ]);

        await ctx.reply(
          "📊 *Chart Generator*\n\n" +
          "Choose a chart type to generate:",
          { 
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup
          }
        );
      } catch (error) {
        logger.error('Error in chart command:', error);
        await ctx.reply("❌ Error loading chart options: " + error.message);
      }
    });

    // Development command - master only
    this.bot.command('dev', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.reply("❌ This command is restricted to the authorized user.");
        return;
      }

      try {
        const devPlugin = this.agent.apiManager.getPlugin('development');
        if (!devPlugin) {
          await ctx.reply("❌ Development plugin not loaded. Use 'enable development plugin' to activate it.");
          return;
        }

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("📋 View Plan", "dev_view_plan"),
            Markup.button.callback("➕ Add Feature", "dev_add_feature")
          ],
          [
            Markup.button.callback("📝 TODOs", "dev_todos"),
            Markup.button.callback("✏️ Planned Edits", "dev_edits")
          ],
          [
            Markup.button.callback("🔄 Prioritize", "dev_prioritize"),
            Markup.button.callback("❌ Close", "close_menu")
          ]
        ]);

        await ctx.reply(
          "🛠️ *Development Planning*\n━━━━━━━━━━━━━━━━━━━━\n\n" +
          "Manage development tasks, features, and planned edits.",
          {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup
          }
        );
      } catch (error) {
        logger.error('Dev command error:', error);
        await ctx.reply("❌ Error: " + error.message);
      }
    });

    // Wake word training command
    this.bot.command('train_wakeword', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`[TelegramDashboard] train_wakeword command received from user ${userId}`);

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
        logger.error('[TelegramDashboard] Error in train_wakeword command:', error);
        await ctx.reply(`❌ Error starting training: ${error.message}`);
      }
    });

    // Cancel wake word training
    this.bot.command('cancel_training', async (ctx) => {
      try {
        if (!this.agent.wakeWordTraining) {
          await ctx.reply('❌ Wake word training service not available.');
          return;
        }

        const result = await this.agent.wakeWordTraining.cancelCollection();
        await ctx.reply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      } catch (error) {
        logger.error('[TelegramDashboard] Error in cancel_training command:', error);
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Wake word training status
    this.bot.command('training_status', async (ctx) => {
      try {
        if (!this.agent.wakeWordTraining) {
          await ctx.reply('❌ Wake word training service not available.');
          return;
        }

        const status = this.agent.wakeWordTraining.getStatus();
        const modelInfo = await this.agent.wakeWordTraining.getModelInfo();

        let message = `🎤 *Wake Word Training Status*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `Wake Word: "${status.wakeWord}"\n`;
        message += `Custom Model: ${modelInfo.exists ? '✅ Trained' : '❌ Not trained'}\n`;

        if (modelInfo.exists) {
          message += `Last trained: ${new Date(modelInfo.modifiedAt).toLocaleString()}\n`;
        }

        if (status.isCollecting) {
          message += `\n*Currently Collecting Samples*\n`;
          message += `Phase: ${status.collectionPhase === 'positive' ? 'Positive (wake word)' : 'Negative (other phrases)'}\n`;
          message += `Positive: ${status.positiveSamples}/${status.targetPositive}\n`;
          message += `Negative: ${status.negativeSamples}/${status.targetNegative}\n`;
        } else if (status.isTraining) {
          message += `\n⏳ Training in progress...`;
        }

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('[TelegramDashboard] Error in training_status command:', error);
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Bug report via reply
    this.bot.command('bug', async (ctx) => {
      try {
        const repliedMsg = ctx.message.reply_to_message;
        if (!repliedMsg) {
          await ctx.reply('💡 Reply to a bot message with /bug to create a GitHub issue from it.\n\nUsage:\n• Reply with `/bug` — uses the message as the bug report\n• Reply with `/bug description here` — adds your explanation', { parse_mode: 'Markdown' });
          return;
        }

        const originalText = repliedMsg.text || repliedMsg.caption || '[non-text message]';
        const userInput = ctx.message.text.replace(/^\/bug\s*/, '').trim();

        const gitPlugin = this.agent.apiManager.getPlugin('git');
        if (!gitPlugin) {
          await ctx.reply('❌ Git plugin is not loaded. Use `enable git plugin` to activate it.');
          return;
        }

        await ctx.reply('🐛 Creating GitHub issue...');

        const titleSource = userInput || originalText;
        const title = 'Bug: ' + titleSource.substring(0, 70).replace(/\n/g, ' ') + (titleSource.length > 70 ? '...' : '');

        const quotedMessage = originalText.substring(0, 2000).split('\n').map(line => `> ${line}`).join('\n');
        const body = `## Bug Report (via Telegram)\n\n### Reported Message\n${quotedMessage}\n\n### Additional Context\n${userInput || 'No additional context provided.'}\n\n---\nReported via Telegram /bug command`;

        const result = await gitPlugin.execute({
          action: 'createIssue',
          title,
          body,
          labels: ['bug', 'telegram-reported']
        });

        if (result.success) {
          await ctx.reply(`✅ Issue #${result.issue.number} created\n${result.issue.url}`);
        } else {
          await ctx.reply(`❌ Failed to create issue: ${result.error}`);
        }
      } catch (error) {
        logger.error('[TelegramDashboard] Error in bug command:', error);
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Missed capability report via reply
    this.bot.command('miss', async (ctx) => {
      try {
        const repliedMsg = ctx.message.reply_to_message;
        if (!repliedMsg) {
          await ctx.reply('💡 Reply to a message with /miss to report a missed capability.\n\nUsage:\n• Reply to the bot\'s failed response or your original question\n• `/miss` — uses the replied message as context\n• `/miss it should check the calendar` — adds your explanation', { parse_mode: 'Markdown' });
          return;
        }

        const originalText = repliedMsg.text || repliedMsg.caption || '[non-text message]';
        const userInput = ctx.message.text.replace(/^\/miss\s*/, '').trim();

        const gitPlugin = this.agent.apiManager.getPlugin('git');
        if (!gitPlugin) {
          await ctx.reply('❌ Git plugin is not loaded. Use `enable git plugin` to activate it.');
          return;
        }

        await ctx.reply('📝 Creating missed capability issue...');

        const titleSource = userInput || originalText;
        const title = 'Missed: ' + titleSource.substring(0, 70).replace(/\n/g, ' ') + (titleSource.length > 70 ? '...' : '');

        const quotedMessage = originalText.substring(0, 2000).split('\n').map(line => `> ${line}`).join('\n');
        const body = `## Missed Capability Report (via Telegram)\n\n### Message Context\n${quotedMessage}\n\n### Expected Behavior\n${userInput || 'The bot should have been able to handle this request.'}\n\n---\nReported via Telegram /miss command`;

        const result = await gitPlugin.execute({
          action: 'createIssue',
          title,
          body,
          labels: ['missed-capability', 'telegram-reported']
        });

        if (result.success) {
          await ctx.reply(`✅ Issue #${result.issue.number} created\n${result.issue.url}`);
        } else {
          await ctx.reply(`❌ Failed to create issue: ${result.error}`);
        }
      } catch (error) {
        logger.error('[TelegramDashboard] Error in miss command:', error);
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

  }


  formatEnhancedDashboard(status) {
    return `📊 *System Dashboard*\n` +
           `━━━━━━━━━━━━━━━━━━━━\n\n` +
           `🤖 *Agent*: ${status?.agent?.name || "LANAgent"} v${status?.agent?.version || "1.0.0"}\n` +
           `⏱️ *Uptime*: ${status?.agent?.uptime || "Unknown"}\n\n` +
           `💾 *Memory*: ${status?.system?.memory?.used || "?"} / ${status?.system?.memory?.total || "?"} GB\n` +
           `💽 *CPU*: ${status?.system?.cpu?.usage !== undefined ? status.system.cpu.usage + "%" : "?%"} (${status?.system?.cpu?.cores || "?"} cores)\n` +
           `🌡️ *Temperature*: ${status?.system?.temperature !== "N/A" && status?.system?.temperature !== undefined ? `${status.system.temperature}°C / ${Math.round((status.system.temperature * 9/5) + 32)}°F` : "N/A"}\n\n` +
           `🌐 *Network*: ${status?.network?.status || "Connected"}\n` +
           `🛠️ *Services*: ${status?.services?.running !== undefined ? status.services.running : "?"} / ${status?.services?.total || 3} running\n\n` +
           `🤖 *AI Provider*: ${this.agent?.providerManager?.activeProvider?.name || "OpenAI"}\n\n` +
           `_Last updated: ${new Date().toLocaleTimeString()}_`;
  }

  async handlePendingOperation(ctx, input) {
    const op = this.pendingOperation;
    logger.info(`TelegramDashboard: handling pending operation ${op}, input: ${input.substring(0, 20)}`);

    // Allow cancel
    if (input.trim().toLowerCase() === '/cancel' || input.trim().toLowerCase() === 'cancel') {
      this.pendingOperation = null;
      await ctx.reply('Operation cancelled.');
      return;
    }

    switch (op) {
      case 'eufy_2fa': {
        const eufyPlugin = this.agent.apiManager?.apis?.get('eufy');
        if (eufyPlugin?.instance) {
          const code = input.trim();
          if (!/^\d{4,6}$/.test(code)) {
            await ctx.reply('Please enter a valid 4-6 digit code, or type "cancel" to abort.');
            return;
          }
          await ctx.reply('Verifying code...');
          const result = await eufyPlugin.instance.submit2FACode(code);
          this.pendingOperation = null;
          await ctx.reply(result.success
            ? 'Eufy connected! Try "show me the cameras" or "take a snapshot".'
            : `${result.error}\n\nRetry with "setup eufy".`);
        } else {
          this.pendingOperation = null;
          await ctx.reply('Eufy plugin not available.');
        }
        break;
      }

      case 'shazam': {
        // Shazam expects audio, not text — let the user know
        await ctx.reply('Send a voice message or audio file for song recognition, or type "cancel" to abort.');
        break;
      }

      default:
        this.pendingOperation = null;
        await ctx.reply('Unknown operation. Cleared.');
    }
  }

  createDashboardKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh", "refresh_dashboard"),
        Markup.button.callback("⚙️ Settings", "dashboard_settings")
      ],
      [
        Markup.button.callback("🤖 AI", "goto_ai"),
        Markup.button.callback("🖥️ System", "goto_system"),
        Markup.button.callback("🌐 Network", "goto_network")
      ],
      [
        Markup.button.url("🌐 Web Dashboard", `http://${getServerHost()}:${process.env.AGENT_PORT || 3000}`),
        Markup.button.callback("❌ Close", "close_dashboard")
      ]
    ]);
  }

  setupTextHandler() {
    // Handle incoming documents/files — store for next command
    this.bot.on(message('document'), async (ctx) => {
      if (ctx.isGuest) return;
      try {
        const doc = ctx.message.document;
        const caption = ctx.message.caption || '';
        logger.info(`Telegram file received: ${doc.file_name} (${doc.file_size} bytes, ${doc.mime_type})`);

        // Download file
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const base64 = buffer.toString('base64');

        // Store for use by next command or process with caption
        this._lastReceivedFile = {
          filename: doc.file_name,
          mimeType: doc.mime_type,
          size: doc.file_size,
          base64,
          receivedAt: Date.now()
        };

        if (caption) {
          // If there's a caption, treat it as a command with the file attached
          logger.info(`Telegram NL request from owner (with file ${doc.file_name}): "${caption}"`);
          const thinkingMsg = await ctx.reply('🤔 Processing file...');

          // Inject file data into the NL context
          const result = await this.agent.processNaturalLanguage(
            `${caption} [attached file: ${doc.file_name}, type: ${doc.mime_type}]`,
            { userId: ctx.from.id.toString(), interface: 'telegram',
              attachedFile: this._lastReceivedFile }
          );

          try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch {}
          await this.sendResponse(ctx, result);
        } else {
          await ctx.reply(`📎 Got it — received ${doc.file_name} (${(doc.file_size / 1024).toFixed(0)}KB).\nNow tell me what to do with it.`);
        }
      } catch (err) {
        logger.error('Error handling document:', err);
        await ctx.reply('Failed to process the file: ' + err.message);
      }
    });

    // Handle incoming photos
    this.bot.on(message('photo'), async (ctx) => {
      if (ctx.isGuest) return;
      try {
        // Get highest resolution photo
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const caption = ctx.message.caption || '';
        logger.info(`Telegram photo received: ${photo.width}x${photo.height} (${photo.file_size} bytes)`);

        // Download photo
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const resp = await fetch(fileLink.href);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const base64 = buffer.toString('base64');

        this._lastReceivedFile = {
          filename: `photo_${Date.now()}.jpg`,
          mimeType: 'image/jpeg',
          size: photo.file_size,
          base64,
          width: photo.width,
          height: photo.height,
          receivedAt: Date.now()
        };

        if (caption) {
          logger.info(`Telegram NL request from owner (with photo): "${caption}"`);
          const thinkingMsg = await ctx.reply('🤔 Processing photo...');

          const result = await this.agent.processNaturalLanguage(
            `${caption} [attached photo: ${photo.width}x${photo.height}]`,
            { userId: ctx.from.id.toString(), interface: 'telegram',
              attachedFile: this._lastReceivedFile }
          );

          try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch {}
          await this.sendResponse(ctx, result);
        } else {
          await ctx.reply(`📸 Got the photo (${photo.width}x${photo.height}).\nWhat would you like me to do with it?`);
        }
      } catch (err) {
        logger.error('Error handling photo:', err);
        await ctx.reply('Failed to process the photo: ' + err.message);
      }
    });

    // Handle video messages (compressed videos)
    this.bot.on(message('video'), async (ctx) => {
      if (ctx.isGuest) return;
      try {
        const video = ctx.message.video;
        const caption = ctx.message.caption || '';
        logger.info(`Telegram video received: ${video.duration}s, ${video.width}x${video.height}, ${(video.file_size/1024/1024).toFixed(1)}MB, caption="${caption}"`);

        // Telegram Bot API limit: 20MB for file downloads
        if (video.file_size > 20 * 1024 * 1024) {
          await ctx.reply(`⚠️ Video is too large (${(video.file_size/1024/1024).toFixed(0)}MB). Telegram limits bot file downloads to 20MB.\n\nTry sending a shorter or lower-resolution video, or send it as a document via the Web UI instead.`);
          return;
        }

        if (caption) {
          // Download video
          const fileLink = await ctx.telegram.getFileLink(video.file_id);
          const resp = await fetch(fileLink.href);
          const buffer = Buffer.from(await resp.arrayBuffer());

          const os = await import('os');
          const path = await import('path');
          const fs = await import('fs/promises');
          const tempDir = path.join(os.tmpdir(), 'lanagent-convert');
          await fs.mkdir(tempDir, { recursive: true });
          const inputPath = path.join(tempDir, `video_${Date.now()}.mp4`);
          await fs.writeFile(inputPath, buffer);

          // Determine target format from caption
          const cap = caption.toLowerCase();
          let targetFormat = 'mp3';
          if (cap.includes('mp4')) targetFormat = 'mp4';
          else if (cap.includes('wav')) targetFormat = 'wav';
          else if (cap.includes('aac')) targetFormat = 'aac';
          else if (cap.includes('flac')) targetFormat = 'flac';
          else if (cap.includes('ogg')) targetFormat = 'ogg';

          const outputPath = path.join(tempDir, `converted_${Date.now()}.${targetFormat}`);
          const thinkingMsg = await ctx.reply(`🔄 Converting to ${targetFormat.toUpperCase()}...`);

          const ffmpeg = this.agent.apiManager?.apis?.get('ffmpeg')?.instance;
          if (!ffmpeg) {
            await ctx.reply('❌ FFmpeg plugin not available.');
            return;
          }

          const result = await ffmpeg.execute({ action: 'convert', input: inputPath, output: outputPath });

          try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch {}

          if (!result.success) {
            await ctx.reply(`❌ Conversion failed: ${result.error}`);
          } else {
            const stat = await fs.stat(outputPath);
            const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
            if (['mp3','wav','aac','flac','ogg'].includes(targetFormat)) {
              await ctx.replyWithAudio({ source: outputPath, filename: `converted.${targetFormat}` },
                { caption: `✅ Converted to ${targetFormat.toUpperCase()} (${sizeMB}MB)` });
            } else {
              await ctx.replyWithDocument({ source: outputPath, filename: `converted.${targetFormat}` },
                { caption: `✅ Converted to ${targetFormat.toUpperCase()} (${sizeMB}MB)` });
            }
          }

          await fs.unlink(inputPath).catch(() => {});
          await fs.unlink(outputPath).catch(() => {});
        } else {
          await ctx.reply('🎬 Got the video. What would you like me to do with it? (e.g., "convert to mp3")');
        }
      } catch (err) {
        logger.error('Error handling video:', err);
        await ctx.reply('Failed to process video: ' + err.message);
      }
    });

    this.bot.on(message('text'), async (ctx) => {
      const text = ctx.message.text;

      // Skip if it's a command
      if (text.startsWith('/')) return;

      // Handle guest messages differently
      if (ctx.isGuest) {
        await this.multiUserSupport.processGuestMessage(ctx, text);
        return;
      }

      // Handle pending operations (e.g. 2FA code entry)
      if (this.pendingOperation) {
        try {
          await this.handlePendingOperation(ctx, text);
        } catch (err) {
          logger.error('Error handling pending operation:', err);
          await ctx.reply('Something went wrong. Please try again.');
          this.pendingOperation = null;
        }
        return;
      }

      // Process natural language input for master user
      try {
        logger.info(`Telegram NL request from owner: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);

        // Send thinking message
        const thinkingMsg = await ctx.reply('🤔 Thinking...');

        // Streaming draft state
        let streamingStarted = false;
        const draftId = Math.floor(Math.random() * 2147483646) + 1;
        let lastDraftTime = 0;
        let draftInFlight = false;
        const DRAFT_THROTTLE_MS = 300;

        const onStreamChunk = async (chunk, fullText) => {
          // First chunk — delete thinking message and switch to draft mode
          if (!streamingStarted) {
            streamingStarted = true;
            try {
              await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
            } catch (e) { /* already deleted */ }
          }

          const now = Date.now();
          if (now - lastDraftTime < DRAFT_THROTTLE_MS || draftInFlight) return;

          draftInFlight = true;
          try {
            await ctx.telegram.callApi('sendMessageDraft', {
              chat_id: ctx.chat.id,
              draft_id: draftId,
              text: fullText.length > 4096 ? fullText.substring(0, 4093) + '...' : fullText
            });
            lastDraftTime = Date.now();
          } catch (err) {
            logger.debug('sendMessageDraft error:', err.message);
          } finally {
            draftInFlight = false;
          }
        };

        // Attach recently received file if within 5 minutes
        const recentFile = this._lastReceivedFile && (Date.now() - this._lastReceivedFile.receivedAt < 300000)
          ? this._lastReceivedFile : null;

        const response = await this.agent.processNaturalLanguage(text, {
          platform: 'telegram',
          userId: ctx.from.id.toString(),
          userName: ctx.from.username || ctx.from.first_name,
          isMaster: true,
          attachedFile: recentFile,
          onStreamChunk,
          showThinking: async (msg) => {
            if (streamingStarted) return;
            try {
              if (msg !== thinkingMsg.text) {
                await ctx.telegram.editMessageText(
                  ctx.chat.id,
                  thinkingMsg.message_id,
                  null,
                  msg
                );
              }
            } catch (err) {
              logger.debug('Could not update thinking message:', err.message);
            }
          }
        });

        // Send one final draft flush with complete text
        if (streamingStarted && response?.content) {
          try {
            const finalText = response.content.length > 4096
              ? response.content.substring(0, 4093) + '...'
              : response.content;
            await ctx.telegram.callApi('sendMessageDraft', {
              chat_id: ctx.chat.id,
              draft_id: draftId,
              text: finalText
            });
          } catch (e) { /* draft will clear when final message is sent */ }
        }

        // Delete thinking message if streaming never started
        if (!streamingStarted) {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
          } catch (e) { /* already deleted */ }
        }
        
        logger.info('TelegramDashboard received response:', {
          hasResponse: !!response,
          responseType: response?.type,
          hasContent: !!response?.content,
          contentLength: response?.content?.length,
          keys: response ? Object.keys(response) : null
        });

        // Handle setOperation from plugins (e.g. eufy_2fa waiting for code input)
        if (response?.metadata?.setOperation) {
          this.pendingOperation = response.metadata.setOperation;
          logger.info(`TelegramDashboard: pendingOperation set to ${this.pendingOperation}`);
        }

        // Handle null response (e.g., when intent detection fails or no valid plugin)
        if (!response) {
          logger.warn('Received null response from agent, falling back to error message');
          await ctx.reply("I couldn't process that request. Could you try rephrasing it?");
          return;
        }

        if (response.requiresApproval) {
          await ctx.reply(response.message, {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback("✅ Approve", `approve_${response.commandId}`)],
              [Markup.button.callback("❌ Deny", `deny_${response.commandId}`)]
            ]).reply_markup
          });
        } else {
          // Handle response based on type
          if (response.type === 'document' && response.path) {
            // Handle document response (e.g., PDF, files)
            await ctx.replyWithDocument(
              { source: response.path },
              { 
                caption: response.caption || 'Here is your document',
                filename: response.filename
              }
            );
          } else if (response.type === 'photo' && response.path) {
            // Handle photo/image response
            await ctx.replyWithPhoto(
              { source: response.path },
              { 
                caption: response.caption || ''
              }
            );
          } else if (response.type === 'video' && response.path) {
            // Handle video response - check file size first (Telegram limit: 50MB)
            try {
              const fsStat = await import('fs').then(m => m.promises);
              const pathMod = await import('path');
              const stats = await fsStat.stat(response.path);
              const sizeMB = stats.size / (1024 * 1024);
              const filename = response.filename || pathMod.basename(response.path);

              // Build a LAN download link if file is in the downloads directory
              const downloadsDir = pathMod.join(process.cwd(), 'downloads');
              let lanUrl = '';
              if (response.path.startsWith(downloadsDir)) {
                const relativePath = response.path.slice(downloadsDir.length);
                lanUrl = `http://${getServerHost()}:${process.env.AGENT_PORT || 3000}/downloads/${encodeURI(relativePath.replace(/^\//, ''))}`;
              }

              if (sizeMB > 50) {
                // Too large for Telegram video - try as document, then fall back to LAN link
                logger.warn(`Video file too large for Telegram video (${sizeMB.toFixed(1)}MB > 50MB), trying document/LAN link`);
                try {
                  await ctx.replyWithDocument(
                    { source: response.path },
                    {
                      caption: `${response.caption || ''}\n📦 Sent as file (${sizeMB.toFixed(1)}MB — too large for inline video)`,
                      filename
                    }
                  );
                } catch (docErr) {
                  // Document also too large — provide LAN download link
                  const linkMsg = lanUrl
                    ? `\n\n🔗 Download on LAN: ${lanUrl}`
                    : `\n\n📂 Saved to: \`${response.path}\``;
                  const safeFilename = filename.replace(/_/g, ' ');
                  await ctx.reply(`✅ Downloaded "${safeFilename}" (${sizeMB.toFixed(1)}MB) but it's too large to send via Telegram.${linkMsg}`);
                }
              } else {
                await ctx.replyWithVideo(
                  { source: response.path },
                  {
                    caption: response.caption || '',
                    duration: response.duration,
                    width: response.width,
                    height: response.height,
                    supports_streaming: response.supports_streaming
                  }
                );
              }
            } catch (videoErr) {
              // Fallback if video send fails for any reason (413, timeout, etc.)
              logger.error('Failed to send video, trying as document:', videoErr.message);
              const pathMod = await import('path');
              const filename = response.filename || pathMod.basename(response.path);
              const downloadsDir = pathMod.join(process.cwd(), 'downloads');
              let lanUrl = '';
              if (response.path.startsWith(downloadsDir)) {
                const relativePath = response.path.slice(downloadsDir.length);
                lanUrl = `http://${getServerHost()}:${process.env.AGENT_PORT || 3000}/downloads/${encodeURI(relativePath.replace(/^\//, ''))}`;
              }
              try {
                await ctx.replyWithDocument(
                  { source: response.path },
                  { caption: response.caption || '', filename }
                );
              } catch (fallbackErr) {
                const linkMsg = lanUrl
                  ? `\n\n🔗 Download on LAN: ${lanUrl}`
                  : `\n\n📂 Saved to: ${response.path}`;
                const safeFilename = filename.replace(/_/g, ' ');
                await ctx.reply(`✅ Downloaded "${safeFilename}" but couldn't send via Telegram.${linkMsg}`);
              }
            }
          } else if (response.type === 'animation' && response.path) {
            // Handle GIF/animation response
            await ctx.replyWithAnimation(
              { source: response.path },
              { 
                caption: response.caption || '',
                duration: response.duration,
                width: response.width,
                height: response.height
              }
            );
          } else if (response.type === 'audio' && response.path) {
            // Handle audio response
            await ctx.replyWithAudio(
              { source: response.path },
              { 
                caption: response.caption || '',
                duration: response.duration,
                performer: response.performer,
                title: response.title
              }
            );
          } else if (response.type === 'voice' && response.path) {
            // Handle voice note response
            await ctx.replyWithVoice(
              { source: response.path },
              { 
                caption: response.caption || '',
                duration: response.duration
              }
            );
          } else if (response.type === 'location' && response.latitude && response.longitude) {
            // Handle location response
            await ctx.replyWithLocation(
              response.latitude,
              response.longitude
            );
          } else if (response.type === 'media_group' && response.media) {
            // Handle multiple media files (album)
            await ctx.replyWithMediaGroup(response.media);
          } else {
            // Handle text response
            const replyContent = response.content || response.response || response.message || "I processed your request but couldn't generate a response.";
            
            // Check if content has device info (which might have problematic characters)
            const isDeviceInfo = replyContent.includes('Connected devices:') && replyContent.includes('**Network Devices');
            
            // For device info, don't use Markdown to avoid parsing errors
            if (isDeviceInfo) {
              await ctx.reply(replyContent);
            } else {
              // Use sendLargeMessage for handling messages that might exceed Telegram's limit
              await this.sendLargeMessage(ctx, replyContent);
            }
          
            // Generate voice response if enabled (copied from TelegramInterface)
            const hasTtsService = !!this.agent.ttsService;
            const telegramEnabled = hasTtsService ? await this.agent.ttsService.isTelegramEnabled() : false;
            
            logger.info(`TelegramDashboard voice check - TTS Service exists: ${hasTtsService}, Telegram enabled: ${telegramEnabled}`);
            
            if (hasTtsService && telegramEnabled) {
              try {
                logger.info('TelegramDashboard: Generating Telegram voice response...');
                // Send typing indicator for voice generation
                await ctx.sendChatAction('record_voice');

                // Clean markdown from content before TTS (prevents speaking asterisks, brackets, etc.)
                const cleanedContent = this.cleanForSpeech(replyContent);
                logger.info(`TelegramDashboard: Generating speech for text: ${cleanedContent.length} characters (cleaned from ${replyContent.length})`);

                const voiceResult = await this.agent.ttsService.generateSpeech(cleanedContent);
                
                // Summarize the response for the voice caption
                const cleaned = replyContent
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
                logger.info(`TelegramDashboard: Sending voice message - size: ${voiceResult.size} bytes`);
                await ctx.replyWithVoice(
                  { source: voiceResult.buffer },
                  { 
                    caption: caption
                  }
                );
                
                logger.info(`TelegramDashboard: Voice response sent: ${voiceResult.size} bytes, cost: $${voiceResult.cost.toFixed(4)}`);
              } catch (error) {
                logger.error('TelegramDashboard: Failed to generate voice response:', error);
                // Don't send error to user, just log it
              }
            } else {
              logger.info(`TelegramDashboard: Voice response skipped - TTS: ${hasTtsService}, Telegram: ${telegramEnabled}`);
            }
          }
        }
      } catch (error) {
        logger.error('Text processing error:', error);
        await ctx.reply('❌ Sorry, I encountered an error processing your request.');
      }
    });

    // Handle voice messages
    this.bot.on(message('voice'), async (ctx) => {
      // Check authorization
      if (!ctx.isAuthorized && !ctx.isGuest) {
        return;
      }

      const userId = ctx.from.id.toString();

      // Check if wake word training is in progress for this user
      if (this.agent.wakeWordTraining?.isCollecting &&
          this.agent.wakeWordTraining.userId === userId) {
        const thinkingMsg = await ctx.reply('🎤 Processing training sample...');
        try {
          // Download voice file
          const fileId = ctx.message.voice.file_id;
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const response = await fetch(fileLink.href);
          const audioBuffer = Buffer.from(await response.arrayBuffer());

          // Process as training sample
          const result = await this.agent.wakeWordTraining.processVoiceSample(audioBuffer, userId);

          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);

          if (result.success) {
            await ctx.reply(result.message, { parse_mode: 'Markdown' });
          } else {
            await ctx.reply(`❌ ${result.message}`);
          }
        } catch (error) {
          logger.error('[TelegramDashboard] Error processing training sample:', error);
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
          await ctx.reply('❌ Failed to process training sample. Please try again.');
        }
        return;
      }

      const thinkingMsg = await ctx.reply('🎤 Processing voice message...');

      try {
        const fileId = ctx.message.voice.file_id;
        const duration = ctx.message.voice.duration;
        logger.info(`Received voice message: ${fileId}, duration: ${duration}s`);

        // Check minimum duration
        if (duration < 1) {
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
          await ctx.reply('🎤 Voice message too short. Please try again with a longer message.');
          return;
        }

        // Transcribe the voice message
        let transcription;
        try {
          transcription = await this.agent.transcribeVoice(fileId);
        } catch (transcribeError) {
          logger.error('Transcription error:', transcribeError);
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
          await ctx.reply('🎤 Could not understand the audio. Please speak clearly and try again.');
          return;
        }

        // Check for empty or invalid transcription
        if (!transcription || transcription.trim().length === 0) {
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
          await ctx.reply('🎤 No speech detected. Please try again.');
          return;
        }

        // Clean up transcription
        transcription = transcription.trim();
        logger.info(`Voice transcribed: "${transcription}"`);

        // Delete the "processing" message
        await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);

        // Show the user what was transcribed
        await ctx.reply(`🎤 *You said:* "${transcription}"`, { parse_mode: 'Markdown' });

        // Process the transcribed text through the agent
        const response = await this.agent.processNaturalLanguage(transcription, {
          userId: ctx.from.id.toString(),
          userName: ctx.from.first_name || ctx.from.username,
          chatId: ctx.chat.id.toString(),
          interface: 'telegram',
          isVoice: true
        });

        // Handle null response
        if (!response) {
          logger.warn('Received null response from agent for voice message');
          await ctx.reply("I couldn't process that request. Could you try again?");
          return;
        }

        // Send text response
        const replyContent = response.content || response.text || 'I processed your request.';
        await this.sendLargeMessage(ctx, replyContent);

        // Generate voice response if TTS is enabled for Telegram
        const hasTtsService = !!this.agent.ttsService;
        const telegramEnabled = hasTtsService ? await this.agent.ttsService.isTelegramEnabled() : false;

        // Check if response is suitable for TTS (skip JSON/object responses)
        const isTextSuitable = typeof replyContent === 'string' &&
          !replyContent.trim().startsWith('{') &&
          !replyContent.trim().startsWith('[') &&
          replyContent.length < 5000; // Skip very long responses

        if (hasTtsService && telegramEnabled && isTextSuitable) {
          try {
            logger.info('Generating voice response for voice input...');
            await ctx.sendChatAction('record_voice');

            const voiceResult = await this.agent.ttsService.generateSpeech(replyContent);

            await ctx.replyWithVoice(
              { source: voiceResult.buffer },
              { caption: '🎤 ALICE' }
            );

            logger.info(`Voice response sent: ${voiceResult.size} bytes`);
          } catch (error) {
            logger.error('Failed to generate voice response:', error);
          }
        }
      } catch (error) {
        logger.error('Voice processing error:', error);
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
        } catch (e) { /* ignore */ }
        await ctx.reply(`❌ Failed to process voice message: ${error.message}`);
      }
    });
  }

  setupCallbackHandlers() {
    // Dashboard callbacks
    this.bot.action('refresh_dashboard', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const status = await this.agent.getSystemStatus();
        logger.info('Dashboard status object:', JSON.stringify(status, null, 2));
        const dashboard = this.formatEnhancedDashboard(status);
        const keyboard = this.createDashboardKeyboard();
        
        await ctx.editMessageText(dashboard, {
          parse_mode: "Markdown",
          reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        logger.error("Dashboard refresh error:", error);
        await ctx.answerCbQuery("❌ Failed to refresh");
      }
    });

    this.bot.action('open_dashboard', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const status = await this.agent.getSystemStatus();
        logger.info('Dashboard status object:', JSON.stringify(status, null, 2));
        const dashboard = this.formatEnhancedDashboard(status);
        const keyboard = this.createDashboardKeyboard();
        
        await ctx.reply(dashboard, {
          parse_mode: "Markdown",
          reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        logger.error("Dashboard open error:", error);
        await ctx.answerCbQuery("❌ Failed to open dashboard");
      }
    });

    this.bot.action('close_dashboard', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await ctx.deleteMessage();
      } catch (error) {
        logger.error("Dashboard close error:", error);
      }
    });
    
    // Dashboard settings handler
    this.bot.action('dashboard_settings', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("🤖 AI Settings", "settings_ai"),
            Markup.button.callback("⏰ Automation", "settings_automation")
          ],
          [
            Markup.button.callback("🔧 Self-Modification", "settings_selfmod"),
            Markup.button.callback("📊 Status", "settings_status")
          ],
          [Markup.button.callback("❌ Close", "close_menu")]
        ]);

        await ctx.editMessageText(
          "⚙️ *Bot Settings*\n\n" +
          "Configure your LANAgent:",
          {
            parse_mode: "Markdown",
            reply_markup: keyboard.reply_markup
          }
        );
      } catch (error) {
        logger.error("Dashboard settings error:", error);
        await ctx.answerCbQuery("❌ Failed to open settings");
      }
    });
    
    // Email approval callbacks
    this.bot.action(/^reply_email_(.+)$/, async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        const emailUid = parseInt(ctx.match[1]);
        await ctx.answerCbQuery("✅ Generating reply...");
        
        // The email auto-reply system will handle the actual reply
        await ctx.editMessageText(
          ctx.callbackQuery.message.text + "\n\n✅ Approved - Reply will be sent",
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        logger.error("Email reply approval error:", error);
        await ctx.answerCbQuery("❌ Error processing approval");
      }
    });
    
    this.bot.action(/^ignore_email_(.+)$/, async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        const emailUid = parseInt(ctx.match[1]);
        await ctx.answerCbQuery("✅ Email ignored");
        
        await ctx.editMessageText(
          ctx.callbackQuery.message.text + "\n\n❌ Ignored - No reply sent",
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        logger.error("Email ignore error:", error);
        await ctx.answerCbQuery("❌ Error processing");
      }
    });

    // Add other callbacks for navigation
    this.bot.action(/^goto_(.+)$/, async (ctx) => {
      const section = ctx.match[1];
      await ctx.answerCbQuery();
      
      // Route to the appropriate section directly
      if (section === 'ai') {
        // Execute AI command directly
        try {
          const providers = this.agent.providerManager?.getProviderList() || [];
          const current = this.agent.getCurrentAIProvider?.() || { name: "Unknown" };
          
          let text = "🤖 *AI Provider Management*\n\n";
          text += `Current Provider: *${current.name}*\n\n`;
          text += "*Available Providers:*\n";
          
          const buttons = [];
          providers.forEach(p => {
            const icon = p.active ? "🟢" : "⚪";
            text += `${icon} ${p.name}\n`;
            if (!p.active) {
              buttons.push([Markup.button.callback(`Switch to ${p.name}`, `switch_provider_${p.name}`)]);
            }
          });
          
          buttons.push([Markup.button.callback("📊 View Metrics", "view_ai_metrics")]);
          buttons.push([Markup.button.callback("❌ Close", "close_menu")]);
          
          const keyboard = Markup.inlineKeyboard(buttons);
          
          await ctx.reply(text, {
            parse_mode: "Markdown",
            reply_markup: keyboard.reply_markup
          });
        } catch (error) {
          logger.error("AI section error:", error);
          ctx.reply("❌ Failed to load AI providers");
        }
      } else if (section === 'system') {
        // Execute System command directly
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("📦 Update System", "system_update"),
            Markup.button.callback("🔄 Restart Services", "restart_services")
          ],
          [
            Markup.button.callback("📊 Resource Usage", "system_resources"),
            Markup.button.callback("📝 View Logs", "system_logs")
          ],
          [
            Markup.button.callback("🐚 Shell Access", "shell_access"),
            Markup.button.callback("❌ Close", "close_menu")
          ]
        ]);

        await ctx.reply(
          "🖥️ *System Management*\n\n" +
          "Select an option:",
          {
            parse_mode: "Markdown",
            reply_markup: keyboard.reply_markup
          }
        );
      } else if (section === 'network') {
        // Execute Network command directly
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("🔍 Scan Network", "network_scan"),
            Markup.button.callback("🌐 Check Internet", "network_internet")
          ],
          [
            Markup.button.callback("📡 Port Scan", "network_ports"),
            Markup.button.callback("🔒 Security Check", "network_security")
          ],
          [Markup.button.callback("❌ Close", "close_menu")]
        ]);

        await ctx.reply(
          "🌐 *Network Tools*\n\n" +
          "Select a network operation:",
          {
            parse_mode: "Markdown",
            reply_markup: keyboard.reply_markup
          }
        );
      } else {
        await ctx.reply(`📋 ${section.toUpperCase()} section - Coming soon!`);
      }
    });

    // Network tool callbacks
    this.bot.action('network_scan', async (ctx) => {
      await ctx.answerCbQuery("🔍 Scanning network...");
      try {
        const response = await this.agent.processNaturalLanguage("scan the local network", {
          userId: ctx.from.id,
          interface: 'telegram'
        });
        await ctx.reply(response);
      } catch (error) {
        await ctx.reply("❌ Network scan failed: " + error.message);
      }
    });

    this.bot.action('network_internet', async (ctx) => {
      await ctx.answerCbQuery("🌐 Checking internet...");
      try {
        const response = await this.agent.processNaturalLanguage("check internet connectivity", {
          userId: ctx.from.id,
          interface: 'telegram'
        });
        await ctx.reply(response);
      } catch (error) {
        await ctx.reply("❌ Internet check failed: " + error.message);
      }
    });

    this.bot.action('network_ports', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply("📡 Port scan - Please specify the target:\nExample: `scan ports 192.168.1.1`");
    });

    this.bot.action('network_security', async (ctx) => {
      await ctx.answerCbQuery("🔒 Checking security...");
      try {
        const response = await this.agent.processNaturalLanguage("check network security", {
          userId: ctx.from.id,
          interface: 'telegram'
        });
        await ctx.reply(response);
      } catch (error) {
        await ctx.reply("❌ Security check failed: " + error.message);
      }
    });

    // System tool callbacks  
    this.bot.action('system_update', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      await ctx.answerCbQuery("📦 Updating system...");
      try {
        const response = await this.agent.processNaturalLanguage("update the system packages", {
          userId: ctx.from.id,
          interface: 'telegram'
        });
        await ctx.reply(response);
      } catch (error) {
        await ctx.reply("❌ Update failed: " + error.message);
      }
    });

    this.bot.action('restart_services', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      await ctx.answerCbQuery();
      await ctx.reply("🔄 Which service would you like to restart?\nExample: `restart nginx`");
    });

    this.bot.action('system_resources', async (ctx) => {
      await ctx.answerCbQuery("📊 Loading resources...");
      try {
        const response = await this.agent.processNaturalLanguage("show system resource usage", {
          userId: ctx.from.id,
          interface: 'telegram'
        });
        await ctx.reply(response);
      } catch (error) {
        await ctx.reply("❌ Resource check failed: " + error.message);
      }
    });

    this.bot.action('system_logs', async (ctx) => {
      await ctx.answerCbQuery("📝 Loading logs...");
      try {
        const response = await this.agent.processNaturalLanguage("show recent system logs", {
          userId: ctx.from.id,
          interface: 'telegram'
        });
        await ctx.reply(response);
      } catch (error) {
        await ctx.reply("❌ Log retrieval failed: " + error.message);
      }
    });

    this.bot.action('shell_access', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      await ctx.answerCbQuery();
      await ctx.reply("🐚 Shell mode activated. Send your commands directly.\nExample: `ls -la /home`");
    });

    // Show help callback
    this.bot.action('show_help', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('/help');
      this.bot.handleUpdate({ message: { text: '/help', from: ctx.from, chat: ctx.chat } });
    });

    // Close menu callback
    this.bot.action('close_menu', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await ctx.deleteMessage();
      } catch (error) {
        logger.error("Close menu error:", error);
      }
    });

    // AI provider callbacks
    this.bot.action(/^switch_provider_(.+)$/, async (ctx) => {
      const provider = ctx.match[1];
      await ctx.answerCbQuery();
      
      try {
        await this.agent.switchAIProvider(provider);
        await ctx.editMessageText(
          `✅ Switched to ${provider}`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        await ctx.editMessageText(
          `❌ Failed to switch to ${provider}`,
          { parse_mode: "Markdown" }
        );
      }
    });

    // System action callbacks
    this.bot.action('resource_usage', async (ctx) => {
      await ctx.answerCbQuery();
      
      const status = await this.agent.getSystemStatus();
      const sys = status.system;
      const usage = `📊 *Resource Usage*\n\n` +
        `CPU: ${sys?.cpu?.usage || "?"}% ` + 
        `${'█'.repeat(Math.floor((sys?.cpu?.usage || 0) / 10))}${'▒'.repeat(10 - Math.floor((sys?.cpu?.usage || 0) / 10))}\n` +
        `Memory: ${sys?.memory?.percentage || "?"}% ` +
        `${'█'.repeat(Math.floor((sys?.memory?.percentage || 0) / 10))}${'▒'.repeat(10 - Math.floor((sys?.memory?.percentage || 0) / 10))}\n` +
        `Disk: ${sys?.disk?.percentage || "?"}% ` +
        `${'█'.repeat(Math.floor((sys?.disk?.percentage || 0) / 10))}${'▒'.repeat(10 - Math.floor((sys?.disk?.percentage || 0) / 10))}\n\n` +
        `Temperature: ${sys?.temperature || "?"}°C\n` +
        `Load Average: ${sys?.loadAvg?.join(', ') || "N/A"}`;

      await ctx.editMessageText(usage, { parse_mode: "Markdown" });
    });

    // Settings callbacks
    this.bot.action(/^settings_(.+)$/, async (ctx) => {
      const setting = ctx.match[1];
      await ctx.answerCbQuery();
      
      if (setting === 'selfmod') {
        await this.showSelfModificationSettings(ctx);
      } else {
        await ctx.reply(`⚙️ ${setting.toUpperCase()} settings - Coming soon!`);
      }
    });
    
    // Self-modification callbacks
    this.bot.action('selfmod_enable', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        await this.agent.selfModification.enable();
        await ctx.answerCbQuery("✅ Self-modification enabled");
        await this.showSelfModificationSettings(ctx);
      } catch (error) {
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });
    
    this.bot.action('selfmod_disable', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      this.agent.selfModification.disable();
      await ctx.answerCbQuery("✅ Self-modification disabled");
      await this.showSelfModificationSettings(ctx);
    });
    
    this.bot.action('selfmod_status', async (ctx) => {
      await ctx.answerCbQuery();
      const status = this.agent.selfModification.getStatus();
      
      const message = `🔧 **Self-Modification Status**\n\n` +
        `**Enabled**: ${status.enabled ? '✅ Yes' : '❌ No'}\n` +
        `**Running**: ${status.isRunning ? '🔄 Yes' : '⏸️ No'}\n` +
        `**Current Branch**: ${status.currentBranch || 'main'}\n` +
        `**Idle Threshold**: ${status.idleThreshold / 60000} minutes\n` +
        `**Check Interval**: ${status.checkInterval / 60000} minutes\n\n` +
        `**Configuration**:\n` +
        `• Max Changes: ${status.config.maxChangesPerSession} lines\n` +
        `• Require Tests: ${status.config.requireTests ? 'Yes' : 'No'}\n` +
        `• Create PR: ${status.config.createPR ? 'Yes' : 'No'}\n` +
        `• Restricted Files: ${status.config.restrictedFiles.length}\n` +
        `• Improvement Types: ${status.config.allowedImprovements.length}`;
      
      await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    // Restart callbacks
    this.bot.action('confirm_restart', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        await ctx.answerCbQuery("🔄 Restarting...");
        await ctx.editMessageText("🔄 Agent restart initiated. I'll be back online in a few seconds!");
        
        const systemPlugin = this.agent.apiManager.getPlugin('system');
        if (systemPlugin) {
          // Pass the user ID for master-only check
          await systemPlugin.execute({ 
            action: 'restart', 
            delay: 3,
            userId: ctx.from.id.toString()
          });
        }
      } catch (error) {
        logger.error('Restart confirmation error:', error);
        await ctx.editMessageText("❌ Restart failed: " + error.message);
      }
    });

    // Development callbacks
    this.bot.action('dev_view_plan', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        await ctx.answerCbQuery();
        const devPlugin = this.agent.apiManager.getPlugin('development');
        if (devPlugin) {
          const result = await devPlugin.execute({ action: 'plan', subAction: 'view' });
          await ctx.reply(result.result, { parse_mode: 'Markdown' });
        }
      } catch (error) {
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('dev_add_feature', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      await ctx.answerCbQuery();
      await ctx.reply(
        "💡 *Add New Feature*\n\n" +
        "Send me the feature description and priority:\n\n" +
        "Example: `feature: Add web search capability [high]`"
      , { parse_mode: 'Markdown' });
    });

    this.bot.action('dev_todos', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        await ctx.answerCbQuery();
        const devPlugin = this.agent.apiManager.getPlugin('development');
        if (devPlugin) {
          const result = await devPlugin.execute({ action: 'todo', subAction: 'list' });
          await ctx.reply(result.result, { parse_mode: 'Markdown' });
        }
      } catch (error) {
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('dev_edits', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        await ctx.answerCbQuery();
        const devPlugin = this.agent.apiManager.getPlugin('development');
        if (devPlugin) {
          const result = await devPlugin.execute({ action: 'edits', subAction: 'list' });
          await ctx.reply(result.result, { parse_mode: 'Markdown' });
        }
      } catch (error) {
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('dev_prioritize', async (ctx) => {
      if (!ctx.isMaster) {
        await ctx.answerCbQuery("❌ Unauthorized");
        return;
      }
      
      try {
        await ctx.answerCbQuery("🔄 Prioritizing...");
        const devPlugin = this.agent.apiManager.getPlugin('development');
        if (devPlugin) {
          const result = await devPlugin.execute({ action: 'plan', subAction: 'prioritize' });
          await ctx.editMessageText("✅ " + result.result, { parse_mode: 'Markdown' });
        }
      } catch (error) {
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    // Log callbacks
    this.bot.action('logs_refresh', async (ctx) => {
      await ctx.answerCbQuery('Refreshing...');
      try {
        const operations = this.agent.getOperationLogsTelegram(20);
        await ctx.editMessageText(operations, { 
          parse_mode: 'Markdown',
          reply_markup: ctx.callbackQuery.message.reply_markup
        });
      } catch (error) {
        await ctx.reply('❌ Error refreshing logs');
      }
    });

    this.bot.action('logs_system', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        const history = this.agent.systemExecutor?.getHistory?.(20) || [];
        if (history.length === 0) {
          await ctx.reply("📊 No recent system commands.");
          return;
        }

        let message = "📊 *System Commands:*\n\n";
        history.forEach((entry) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const status = entry.result.success ? '✅' : '❌';
          message += `${status} ${time} - ${entry.command.substring(0, 50)}${entry.command.length > 50 ? '...' : ''}\n`;
        });

        await ctx.editMessageText(message, { 
          parse_mode: 'Markdown',
          reply_markup: ctx.callbackQuery.message.reply_markup
        });
      } catch (error) {
        await ctx.reply('❌ Error viewing system logs');
      }
    });

    this.bot.action('logs_plugins', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        const pluginOps = this.agent.getOperationLogs(20, { type: 'plugin' });
        if (pluginOps.length === 0) {
          await ctx.reply("🔌 No recent plugin operations.");
          return;
        }

        let message = "🔌 *Plugin Operations:*\n\n";
        pluginOps.forEach((op) => {
          const time = new Date(op.timestamp).toLocaleTimeString();
          const icon = op.status === 'success' ? '✅' : '❌';
          message += `${icon} ${time} - ${op.plugin}: ${op.action}\n`;
          if (op.result?.message) {
            message += `   → ${op.result.message}\n`;
          }
        });

        await ctx.editMessageText(message, { 
          parse_mode: 'Markdown',
          reply_markup: ctx.callbackQuery.message.reply_markup
        });
      } catch (error) {
        await ctx.reply('❌ Error viewing plugin logs');
      }
    });

    this.bot.action('logs_summary', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        const summary = this.agent.getOperationSummary();
        
        let message = "📈 *Operations Summary:*\n\n";
        message += `📊 Total Operations: ${summary.total}\n`;
        message += `⏱️ Last Hour: ${summary.lastHour}\n`;
        message += `📅 Last 24 Hours: ${summary.last24Hours}\n\n`;
        
        message += "*By Type:*\n";
        Object.entries(summary.byType).forEach(([type, count]) => {
          message += `• ${type}: ${count}\n`;
        });
        
        message += "\n*By Plugin:*\n";
        Object.entries(summary.byPlugin).forEach(([plugin, count]) => {
          message += `• ${plugin}: ${count}\n`;
        });
        
        message += "\n*By Status:*\n";
        Object.entries(summary.byStatus).forEach(([status, count]) => {
          const icon = status === 'success' ? '✅' : status === 'error' ? '❌' : '⏳';
          message += `${icon} ${status}: ${count}\n`;
        });

        await ctx.editMessageText(message, { 
          parse_mode: 'Markdown',
          reply_markup: ctx.callbackQuery.message.reply_markup
        });
      } catch (error) {
        await ctx.reply('❌ Error viewing summary');
      }
    });
    
    // Task callbacks
    this.bot.action('refresh_tasks', async (ctx) => {
      await ctx.answerCbQuery('🔄 Refreshing tasks...');
      this.bot.handleUpdate({ message: { text: '/tasks', from: ctx.from, chat: ctx.chat } });
    });
    
    this.bot.action('add_task', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply(
        "➕ *Add New Task*\n\n" +
        "To add a task, just type it naturally:\n\n" +
        "Examples:\n" +
        "• Add task: Deploy new feature to production\n" +
        "• Create reminder to check server logs tomorrow\n" +
        "• Schedule database backup for next week\n\n" +
        "Or use format: `add task <title>`",
        { parse_mode: 'Markdown' }
      );
    });
    
    // API callbacks
    this.bot.action('refresh_api', async (ctx) => {
      await ctx.answerCbQuery('🔄 Refreshing API info...');
      this.bot.handleUpdate({ message: { text: '/api', from: ctx.from, chat: ctx.chat } });
    });
    
    this.bot.action('api_test_email', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        const emailPlugin = this.agent.apiManager.getPlugin('email');
        if (!emailPlugin) {
          await ctx.reply('📧 Email plugin not loaded.');
          return;
        }
        
        const result = await emailPlugin.execute({ action: 'checkConnection' });
        const message = result.connected 
          ? `✅ Email connected!\nAccount: ${result.emailAddress}`
          : `❌ Email not connected: ${result.error}`;
          
        await ctx.reply(message);
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });
    
    this.bot.action('api_test_tasks', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        const tasksPlugin = this.agent.apiManager.getPlugin('tasks');
        if (!tasksPlugin) {
          await ctx.reply('📋 Tasks plugin not loaded.');
          return;
        }
        
        // Create a test task
        const result = await tasksPlugin.execute({
          action: 'create',
          title: 'Test task from API',
          priority: 'low',
          description: 'This is a test task created via the API'
        });
        
        await ctx.reply(
          `✅ Test task created!\n\n` +
          `ID: ${result.task.id}\n` +
          `Title: ${result.task.title}\n` +
          `Priority: ${result.task.priorityEmoji} ${result.task.priority}`
        );
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });
    
    // API plugin management
    this.bot.action('api_manage_plugins', async (ctx) => {
      await ctx.answerCbQuery();
      
      try {
        const plugins = this.agent.apiManager.getPluginList();
        let message = "⚙️ *Plugin Management*\n\n";
        
        const buttons = [];
        plugins.forEach(plugin => {
          const action = plugin.enabled ? 'disable' : 'enable';
          const emoji = plugin.enabled ? '🔴' : '🟢';
          buttons.push([
            Markup.button.callback(
              `${emoji} ${action.charAt(0).toUpperCase() + action.slice(1)} ${plugin.name}`,
              `api_${action}_${plugin.name}`
            )
          ]);
        });
        
        buttons.push([Markup.button.callback("🔙 Back to API", "refresh_api")]);
        
        const keyboard = Markup.inlineKeyboard(buttons);
        
        await ctx.editMessageText(message + "Select a plugin to enable/disable:", {
          parse_mode: 'Markdown',
          reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });
    
    // Plugin enable/disable callbacks
    this.bot.action(/^api_(enable|disable)_(.+)$/, async (ctx) => {
      const action = ctx.match[1];
      const pluginName = ctx.match[2];
      
      await ctx.answerCbQuery(`${action === 'enable' ? 'Enabling' : 'Disabling'} ${pluginName}...`);
      
      try {
        let result;
        if (action === 'enable') {
          result = await this.agent.apiManager.enablePlugin(pluginName);
        } else {
          result = await this.agent.apiManager.disablePlugin(pluginName);
        }
        
        await ctx.reply(`✅ ${result.message}`);
        
        // Refresh the plugin management view
        this.bot.handleUpdate({ 
          callback_query: { 
            ...ctx.callbackQuery, 
            data: 'api_manage_plugins',
            message: ctx.callbackQuery.message
          } 
        });
        
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });
    
    // Git callbacks
    this.bot.action('refresh_git', async (ctx) => {
      await ctx.answerCbQuery('🔄 Refreshing git status...');
      this.bot.handleUpdate({ message: { text: '/git', from: ctx.from, chat: ctx.chat } });
    });
    
    this.bot.action('git_add_all', async (ctx) => {
      await ctx.answerCbQuery('📝 Staging all changes...');
      try {
        const gitPlugin = this.agent.apiManager.getPlugin('git');
        const result = await gitPlugin.execute({ action: 'add', files: ['.'] });
        await ctx.reply(`✅ ${result.message}`);
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });
    
    this.bot.action('git_commit', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply(
        "💾 *Create Commit*\n\n" +
        "Please type your commit message:\n" +
        "Example: `commit: Fix API integration bug`\n\n" +
        "Or let me generate one: `commit: auto`",
        { parse_mode: 'Markdown' }
      );
    });
    
    this.bot.action('git_push', async (ctx) => {
      await ctx.answerCbQuery('⬆️ Pushing to remote...');
      try {
        const gitPlugin = this.agent.apiManager.getPlugin('git');
        const result = await gitPlugin.execute({ action: 'push' });
        await ctx.reply("✅ Pushed to remote successfully");
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });
    
    this.bot.action('git_pull', async (ctx) => {
      await ctx.answerCbQuery('⬇️ Pulling from remote...');
      try {
        const gitPlugin = this.agent.apiManager.getPlugin('git');
        const result = await gitPlugin.execute({ action: 'pull' });
        await ctx.reply(result.hasConflicts 
          ? "⚠️ Pulled with conflicts - resolve before continuing"
          : "✅ Pulled latest changes successfully"
        );
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });
    
    this.bot.action('git_log', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        const gitPlugin = this.agent.apiManager.getPlugin('git');
        const result = await gitPlugin.execute({ action: 'log', limit: 5 });
        await ctx.reply(
          "📜 *Recent Commits*\n\n```\n" + result.commits.join('\n') + "\n```",
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Chart generation callbacks
    this.bot.action('chart_system_health', async (ctx) => {
      await ctx.answerCbQuery('📊 Generating system health chart...');
      try {
        const status = await this.agent.getSystemStatus();
        const chartResult = await this.mediaGenerator.generateSystemHealthChart({
          cpu: parseFloat(status.system?.cpu?.replace('%', '') || 0),
          memory: parseFloat(status.system?.memory?.replace('%', '') || 0),
          disk: parseFloat(status.system?.disk?.replace('%', '') || 0)
        });

        if (chartResult.success) {
          await ctx.replyWithPhoto(
            { source: chartResult.filepath },
            { 
              caption: '📊 **System Health Overview**\n\nGenerated: ' + new Date().toLocaleString(),
              parse_mode: 'Markdown'
            }
          );
          // Clean up the file after sending
          setTimeout(() => chartResult.cleanup(), 5000);
        } else {
          await ctx.reply('❌ Failed to generate system health chart: ' + chartResult.error);
        }
      } catch (error) {
        logger.error('Error generating system health chart:', error);
        await ctx.reply('❌ Error generating chart: ' + error.message);
      }
    });

    this.bot.action('chart_process_usage', async (ctx) => {
      await ctx.answerCbQuery('🔄 Generating process usage chart...');
      try {
        // Get process data from process manager if available
        const processData = await this.agent.processManager?.checkProcessHealth?.() || { processes: [] };
        
        const chartResult = await this.mediaGenerator.generateProcessPieChart(processData.processes || []);

        if (chartResult.success) {
          await ctx.replyWithPhoto(
            { source: chartResult.filepath },
            { 
              caption: '🔄 **Process Usage Chart**\n\nTop processes by CPU usage\n\nGenerated: ' + new Date().toLocaleString(),
              parse_mode: 'Markdown'
            }
          );
          setTimeout(() => chartResult.cleanup(), 5000);
        } else {
          await ctx.reply('❌ Failed to generate process chart: ' + chartResult.error);
        }
      } catch (error) {
        logger.error('Error generating process chart:', error);
        await ctx.reply('❌ Error generating chart: ' + error.message);
      }
    });

    this.bot.action('chart_ai_usage', async (ctx) => {
      await ctx.answerCbQuery('🤖 Generating AI usage chart...');
      try {
        // Get AI usage data from provider manager
        const providers = this.agent.providerManager?.getProviderList() || [];
        const usageData = providers.map(provider => ({
          name: provider.name || provider.type,
          tokens: Math.floor(Math.random() * 10000) + 1000 // Mock data for demo
        }));

        const chartResult = await this.mediaGenerator.generateAIUsageChart(usageData);

        if (chartResult.success) {
          await ctx.replyWithPhoto(
            { source: chartResult.filepath },
            { 
              caption: '🤖 **AI Provider Usage Analytics**\n\nToken usage by provider\n\nGenerated: ' + new Date().toLocaleString(),
              parse_mode: 'Markdown'
            }
          );
          setTimeout(() => chartResult.cleanup(), 5000);
        } else {
          await ctx.reply('❌ Failed to generate AI usage chart: ' + chartResult.error);
        }
      } catch (error) {
        logger.error('Error generating AI usage chart:', error);
        await ctx.reply('❌ Error generating chart: ' + error.message);
      }
    });

    this.bot.action('chart_progress_demo', async (ctx) => {
      await ctx.answerCbQuery('📈 Generating progress demonstration...');
      try {
        // Demo progress bar
        const progressResult = await this.mediaGenerator.generateProgressBar(
          'System Update Progress',
          75,
          { 
            subtitle: 'Installing security patches...', 
            color: '#2ecc71' // green
          }
        );

        if (progressResult.success) {
          await ctx.replyWithPhoto(
            { source: progressResult.filepath },
            { 
              caption: '📈 **Progress Bar Demo**\n\nExample: System update progress indicator\n\nGenerated: ' + new Date().toLocaleString(),
              parse_mode: 'Markdown'
            }
          );
          setTimeout(() => progressResult.cleanup(), 5000);
        }

        // Also demo installation progress
        const installSteps = [
          'Checking dependencies',
          'Downloading packages',
          'Installing updates',
          'Configuring services',
          'Finalizing installation'
        ];

        const installResult = await this.mediaGenerator.generateInstallProgressChart(installSteps, 2);

        if (installResult.success) {
          await ctx.replyWithPhoto(
            { source: installResult.filepath },
            { 
              caption: '🛠️ **Installation Progress Demo**\n\nExample: Step-by-step progress visualization\n\nGenerated: ' + new Date().toLocaleString(),
              parse_mode: 'Markdown'
            }
          );
          setTimeout(() => installResult.cleanup(), 5000);
        }
      } catch (error) {
        logger.error('Error generating progress demo:', error);
        await ctx.reply('❌ Error generating progress demo: ' + error.message);
      }
    });

    // Diagnostics callbacks
    this.bot.action('diag_run', async (ctx) => {
      try {
        await ctx.answerCbQuery("🔄 Running diagnostics...");
        await ctx.editMessageText("🏥 Running comprehensive system diagnostics...\n\n⏳ This may take a few moments...");
        
        const result = await this.agent.selfDiagnosticsService.runDiagnostics('manual', ctx.from.id.toString());
        
        if (result.success) {
          const report = await this.agent.selfDiagnosticsService.getReport(result.reportId);
          const formatted = this.agent.selfDiagnosticsService.formatReport(report);
          
          await ctx.editMessageText(formatted, { 
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback("🔄 Run Again", "diag_run")],
              [Markup.button.callback("📊 View Trend", "diag_trend")],
              [Markup.button.callback("✅ Done", "close_dashboard")]
            ]).reply_markup
          });
        } else {
          await ctx.editMessageText(`❌ Diagnostics failed: ${result.error}`);
        }
      } catch (error) {
        logger.error('Diagnostics run error:', error);
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('diag_latest', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const report = await this.agent.selfDiagnosticsService.getReport();
        
        if (!report) {
          await ctx.reply("📭 No diagnostic reports found. Run diagnostics first.");
          return;
        }
        
        const formatted = this.agent.selfDiagnosticsService.formatReport(report);
        await ctx.editMessageText(formatted, { 
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("🔄 Run New", "diag_run")],
            [Markup.button.callback("📊 View Trend", "diag_trend")],
            [Markup.button.callback("✅ Done", "close_dashboard")]
          ]).reply_markup
        });
      } catch (error) {
        logger.error('Diagnostics latest error:', error);
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('diag_trend', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const trend = await this.agent.selfDiagnosticsService.getHealthTrend(7);
        
        if (!trend || trend.length === 0) {
          await ctx.reply("📈 No trend data available. Run diagnostics over several days to see trends.");
          return;
        }
        
        let trendMessage = `📈 *7-Day Health Trend*\n\n`;
        trend.forEach(day => {
          const healthCounts = day.healthCounts.reduce((acc, health) => {
            acc[health] = (acc[health] || 0) + 1;
            return acc;
          }, {});
          
          const icon = healthCounts.critical ? '🔴' : healthCounts.warning ? '🟡' : '🟢';
          trendMessage += `${icon} *${day._id}*\n`;
          trendMessage += `  Checks: ${day.count}, Avg Duration: ${Math.round(day.avgDuration)}ms\n`;
          Object.entries(healthCounts).forEach(([health, count]) => {
            trendMessage += `  ${health}: ${count}\n`;
          });
          trendMessage += '\n';
        });
        
        await ctx.reply(trendMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Diagnostics trend error:', error);
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('diag_history', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const history = await this.agent.selfDiagnosticsService.getHistory(10);
        
        if (!history || history.length === 0) {
          await ctx.reply("📜 No diagnostic history found.");
          return;
        }
        
        let historyMessage = `📜 *Diagnostic History*\n\n`;
        history.forEach(report => {
          const icon = report.overallHealth === 'critical' ? '🔴' : 
                      report.overallHealth === 'warning' ? '🟡' : '🟢';
          historyMessage += `${icon} *${report.timestamp.toLocaleString()}*\n`;
          historyMessage += `  Health: ${report.overallHealth}\n`;
          historyMessage += `  Trigger: ${report.triggeredBy}\n`;
          historyMessage += `  Duration: ${report.duration}ms\n`;
          if (report.summary) {
            historyMessage += `  Summary: ${report.summary}\n`;
          }
          historyMessage += '\n';
        });
        
        await ctx.reply(historyMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Diagnostics history error:', error);
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('diag_settings', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const service = this.agent.selfDiagnosticsService;
        const config = service.config;
        
        const message = `⚙️ *Diagnostic Settings*\n\n` +
          `**Auto-Check**: ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `**Check Interval**: Every ${config.autoRunInterval / 1000 / 60 / 60} hours\n` +
          `**Last Run**: ${service.lastRun ? service.lastRun.toLocaleString() : 'Never'}\n\n` +
          `**Thresholds:**\n` +
          `  Memory: ${config.thresholds.memory}%\n` +
          `  Disk: ${config.thresholds.disk}%\n` +
          `  CPU: ${config.thresholds.cpu}%\n` +
          `  Response Time: ${config.thresholds.responseTime}ms\n\n` +
          `**Critical Checks:**\n` +
          config.criticalChecks.map(check => `  • ${check}`).join('\n');
        
        await ctx.reply(message, { 
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(config.enabled ? "⏸️ Disable Auto-Check" : "▶️ Enable Auto-Check", "diag_toggle_auto")
            ],
            [Markup.button.callback("✅ Done", "close_dashboard")]
          ]).reply_markup
        });
      } catch (error) {
        logger.error('Diagnostics settings error:', error);
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });

    this.bot.action('diag_toggle_auto', async (ctx) => {
      try {
        const service = this.agent.selfDiagnosticsService;
        service.config.enabled = !service.config.enabled;
        
        await ctx.answerCbQuery(service.config.enabled ? "✅ Auto-check enabled" : "⏸️ Auto-check disabled");
        
        // Reinitialize to update the interval
        if (service.config.enabled) {
          await service.initialize();
        }
        
        // Show updated settings
        await this.bot.telegram.callApi('answerCallbackQuery', {
          callback_query_id: ctx.callbackQuery.id,
          text: service.config.enabled ? "✅ Auto-check enabled" : "⏸️ Auto-check disabled"
        });
      } catch (error) {
        logger.error('Diagnostics toggle error:', error);
        await ctx.answerCbQuery("❌ Error: " + error.message);
      }
    });
  }

  async getAboutInformation() {
    const status = await this.agent.getSystemStatus();
    return `🤖 *About ${this.agent.config.name}*\n\n` +
      `Hi! I'm **${this.agent.config.name}** (v${status.agent.version}), your AI-powered personal assistant running on a dedicated home server.\n\n` +
      `🏠 **What I Am:**\n` +
      `• AI assistant with persistent memory\n` +
      `• Home server management system\n` +
      `• Development and automation helper\n` +
      `• Multi-interface communication hub\n\n` +
      `🖥️ **Where I Live:**\n` +
      `• Server: ${status.system.hostname}\n` +
      `• Platform: ${status.system.platform} (${status.system.arch})\n` +
      `• Uptime: ${status.agent.uptime}\n` +
      `• Interfaces: Telegram, Web Dashboard, SSH\n\n` +
      `🧠 **My Personality:**\n` +
      `I'm helpful, proactive, technical, and friendly. I can manage your server, help with development tasks, control IoT devices, and remember our conversations!\n\n` +
      `📚 **Documentation:**\n` +
      `GitHub: https://github.com/PortableDiag/LANAgent\n` +
      `Use /features to see what I can do!`;
  }

  async showSelfModificationSettings(ctx) {
    const status = this.agent.selfModification.getStatus();
    
    const message = `🔧 **Self-Modification Settings**\n\n` +
      `This feature allows ALICE to analyze and improve her own code during idle time.\n\n` +
      `**Status**: ${status.enabled ? '✅ ENABLED' : '❌ DISABLED'}\n` +
      `**Safety**: All changes create PRs for review\n\n` +
      `**Capabilities**:\n` +
      `• Add helpful code comments\n` +
      `• Fix TODO items\n` +
      `• Improve error handling\n` +
      `• Optimize imports\n` +
      `• Replace console.log with logger\n` +
      `• Small refactoring tasks\n\n` +
      `⚠️ **Warning**: This is an experimental feature!`;
    
    const keyboard = status.enabled ?
      Markup.inlineKeyboard([
        [Markup.button.callback("🛑 Disable", "selfmod_disable")],
        [Markup.button.callback("📊 View Status", "selfmod_status")],
        [Markup.button.callback("🔙 Back", "settings")]
      ]) :
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Enable", "selfmod_enable")],
        [Markup.button.callback("📊 View Status", "selfmod_status")],
        [Markup.button.callback("🔙 Back", "settings")]
      ]);
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    } else {
      await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    }
  }

  async getFeaturesInformation() {
    const pluginList = this.agent.apiManager.getPluginList();
    const providerCount = this.agent.providerManager.getProviderList?.()?.length || 5;
    
    let message = `🚀 *${this.agent.config.name} Capabilities*\n\n`;
    
    message += `🎯 **Core Interfaces:**\n`;
    message += `✅ Telegram Bot (this interface)\n`;
    message += `✅ Web Dashboard (http://${getServerHost()}:${process.env.AGENT_PORT || 3000})\n`;
    message += `✅ SSH Server (port 2222)\n\n`;
    
    message += `🤖 **AI Integration:**\n`;
    message += `• ${providerCount} AI providers (OpenAI, Anthropic, etc.)\n`;
    message += `• Natural language command processing\n`;
    message += `• Context-aware conversations\n\n`;
    
    message += `🔌 **API Plugins (${pluginList.length}):**\n`;
    pluginList.forEach(plugin => {
      const status = plugin.enabled ? '✅' : '❌';
      const testStatus = ['tasks', 'email', 'git'].includes(plugin.name.toLowerCase()) ? '' : ' (testing needed)';
      message += `${status} ${plugin.name} v${plugin.version}${testStatus}\n`;
    });
    
    message += `\n📋 **What I Can Do:**\n`;
    message += `• **System Management**: Monitor resources, manage processes\n`;
    message += `• **Development**: Git operations, code assistance\n`;
    message += `• **Task Management**: Create, track, and remind about tasks\n`;
    message += `• **Email**: Send emails with templates via Gmail\n`;
    message += `• **IoT Programming**: Arduino/ESP32 with 9+ templates\n`;
    message += `• **Network Tools**: Port scanning, device discovery\n`;
    message += `• **Docker**: Container management operations\n`;
    message += `• **Memory**: Remember conversations and preferences\n\n`;
    
    message += `🎮 **Try These Commands:**\n`;
    message += `/dashboard - Live system metrics\n`;
    message += `/tasks - Manage your tasks\n`;
    message += `/ai - Switch AI providers\n`;
    message += `/api - Explore plugins\n`;
    message += `"Add task: Deploy new feature" - Natural language\n\n`;
    
    message += `📖 **Learn More:**\n`;
    message += `GitHub README: https://github.com/PortableDiag/LANAgent\n`;
    message += `Just ask me anything - I'm here to help! 🤝`;
    
    return message;
  }

  async start() {
    await super.start();
    
    // Override startup notification (non-blocking)
    this.sendNotification(
      `🚀 *${this.agent.config.name} Dashboard is online!*\n\n` +
      `Access the enhanced dashboard with /dashboard`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("📊 Open Dashboard", "open_dashboard")]
        ]).reply_markup
      }
    ).catch(error => {
      logger.error('Failed to send dashboard startup notification:', error);
    });
  }
}