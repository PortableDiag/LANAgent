import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

export class MultiUserSupport {
  constructor(agent) {
    this.agent = agent;
    this.masterUserId = process.env.TELEGRAM_USER_ID;
    this.masterEmail = process.env.EMAIL_OF_MASTER || '';
    
    // Define restricted commands that only master can use
    this.restrictedCommands = [
      'system', 'network', 'git', 'logs', 'settings', 'api',
      'execute', 'shell', 'sudo', 'restart', 'shutdown', 'install',
      'uninstall', 'delete', 'remove', 'modify', 'update', 'deploy',
      'push', 'pull', 'commit', 'merge', 'branch', 'clone',
      'email', 'send', 'write'
    ];
    
    // Define safe commands for other users
    this.safeCommands = [
      'start', 'help', 'about', 'features', 'dashboard', 
      'tasks', 'newchat', 'status', 'info'
    ];
    
    // Track conversations with non-master users
    this.conversations = new Map();
    // Track email conversations separately
    this.emailConversations = new Map();
    
    // Clean up any existing GitHub notifications on startup
    setTimeout(() => {
      if (this.emailConversations) {
        this.emailConversations.delete('notifications@github.com');
        logger.info('Cleaned up GitHub notifications from guest logs');
      }
    }, 1000);
  }

  /**
   * Check if user is the master
   */
  isMaster(userId) {
    return userId && userId.toString() === this.masterUserId;
  }

  /**
   * Check if a command/message contains restricted actions
   */
  containsRestrictedAction(text) {
    const lowerText = text.toLowerCase();
    
    // Check for restricted command keywords
    for (const cmd of this.restrictedCommands) {
      if (lowerText.includes(cmd)) {
        return true;
      }
    }
    
    // Check for system-level operations
    const restrictedPatterns = [
      /(?:run|execute|perform)\s+(?:command|script|code)/i,
      /(?:access|modify|delete)\s+(?:file|folder|system)/i,
      /(?:send|write|compose)\s+email/i,
      /(?:restart|shutdown|reboot)\s+(?:system|server|agent)/i,
      /(?:install|uninstall|update)\s+(?:package|software|plugin)/i,
      /git\s+(?:push|pull|commit|merge|branch)/i,
      /ssh\s+(?:into|access|connect)/i,
      /(?:root|sudo|admin)\s+access/i
    ];
    
    return restrictedPatterns.some(pattern => pattern.test(text));
  }

  /**
   * Process message from non-master user
   */
  async processGuestMessage(ctx, text) {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'Guest';
    const username = ctx.from.username || 'unknown';
    
    // Log guest interaction
    logger.info(`Guest interaction from ${userName} (@${username}, ID: ${userId}): ${text}`);
    
    // Check if it's a restricted action
    if (this.containsRestrictedAction(text)) {
      await ctx.reply(
        `❌ Sorry, that action is restricted. I can only perform system operations for my authorized user.\n\n` +
        `✅ I can help you with:\n` +
        `• General questions and conversations\n` +
        `• Information about my capabilities\n` +
        `• Task viewing (read-only)\n` +
        `• Status information\n\n` +
        `If you need system-level assistance, please contact my administrator.`
      );
      
      // Notify master about the attempt
      await this.notifyMaster(
        `⚠️ Restricted action attempt:\n` +
        `User: ${userName} (@${username})\n` +
        `ID: ${userId}\n` +
        `Message: "${text}"`
      );
      
      return;
    }
    
    // Track conversation
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, {
        userName,
        username,
        startTime: new Date(),
        messageCount: 0,
        lastMessage: null
      });
      
      // Notify master about new conversation
      await this.notifyMaster(
        `👤 New user conversation started:\n` +
        `User: ${userName} (@${username})\n` +
        `ID: ${userId}\n` +
        `First message: "${text}"`
      );
    }
    
    // Update conversation tracking
    const conv = this.conversations.get(userId);
    conv.messageCount++;
    conv.lastMessage = new Date();
    
    // Prepare context for AI
    const context = {
      userId,
      userName,
      username,
      isGuest: true,
      masterName: 'my authorized user',
      restrictions: 'conversational_only'
    };
    
    // Add system prompt for guest interactions
    const guestSystemPrompt = `You are ${this.agent.config.name}, a personal assistant agent. You are currently talking to a guest user (not your authorized user). 
    You should:
    - Be helpful and friendly
    - Answer general questions
    - NOT perform any system operations
    - NOT send emails or access private data
    - Politely decline requests for restricted actions
    - Mention that system operations are only available to your authorized user
    - Remember that you work on behalf of your authorized user (master)`;
    
    try {
      // Process with AI but with guest context (with retry for transient errors)
      const response = await retryOperation(
        () => this.agent.processNaturalLanguage(text, context, guestSystemPrompt),
        { retries: 2, context: 'processGuestMessage', minTimeout: 1000 }
      );

      await ctx.reply(response.text || response);

      // Log successful interaction
      logger.info(`Guest response sent to ${userName} (${userId})`);
      
    } catch (error) {
      logger.error('Error processing guest message:', error);
      await ctx.reply('❌ Sorry, I encountered an error processing your message. Please try again.');
    }
  }

  /**
   * Check if command is safe for guests
   */
  isSafeCommand(command) {
    return this.safeCommands.includes(command.toLowerCase());
  }

  /**
   * Process command from guest
   */
  async processGuestCommand(ctx, command) {
    const userName = ctx.from.first_name || 'Guest';
    
    if (this.isSafeCommand(command)) {
      // Allow safe commands to proceed
      return true;
    }
    
    // Block restricted command
    await ctx.reply(
      `❌ Sorry ${userName}, the /${command} command is restricted.\n\n` +
      `Available commands for guests:\n` +
      `• /start - Welcome message\n` +
      `• /help - Get help\n` +
      `• /about - Learn about ALICE\n` +
      `• /features - See capabilities\n` +
      `• /dashboard - View system status (read-only)`
    );
    
    // Notify master
    await this.notifyMaster(
      `⚠️ Restricted command attempt:\n` +
      `User: ${userName} (@${ctx.from.username})\n` +
      `Command: /${command}`
    );
    
    return false;
  }

  /**
   * Notify master via Telegram
   */
  async notifyMaster(message) {
    try {
      const telegram = this.agent.interfaces?.get('telegram');
      if (telegram && telegram.bot) {
        await telegram.bot.telegram.sendMessage(this.masterUserId, message);
      }
    } catch (error) {
      logger.error('Failed to notify master:', error);
    }
  }

  /**
   * Track email conversation
   */
  trackEmailConversation(fromEmail, subject) {
    const emailKey = fromEmail.toLowerCase();
    
    // Skip tracking for GitHub notifications
    if (emailKey === 'notifications@github.com') {
      return;
    }
    
    if (!this.emailConversations.has(emailKey)) {
      this.emailConversations.set(emailKey, {
        email: fromEmail,
        messageCount: 0,
        startTime: new Date(),
        lastMessage: null,
        subjects: new Set()
      });
    }
    
    const conv = this.emailConversations.get(emailKey);
    conv.messageCount++;
    conv.lastMessage = new Date();
    conv.subjects.add(subject);
    
    logger.info(`Email conversation tracked: ${fromEmail} (${conv.messageCount} messages)`);
  }

  /**
   * Get conversation statistics
   */
  getConversationStats() {
    const stats = {
      totalConversations: this.conversations.size + this.emailConversations.size,
      telegramConversations: this.conversations.size,
      emailConversations: this.emailConversations.size,
      activeToday: 0,
      totalMessages: 0,
      users: []
    };
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Process Telegram conversations
    for (const [userId, conv] of this.conversations) {
      stats.totalMessages += conv.messageCount;
      
      if (conv.lastMessage && conv.lastMessage >= today) {
        stats.activeToday++;
      }
      
      stats.users.push({
        userId,
        userName: conv.userName,
        username: conv.username,
        messageCount: conv.messageCount,
        firstSeen: conv.startTime,
        lastSeen: conv.lastMessage,
        type: 'telegram'
      });
    }
    
    // Process Email conversations
    for (const [email, conv] of this.emailConversations) {
      stats.totalMessages += conv.messageCount;
      
      if (conv.lastMessage && conv.lastMessage >= today) {
        stats.activeToday++;
      }
      
      stats.users.push({
        userId: email,
        userName: email.split('@')[0],
        username: email,
        messageCount: conv.messageCount,
        firstSeen: conv.startTime,
        lastSeen: conv.lastMessage,
        type: 'email',
        subjects: Array.from(conv.subjects)
      });
    }
    
    return stats;
  }

  /**
   * Clean up old conversations (older than 30 days)
   */
  cleanupOldConversations() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Also clean up GitHub notifications that might have been tracked before
    this.emailConversations.delete('notifications@github.com');
    
    for (const [userId, conv] of this.conversations) {
      if (conv.lastMessage && conv.lastMessage < thirtyDaysAgo) {
        this.conversations.delete(userId);
      }
    }
    
    for (const [email, conv] of this.emailConversations) {
      if (conv.lastMessage && conv.lastMessage < thirtyDaysAgo) {
        this.emailConversations.delete(email);
      }
    }
  }

  /**
   * Load recent email conversations from database to restore state after restart
   */
  async loadEmailConversationsFromDatabase() {
    try {
      // Import Email model dynamically to avoid circular dependencies
      const { Email } = await import('../../models/Email.js');
      
      // Get emails from the last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      const recentEmails = await Email.find({
        type: 'received',
        sentDate: { $gte: sevenDaysAgo }
      }).sort({ sentDate: -1 });
      
      // Group emails by sender and rebuild conversation tracking
      const emailGroups = new Map();
      
      for (const email of recentEmails) {
        if (!email.from) continue;
        
        // Extract email address from "Name <email@domain.com>" format
        const emailMatch = email.from.match(/<(.+?)>/) || email.from.match(/([^\s<>]+@[^\s<>]+)/);
        const fromEmail = emailMatch ? emailMatch[1] || emailMatch[0] : email.from;
        
        if (!fromEmail || !fromEmail.includes('@')) continue;
        
        const emailKey = fromEmail.toLowerCase();
        
        if (!emailGroups.has(emailKey)) {
          emailGroups.set(emailKey, {
            fromEmail,
            emails: [],
            subjects: new Set()
          });
        }
        
        const group = emailGroups.get(emailKey);
        group.emails.push(email);
        if (email.subject) {
          group.subjects.add(email.subject);
        }
      }
      
      // Restore email conversations from database
      for (const [emailKey, group] of emailGroups) {
        if (!this.emailConversations.has(emailKey)) {
          const firstEmail = group.emails[group.emails.length - 1]; // Oldest email
          const lastEmail = group.emails[0]; // Newest email
          
          this.emailConversations.set(emailKey, {
            email: group.fromEmail,
            messageCount: group.emails.length,
            startTime: firstEmail.sentDate,
            lastMessage: lastEmail.sentDate,
            subjects: group.subjects
          });
        }
      }
      
      if (emailGroups.size > 0) {
        logger.info(`Restored ${emailGroups.size} email conversations from database`);
      }
      
    } catch (error) {
      console.error('Failed to load email conversations from database:', error);
    }
  }
}

export default MultiUserSupport;