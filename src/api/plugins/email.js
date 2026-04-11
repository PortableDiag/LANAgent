import { BasePlugin } from '../core/basePlugin.js';
import nodemailer from 'nodemailer';
import Imap from 'imap';
import pkg from 'mailparser';
const { simpleParser } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Email } from '../../models/Email.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { EmailContactManager } from '../../utils/emailContactManager.js';
import { addGravatarHeaders, getGravatarUrl, enrichContactWithGravatar, fetchGravatarProfile } from '../../utils/gravatarHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class EmailPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'email';
    this.version = '1.0.0';
    this.description = 'Email integration with Gmail support';
    this.commands = [
      {
        command: 'send',
        description: 'Send an email',
        usage: 'send({ to: "user@example.com", subject: "Hello", html: "<p>Message</p>", attachments: [] })'
      },
      {
        command: 'check',
        description: 'Check for new emails',
        usage: 'check({ folder: "INBOX", limit: 10, unreadOnly: true })'
      },
      {
        command: 'search',
        description: 'Search emails',
        usage: 'search({ query: "from:user@example.com", folder: "INBOX", limit: 20 })'
      },
      {
        command: 'reply',
        description: 'Reply to an email',
        usage: 'reply({ messageId: "msg123", text: "Reply message" })'
      },
      {
        command: 'schedule',
        description: 'Schedule an email to be sent later',
        usage: 'schedule({ to: "user@example.com", subject: "Meeting", html: "<p>Reminder</p>", sendAt: "2024-01-15T10:00:00" })'
      },
      {
        command: 'addContact',
        description: 'Add an email contact',
        usage: 'addContact({ email: "user@example.com", name: "John Doe", nickname: "john" })'
      },
      {
        command: 'listContacts',
        description: 'List all email contacts',
        usage: 'listContacts()'
      },
      {
        command: 'getFolder',
        description: 'Get emails from a specific folder',
        usage: 'getFolder({ folder: "Sent", limit: 10 })'
      },
      {
        command: 'delete',
        description: 'Delete an email',
        usage: 'delete({ messageId: "msg123" })'
      },
      {
        command: 'forward',
        description: 'Forward an email',
        usage: 'forward({ messageId: "msg123", to: "another@example.com", comment: "FYI" })'
      },
      {
        command: 'listScheduled',
        description: 'List all scheduled emails that have not been sent yet',
        usage: 'listScheduled()'
      },
      {
        command: 'cancelScheduled',
        description: 'Cancel a scheduled email',
        usage: 'cancelScheduled({ jobId: "job_id_here" })'
      },
      {
        command: 'scheduleRecurring',
        description: 'Schedule a recurring email with various recurrence patterns',
        usage: 'scheduleRecurring({ to: "user@example.com", subject: "Weekly Report", html: "<p>Report</p>", recurrence: "weekly" })\n        // Recurrence options: "daily", "weekly", "monthly", "yearly", "5 minutes", "2 hours", "0 9 * * 1" (cron)'
      },
      {
        command: 'listRecurring',
        description: 'List all active recurring email jobs',
        usage: 'listRecurring()'
      },
      {
        command: 'cancelRecurring',
        description: 'Cancel a recurring email job',
        usage: 'cancelRecurring({ jobId: "job_id_here" })'
      }
    ];
    this.transporter = null;
    this.oauth2Client = null;
    this.imap = null;
    this.gmailUser = null;
    this.gmailPassword = null;
    this.contactManager = new EmailContactManager(agent);
  }

  async initialize() {
    this.logger.info('Email plugin initializing...');

    // Support multiple email providers: gmail, outlook, or custom
    // Check generic EMAIL_* vars first, then fall back to GMAIL_* for backward compatibility
    const emailProvider = (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase();
    const emailUser = process.env.EMAIL_USER || process.env.GMAIL_USER;
    const emailPassword = process.env.EMAIL_PASSWORD || process.env.GMAIL_APP_PASS || process.env.GMAIL_APP_PASSWORD;

    // If no env credentials, check for P2P-leased email (welcome package)
    let leasedEmail = null;
    if (!emailUser || !emailPassword) {
      try {
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        const lease = await SystemSettings.getSetting('email.myLease', null);
        if (lease && lease.email && lease.password) {
          leasedEmail = lease;
          this.logger.info(`Using leased email: ${lease.email}`);
        }
      } catch (e) {
        this.logger.debug('Could not check for leased email:', e.message);
      }
    }

    const effectiveUser = emailUser || (leasedEmail ? leasedEmail.email : null);
    const effectivePassword = emailPassword || (leasedEmail ? leasedEmail.password : null);

    if (!effectiveUser || !effectivePassword) {
      this.logger.warn('Email credentials not found in environment or lease - email transport disabled, contact management still available');
      this.transporter = null;
      await this.ensureNotificationSettings();
      return;
    }

    // Provider-specific SMTP/IMAP configurations
    this.providerConfigs = {
      gmail: {
        smtp: { service: 'gmail' },
        imap: { host: 'imap.gmail.com', port: 993, tls: true }
      },
      outlook: {
        smtp: { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true },
        imap: { host: 'outlook.office365.com', port: 993, tls: true }
      },
      hotmail: {
        smtp: { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true },
        imap: { host: 'outlook.office365.com', port: 993, tls: true }
      },
      fastmail: {
        smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
        imap: { host: 'imap.fastmail.com', port: 993, tls: true }
      },
      custom: {
        smtp: {
          host: process.env.EMAIL_SMTP_HOST,
          port: parseInt(process.env.EMAIL_SMTP_PORT) || 587,
          secure: process.env.EMAIL_SMTP_SECURE === 'true'
        },
        imap: {
          host: process.env.EMAIL_IMAP_HOST,
          port: parseInt(process.env.EMAIL_IMAP_PORT) || 993,
          tls: process.env.EMAIL_IMAP_TLS !== 'false'
        }
      }
    };

    // If using leased email, override to custom provider with lease config
    let effectiveProvider = emailProvider;
    if (leasedEmail) {
      effectiveProvider = 'leased';
      this.providerConfigs.leased = {
        smtp: {
          host: leasedEmail.smtp?.host || 'mail.lanagent.net',
          port: leasedEmail.smtp?.port || 587,
          secure: false,
          requireTLS: leasedEmail.smtp?.starttls !== false
        },
        imap: {
          host: leasedEmail.imap?.host || 'mail.lanagent.net',
          port: leasedEmail.imap?.port || 993,
          tls: leasedEmail.imap?.secure !== false
        }
      };
    }

    const providerConfig = this.providerConfigs[effectiveProvider] || this.providerConfigs.gmail;
    this.currentProvider = effectiveProvider;
    this.imapConfig = providerConfig.imap;

    // Setup email transporter
    try {
      const transportConfig = {
        ...providerConfig.smtp,
        auth: {
          user: effectiveUser,
          pass: effectivePassword
        }
      };

      this.transporter = nodemailer.createTransport(transportConfig);

      // Verify connection
      await this.transporter.verify();
      this.logger.info(`Email plugin initialized with ${effectiveProvider} account: ${effectiveUser}`);

      // Store email address for agent use (keep gmailUser/gmailPassword for backward compatibility)
      this.setState('emailAddress', effectiveUser);
      this.gmailUser = effectiveUser;
      this.gmailPassword = effectivePassword;
      this.emailUser = effectiveUser;
      this.emailPassword = effectivePassword;

      // Enable auto-reply by default if not already configured
      if (!this.getState('autoReply')) {
        this.setState('autoReply', {
          enabled: true,
          subject: 'Auto-Reply: Message Received',
          message: `Thank you for your email. I am ${this.agent.config.name}, an AI assistant. I have received your message and will process it shortly.\n\nThis is an automated response. If this is urgent, please contact my administrator directly.`,
          startDate: new Date(),
          endDate: null
        });
        this.logger.info('Auto-reply enabled by default');
      }

      // Initialize notification settings if not already configured
      await this.ensureNotificationSettings();

    } catch (error) {
      this.logger.error(`Failed to initialize ${emailProvider} email transport:`, error.message);
      // Don't throw - allow plugin to load for contact management even if email fails
      this.transporter = null;
      this.logger.warn('Email plugin loaded without email transport - contact management still available');
    }
  }

  async execute(params) {
    const { action, ...data } = params;
    
    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['send', 'sendWithAI', 'sendWithTemplate', 'checkConnection', 'setAutoReply', 'sendBulk', 'getEmails', 'markAsRead', 'replyToEmail', 'searchEmails', 'addContact', 'listContacts', 'deleteContact', 'getContact', 'updateContact', 'findContact', 'blockContact', 'unblockContact', 'listBlockedContacts', 'sendWithConfirmation', 'promoteContact', 'getEmailById', 'getNotificationSettings', 'setNotificationSettings', 'schedule', 'listScheduled', 'cancelScheduled', 'scheduleRecurring', 'listRecurring', 'cancelRecurring']
      }
    });
    
    switch (action) {
      case 'send':
        return await this.sendEmail(data);
      case 'sendWithAI':
        return await this.sendEmailWithAI(data);
      case 'sendWithTemplate':
        return await this.sendWithTemplate(data);
      case 'checkConnection':
        return await this.checkConnection();
      case 'setAutoReply':
        return await this.setAutoReply(data);
      case 'sendBulk':
        return await this.sendBulkEmails(data);
      case 'getEmails':
        return await this.getEmails(data);
      case 'markAsRead':
        return await this.markAsRead(data);
      case 'replyToEmail':
        return await this.replyToEmail(data);
      case 'searchEmails':
        return await this.searchEmails(data);
      case 'addContact':
        return await this.addContact(data);
      case 'listContacts':
        return await this.listContacts(data);
      case 'deleteContact':
        return await this.deleteContact(data);
      case 'getContact':
        return await this.getContact(data);
      case 'updateContact':
        return await this.updateContact(data);
      case 'findContact':
        return await this.findContact(data);
      case 'blockContact':
        return await this.blockContact(data);
      case 'unblockContact':
        return await this.unblockContact(data);
      case 'listBlockedContacts':
        return await this.listBlockedContacts(data);
      case 'sendWithConfirmation':
        return await this.sendWithConfirmation(data);
      case 'promoteContact':
        return await this.promoteContact(data);
      case 'getEmailById':
        return await this.getEmailById(data);
      case 'getNotificationSettings':
        return await this.getNotificationSettings();
      case 'setNotificationSettings':
        return await this.setNotificationSettings(data);
      case 'schedule':
        return await this.scheduleEmail(data);
      case 'listScheduled':
        return await this.listScheduledEmails();
      case 'cancelScheduled':
        return await this.cancelScheduledEmail(data);
      case 'scheduleRecurring':
        return await this.scheduleRecurringEmail(data);
      case 'listRecurring':
        return await this.listRecurringEmails();
      case 'cancelRecurring':
        return await this.cancelRecurringEmail(data);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async sendEmail(data) {
    this.validateParams(data, {
      to: { required: true, type: 'string' },
      subject: { required: true, type: 'string' },
      text: { type: 'string' },
      html: { type: 'string' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
      attachments: { type: 'array' },
      replyTo: { type: 'string' },
      recipientName: { type: 'string' }
    });
    
    if (!data.text && !data.html) {
      throw new Error('Either text or html content is required');
    }
    
    if (!this.transporter) {
      throw new Error('Email transport not initialized');
    }
    
    // Resolve recipient to email address if needed
    let resolvedEmail = data.to;
    if (!data.to.includes('@')) {
      this.logger.info(`Resolving recipient name "${data.to}" to email address`);
      try {
        const resolution = await this.contactManager.resolveRecipient(data.to, false);
        if (resolution.email) {
          resolvedEmail = resolution.email;
          if (!data.recipientName && resolution.name) {
            data.recipientName = resolution.name;
          }
          this.logger.info(`Resolved "${data.to}" to ${resolvedEmail} (${data.recipientName}) with confidence ${resolution.confidence}`);
        } else {
          // Check if we have suggestions
          if (resolution.suggestions && resolution.suggestions.length > 0) {
            const suggestions = resolution.suggestions.map(s => {
              const name = s.contact?.metadata?.name || s.matchedValue || 'Unknown';
              const score = Math.round((s.score || 0) * 100);
              return `${name} (${score}% match)`;
            }).join(', ');
            throw new Error(`Could not find exact match for "${data.to}". Did you mean: ${suggestions}?`);
          } else {
            throw new Error(`Could not find contact "${data.to}". Please use a valid email address or contact name.`);
          }
        }
      } catch (err) {
        this.logger.error(`Failed to resolve recipient "${data.to}":`, err);
        throw new Error(err.message || `Could not resolve recipient "${data.to}". Please use a valid email address or known contact name.`);
      }
    }
    
    // Add AI assistant signature to emails
    const masterEmail = process.env.EMAIL_OF_MASTER || 'the user';
    const isToMaster = resolvedEmail.toLowerCase() === masterEmail.toLowerCase();
    
    // Get master's name from environment, contact card, or email address
    let masterName = process.env.MASTER_NAME;
    
    // If no MASTER_NAME set, extract from email address as default
    if (!masterName && masterEmail && masterEmail !== 'the user' && masterEmail.includes('@')) {
      const emailParts = masterEmail.split('@')[0];
      masterName = emailParts.charAt(0).toUpperCase() + emailParts.slice(1);
    }
    
    // If still no name, use fallback
    if (!masterName) {
      masterName = 'the user';
    }
    
    // Try to get better name from contact database if available
    if (masterEmail && masterEmail !== 'the user') {
      try {
        // Use the same listContacts action that the web interface uses
        const contactsResult = await this.execute({ action: 'listContacts' });
        this.logger.debug('Master contact lookup via listContacts:', contactsResult);
        
        if (contactsResult && contactsResult.success && contactsResult.contacts) {
          // Find the master contact by email
          const masterContact = contactsResult.contacts.find(contact => 
            contact.email && contact.email.toLowerCase() === masterEmail.toLowerCase()
          );
          
          if (masterContact && masterContact.name && 
              masterContact.name !== 'Unknown Name' && masterContact.name !== 'the user') {
            masterName = masterContact.name;
            this.logger.debug('Using master name from contact database:', masterName);
          } else {
            // Try to find by relationship = master as fallback
            const masterRelationshipContact = contactsResult.contacts.find(contact => 
              contact.relationship === 'master'
            );
            if (masterRelationshipContact && masterRelationshipContact.name && 
                masterRelationshipContact.name !== 'Unknown Name' && masterRelationshipContact.name !== 'the user') {
              masterName = masterRelationshipContact.name;
              this.logger.debug('Using master name from relationship=master contact:', masterName);
            }
          }
        }
      } catch (error) {
        this.logger.debug('Could not fetch master contact for signature:', error.message);
      }
    }
    
    // Use the masterName we've already processed
    const signatureName = masterName;
    
    const signature = isToMaster 
      ? `\n\n---\n${this.agent.config.name} - AI Assistant\nEmail: ${this.getState('emailAddress')}`
      : `\n\n---\n${this.agent.config.name} - ${signatureName}'s AI Assistant\nEmail: ${this.getState('emailAddress')}\nThis message was sent by an AI assistant on behalf of ${signatureName}.`;
    
    // Generate avatar URL for signature - prefer local avatar, fallback to Gravatar
    const serverHost = process.env.AGENT_HOST || process.env.SERVER_IP || 'localhost';
    const webPort = process.env.AGENT_PORT || 80;
    const localAvatarUrl = this.agent.agentModel?.avatarPath
      ? `http://${serverHost}:${webPort}/api/agent/avatar`
      : null;
    const signatureAvatarUrl = localAvatarUrl || getGravatarUrl(this.getState('emailAddress'), 100, 'robohash');
    
    const htmlSignature = isToMaster
      ? `<br><br>
        <table cellpadding="0" cellspacing="0" border="0" style="border-top: 2px solid #e0e0e0; padding-top: 20px; margin-top: 20px;">
          <tr>
            <td style="padding-right: 20px; vertical-align: top;">
              <img src="${signatureAvatarUrl}" alt="${this.agent.config.name}" style="width: 80px; height: 80px; border-radius: 50%; display: block;">
            </td>
            <td style="vertical-align: top;">
              <p style="margin: 0; padding: 0;">
                <strong style="font-size: 16px; color: #333;">${this.agent.config.name}</strong><br>
                <span style="color: #666; font-size: 14px;">AI Assistant</span><br>
                <a href="mailto:${this.getState('emailAddress')}" style="color: #0066cc; text-decoration: none; font-size: 14px;">${this.getState('emailAddress')}</a>
              </p>
            </td>
          </tr>
        </table>`
      : `<br><br>
        <table cellpadding="0" cellspacing="0" border="0" style="border-top: 2px solid #e0e0e0; padding-top: 20px; margin-top: 20px;">
          <tr>
            <td style="padding-right: 20px; vertical-align: top;">
              <img src="${signatureAvatarUrl}" alt="${this.agent.config.name}" style="width: 80px; height: 80px; border-radius: 50%; display: block;">
            </td>
            <td style="vertical-align: top;">
              <p style="margin: 0; padding: 0;">
                <strong style="font-size: 16px; color: #333;">${this.agent.config.name}</strong><br>
                <span style="color: #666; font-size: 14px;">${signatureName}'s AI Assistant</span><br>
                <a href="mailto:${this.getState('emailAddress')}" style="color: #0066cc; text-decoration: none; font-size: 14px;">${this.getState('emailAddress')}</a><br>
                <em style="color: #999; font-size: 12px;">This message was sent by an AI assistant on behalf of ${signatureName}.</em>
              </p>
            </td>
          </tr>
        </table>`;
    
    // Extract clean email address from resolved email (handle "Name <email>" format)
    const extractEmail = (input) => {
      if (!input) return input;
      // Remove extra quotes and extract email from various formats
      const cleanInput = input.replace(/^"([^"]+)"/, '$1');
      const emailMatch = cleanInput.match(/<([^<>]+@[^<>]+)>/) || cleanInput.match(/([^\s<>]+@[^\s<>]+)/);
      return emailMatch ? emailMatch[1] || emailMatch[0] : input;
    };
    
    const cleanEmail = extractEmail(resolvedEmail);
    
    // Look up recipient name if not provided and personalize content
    let recipientDisplay = cleanEmail;
    let recipientName = data.recipientName || null;
    
    // Always try to look up recipient name for personalization
    try {
      const contact = await this.findContactByEmailOrAlias(cleanEmail);
      if (contact && contact.metadata && contact.metadata.name) {
        recipientDisplay = `"${contact.metadata.name}" <${cleanEmail}>`;
        recipientName = contact.metadata.name;
      }
    } catch (err) {
      // Ignore lookup errors
    }
    
    // Fallback: If explicit recipientName provided, use it
    if (!recipientName && data.recipientName) {
      recipientDisplay = `"${data.recipientName}" <${cleanEmail}>`;
      recipientName = data.recipientName;
    }
    
    // Personalize content by adding recipient name at the beginning if not already present
    let personalizedText = data.text;
    let personalizedHtml = data.html;
    
    // Check if content already has a greeting
    const hasGreeting = (content) => {
      if (!content) return false;
      const firstLine = content.trim().split('\n')[0].toLowerCase();
      return firstLine.match(/^(dear|hello|hi|hey|good morning|good afternoon|good evening)\s/);
    };
    
    if (recipientName && personalizedText && !hasGreeting(personalizedText)) {
      personalizedText = `Dear ${recipientName},\n\n${personalizedText}`;
    }
    if (recipientName && personalizedHtml && !hasGreeting(personalizedHtml.replace(/<[^>]*>/g, ''))) {
      personalizedHtml = `<p>Dear ${recipientName},</p>\n\n${personalizedHtml}`;
    }
    
    // Append signature to content (use personalized content)
    const textContent = personalizedText ? personalizedText + signature : null;
    const htmlContent = personalizedHtml ? personalizedHtml + htmlSignature : (personalizedText ? `<p>${personalizedText.replace(/\n/g, '<br>')}</p>${htmlSignature}` : null);
    
    // Log who we're about to email for safety
    this.logger.info(`Preparing to send email to: ${recipientDisplay} (${resolvedEmail})`);
    this.logger.info(`Subject: ${data.subject}`);
    
    // Add Gravatar headers for better avatar support
    const enhancedHeaders = addGravatarHeaders(data.headers || {}, this.getState('emailAddress'), 'G', localAvatarUrl);
    
    const mailOptions = {
      from: `"${this.agent.config.name} (AI Assistant)" <${this.getState('emailAddress')}>`,
      to: recipientDisplay,
      subject: data.subject,
      text: textContent,
      html: htmlContent,
      cc: data.cc,
      bcc: data.bcc,
      replyTo: data.replyTo || this.getState('emailAddress'),
      headers: enhancedHeaders
    };
    
    // Handle attachments
    if (data.attachments && data.attachments.length > 0) {
      mailOptions.attachments = data.attachments.map(att => {
        if (typeof att === 'string') {
          // Assume it's a file path
          return { path: att };
        }
        return att;
      });
    }

    // Include README.md if requested
    if (data.includeReadme) {
      const readme = this.getReadmeAttachment();
      if (readme) {
        mailOptions.attachments = mailOptions.attachments || [];
        mailOptions.attachments.push(readme);
        this.logger.info('Attached README.md to email');
      } else {
        this.logger.warn('includeReadme requested but README.md not found');
      }
    }

    try {
      if (!this.transporter) {
        throw new Error('Email transport not initialized - Gmail credentials required');
      }
      const info = await this.transporter.sendMail(mailOptions);
      
      // Save sent email to MongoDB
      try {
        await Email.create({
          messageId: info.messageId,
          type: 'sent',
          from: this.getState('emailAddress'),
          to: recipientDisplay,  // Use display format with name
          cc: data.cc,
          bcc: data.bcc,
          subject: data.subject,
          text: textContent,
          html: htmlContent,
          preview: (textContent || '').substring(0, 200),
          sentDate: new Date(),
          processed: true,
          processedBy: 'sent'
        });
      } catch (saveError) {
        this.logger.error('Failed to save sent email to database:', saveError);
      }
      
      // Store in memory for tracking
      try {
        await this.agent.memoryManager.storeKnowledge(
          `Email sent - To: ${resolvedEmail}, Subject: ${data.subject}, MessageId: ${info.messageId}`,
          'email_history',
          { 
            importance: 7,
            messageId: info.messageId,
            to: resolvedEmail,
            subject: data.subject,
            timestamp: new Date(),
            status: 'sent',
            type: 'outgoing'
          }
        );
        
        // Store contact if not already known
        await this.storeEmailContact(cleanEmail, recipientName);
      } catch (err) {
        logger.debug("Could not store email history:", err);
      }
      
      // Notify via Telegram
      await this.notify(`📧 Email sent to ${resolvedEmail}\nSubject: ${data.subject}`);
      
      return {
        success: true,
        messageId: info.messageId,
        accepted: info.accepted,
        response: info.response
      };
      
    } catch (error) {
      this.logger.error('Failed to send email:', error);
      
      // Store failed attempt (disabled for now due to validation errors)
      // await this.storeMemory('failed_emails', {
      //   to: data.to,
      //   subject: data.subject,
      //   error: error.message,
      //   timestamp: new Date()
      // });
      
      throw error;
    }
  }

  async sendWithTemplate(data) {
    this.validateParams(data, {
      to: { required: true, type: 'string' },
      template: { required: false, type: 'string' },
      customTemplate: { required: false, type: 'object' },
      variables: { type: 'object' }
    });
    
    // Validate that either template or customTemplate is provided
    if (!data.template && !data.customTemplate) {
      throw new Error('Either template name or customTemplate object must be provided');
    }
    
    let templateToUse;
    
    // Check if using a custom template
    if (data.customTemplate) {
      this.validateParams(data.customTemplate, {
        subject: { required: true, type: 'string' },
        html: { required: false, type: 'string' },
        text: { required: false, type: 'string' }
      });
      
      if (!data.customTemplate.html && !data.customTemplate.text) {
        throw new Error('Custom template must have either html or text content');
      }
      
      templateToUse = data.customTemplate;
    } else {
      // Use predefined template
      const templates = {
      welcome: {
        subject: 'Welcome to {{agentName}}!',
        html: `
          <h1>Welcome!</h1>
          <p>Hello {{recipientName}},</p>
          <p>Thank you for connecting with {{agentName}}. I'm here to help you with:</p>
          <ul>
            <li>System management and automation</li>
            <li>Development assistance</li>
            <li>Task scheduling and reminders</li>
            <li>And much more!</li>
          </ul>
          <p>Feel free to reach out anytime!</p>
          <p>Best regards,<br>{{agentName}}</p>
        `
      },
      
      taskReminder: {
        subject: 'Task Reminder: {{taskTitle}}',
        html: `
          <h2>⏰ Task Reminder</h2>
          <p>This is a reminder about your task:</p>
          <h3>{{taskTitle}}</h3>
          <p>{{taskDescription}}</p>
          <p><strong>Due Date:</strong> {{dueDate}}</p>
          <p><strong>Due In:</strong> {{timeLeft}}</p>
          <p><strong>Priority:</strong> {{priority}}</p>
          <hr>
          <p>Sent by {{agentName}}</p>
        `
      },
      
      report: {
        subject: '{{reportType}} Report - {{date}}',
        html: `
          <h1>{{reportType}} Report</h1>
          <p>Generated on: {{date}}</p>
          <hr>
          {{reportContent}}
          <hr>
          <p><em>This report was automatically generated by {{agentName}}</em></p>
        `
      },
      
      notification: {
        subject: '{{agentName}} Notification: {{title}}',
        text: `
{{title}}

{{message}}

Time: {{timestamp}}

--
Sent by {{agentName}}
        `
      }
    };
    
      templateToUse = templates[data.template];
      if (!templateToUse) {
        throw new Error(`Unknown template: ${data.template}`);
      }
    }
    
    // Prepare variables
    const vars = {
      agentName: this.agent.config.name,
      timestamp: new Date().toLocaleString(),
      ...data.variables
    };
    
    // Replace variables in template
    let subject = templateToUse.subject;
    let html = templateToUse.html;
    let text = templateToUse.text;
    
    for (const [key, value] of Object.entries(vars)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      subject = subject.replace(regex, value);
      if (html) html = html.replace(regex, value);
      if (text) text = text.replace(regex, value);
    }
    
    return await this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
      cc: data.cc,
      bcc: data.bcc
    });
  }

  async checkConnection() {
    if (!this.transporter) {
      return {
        success: false,
        connected: false,
        error: 'Email transport not initialized'
      };
    }
    
    try {
      await this.transporter.verify();
      return {
        success: true,
        connected: true,
        emailAddress: this.getState('emailAddress')
      };
    } catch (error) {
      return {
        success: false,
        connected: false,
        error: error.message
      };
    }
  }

  async setAutoReply(data) {
    this.validateParams(data, {
      enabled: { required: true, type: 'boolean' },
      subject: { type: 'string' },
      message: { type: 'string' },
      startDate: { type: 'string' },
      endDate: { type: 'string' }
    });
    
    // Store auto-reply settings
    this.setState('autoReply', {
      enabled: data.enabled,
      subject: data.subject || 'Auto-Reply: I am currently unavailable',
      message: data.message || `Thank you for your email. I am currently unavailable and will respond as soon as possible.\n\nThis is an automated response from ${this.agent.config.name}.`,
      startDate: data.startDate ? new Date(data.startDate) : new Date(),
      endDate: data.endDate ? new Date(data.endDate) : null
    });
    
    // Note: Actual auto-reply would require email monitoring capability
    // This is a placeholder for settings management
    
    return {
      success: true,
      message: 'Auto-reply settings updated',
      settings: this.getState('autoReply')
    };
  }

  async sendBulkEmails(data) {
    this.validateParams(data, {
      recipients: { required: true, type: 'array' },
      subject: { required: true, type: 'string' },
      template: { type: 'string' },
      content: { type: 'object' },
      delay: { type: 'number', min: 0, max: 60000 }
    });
    
    const delay = data.delay || 1000; // Default 1 second between emails
    const results = [];
    
    for (let i = 0; i < data.recipients.length; i++) {
      const recipient = data.recipients[i];
      
      try {
        let emailData;
        
        if (data.template) {
          // Use template
          emailData = {
            to: typeof recipient === 'string' ? recipient : recipient.email,
            template: data.template,
            variables: {
              recipientName: recipient.name || 'User',
              ...data.content,
              ...(typeof recipient === 'object' ? recipient.variables : {})
            }
          };
          
          await this.sendWithTemplate(emailData);
        } else {
          // Direct send
          emailData = {
            to: typeof recipient === 'string' ? recipient : recipient.email,
            subject: data.subject,
            ...data.content
          };
          
          await this.sendEmail(emailData);
        }
        
        results.push({
          recipient: recipient,
          status: 'sent',
          timestamp: new Date()
        });
        
      } catch (error) {
        results.push({
          recipient: recipient,
          status: 'failed',
          error: error.message,
          timestamp: new Date()
        });
      }
      
      // Delay between sends (except for last one)
      if (i < data.recipients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Summary
    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;
    
    await this.notify(
      `📧 Bulk email completed\n` +
      `✅ Sent: ${sent}\n` +
      `❌ Failed: ${failed}\n` +
      `Total: ${data.recipients.length}`
    );
    
    return {
      success: true,
      total: data.recipients.length,
      sent,
      failed,
      results
    };
  }

  // Public methods for direct access
  async sendEmailDirect(to, subject, content) {
    return await this.sendEmail({
      to,
      subject,
      ...(typeof content === 'string' ? { text: content } : content)
    });
  }

  async sendTaskReminder(to, task) {
    return await this.sendWithTemplate({
      to,
      template: 'taskReminder',
      variables: {
        taskTitle: task.title,
        taskDescription: task.description || 'No description',
        dueDate: task.dueDate ? new Date(task.dueDate).toLocaleString() : 'Not set',
        priority: task.priority || 'medium'
      }
    });
  }

  async sendReport(to, reportType, content) {
    return await this.sendWithTemplate({
      to,
      template: 'report',
      variables: {
        reportType,
        date: new Date().toLocaleDateString(),
        reportContent: content
      }
    });
  }

  // Email reading methods

  async initializeImap() {
    if (!this.gmailUser || !this.gmailPassword) {
      throw new Error('Gmail credentials not configured');
    }
    
    // Return existing connection if it's still alive
    if (this.imap && this.imap.state === 'authenticated') {
      this.logger.debug('Reusing existing IMAP connection');
      return Promise.resolve();
    }
    
    // Close any existing dead connection
    if (this.imap) {
      try {
        this.imap.end();
      } catch (error) {
        this.logger.debug('Error closing old IMAP connection:', error.message);
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IMAP authentication timeout after 30 seconds'));
      }, 30000); // Increase timeout to 30 seconds

      // Use dynamic IMAP config based on provider
      const imapHost = this.imapConfig?.host || 'imap.gmail.com';
      const imapPort = this.imapConfig?.port || 993;
      const imapTls = this.imapConfig?.tls !== false;

      this.imap = new Imap({
        user: this.emailUser || this.gmailUser,
        password: this.emailPassword || this.gmailPassword,
        host: imapHost,
        port: imapPort,
        tls: imapTls,
        tlsOptions: {
          servername: imapHost,
          rejectUnauthorized: false // Help with some certificate issues
        },
        authTimeout: 30000, // Increase from 10 to 30 seconds
        connTimeout: 30000, // Add connection timeout
        keepalive: {
          interval: 10000, // Send keepalive every 10 seconds
          idleInterval: 300000, // 5 minutes
          forceNoop: true
        }
      });

      this.imap.once('ready', () => {
        clearTimeout(timeout);
        this.logger.info('IMAP connection established');
        resolve();
      });

      this.imap.once('error', (err) => {
        clearTimeout(timeout);
        this.logger.error('IMAP connection error:', err);
        this.imap = null; // Clear the connection on error
        reject(err);
      });
      
      this.imap.once('end', () => {
        this.logger.info('IMAP connection ended');
        this.imap = null; // Clear the connection when it ends
      });

      try {
        this.imap.connect();
      } catch (error) {
        clearTimeout(timeout);
        this.logger.error('IMAP connect error:', error);
        reject(error);
      }
    });
  }

  async getEmails(data = {}) {
    const {
      folder = 'INBOX',
      limit = 10,
      unreadOnly = false,
      markSeen = false
    } = data;

    try {
  await this.initializeImap();
} catch (error) {
  this.logger.error('Failed to initialize IMAP connection:', error);
  throw error;
}

    return new Promise((resolve, reject) => {
      this.imap.openBox(folder, false, async (err, box) => {
        if (err) {
          this.imap.end();
          return reject(err);
        }

        try {
          // Build search criteria
          const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
          
          this.imap.search(searchCriteria, (err, results) => {
            if (err) {
              this.imap.end();
              return reject(err);
            }

            if (!results || results.length === 0) {
              this.imap.end();
              return resolve({ success: true, emails: [], count: 0 });
            }

            // Get latest emails
            const toFetch = results.slice(-limit).reverse();
            const emails = [];

            const f = this.imap.fetch(toFetch, {
              bodies: '',
              markSeen: markSeen
            });

            const emailPromises = [];
            
            f.on('message', (msg, seqno) => {
              const emailPromise = new Promise((resolveEmail) => {
                let email = { seqno };
                let bodyParsed = false;
                let attributesParsed = false;

                const checkComplete = () => {
                  if (bodyParsed && attributesParsed) {
                    resolveEmail(email);
                  }
                };

                msg.on('body', (stream, info) => {
                  let buffer = '';
                  stream.on('data', chunk => {
                    buffer += chunk.toString('utf8');
                  });
                  stream.once('end', async () => {
                    try {
                      const parsed = await simpleParser(buffer);
                      email.messageId = parsed.messageId;
                      email.from = parsed.from?.text;
                      email.to = parsed.to?.text;
                      email.subject = parsed.subject;
                      email.date = parsed.date;
                      email.text = parsed.text;
                      email.html = parsed.html;
                      email.textAsHtml = parsed.textAsHtml;
                      email.attachments = parsed.attachments?.map(att => ({
                        filename: att.filename,
                        contentType: att.contentType,
                        size: att.size
                      }));
                      
                      // Save to MongoDB
                      try {
                        const existingEmail = await Email.findByMessageId(parsed.messageId);
                        if (!existingEmail) {
                          await Email.create({
                            messageId: parsed.messageId,
                            uid: email.uid,
                            type: 'received',
                            from: parsed.from?.text || '',
                            to: parsed.to?.text || this.gmailUser,
                            subject: parsed.subject || '(No subject)',
                            text: parsed.text,
                            html: parsed.html,
                            preview: (parsed.text || '').substring(0, 200),
                            sentDate: parsed.date || new Date(),
                            attachments: email.attachments,
                            flags: email.flags
                          });
                        }
                      } catch (saveError) {
                        this.logger.error('Failed to save email to database:', saveError);
                      }
                      
                      bodyParsed = true;
                      checkComplete();
                    } catch (parseError) {
                      this.logger.error('Email parsing error:', parseError);
                      bodyParsed = true;
                      checkComplete();
                    }
                  });
                });

                msg.once('attributes', (attrs) => {
                  email.uid = attrs.uid;
                  email.flags = attrs.flags;
                  attributesParsed = true;
                  checkComplete();
                });
              });
              
              emailPromises.push(emailPromise);
            });

            f.once('error', (err) => {
              this.imap.end();
              reject(err);
            });

            f.once('end', async () => {
              try {
                // Wait for all emails to be fully parsed
                const parsedEmails = await Promise.all(emailPromises);
                this.imap.end();
                resolve({
                  success: true,
                  emails: parsedEmails,
                  count: parsedEmails.length,
                  totalInFolder: box.messages.total,
                  unreadCount: results.length
                });
              } catch (parseError) {
                this.logger.error('Error waiting for email parsing:', parseError);
                this.imap.end();
                reject(parseError);
              }
            });
          });
        } catch (error) {
          this.imap.end();
          reject(error);
        }
      });
    });
  }

  async markAsRead(data) {
    this.validateParams(data, {
      uid: { required: true, type: 'number' }
    });

    await this.initializeImap();

    return new Promise((resolve, reject) => {
      this.imap.openBox('INBOX', false, (err) => {
        if (err) {
          this.imap.end();
          return reject(err);
        }

        this.imap.addFlags(data.uid, ['\\Seen'], (err) => {
          this.imap.end();
          if (err) return reject(err);
          resolve({ success: true, message: 'Email marked as read' });
        });
      });
    });
  }

  async searchEmails(data = {}) {
    const {
      query,
      from,
      to,
      subject,
      body,
      since,
      before,
      limit = 20
    } = data;

    await this.initializeImap();

    return new Promise((resolve, reject) => {
      this.imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          this.imap.end();
          return reject(err);
        }

        // Build search criteria
        const criteria = [];
        if (query) {
          criteria.push(['OR', ['SUBJECT', query], ['TEXT', query]]);
        }
        if (from) criteria.push(['FROM', from]);
        if (to) criteria.push(['TO', to]);
        if (subject) criteria.push(['SUBJECT', subject]);
        if (body) criteria.push(['TEXT', body]);
        if (since) criteria.push(['SINCE', new Date(since)]);
        if (before) criteria.push(['BEFORE', new Date(before)]);
        
        if (criteria.length === 0) criteria.push('ALL');

        this.imap.search(criteria, async (err, results) => {
          if (err) {
            this.imap.end();
            return reject(err);
          }

          if (!results || results.length === 0) {
            this.imap.end();
            return resolve({ success: true, emails: [], count: 0 });
          }

          // Fetch matching emails
          const toFetch = results.slice(-limit).reverse();
          const emails = [];

          const f = this.imap.fetch(toFetch, {
            bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
            struct: false
          });

          f.on('message', (msg, seqno) => {
            let email = { seqno };

            msg.on('body', (stream, info) => {
              let buffer = '';
              stream.on('data', chunk => {
                buffer += chunk.toString('utf8');
              });
              stream.once('end', () => {
                const lines = buffer.split('\r\n');
                lines.forEach(line => {
                  if (line.startsWith('From: ')) email.from = line.substring(6);
                  if (line.startsWith('To: ')) email.to = line.substring(4);
                  if (line.startsWith('Subject: ')) email.subject = line.substring(9);
                  if (line.startsWith('Date: ')) email.date = new Date(line.substring(6));
                });
              });
            });

            msg.once('attributes', (attrs) => {
              email.uid = attrs.uid;
              email.flags = attrs.flags;
            });

            msg.once('end', () => {
              emails.push(email);
            });
          });

          f.once('error', (err) => {
            this.imap.end();
            reject(err);
          });

          f.once('end', () => {
            this.imap.end();
            resolve({
              success: true,
              emails: emails,
              count: emails.length,
              query: data
            });
          });
        });
      });
    });
  }

  async replyToEmail(data) {
    this.validateParams(data, {
      originalMessageId: { required: true, type: 'string' },
      to: { required: true, type: 'string' },
      text: { required: true, type: 'string' }
    });

    // Extract original subject and add Re: if needed
    let subject = data.subject || 'Re: Your email';
    if (!subject.startsWith('Re: ') && !subject.startsWith('RE: ')) {
      subject = 'Re: ' + subject;
    }

    // Send the reply with threading headers
    return await this.sendEmail({
      to: data.to,
      subject: subject,
      text: data.text,
      html: data.html,
      headers: {
        'In-Reply-To': data.originalMessageId,
        'References': data.originalMessageId
      }
    });
  }

  async checkEmails() {
    try {
      // Fetch latest unread emails
      const result = await this.getEmails({
        unreadOnly: true,
        limit: 20,
        markSeen: false
      });
      
      this.logger.info(`Checked emails: ${result.count} new emails found`);
      
      return {
        success: true,
        newEmails: result.count,
        emails: result.emails
      };
    } catch (error) {
      this.logger.error('Error checking emails:', error);
      throw error;
    }
  }

  // Contact management methods
  async addContact(data) {
    this.validateParams(data, {
      email: { required: true, type: 'string' },
      name: { type: 'string' },
      aliases: { type: 'array' },
      phone: { type: 'string' },
      telegram: { type: 'string' },
      socialMedia: { type: 'object' }
    });
    
    try {
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email)) {
        throw new Error('Invalid email format');
      }
      
      // Check if contact already exists by email or aliases
      const existingContact = await this.findContactByEmailOrAlias(data.email);
      
      if (existingContact) {
        // Update existing contact
        const updatedFields = {};
        if (data.name && data.name !== existingContact.metadata.name) updatedFields.name = data.name;
        if (data.aliases) updatedFields.aliases = [...new Set([...(existingContact.metadata.aliases || []), ...data.aliases])];
        if (data.phone) updatedFields.phone = data.phone;
        if (data.telegram) updatedFields.telegram = data.telegram;
        if (data.socialMedia) updatedFields.socialMedia = { ...(existingContact.metadata.socialMedia || {}), ...data.socialMedia };
        
        if (Object.keys(updatedFields).length > 0) {
          await this.storeEmailContact(data.email, {
            ...existingContact.metadata,
            ...updatedFields
          }, true);
          
          await this.notify(`📝 Contact updated: ${updatedFields.name || existingContact.metadata.name} <${data.email}>`);
          return {
            success: true,
            message: 'Contact updated successfully',
            contact: {
              name: updatedFields.name || existingContact.metadata.name,
              email: data.email,
              aliases: updatedFields.aliases || existingContact.metadata.aliases || [],
              phone: updatedFields.phone || existingContact.metadata.phone,
              telegram: updatedFields.telegram || existingContact.metadata.telegram,
              socialMedia: updatedFields.socialMedia || existingContact.metadata.socialMedia,
              relationship: existingContact.metadata.relationship
            }
          };
        }
        
        return {
          success: true,
          message: 'Contact already exists',
          contact: {
            name: existingContact.metadata.name,
            email: data.email,
            aliases: existingContact.metadata.aliases || [],
            phone: existingContact.metadata.phone,
            telegram: existingContact.metadata.telegram,
            socialMedia: existingContact.metadata.socialMedia,
            relationship: existingContact.metadata.relationship
          }
        };
      }
      
      // Add new contact
      const contactData = {
        name: data.name || data.email.split('@')[0],
        email: data.email,
        aliases: data.aliases || [],
        phone: data.phone,
        telegram: data.telegram,
        socialMedia: data.socialMedia || {},
        relationship: 'contact'
      };
      
      await this.storeEmailContact(data.email, contactData);
      
      await this.notify(`✅ Contact added: ${contactData.name} <${data.email}>`);
      
      return {
        success: true,
        message: 'Contact added successfully',
        contact: contactData
      };
      
    } catch (error) {
      this.logger.error('Failed to add contact:', error);
      throw error;
    }
  }
  
  async listContacts(data) {
    const filter = data.filter || '';
    
    try {
      // Import Memory model directly to query by category
      const { Memory } = await import('../../models/Memory.js');
      
      // Build query - simplified without relationship filter
      const query = {
        type: 'knowledge',
        'metadata.category': 'email_contacts'
      };
      
      // Get all email contacts by category, sorted by importance and date
      const contacts = await Memory.find(query)
        .limit(500)
        .sort({ 
          "metadata.importance": -1, // Master/Self first (10), others by importance
          createdAt: -1 
        });
      
      this.logger.info(`Found ${contacts.length} raw contacts from database`);
      
      // Get deleted contacts to filter out - use precise search to avoid matching regular contacts
      const deletedContacts = await Memory.find({
        type: 'knowledge',
        content: { $regex: /^Deleted email contact:/i }
      }).limit(500);
      
      const deletedEmails = new Set(deletedContacts
        .map(d => {
          // Try to get email from metadata or from content
          const email = d.metadata?.email || d.content?.match(/([^\s]+@[^\s]+)/)?.[1];
          return email?.toLowerCase();
        })
        .filter(email => email !== undefined));
      
      this.logger.info(`After deletion filter check, deletedEmails size: ${deletedEmails.size}`);
      
      if (!contacts || contacts.length === 0) {
        this.logger.warn('No contacts returned from database query');
        return {
          success: true,
          count: 0,
          contacts: [],
          message: 'No contacts found'
        };
      }
      
      // Extract and format contact info, filtering out deleted ones
      this.logger.info(`Starting to process ${contacts.length} contacts`);
      
      const formattedContacts = contacts
        .filter((mem, index) => {
          if (index < 3) {
            this.logger.info(`Contact ${index}: content="${mem.content?.substring(0,50)}", hasMetadata=${!!mem.metadata}, metadataKeys=${mem.metadata ? Object.keys(mem.metadata).join(',') : 'none'}`);
          }
          
          // Keep contacts with metadata object (even if fields are undefined)
          if (!mem.metadata) {
            if (index < 10) this.logger.info(`Filtering out contact ${index} - no metadata object`);
            return false;
          }
          
          // Don't filter out contacts just because metadata fields are undefined - we can parse from content
          
          // Try to get email from metadata or content
          // Handle case where metadata.email is string "undefined"
          const metadataEmail = (mem.metadata.email && mem.metadata.email !== 'undefined') ? mem.metadata.email : null;
          const email = metadataEmail || (mem.content ? mem.content.match(/<([^>]+@[^>]+)>/)?.[1] || mem.content.match(/([^\s<]+@[^\s>]+)/)?.[1] : null);
          
          if (index < 3) {
            this.logger.info(`Contact ${index}: metadata.email="${mem.metadata.email}", extracted.email="${email}"`);
          }
          
          // If no email found, keep the contact (it might have been stored differently)
          if (!email) {
            if (index < 10) this.logger.info(`Keeping contact ${index} - no email found`);
            return true;
          }
          
          // Filter out system emails (noreply, support, mailer-daemon, etc.)
          const emailLower = email.toLowerCase();
          const systemEmailPatterns = [
            'noreply@', 'no-reply@', 'no_reply@', 'donotreply@', 'do-not-reply@', 'do_not_reply@',
            'mailer-daemon@', 'postmaster@', 'support@', 'help@', 'admin@',
            'notifications@', 'automated@', 'system@', 'bounce@', 'unsubscribe@'
          ];
          const noReplyRegex = /\b(no[-_.]?reply|do[-_.]?not[-_.]?reply)\b/i;
          if (systemEmailPatterns.some(pattern => emailLower.includes(pattern)) || noReplyRegex.test(emailLower)) {
            if (index < 10) this.logger.info(`Filtering out contact ${index} - system email: ${email}`);
            return false;
          }
          
          // Filter out only if email exists AND is in deleted set
          const keep = !deletedEmails.has(emailLower);
          if (!keep && index < 10) {
            this.logger.info(`Filtering out contact ${index} - deleted: ${email}`);
          }
          return keep;
        })
        .map(mem => {
          // Try to get from metadata first, then parse from content as fallback
          // Handle case where metadata fields are string "undefined"
          let name = (mem.metadata.name && mem.metadata.name !== 'undefined') ? mem.metadata.name : null;
          let email = (mem.metadata.email && mem.metadata.email !== 'undefined') ? mem.metadata.email : null;
          let aliases = (mem.metadata.aliases && Array.isArray(mem.metadata.aliases)) ? mem.metadata.aliases : [];
          
          // If metadata is missing, parse from content (for legacy contacts)
          if (!name || !email) {
            // Parse content like "Email contact: Name aka Alias <email@domain.com>"
            const contentMatch = mem.content.match(/Email contact:\s*(.+?)\s*<([^>]+)>/);
            if (contentMatch) {
              const nameAndAliases = contentMatch[1];
              email = email || contentMatch[2];
              
              // Split name and aliases  
              if (nameAndAliases && nameAndAliases.includes(' aka ')) {
                const parts = nameAndAliases.split(' aka ');
                name = name || parts[0];
                if (aliases.length === 0 && parts.length > 1) {
                  aliases = parts.slice(1);
                }
              } else {
                name = name || nameAndAliases;
              }
            }
          }
          
          // Final fallback to email match in content
          if (!email) {
            const emailMatch = mem.content ? mem.content.match(/<([^>]+@[^>]+)>/) || mem.content.match(/([^\s<]+@[^\s>]+)/) : null;
            email = emailMatch ? emailMatch[1] : 'unknown';
          }
          
          // Handle metadata fields that might be string "undefined"
          const safeGet = (field) => (field && field !== 'undefined') ? field : null;
          const safeGetArray = (field) => (Array.isArray(field) && field.length > 0) ? field : [];
          
          return {
            _id: mem._id.toString(),
            name: name || 'Unknown Name',
            email: email || 'unknown@email.com',
            aliases: aliases,
            phone: safeGet(mem.metadata.phone),
            telegram: safeGet(mem.metadata.telegram),
            socialMedia: (mem.metadata.socialMedia && typeof mem.metadata.socialMedia === 'object') ? mem.metadata.socialMedia : {},
            relationship: safeGet(mem.metadata.relationship) || 'contact',
            importance: mem.metadata.importance || 8,
            firstContact: mem.metadata.firstContactDate,
            lastContact: mem.metadata.lastContactDate || mem.metadata.firstContactDate,
            lastContactDate: mem.metadata.lastContactDate || mem.metadata.firstContactDate
          };
        });
      
      // Apply filter if provided
      const filteredContacts = filter 
        ? formattedContacts.filter(c => {
            const filterLower = filter.toLowerCase();
            return (
              (c.name && c.name.toLowerCase().includes(filterLower)) ||
              (c.email && c.email.toLowerCase().includes(filterLower)) ||
              (c.aliases && c.aliases.some(alias => alias && alias.toLowerCase().includes(filterLower))) ||
              (c.phone && c.phone.includes(filter)) ||
              (c.telegram && c.telegram.toLowerCase().includes(filterLower))
            );
          })
        : formattedContacts;
      
      this.logger.info(`After filtering and parsing: ${filteredContacts.length} contacts`);
      
      // Remove duplicates based on email address (keep the most recent/complete entry)
      const emailMap = new Map();
      filteredContacts.forEach(contact => {
        // Normalize email by removing angle brackets and converting to lowercase
        const email = contact.email.replace(/[<>]/g, '').toLowerCase();
        
        const existing = emailMap.get(email);
        if (!existing) {
          // First contact with this email
          emailMap.set(email, {...contact, email}); // Use normalized email
        } else {
          // Choose the better contact based on priority:
          // 1. Valid relationship (master > contact)
          // 2. Non-"Unknown Name" > "Unknown Name"  
          // 3. More complete data (aliases, phone, etc.)
          // 4. More recent creation
          
          const contactScore = this.calculateContactScore(contact);
          const existingScore = this.calculateContactScore(existing);
          
          if (contactScore > existingScore) {
            emailMap.set(email, {...contact, email}); // Use normalized email
          }
        }
      });
      
      const deduplicatedContacts = Array.from(emailMap.values());
      this.logger.info(`After deduplication: ${deduplicatedContacts.length} contacts (removed ${filteredContacts.length - deduplicatedContacts.length} duplicates)`);
      
      // Sort by name
      deduplicatedContacts.sort((a, b) => {
        const nameA = a.name || a.email;
        const nameB = b.name || b.email;
        return nameA.localeCompare(nameB);
      });
      
      // Check for Master contact and auto-create if missing or incomplete
      const masterEmail = process.env.EMAIL_OF_MASTER;
      if (masterEmail) {
        const masterContact = deduplicatedContacts.find(c => c.email.toLowerCase() === masterEmail.toLowerCase());
        
        if (!masterContact) {
          // Master contact doesn't exist, create it
          this.logger.info('Master contact not found, creating...');
          await this.storeEmailContact(masterEmail, {
            name: 'Master', // Default name, will prompt user to update
            relationship: 'master'
          });
          
          // Add to the list
          deduplicatedContacts.push({
            name: 'Master',
            email: masterEmail,
            aliases: [],
            phone: null,
            telegram: null,
            socialMedia: {},
            relationship: 'master',
            needsCompletion: true
          });
        } else if (!masterContact.name || masterContact.name === 'Unknown Name' || masterContact.name === masterEmail.split('@')[0]) {
          // Master contact exists but needs name completion
          masterContact.needsCompletion = true;
        }
      }
      
      this.logger.info(`Returning ${deduplicatedContacts.length} contacts to caller`);
      
      // Generate contact statistics
      const stats = {
        total: deduplicatedContacts.length
      };
      
      return {
        success: true,
        count: deduplicatedContacts.length,
        contacts: deduplicatedContacts,
        stats: stats,
        message: `Found ${deduplicatedContacts.length} contact${deduplicatedContacts.length !== 1 ? 's' : ''}`
      };
      
    } catch (error) {
      this.logger.error('Failed to list contacts:', error);
      throw error;
    }
  }

  async deleteContact(data) {
    // Support both email and contactId parameters
    if (!data.email && !data.contactId) {
      throw new Error('Either email or contactId is required');
    }
    
    try {
      let contact;
      let email;
      
      if (data.contactId) {
        // Find by MongoDB ID
        const { Memory } = await import('../../models/Memory.js');
        contact = await Memory.findById(data.contactId);
        
        if (!contact) {
          return {
            success: false,
            message: `Contact not found with ID: ${data.contactId}`
          };
        }
        
        email = contact.metadata?.email;
        if (!email) {
          return {
            success: false,
            message: 'Contact does not have a valid email address'
          };
        }
      } else {
        // Find by email (legacy support)
        const existingContacts = await this.agent.memoryManager.recall(`email contact ${data.email}`, {
          type: 'knowledge',
          limit: 1
        });
        
        if (!existingContacts || existingContacts.length === 0) {
          return {
            success: false,
            message: 'Contact not found'
          };
        }
        
        contact = existingContacts[0];
        email = data.email;
      }
      
      const isMasterEmail = email.toLowerCase() === (process.env.EMAIL_OF_MASTER || '').toLowerCase();
      const isAgentEmail = email.toLowerCase() === (process.env.EMAIL_USER || process.env.GMAIL_USER || '').toLowerCase();
      
      // Prevent deletion of master or self emails
      if (isMasterEmail || isAgentEmail) {
        return {
          success: false,
          message: `Cannot delete ${isMasterEmail ? 'master' : 'self'} contact`
        };
      }
      
      // Mark the contact as deleted by storing a deletion record
      await this.agent.memoryManager.storeKnowledge(
        `Deleted email contact: ${contact.metadata?.name || 'Unknown'} <${email}>`,
        'email_contacts_deleted',
        {
          importance: 5,
          email: email,
          name: contact.metadata?.name || 'Unknown',
          deletedAt: new Date(),
          originalContactId: contact.id || contact._id
        }
      );
      
      await this.notify(`🗑️ Contact deleted: ${contact.metadata?.name || 'Unknown'} <${email}>`);
      
      return {
        success: true,
        message: `Contact deleted: ${contact.metadata?.name || 'Unknown'} <${email}>`,
        contact: {
          name: contact.metadata?.name || 'Unknown',
          email: email
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to delete contact:', error);
      throw error;
    }
  }
  
  async getContact(data) {
    this.validateParams(data, {
      email: { required: true, type: 'string' }
    });
    
    try {
      // Check if contact has been deleted
      const deletedContacts = await this.agent.memoryManager.recall(`Deleted email contact ${data.email}`, {
        type: 'knowledge',
        limit: 1
      });
      
      if (deletedContacts && deletedContacts.length > 0) {
        return {
          success: false,
          message: 'Contact has been deleted'
        };
      }
      
      // Look up contact by email
      const contacts = await this.agent.memoryManager.recall(`email contact ${data.email}`, {
        type: 'knowledge',
        limit: 1
      });
      
      if (!contacts || contacts.length === 0) {
        return {
          success: false,
          message: 'Contact not found'
        };
      }
      
      const mem = contacts[0];
      const contact = {
        name: mem.metadata.name,
        email: mem.metadata.email || data.email,
        aliases: mem.metadata.aliases || [],
        phone: mem.metadata.phone || null,
        telegram: mem.metadata.telegram || null,
        socialMedia: mem.metadata.socialMedia || {},
        relationship: mem.metadata.relationship || 'contact',
        firstContact: mem.metadata.firstContactDate,
        lastContact: mem.metadata.lastContactDate || mem.metadata.firstContactDate
      };
      
      return {
        success: true,
        contact: contact
      };
      
    } catch (error) {
      this.logger.error('Failed to get contact:', error);
      throw error;
    }
  }

  async updateContact(data) {
    // Support both email and contactId parameters
    if (!data.email && !data.contactId) {
      throw new Error('Either email or contactId is required');
    }
    
    this.validateParams(data, {
      name: { type: 'string' },
      aliases: { type: 'array' },
      phone: { type: 'string' },
      telegram: { type: 'string' },
      socialMedia: { type: 'object' },
      addAliases: { type: 'array' },
      removeAliases: { type: 'array' },
      relationship: { type: 'string' },
      importance: { type: 'number' }
    });
    
    try {
      let existingContact;
      let email;
      
      if (data.contactId) {
        // Find by MongoDB ID
        const { Memory } = await import('../../models/Memory.js');
        existingContact = await Memory.findById(data.contactId);
        
        if (!existingContact) {
          return {
            success: false,
            message: `Contact not found with ID: ${data.contactId}`
          };
        }
        
        email = existingContact.metadata?.email;
        if (!email) {
          return {
            success: false,
            message: 'Contact does not have a valid email address'
          };
        }
      } else {
        // Find by email (legacy support)
        existingContact = await this.findContactByEmailOrAlias(data.email);
        
        if (!existingContact) {
          return {
            success: false,
            message: 'Contact not found'
          };
        }
        
        email = data.email;
      }
      
      // Build updated contact data
      const updatedData = { ...existingContact.metadata };
      
      // Update fields if provided
      if (data.name !== undefined) updatedData.name = data.name;
      if (data.phone !== undefined) updatedData.phone = data.phone;
      if (data.telegram !== undefined) updatedData.telegram = data.telegram;
      if (data.relationship !== undefined) updatedData.relationship = data.relationship;
      if (data.importance !== undefined) updatedData.importance = data.importance;
      if (data.socialMedia !== undefined) {
        updatedData.socialMedia = { ...updatedData.socialMedia, ...data.socialMedia };
      }
      
      // Handle aliases
      if (data.aliases !== undefined) {
        updatedData.aliases = data.aliases;
      } else {
        // Handle add/remove aliases
        let aliases = updatedData.aliases || [];
        
        if (data.addAliases) {
          aliases = [...new Set([...aliases, ...data.addAliases])];
        }
        
        if (data.removeAliases) {
          aliases = aliases.filter(alias => !data.removeAliases.includes(alias));
        }
        
        updatedData.aliases = aliases;
      }
      
      // Store updated contact
      await this.storeEmailContact(email, updatedData, true);
      
      await this.notify(`📝 Contact updated: ${updatedData.name} <${email}>`);
      
      return {
        success: true,
        message: 'Contact updated successfully',
        contact: updatedData
      };
      
    } catch (error) {
      this.logger.error('Failed to update contact:', error);
      throw error;
    }
  }
  
  async findContact(data) {
    // Handle self-referential queries
    const term = (data.searchTerm || '').trim().toLowerCase();
    const agentName = (process.env.AGENT_NAME || 'alice').toLowerCase();
    const ownerEmail = process.env.EMAIL_USER || process.env.GMAIL_USER;

    // "your email", "alice's email", agent name → return the agent's email
    const agentTerms = ['your', 'yours', 'your email', 'your address', 'agent', agentName];
    if (agentTerms.includes(term) || term.includes(agentName + "'s") || term.includes(agentName + "s ")) {
      const agentEmail = process.env.AGENT_EMAIL || ownerEmail;
      if (agentEmail) {
        return {
          success: true,
          contact: { name: process.env.AGENT_NAME || 'Agent', email: agentEmail },
          message: `My email is ${agentEmail}`
        };
      }
      return {
        success: false,
        message: 'No agent email configured. Set AGENT_EMAIL or EMAIL_USER in .env'
      };
    }

    // "my email", "me", "owner" → return the owner's email
    const ownerTerms = ['me', 'my', 'myself', 'owner', 'my email', 'my address'];
    if (!term || ownerTerms.includes(term)) {
      const ownerName = process.env.OWNER_NAME || 'Owner';
      if (ownerEmail) {
        return {
          success: true,
          contact: { name: ownerName, email: ownerEmail },
          message: `Your configured email is ${ownerEmail}`
        };
      }
      return {
        success: false,
        message: 'No owner email configured. Set EMAIL_USER or GMAIL_USER in .env'
      };
    }

    this.validateParams(data, {
      searchTerm: { required: true, type: 'string' }
    });

    try {
      // Use the new contact manager for better search
      const resolution = await this.contactManager.resolveRecipient(data.searchTerm, false);
      
      if (resolution.didYouMean) {
        // Multiple possible matches found
        return {
          success: false,
          message: `No exact match found for "${data.searchTerm}". Did you mean one of these?`,
          suggestions: resolution.suggestions.map(s => ({
            name: s.contact.metadata.name,
            email: s.contact.metadata.email,
            confidence: Math.round(s.score * 100)
          }))
        };
      }
      
      if (!resolution.contact && !resolution.email) {
        return {
          success: false,
          message: `No contact found matching "${data.searchTerm}"`
        };
      }
      
      const contact = resolution.contact || await this.findContactByEmailOrAlias(data.searchTerm);
      
      if (!contact) {
        return {
          success: false,
          message: 'Contact not found'
        };
      }
      
      return {
        success: true,
        contact: {
          name: contact.metadata.name,
          email: contact.metadata.email,
          aliases: contact.metadata.aliases || [],
          phone: contact.metadata.phone || null,
          telegram: contact.metadata.telegram || null,
          socialMedia: contact.metadata.socialMedia || {},
          relationship: contact.metadata.relationship || 'contact',
          firstContact: contact.metadata.firstContactDate,
          lastContact: contact.metadata.lastContactDate || contact.metadata.firstContactDate
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to find contact:', error);
      // Return user-friendly error instead of throwing
      return {
        success: false,
        message: error.message || 'Failed to find contact'
      };
    }
  }

  // Helper method to store email contacts
  async storeEmailContact(email, contactData, forceUpdate = false, source = 'personal') {
    try {
      // Clean email address to ensure consistent format
      const cleanEmailAddress = email.toLowerCase().trim();
      
      // Handle both old format (string name) and new format (object with all data)
      let fullContactData;
      if (!contactData || typeof contactData === 'string') {
        // Legacy format or no data - just name
        fullContactData = {
          name: (typeof contactData === 'string' ? contactData : null) || cleanEmailAddress.split('@')[0],
          email: cleanEmailAddress,
          aliases: [],
          phone: null,
          telegram: null,
          socialMedia: {}
        };
      } else {
        // New format - full contact data
        // Helper function to safely get values, converting string "undefined" to null
        const safeGet = (value) => {
          if (value === 'undefined' || value === undefined) return null;
          return value;
        };
        
        fullContactData = {
          name: safeGet(contactData.name) || cleanEmailAddress.split('@')[0],
          email: cleanEmailAddress,
          aliases: Array.isArray(contactData.aliases) ? contactData.aliases : [],
          phone: safeGet(contactData.phone),
          telegram: safeGet(contactData.telegram),
          socialMedia: (typeof contactData.socialMedia === 'object' && contactData.socialMedia !== null) ? contactData.socialMedia : {},
          relationship: safeGet(contactData.relationship),
          ...contactData
        };
      }
      
      // Enrich contact with Gravatar profile data (non-blocking, graceful fallback)
      try {
        const gravatarProfile = await fetchGravatarProfile(cleanEmailAddress);
        if (gravatarProfile) {
          // Add Gravatar data to contact
          fullContactData.gravatar = {
            avatarUrl: gravatarProfile.avatar_url,
            hasGravatar: !!gravatarProfile.avatar_url,
            profileUrl: gravatarProfile.profile_url
          };

          // Use Gravatar display name if we don't have a name
          if (!fullContactData.name || fullContactData.name === cleanEmailAddress.split('@')[0]) {
            if (gravatarProfile.display_name) {
              fullContactData.name = gravatarProfile.display_name;
            }
          }

          // Add additional profile info if available
          if (gravatarProfile.job_title) fullContactData.jobTitle = gravatarProfile.job_title;
          if (gravatarProfile.company) fullContactData.company = gravatarProfile.company;
          if (gravatarProfile.location) fullContactData.location = gravatarProfile.location;
          if (gravatarProfile.description) fullContactData.bio = gravatarProfile.description;

          // Add verified social accounts
          if (gravatarProfile.verified_accounts?.length > 0) {
            fullContactData.socialMedia = {
              ...fullContactData.socialMedia,
              ...Object.fromEntries(
                gravatarProfile.verified_accounts.map(acc => [acc.service_type, acc.url])
              )
            };
          }

          this.logger.debug(`Enriched contact ${cleanEmailAddress} with Gravatar data`);
        }
      } catch (gravatarError) {
        // Graceful fallback - don't fail if Gravatar is unavailable
        this.logger.debug(`Gravatar enrichment skipped for ${cleanEmailAddress}: ${gravatarError.message}`);
      }

      // Check if contact already exists using direct database query
      const { Memory } = await import('../../models/Memory.js');
      const existingContact = await Memory.findOne({
        type: 'knowledge',
        'metadata.category': 'email_contacts',
        $or: [
          { 'metadata.email': cleanEmailAddress },
          { 'metadata.email': email },  // Check original format too
          { content: new RegExp(`<${cleanEmailAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'i') },
          { content: new RegExp(`${cleanEmailAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }
        ]
      });
      
      if (existingContact && !forceUpdate) {
        this.logger.debug(`Contact ${cleanEmailAddress} already exists (ID: ${existingContact._id}), skipping duplicate creation`);
        return; // Contact already exists
      }
      
      // Determine relationship
      const isMasterEmail = email.toLowerCase() === (process.env.EMAIL_OF_MASTER || '').toLowerCase();
      const isAgentEmail = email.toLowerCase() === (process.env.EMAIL_USER || process.env.GMAIL_USER || '').toLowerCase();
      
      let relationship = fullContactData.relationship || 'contact';
      let importance = 8;
      
      if (isMasterEmail) {
        relationship = 'master';
        importance = 10;
      } else if (isAgentEmail) {
        relationship = 'self';
        importance = 10;
      } else {
        relationship = 'contact';
        importance = 8; // All regular contacts have same priority
      }
      
      // Build search content that includes all names and aliases
      const searchableNames = [fullContactData.name, ...fullContactData.aliases].filter(Boolean).join(' aka ');
      const contactDescription = `Email contact: ${searchableNames} <${email}>`;
      
      await this.agent.memoryManager.storeKnowledge(
        contactDescription,
        'email_contacts',
        {
          importance,
          email,
          name: fullContactData.name,
          aliases: fullContactData.aliases,
          phone: fullContactData.phone,
          telegram: fullContactData.telegram,
          socialMedia: fullContactData.socialMedia,
          relationship,
          firstContactDate: existingContact && existingContact.length > 0 
            ? existingContact[0].metadata.firstContactDate 
            : new Date(),
          lastContactDate: new Date(),
          isPermanent: true
        }
      );
      
      this.logger.info(`Stored email contact: ${searchableNames} <${email}> (${relationship})`);
      
      // Notify when new contact is discovered (excluding self/master)
      if (source === 'agent' && relationship === 'contact') {
        try {
          await this.notify(`📧 New contact discovered: ${fullContactData.name || email} <${email}> (from incoming email)`);
        } catch (notifyError) {
          this.logger.warn('Failed to send contact notification:', notifyError);
        }
      }
    } catch (error) {
      this.logger.error('Failed to store email contact:', error);
    }
  }

  // Helper method to calculate contact quality score for deduplication
  calculateContactScore(contact) {
    let score = 0;
    
    // Special relationships get priority (master/self are most important)
    if (contact.relationship === 'master' || contact.relationship === 'self') score += 1000;
    
    // Name quality
    if (contact.name && contact.name !== 'Unknown Name' && contact.name !== contact.email.split('@')[0]) score += 500;
    else if (contact.name && contact.name !== 'Unknown Name') score += 200;
    
    // Additional data completeness
    if (contact.aliases && contact.aliases.length > 0) score += 50;
    if (contact.phone) score += 30;
    if (contact.telegram) score += 30;
    if (contact.socialMedia && Object.keys(contact.socialMedia).length > 0) score += 20;
    
    // Penalize malformed emails
    if (contact.email && (contact.email.includes('<') || contact.email.includes('>'))) score -= 100;
    
    return score;
  }

  // Helper method to find contact by email or alias
  async findContactByEmailOrAlias(searchTerm) {
    try {
      this.logger.info(`Finding contact by email or alias: "${searchTerm}"`);
      
      // Use direct database query like storeEmailContact
      const { Memory } = await import('../../models/Memory.js');
      
      // First try exact email match if searchTerm looks like an email
      if (searchTerm.includes('@')) {
        const emailMatch = await Memory.findOne({
          type: 'knowledge',
          'metadata.category': 'email_contacts',
          $or: [
            { 'metadata.email': searchTerm },
            { content: new RegExp(`<${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'i') }
          ]
        });
        
        if (emailMatch) {
          this.logger.info('Found contact by exact email match');
          return emailMatch;
        }
      }
      
      // Get all contacts using direct database query
      const allContacts = await Memory.find({
        type: 'knowledge',
        'metadata.category': 'email_contacts'
      }).limit(500).sort({ createdAt: -1 });
      
      // Get deleted contacts to filter out - use precise search to avoid matching regular contacts  
      const deletedContacts = await Memory.find({
        type: 'knowledge',
        content: { $regex: /^Deleted email contact:/i }
      }).limit(500);
      
      const deletedEmails = new Set(deletedContacts
        .map(d => {
          // Try to get email from metadata or from content
          const email = d.metadata?.email || d.content?.match(/([^\s]+@[^\s]+)/)?.[1];
          return email?.toLowerCase();
        })
        .filter(email => email !== undefined));
      
      if (deletedEmails.size > 0) {
        this.logger.debug(`Deleted emails: ${Array.from(deletedEmails).join(', ')}`);
      }
      
      // Filter out deleted contacts
      const activeContacts = allContacts.filter(contact => {
        const email = contact.metadata?.email?.toLowerCase();
        // Keep contacts that have valid metadata even if email field is missing
        // Only filter out if email exists AND is in deleted set
        if (!contact.metadata) return false;
        if (!email) return true; // Keep contacts without email field
        return !deletedEmails.has(email);
      });
      
      this.logger.info(`Searching through ${activeContacts.length} active contacts (${allContacts.length} total, ${deletedEmails.size} deleted)...`);
      
      // Debug: Log first few contacts for inspection
      if (activeContacts.length > 0) {
        this.logger.debug(`Sample active contacts: ${activeContacts.slice(0, 3).map(c => 
          `${c.metadata?.name} (${c.metadata?.email || 'no-email'})`
        ).join(', ')}`);
      }
      
      // Search through contacts for matching name or alias
      const searchTermLower = searchTerm.toLowerCase();
      let exactMatches = [];
      let partialMatches = [];
      
      for (const contact of activeContacts) {
        const metadata = contact.metadata;
        if (!metadata) continue;
        
        // Log contact details for debugging
        this.logger.debug(`Checking contact: ${metadata.name} (${metadata.email}), aliases: ${metadata.aliases?.join(', ') || 'none'}`);
        
        // Check exact name match
        if (metadata.name && metadata.name.toLowerCase() === searchTermLower) {
          this.logger.info(`Found exact name match: ${metadata.name}`);
          exactMatches.push({ contact, matchType: 'exact-name', matchedValue: metadata.name });
        }
        
        // Check exact alias match
        if (metadata.aliases && Array.isArray(metadata.aliases)) {
          for (const alias of metadata.aliases) {
            if (alias.toLowerCase() === searchTermLower) {
              this.logger.info(`Found exact alias match: ${alias} -> ${metadata.name}`);
              exactMatches.push({ contact, matchType: 'exact-alias', matchedValue: alias });
            }
          }
        }
        
        // Only collect partial matches if no exact matches yet
        if (exactMatches.length === 0) {
          // Check if search term is contained in name (partial match)
          if (metadata.name && metadata.name.toLowerCase().includes(searchTermLower)) {
            // Calculate match score based on how much of the name matches
            const score = searchTermLower.length / metadata.name.length;
            partialMatches.push({ 
              contact, 
              matchType: 'partial-name', 
              matchedValue: metadata.name,
              score 
            });
          }
          
          // Check partial alias matches
          if (metadata.aliases && Array.isArray(metadata.aliases)) {
            for (const alias of metadata.aliases) {
              if (alias.toLowerCase().includes(searchTermLower)) {
                const score = searchTermLower.length / alias.length;
                partialMatches.push({ 
                  contact, 
                  matchType: 'partial-alias', 
                  matchedValue: alias,
                  score 
                });
              }
            }
          }
        }
      }
      
      // Return best match
      if (exactMatches.length === 1) {
        this.logger.info(`Returning single exact match: ${exactMatches[0].matchedValue}`);
        return exactMatches[0].contact;
      } else if (exactMatches.length > 1) {
        // Multiple exact matches - shouldn't happen but return first
        this.logger.warn(`Multiple exact matches found for "${searchTerm}", using first: ${exactMatches[0].matchedValue}`);
        return exactMatches[0].contact;
      } else if (partialMatches.length > 0) {
        // Sort by score (higher is better) and check if we have a clear winner
        partialMatches.sort((a, b) => b.score - a.score);
        
        // If the best match has a significantly higher score (>80% match), use it
        if (partialMatches[0].score > 0.8) {
          this.logger.info(`Found high-confidence partial match: ${partialMatches[0].matchedValue} (${Math.round(partialMatches[0].score * 100)}% match)`);
          return partialMatches[0].contact;
        } else if (partialMatches.length === 1) {
          // Only one partial match, use it but log warning
          this.logger.warn(`Only partial match found: ${partialMatches[0].matchedValue} (${Math.round(partialMatches[0].score * 100)}% match) for search "${searchTerm}"`);
          return partialMatches[0].contact;
        } else {
          // Multiple low-confidence matches - log them all
          this.logger.warn(`Multiple partial matches found for "${searchTerm}":`);
          partialMatches.slice(0, 3).forEach(m => {
            this.logger.warn(`  - ${m.matchedValue} (${Math.round(m.score * 100)}% match)`);
          });
          // Return best match but this is risky
          this.logger.warn(`Using best partial match: ${partialMatches[0].matchedValue}`);
          return partialMatches[0].contact;
        }
      }
      
      this.logger.warn(`No contact found for search term: "${searchTerm}"`);
      return null;
    } catch (error) {
      this.logger.error('Failed to find contact by email or alias:', error);
      return null;
    }
  }

  // New methods for enhanced safety
  async sendWithConfirmation(data) {
    this.validateParams(data, {
      to: { required: true, type: 'string' },
      subject: { required: true, type: 'string' },
      text: { type: 'string' },
      html: { type: 'string' },
      requireConfirmation: { type: 'boolean' }
    });

    try {
      // Use contact manager to resolve recipient
      const resolution = await this.contactManager.resolveRecipient(
        data.to, 
        data.requireConfirmation !== false
      );

      if (resolution.needsConfirmation) {
        if (resolution.didYouMean) {
          // Return "did you mean" suggestions
          return {
            success: false,
            needsConfirmation: true,
            ...resolution.didYouMean
          };
        } else if (resolution.confirmationData) {
          // Return confirmation request
          return {
            success: false,
            needsConfirmation: true,
            ...resolution.confirmationData,
            emailData: {
              to: resolution.email,
              subject: data.subject,
              preview: data.text?.substring(0, 100) + '...'
            }
          };
        }
      }

      // High confidence match - send the email
      return await this.sendEmail({
        ...data,
        to: resolution.email,
        recipientName: resolution.name
      });

    } catch (error) {
      this.logger.error('Failed to send with confirmation:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async blockContact(data) {
    this.validateParams(data, {
      email: { required: true, type: 'string' },
      reason: { type: 'string' }
    });

    return await this.contactManager.blockContact(data.email, data.reason);
  }

  async unblockContact(data) {
    this.validateParams(data, {
      email: { required: true, type: 'string' }
    });

    return await this.contactManager.unblockContact(data.email);
  }

  async listBlockedContacts() {
    try {
      const blockedList = Array.from(this.contactManager.blocklist);
      return {
        success: true,
        count: blockedList.length,
        blockedContacts: blockedList
      };
    } catch (error) {
      this.logger.error('Failed to list blocked contacts:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async promoteContact(data) {
    // Support both email and contactId parameters
    if (!data.email && !data.contactId) {
      throw new Error('Either email or contactId is required');
    }

    try {
      let existingContact;
      
      if (data.contactId) {
        // Find by MongoDB ID
        const { Memory } = await import('../../models/Memory.js');
        existingContact = await Memory.findById(data.contactId);
        
        if (!existingContact) {
          return {
            success: false,
            message: `Contact not found with ID: ${data.contactId}`
          };
        }
      } else {
        // Find by email (legacy support)
        existingContact = await this.findContactByEmailOrAlias(data.email);
        
        if (!existingContact) {
          return {
            success: false,
            message: `Contact not found: ${data.email}`
          };
        }
      }

      // Promotion is no longer needed since all contacts are unified
      return {
        success: false,
        message: 'Contact promotion is no longer available - all contacts are now unified'
      };
    } catch (error) {
      this.logger.error('Failed to promote contact:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Expose API methods for direct access
  get api() {
    return {
      checkEmails: this.checkEmails.bind(this),
      sendEmail: this.sendEmail.bind(this),
      sendWithConfirmation: this.sendWithConfirmation.bind(this),
      getEmails: this.getEmails.bind(this),
      addContact: this.addContact.bind(this),
      listContacts: this.listContacts.bind(this),
      deleteContact: this.deleteContact.bind(this),
      getContact: this.getContact.bind(this),
      updateContact: this.updateContact.bind(this),
      findContact: this.findContact.bind(this),
      blockContact: this.blockContact.bind(this),
      unblockContact: this.unblockContact.bind(this),
      listBlockedContacts: this.listBlockedContacts.bind(this),
      findContactByEmailOrAlias: this.findContactByEmailOrAlias.bind(this)
    };
  }

  async getEmailById(data) {
    try {
      this.validateParams(data, {
        emailId: { required: true, type: 'string' }
      });

      const { Email } = await import('../../models/Email.js');
      const email = await Email.findById(data.emailId);
      
      if (!email) {
        return {
          success: false,
          message: 'Email not found'
        };
      }

      return {
        success: true,
        email: {
          _id: email._id,
          messageId: email.messageId,
          type: email.type,
          from: email.from,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          subject: email.subject,
          text: email.text,
          html: email.html,
          preview: email.preview,
          sentDate: email.sentDate || email.receivedDate,
          processed: email.processed,
          processedBy: email.processedBy
        }
      };
    } catch (error) {
      this.logger.error('Failed to get email by ID:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async sendEmailWithAI(data) {
    this.validateParams(data, {
      to: { required: true, type: 'string' },
      prompt: { required: true, type: 'string' },
      subject: { type: 'string' },
      context: { type: 'string' }
    });

    try {
      // First resolve recipient to email address if needed
      let resolvedEmail = data.to;
      let recipientName = null;
      let recipientContext = '';
      
      // If 'to' doesn't look like an email address, try to resolve it
      if (!data.to.includes('@')) {
        this.logger.info(`Resolving recipient name "${data.to}" to email address`);
        try {
          const resolution = await this.contactManager.resolveRecipient(data.to, false);
          if (resolution.email) {
            resolvedEmail = resolution.email;
            recipientName = resolution.name || resolution.contact?.metadata?.name;
            recipientContext = ` The recipient's name is ${recipientName}.`;
            this.logger.info(`Resolved "${data.to}" to ${resolvedEmail} (${recipientName}) with confidence ${resolution.confidence}`);
          } else {
            // Check if we have suggestions
            if (resolution.suggestions && resolution.suggestions.length > 0) {
              const suggestions = resolution.suggestions.map(s => {
                const name = s.contact?.metadata?.name || s.matchedValue || 'Unknown';
                const score = Math.round((s.score || 0) * 100);
                return `${name} (${score}% match)`;
              }).join(', ');
              throw new Error(`Could not find exact match for "${data.to}". Did you mean: ${suggestions}?`);
            } else {
              throw new Error(`Could not find contact "${data.to}". Please use a valid email address or contact name.`);
            }
          }
        } catch (err) {
          this.logger.error(`Failed to resolve recipient "${data.to}":`, err);
          throw new Error(err.message || `Could not resolve recipient "${data.to}". Please use a valid email address or known contact name.`);
        }
      } else {
        // It's an email address, but still try to get contact info
        try {
          const contact = await this.findContactByEmailOrAlias(data.to);
          if (contact && contact.metadata && contact.metadata.name) {
            recipientName = contact.metadata.name;
            recipientContext = ` The recipient's name is ${recipientName}.`;
          }
        } catch (err) {
          // Ignore lookup errors for email addresses
        }
      }

      // Determine if sending to master
      const masterEmail = process.env.EMAIL_OF_MASTER || '';
      const isToMaster = resolvedEmail.toLowerCase() === masterEmail.toLowerCase();
      // Get master name from environment or config, with better fallback
      let masterName = process.env.MASTER_NAME || process.env.EMAIL_OF_MASTER || 'the user';
      
      // If still generic, try to get from email address
      if (masterName === 'the user' || masterName === 'my user') {
        const masterEmail = process.env.EMAIL_OF_MASTER;
        if (masterEmail && masterEmail !== 'the user') {
          const emailParts = masterEmail.split('@')[0];
          masterName = emailParts.charAt(0).toUpperCase() + emailParts.slice(1);
        }
      }

      // Check if the prompt might benefit from web search
      let searchResults = '';
      if (data.enableWebSearch !== false) { // Default to enabled unless explicitly disabled
        // Keywords that suggest web search would be helpful
        const searchKeywords = [
          'latest', 'current', 'recent', 'news', 'update', 'today',
          'weather', 'stock', 'price', 'event', 'announcement',
          'research', 'find out', 'what is', 'how to', 'when is',
          'where is', 'status of', 'information about', 'details on'
        ];
        
        const promptLower = data.prompt.toLowerCase();
        const shouldSearch = searchKeywords.some(keyword => promptLower.includes(keyword));
        
        if (shouldSearch) {
          try {
            // Extract search query from prompt
            const searchQuery = data.searchQuery || data.prompt;
            this.logger.info(`Performing web search for email content: "${searchQuery}"`);
            
            // Use the web search plugin if available
            const webPlugin = this.agent.apiManager.getPlugin('web');
            if (webPlugin) {
              const searchResult = await webPlugin.execute({
                action: 'search',
                query: searchQuery,
                limit: 3 // Get top 3 results
              });
              
              if (searchResult.success && searchResult.results && searchResult.results.length > 0) {
                searchResults = '\n\nWeb search results for context:\n';
                searchResult.results.forEach((result, index) => {
                  searchResults += `${index + 1}. ${result.title}\n   ${result.snippet}\n   Source: ${result.link}\n\n`;
                });
                this.logger.info(`Found ${searchResult.results.length} search results for email context`);
              }
            }
          } catch (searchError) {
            this.logger.warn('Web search for email failed:', searchError.message);
            // Continue without search results
          }
        }
      }

      // Compose email with AI
      const composePrompt = `You are ${this.agent.config.name}, a personal assistant agent. You need to compose an email based on this request: "${data.prompt}"

Recipient: ${resolvedEmail}${recipientContext}
Is this to your master/user: ${isToMaster ? 'Yes' : 'No'}
Your master's name: ${masterName}
${data.context ? `Additional context: ${data.context}` : ''}${searchResults}

CRITICAL: You must write the email FROM YOUR OWN PERSPECTIVE as ${this.agent.config.name}, maintaining your character at all times. Do NOT just repeat the user's words! NEVER break character or admit to being any AI model.

When referring to your master/user, use their actual name "${masterName}" - never say "my user" or "my user's". You work for ${masterName}, not for "my user".

${searchResults ? 'Use the web search results above to provide current, accurate information in your email.' : ''}
${data.includeReadme ? 'IMPORTANT: A README document describing your capabilities is attached to this email. Mention in the email that you have included your documentation/README for their reference, so they can learn more about your features and capabilities.' : ''}
${data.attachments && data.attachments.length > 0 ? `Note: ${data.attachments.length} file(s) are attached to this email. You may reference the attachments in the body if relevant.` : ''}

Write a complete, professional and formal email with:
1. Formal greeting (e.g., "Dear ${recipientName || 'recipient'},")
2. Comprehensive, well-structured content that:
   - Opens with context or purpose statement
   - Elaborates thoroughly on the requested topic with multiple paragraphs
   - Uses formal business language and complete sentences
   - Includes relevant details, explanations, and supporting information
   - Maintains a professional, courteous tone throughout
   - Concludes with next steps or a summary when appropriate
3. Professional closing (e.g., "Sincerely," "Best regards," "Respectfully,")
4. CRITICAL: Do NOT add your name after the closing. The signature is added automatically.
5. Aim for 3-5 paragraphs minimum to ensure thorough coverage of the topic.

FORBIDDEN: Never write things like:
- "Warm regards, ALICE"
- "Best regards, ${this.agent.config.name} - Personal Assistant"
- "Sincerely, Your AI Assistant"

CORRECT: End with just:
- "Warm regards,"
- "Best regards,"
- "Sincerely,"

Respond in JSON format:
{
  "subject": "A descriptive subject line about the topic",
  "body": "The complete email content with greeting, message, and closing"
}`;

      const composeResponse = await this.agent.providerManager.generateResponse(composePrompt, {
        maxTokens: 1500,
        temperature: 0.7
      });

      // Parse AI response
      let cleanedResponse = composeResponse.content.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const composed = JSON.parse(cleanedResponse);

      // Use the AI-generated body as-is
      let emailBody = composed.body;

      // Use provided subject or AI-generated one
      const finalSubject = data.subject || composed.subject || `Message from ${this.agent.config.name}`;

      // Send the email
      const result = await this.sendEmail({
        to: resolvedEmail,
        subject: finalSubject,
        text: emailBody, // Use cleaned body
        recipientName: recipientName,
        attachments: data.attachments,
        includeReadme: data.includeReadme
      });

      return {
        ...result,
        aiGenerated: true,
        originalPrompt: data.prompt,
        generatedSubject: composed.subject,
        generatedBody: composed.body,
        webSearchUsed: searchResults.length > 0
      };

    } catch (error) {
      this.logger.error('Failed to send AI-generated email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getNotificationSettings() {
    try {
      const settings = await this.loadNotificationSettings();
      return {
        success: true,
        settings
      };
    } catch (error) {
      this.logger.error('Failed to get notification settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async setNotificationSettings(data) {
    try {
      const currentSettings = await this.loadNotificationSettings();
      const updatedSettings = { ...currentSettings, ...data };

      await this.saveNotificationSettings(updatedSettings);
      this.logger.info('Email notification settings updated:', updatedSettings);

      return {
        success: true,
        settings: updatedSettings,
        message: 'Notification settings updated successfully'
      };
    } catch (error) {
      this.logger.error('Failed to update notification settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Database helper methods for persistent notification settings
  async ensureNotificationSettings() {
    try {
      const existing = await PluginSettings.findOne({
        pluginName: 'email',
        settingsKey: 'notificationSettings'
      });

      if (!existing) {
        const defaultSettings = { notifyMasterOnAutoReply: false };
        await this.saveNotificationSettings(defaultSettings);
        this.logger.info('Email notification settings initialized in database');
      }
    } catch (error) {
      this.logger.error('Failed to ensure notification settings:', error);
      // Fallback to in-memory
      this.setState('notificationSettings', { notifyMasterOnAutoReply: false });
    }
  }

  async loadNotificationSettings() {
    try {
      const record = await PluginSettings.findOne({
        pluginName: 'email',
        settingsKey: 'notificationSettings'
      });

      if (record) {
        return record.settingsValue;
      } else {
        // Return default settings if not found
        return { notifyMasterOnAutoReply: false };
      }
    } catch (error) {
      this.logger.error('Failed to load notification settings from database:', error);
      // Fallback to in-memory state
      return this.getState('notificationSettings') || { notifyMasterOnAutoReply: false };
    }
  }

  async saveNotificationSettings(settings) {
    try {
      await PluginSettings.findOneAndUpdate(
        {
          pluginName: 'email',
          settingsKey: 'notificationSettings'
        },
        {
          pluginName: 'email',
          settingsKey: 'notificationSettings',
          settingsValue: settings
        },
        {
          upsert: true,
          new: true
        }
      );
      
      // Also update in-memory state for backward compatibility
      this.setState('notificationSettings', settings);
      
      this.logger.info('Notification settings saved to database:', settings);
    } catch (error) {
      this.logger.error('Failed to save notification settings to database:', error);
      // Fallback to in-memory only
      this.setState('notificationSettings', settings);
      throw error;
    }
  }
  
  /**
   * Schedule an email for future delivery
   */
  async scheduleEmail(data) {
    this.validateParams(data, {
      to: { required: true, type: 'string' },
      subject: { required: true, type: 'string' },
      sendAt: { required: true, type: 'string' },
      text: { type: 'string' },
      html: { type: 'string' }
    });
    
    try {
      // Parse the send time
      const sendTime = new Date(data.sendAt);
      
      // Validate it's in the future
      if (sendTime <= new Date()) {
        return {
          success: false,
          error: 'Scheduled time must be in the future'
        };
      }
      
      // Find recipient
      let recipient = data.to;
      if (!recipient.includes('@')) {
        // Look up contact
        const contactResult = await this.execute({
          action: 'findContact',
          searchTerm: recipient
        });
        
        if (!contactResult.success) {
          return {
            success: false,
            error: `Could not find contact: ${recipient}`
          };
        }
        
        recipient = contactResult.contact.email;
      }
      
      // Schedule the email using Agenda
      const job = await this.agent.scheduler.agenda.schedule(sendTime, 'send-scheduled-email', {
        to: recipient,
        subject: data.subject,
        text: data.text || '',
        html: data.html,
        cc: data.cc,
        bcc: data.bcc,
        scheduledBy: data.userId || 'system',
        plugin: 'email'
      });
      
      this.logger.info(`Scheduled email to ${recipient} for ${sendTime.toLocaleString()}`);
      
      return {
        success: true,
        message: `Email scheduled for ${sendTime.toLocaleString()}`,
        jobId: job.attrs._id.toString(),
        details: {
          to: recipient,
          subject: data.subject,
          sendAt: sendTime.toISOString()
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to schedule email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * List all scheduled emails
   */
  async listScheduledEmails() {
    try {
      const jobs = await this.agent.scheduler.agenda.jobs({
        name: 'send-scheduled-email',
        nextRunAt: { $gte: new Date() }
      });
      
      const scheduled = jobs.map(job => ({
        id: job.attrs._id.toString(),
        to: job.attrs.data.to,
        subject: job.attrs.data.subject,
        sendAt: job.attrs.nextRunAt,
        scheduledBy: job.attrs.data.scheduledBy,
        status: job.attrs.lockedAt ? 'processing' : 'scheduled'
      }));
      
      return {
        success: true,
        count: scheduled.length,
        scheduled: scheduled
      };
      
    } catch (error) {
      this.logger.error('Failed to list scheduled emails:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Cancel a scheduled email
   */
  async cancelScheduledEmail(data) {
    this.validateParams(data, {
      jobId: { required: true, type: 'string' }
    });
    
    try {
      const { ObjectId } = await import('mongodb');
      const numRemoved = await this.agent.scheduler.agenda.cancel({
        _id: new ObjectId(data.jobId),
        name: 'send-scheduled-email'
      });
      
      if (numRemoved > 0) {
        return {
          success: true,
          message: 'Scheduled email cancelled'
        };
      } else {
        return {
          success: false,
          error: 'Scheduled email not found or already sent'
        };
      }
      
    } catch (error) {
      this.logger.error('Failed to cancel scheduled email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Schedule a recurring email
   */
  async scheduleRecurringEmail(data) {
    this.validateParams(data, {
      to: { required: true, type: 'string' },
      subject: { required: true, type: 'string' },
      recurrence: { required: true, type: 'string' },
      text: { type: 'string' },
      html: { type: 'string' }
    });
    
    try {
      // Find recipient
      let recipient = data.to;
      if (!recipient.includes('@')) {
        // Look up contact
        const contactResult = await this.execute({
          action: 'findContact',
          searchTerm: recipient
        });
        
        if (!contactResult.success) {
          return {
            success: false,
            error: `Could not find contact: ${recipient}`
          };
        }
        
        recipient = contactResult.contact.email;
      }
      
      // Validate recurrence pattern
      const validPatterns = [
        /^\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?)$/i,
        /^(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)$/,  // Cron format
        /^(daily|weekly|monthly|yearly)$/i
      ];
      
      const isValidPattern = validPatterns.some(pattern => pattern.test(data.recurrence));
      if (!isValidPattern) {
        return {
          success: false,
          error: 'Invalid recurrence pattern. Use formats like: "daily", "weekly", "5 minutes", "0 9 * * 1" (cron)'
        };
      }
      
      // Schedule the recurring email
      const job = await this.agent.scheduler.agenda.every(data.recurrence, 'send-scheduled-email', {
        to: recipient,
        subject: data.subject,
        text: data.text || '',
        html: data.html,
        scheduledBy: data.userId || 'system',
        plugin: 'email',
        recurring: true
      });
      
      this.logger.info(`Scheduled recurring email to ${recipient} with pattern ${data.recurrence}`);
      
      return {
        success: true,
        message: `Recurring email scheduled with pattern: ${data.recurrence}`,
        jobId: job.attrs._id.toString(),
        details: {
          to: recipient,
          subject: data.subject,
          recurrence: data.recurrence,
          nextRun: job.attrs.nextRunAt
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to schedule recurring email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async listRecurringEmails() {
    try {
      const jobs = await this.agent.scheduler.agenda.jobs({
        name: 'send-scheduled-email',
        'data.recurring': true
      });
      
      const recurring = jobs.map(job => ({
        id: job.attrs._id.toString(),
        to: job.attrs.data.to,
        subject: job.attrs.data.subject,
        recurrence: job.attrs.repeatInterval,
        nextRunAt: job.attrs.nextRunAt,
        scheduledBy: job.attrs.data.scheduledBy,
        status: job.attrs.lockedAt ? 'processing' : 'active'
      }));
      
      return {
        success: true,
        count: recurring.length,
        recurring: recurring
      };
      
    } catch (error) {
      this.logger.error('Failed to list recurring emails:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async cancelRecurringEmail(data) {
    this.validateParams(data, {
      jobId: { required: true, type: 'string' }
    });
    
    try {
      const { default: mongoose } = await import('mongoose');
      const numRemoved = await this.agent.scheduler.agenda.cancel({
        _id: new mongoose.Types.ObjectId(data.jobId),
        name: 'send-scheduled-email',
        'data.recurring': true
      });
      
      if (numRemoved > 0) {
        return {
          success: true,
          message: 'Recurring email cancelled'
        };
      } else {
        return {
          success: false,
          error: 'Recurring email not found'
        };
      }
      
    } catch (error) {
      this.logger.error('Failed to cancel recurring email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get the LANAgent README.md as a nodemailer attachment object
   */
  getReadmeAttachment() {
    const readmePath = path.join(__dirname, '../../..', 'README.md');
    if (fs.existsSync(readmePath)) {
      return { filename: 'LANAgent-README.md', path: readmePath };
    }
    // Fallback: try deploy path
    const deployReadme = path.join(process.env.DEPLOY_PATH || process.cwd(), 'README.md');
    if (deployReadme !== readmePath && fs.existsSync(deployReadme)) {
      return { filename: 'LANAgent-README.md', path: deployReadme };
    }
    return null;
  }

  /**
   * Cleanup method to properly close IMAP connections
   */
  async cleanup() {
    try {
      if (this.imap) {
        this.logger.info('Closing IMAP connection...');
        this.imap.end();
        this.imap = null;
      }
    } catch (error) {
      this.logger.error('Error during email plugin cleanup:', error);
    }
  }
}
