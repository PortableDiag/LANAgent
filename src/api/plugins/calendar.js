import { BasePlugin } from '../core/basePlugin.js';
import { createRequire } from 'module';
import ICAL from 'ical.js';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import { CalendarEvent } from '../../models/CalendarEvent.js';

// dav is a CommonJS module, so we need to require it
const require = createRequire(import.meta.url);
const dav = require('dav');

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class CalendarPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'calendar';
    this.version = '1.0.0';
    this.description = 'Calendar and event management with local MongoDB storage and optional CalDAV sync';
    this.category = 'automation';

    // Intent definitions for vector-based detection
    this.intents = {
      createEvent: {
        name: 'Create Calendar Event',
        description: 'Create a new event or appointment on the calendar',
        action: 'createEvent',
        examples: [
          'add an event to my calendar',
          'schedule a meeting for tomorrow at 2pm',
          'create a calendar event',
          'add appointment on friday',
          'schedule dentist appointment next week',
          'put a reminder on my calendar',
          'add event called team standup',
          'create meeting with john tomorrow',
          'schedule call for 3pm today',
          'book time for lunch meeting'
        ]
      },
      getToday: {
        name: 'Get Today Events',
        description: 'Show all events scheduled for today',
        action: 'getToday',
        examples: [
          'what do I have today',
          'show my schedule for today',
          'what events are today',
          'whats on my calendar today',
          'do I have any meetings today',
          'today\'s agenda',
          'show today\'s events',
          'what\'s happening today',
          'any appointments today'
        ]
      },
      getUpcoming: {
        name: 'Get Upcoming Events',
        description: 'Show upcoming events for the next few days',
        action: 'getUpcoming',
        examples: [
          'what\'s coming up',
          'show my upcoming events',
          'what do I have this week',
          'upcoming appointments',
          'show me my schedule',
          'what\'s on my calendar',
          'next few days events',
          'show my agenda for the week',
          'what meetings do I have coming up'
        ]
      },
      searchEvents: {
        name: 'Search Calendar Events',
        description: 'Search for events by title or description',
        action: 'searchEvents',
        examples: [
          'find events about project',
          'search calendar for meeting',
          'look for dentist appointment',
          'find all meetings with john',
          'search for team events',
          'find calendar events about budget'
        ]
      },
      deleteEvent: {
        name: 'Delete Calendar Event',
        description: 'Remove an event from the calendar',
        action: 'deleteEvent',
        examples: [
          'delete the meeting',
          'cancel the appointment',
          'remove event from calendar',
          'delete tomorrow\'s meeting',
          'cancel my dentist appointment'
        ]
      },
      updateEvent: {
        name: 'Update Calendar Event',
        description: 'Modify an existing calendar event',
        action: 'updateEvent',
        examples: [
          'reschedule the meeting',
          'change the appointment time',
          'move the event to 3pm',
          'update meeting title',
          'change event location'
        ]
      }
    };

    this.commands = [
      {
        command: 'setCredentials',
        description: 'Configure calendar credentials for CalDAV access',
        usage: 'setCredentials({ username: "email@example.com", password: "app-password" })'
      },
      {
        command: 'listCalendars',
        description: 'List all available calendars in the account',
        usage: 'listCalendars()'
      },
      {
        command: 'getEvents',
        description: 'Get events from calendar with optional date range',
        usage: 'getEvents({ startDate: "2024-01-01", endDate: "2024-01-31", limit: 10 })'
      },
      {
        command: 'createEvent',
        description: 'Create a new calendar event',
        usage: 'createEvent({ title: "Meeting", start: "2024-01-15T10:00:00", end: "2024-01-15T11:00:00", description: "Team meeting" })'
      },
      {
        command: 'updateEvent',
        description: 'Update an existing calendar event',
        usage: 'updateEvent({ eventId: "event123", updates: { title: "Updated Meeting" } })'
      },
      {
        command: 'deleteEvent',
        description: 'Delete a calendar event',
        usage: 'deleteEvent({ eventId: "event123" })'
      },
      {
        command: 'checkAvailability',
        description: 'Check available time slots on a specific date',
        usage: 'checkAvailability({ date: "2024-01-15", duration: 60, startHour: 9, endHour: 17 })'
      },
      {
        command: 'searchEvents',
        description: 'Search for events by keyword',
        usage: 'searchEvents({ query: "meeting", startDate: "2024-01-01" })',
        params: { query: 'Search keyword (required)', startDate: 'Start date (optional)', endDate: 'End date (optional)' }
      },
      {
        command: 'getUpcoming',
        description: 'Get upcoming events for the next N days',
        usage: 'getUpcoming({ days: 7, limit: 10 })',
        params: { days: 'Number of days ahead (default 7)', limit: 'Max events to return (default 10)' }
      },
      {
        command: 'getToday',
        description: 'Get all events for today',
        usage: 'getToday()'
      }
    ];
    this.client = null;
    this.account = null;
    this.calendars = [];
    this.credentials = null;
    this.localMode = true; // Default to local MongoDB mode
    this.reminderInterval = null;
    
    // Create dedicated calendar logger
    const logsDir = process.env.LOGS_PATH || path.join(__dirname, '../../../logs');
    this.calendarLogger = winston.createLogger({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level.toUpperCase()}] ${message}`;
        })
      ),
      transports: [
        new winston.transports.File({ 
          filename: path.join(logsDir, 'calendar-debug.log'),
          maxsize: 5 * 1024 * 1024, // 5MB
          maxFiles: 5
        })
      ]
    });
    
    // Log to both regular logger and calendar logger
    this.log = (level, message, ...args) => {
      if (this.logger && this.logger[level]) {
        this.logger[level](message, ...args);
      }
      this.calendarLogger[level](message, ...args);
    };
    
  }
  
  // Override the setLogger method from BasePlugin
  setLogger(logger) {
    super.setLogger(logger);
    
    // Now override logger methods to use our custom log
    if (this.logger) {
      const originalLogger = this.logger;
      this.logger = {
        info: (msg, ...args) => this.log('info', msg, ...args),
        warn: (msg, ...args) => this.log('warn', msg, ...args),
        error: (msg, ...args) => this.log('error', msg, ...args),
        debug: (msg, ...args) => this.log('debug', msg, ...args)
      };
    }
  }

  async initialize() {
    try {
      this.logger.info('Calendar plugin initializing...');
      this.log('info', 'Calendar plugin initializing (in calendar-debug.log)...');

    // Start local reminder checker (works regardless of CalDAV connection)
    this.startLocalReminderChecker();

    // Check if local-only mode is forced via environment variable
    if (process.env.CALENDAR_LOCAL_ONLY === 'true') {
      this.logger.info('Calendar running in local-only mode (CALENDAR_LOCAL_ONLY=true)');
      this.localMode = true;
      return;
    }

    // Load saved calendar configuration
    await this.loadConfig();

    // Check for calendar credentials in environment or config
    // Only use CALENDAR_USERNAME, not EMAIL_USER (to avoid accidental CalDAV attempts)
    const username = this.config.username || process.env.CALENDAR_USERNAME;
    const password = this.config.password || process.env.CALENDAR_APP_PASSWORD;
    
    // Debug log credentials
    this.logger.info(`Calendar credentials check - username: ${username ? username : 'not set'}, password: ${password ? '[set]' : 'not set'}`);
    
    // Determine server URL based on username if not explicitly set
    let serverUrl = this.config.serverUrl || process.env.CALENDAR_SERVER_URL;
    if (!serverUrl && username) {
      serverUrl = this.getServerUrl(username);
    }
    
    this.logger.info(`Server URL determined: ${serverUrl}`);
    
    if (!username || !password) {
      this.logger.warn('Calendar credentials not configured. Use setCredentials action to configure.');
      return;
    }
    
    if (!serverUrl) {
      this.logger.error('Server URL is undefined - this should not happen');
      return;
    }
    
    try {
      this.logger.info(`Attempting to connect to calendar server: ${serverUrl} with user: ${username}`);
      
      // Try to connect with retry logic
      let connected = false;
      let retries = 3;
      let lastError = null;
      
      while (!connected && retries > 0) {
        try {
          await this.connect(username, password, serverUrl);
          connected = true;
          this.logger.info(`Calendar plugin initialized successfully for user: ${username}`);
        } catch (connectError) {
          lastError = connectError;
          retries--;
          if (retries > 0) {
            this.logger.warn(`Calendar connection failed, retrying... (${retries} retries left)`);
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      
      if (!connected && lastError) {
        throw lastError;
      }
    } catch (error) {
      this.logger.error('Failed to initialize calendar connection after retries:', error.message || error);
      this.logger.error('Calendar initialization error details:', {
        username: username,
        serverUrl: serverUrl,
        errorType: error.constructor.name,
        errorMessage: error.message
      });
    }
    } catch (error) {
      this.logger.error('Calendar plugin initialization failed:', error);
    }
  }

  async connect(username, password, serverUrl) {
    try {
      // Validate parameters
      if (!username || !password || !serverUrl) {
        throw new Error(`Missing required parameters - username: ${!!username}, password: ${!!password}, serverUrl: ${!!serverUrl}`);
      }
      
      this.logger.info(`Connecting with validated params - serverUrl: ${serverUrl}, username: ${username}`);
      
      // Create transport with credentials
      const xhr = new dav.transport.Basic(
        new dav.Credentials({
          username: username,
          password: password
        })
      );
      
      this.client = new dav.Client(xhr, {
        baseUrl: serverUrl
      });
      
      // Create account and discover calendars with timeout
      this.account = await dav.createAccount({
        server: serverUrl,
        xhr: xhr,
        loadCollections: true,
        accountType: 'caldav',
        timeoutMs: 30000 // 30 second timeout
      });
      
      // Store calendars
      this.calendars = this.account.calendars || [];
      
      // Log calendar details for debugging
      this.logger.info(`Found ${this.calendars.length} calendars:`);
      this.calendars.forEach(cal => {
        this.logger.info(`  - ${cal.displayName} (${cal.url})`);
        // Log calendar properties to understand structure
        this.logger.info(`    Calendar properties: ${Object.keys(cal).join(', ')}`);
      });
      
      // Save credentials for future use (don't save serverUrl as it might include calendar path)
      this.credentials = { username, password, serverUrl };
      await this.saveConfig({ username });
      
      this.logger.info(`Connected to CalDAV server. Found ${this.calendars.length} calendars.`);
      this.localMode = false; // Disable local mode when CalDAV is connected

      return { success: true, calendars: this.calendars.length };
    } catch (error) {
      this.logger.error('CalDAV connection failed:', error);
      this.logger.error('Error stack:', error.stack);
      throw error;
    }
  }

  // ==========================================
  // LOCAL MODE METHODS (MongoDB-based calendar)
  // ==========================================

  startLocalReminderChecker() {
    // Check for upcoming reminders every minute
    this.reminderInterval = setInterval(async () => {
      await this.checkAndSendLocalReminders();
    }, 60000);

    // Also check immediately on startup
    this.checkAndSendLocalReminders();
    this.logger.info('Local reminder checker started');
  }

  async checkAndSendLocalReminders() {
    try {
      const now = new Date();
      const events = await CalendarEvent.findPendingReminders();

      for (const event of events) {
        for (let i = 0; i < event.reminders.length; i++) {
          const reminder = event.reminders[i];
          if (reminder.sent) continue;

          const firstFireTime = new Date(event.startDate.getTime() - reminder.minutesBefore * 60 * 1000);
          if (firstFireTime > now) continue;

          // Recurring reminder: fire every customInterval minutes between firstFireTime and event start
          if (reminder.customInterval && reminder.customInterval > 0) {
            const intervalMs = reminder.customInterval * 60 * 1000;
            const lastSent = reminder.lastSentAt ? new Date(reminder.lastSentAt) : null;
            const dueForRecurrence = !lastSent || (now.getTime() - lastSent.getTime()) >= intervalMs;

            if (dueForRecurrence && now < event.startDate) {
              await this.sendLocalReminder(event, reminder, i, { recurring: true });
            } else if (now >= event.startDate) {
              // Event has started — finalize this reminder so it stops firing
              await event.markReminderSent(i);
            }
          } else {
            await this.sendLocalReminder(event, reminder, i);
          }
        }
      }
    } catch (error) {
      this.logger.error('Error checking local reminders:', error);
    }
  }

  async sendLocalReminder(event, reminder, reminderIndex, options = {}) {
    try {
      const timeUntil = this.formatTimeUntil(event.startDate);
      const message = `📅 Reminder: ${event.title}\n` +
        `⏰ Starts ${timeUntil}\n` +
        (event.location ? `📍 ${event.location}\n` : '') +
        (event.description ? `📝 ${event.description}` : '');

      // Send notification based on reminder type
      if (reminder.type === 'telegram' && this.agent) {
        await this.agent.sendNotification(message);
      } else if (reminder.type === 'email' && this.agent) {
        const emailPlugin = this.agent.pluginManager?.getPlugin('email');
        if (emailPlugin) {
          await emailPlugin.execute({
            action: 'send',
            to: process.env.EMAIL_OF_MASTER,
            subject: `Calendar Reminder: ${event.title}`,
            body: message
          });
        }
      } else if (reminder.type === 'sms') {
        const to = reminder.target || process.env.PHONE_OF_MASTER;
        if (!to) {
          this.logger.warn('SMS reminder skipped: no target phone number (set reminder.target or PHONE_OF_MASTER)');
        } else {
          const smsPlugin = this.agent?.pluginManager?.getPlugin('vonage')
            || this.agent?.pluginManager?.getPlugin('sinch')
            || this.agent?.pluginManager?.getPlugin('messagebird');
          if (smsPlugin) {
            await smsPlugin.execute({ action: 'sendsms', to, text: message });
          } else {
            this.logger.warn('SMS reminder skipped: no SMS plugin available (vonage/sinch/messagebird)');
          }
        }
      } else if (reminder.type === 'push') {
        const token = reminder.target || process.env.FCM_TOKEN_OF_MASTER;
        if (!token) {
          this.logger.warn('Push reminder skipped: no FCM token (set reminder.target or FCM_TOKEN_OF_MASTER)');
        } else {
          const fcmPlugin = this.agent?.pluginManager?.getPlugin('firebasecloudmessagingfcm');
          if (fcmPlugin) {
            await fcmPlugin.execute({
              action: 'sendMessage',
              registrationToken: token,
              title: `Reminder: ${event.title}`,
              body: message
            });
          } else {
            this.logger.warn('Push reminder skipped: firebasecloudmessagingfcm plugin not available');
          }
        }
      } else if (reminder.type === 'notification' && this.agent) {
        // In-app notification — falls back to telegram if available
        await this.agent.sendNotification?.(message);
      }

      if (options.recurring) {
        // Track the recurring fire without ending the reminder lifecycle
        event.reminders[reminderIndex].lastSentAt = new Date();
        await event.save();
        this.logger.info(`Sent recurring reminder for event: ${event.title}`);
      } else {
        await event.markReminderSent(reminderIndex);
        this.logger.info(`Sent local reminder for event: ${event.title}`);
      }
    } catch (error) {
      this.logger.error('Error sending local reminder:', error);
    }
  }

  formatTimeUntil(date) {
    const now = new Date();
    const diff = date.getTime() - now.getTime();
    const minutes = Math.round(diff / 60000);

    if (minutes < 1) return 'now';
    if (minutes === 1) return 'in 1 minute';
    if (minutes < 60) return `in ${minutes} minutes`;

    const hours = Math.round(minutes / 60);
    if (hours === 1) return 'in 1 hour';
    if (hours < 24) return `in ${hours} hours`;

    const days = Math.round(hours / 24);
    if (days === 1) return 'tomorrow';
    return `in ${days} days`;
  }

  async createLocalEvent(data) {
    // Validate required fields
    if (!data.title) {
      return { success: false, error: 'Event title is required' };
    }

    const startDate = this.parseLocalDate(data.start || data.startDate);
    if (!startDate) {
      return { success: false, error: `Could not parse start date: "${data.start || data.startDate}". Try formats like "tomorrow at 3pm", "friday 10am", or "2026-01-20T10:00"` };
    }

    let endDate;
    if (data.end || data.endDate) {
      endDate = this.parseLocalDate(data.end || data.endDate);
      if (!endDate) {
        return { success: false, error: `Could not parse end date: "${data.end || data.endDate}"` };
      }
    } else if (data.allDay) {
      endDate = new Date(startDate);
      endDate.setHours(23, 59, 59, 999);
    } else {
      endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    }

    const reminders = [];
    if (data.reminder || data.reminders) {
      const reminderMinutes = data.reminder || (data.reminders && data.reminders[0]?.minutes) || 15;
      reminders.push({
        type: 'telegram',
        minutesBefore: reminderMinutes,
        sent: false
      });
    }

    const event = new CalendarEvent({
      title: data.title,
      description: data.description || '',
      location: data.location || '',
      startDate,
      endDate,
      allDay: data.allDay || false,
      category: data.category || 'personal',
      color: data.color || '#4285f4',
      priority: data.priority || 'normal',
      reminders,
      source: 'manual',
      notes: data.notes || ''
    });

    await event.save();

    this.logger.info(`Created local calendar event: ${event.title}`);
    await this.notify(`📅 Event created: "${event.title}" on ${startDate.toLocaleDateString()}`);

    return {
      success: true,
      message: `Event "${event.title}" created for ${this.formatLocalDate(startDate)}`,
      event: this.formatLocalEventResponse(event)
    };
  }

  async getLocalEvents(data = {}) {
    const days = data.days || 30;
    const limit = data.limit || 50;

    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const events = await CalendarEvent.findByDateRange(now, future);

    return {
      success: true,
      events: events.slice(0, limit).map(e => this.formatLocalEventResponse(e)),
      total: events.length,
      mode: 'local'
    };
  }

  async getLocalToday() {
    const events = await CalendarEvent.findToday();

    return {
      success: true,
      message: `You have ${events.length} events today`,
      events: events.map(e => this.formatLocalEventResponse(e)),
      mode: 'local'
    };
  }

  async getLocalUpcoming(data = {}) {
    const days = data.days || 7;
    const events = await CalendarEvent.findUpcoming(days);

    return {
      success: true,
      events: events.map(e => this.formatLocalEventResponse(e)),
      total: events.length,
      mode: 'local'
    };
  }

  async updateLocalEvent(data) {
    const event = await CalendarEvent.findById(data.eventId);
    if (!event) {
      return { success: false, error: 'Event not found' };
    }

    const updates = data.updates || data;
    const updateFields = ['title', 'description', 'location', 'category', 'color', 'priority', 'notes', 'status'];

    for (const field of updateFields) {
      if (updates[field] !== undefined) {
        event[field] = updates[field];
      }
    }

    if (updates.start || updates.startDate) {
      event.startDate = this.parseLocalDate(updates.start || updates.startDate);
    }
    if (updates.end || updates.endDate) {
      event.endDate = this.parseLocalDate(updates.end || updates.endDate);
    }

    await event.save();

    return {
      success: true,
      message: `Event "${event.title}" updated`,
      event: this.formatLocalEventResponse(event)
    };
  }

  async deleteLocalEvent(data) {
    const event = await CalendarEvent.findByIdAndDelete(data.eventId);
    if (!event) {
      return { success: false, error: 'Event not found' };
    }

    await this.notify(`📅 Event "${event.title}" deleted`);

    return {
      success: true,
      message: `Event "${event.title}" deleted`
    };
  }

  async searchLocalEvents(data) {
    const query = data.query || data.keyword || '';
    const limit = data.limit || 20;

    if (!query) {
      return { success: false, error: 'Search query is required. Provide a "query" parameter.' };
    }

    const searchStr = String(query);
    const events = await CalendarEvent.find({
      $or: [
        { title: { $regex: searchStr, $options: 'i' } },
        { description: { $regex: searchStr, $options: 'i' } },
        { location: { $regex: searchStr, $options: 'i' } }
      ],
      status: { $ne: 'cancelled' }
    })
      .sort({ startDate: -1 })
      .limit(limit);

    return {
      success: true,
      query,
      matches: events.map(e => this.formatLocalEventResponse(e)),
      total: events.length
    };
  }

  parseLocalDate(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;

    const lower = dateStr.toLowerCase().trim();
    const now = new Date();

    // Helper to parse time string like "10am", "3pm", "14:00", "2:30pm"
    const parseTime = (timeStr, baseDate) => {
      const date = new Date(baseDate);
      // Match patterns like "10am", "3pm", "10:30am", "14:00"
      const timeMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]) || 0;
        const period = timeMatch[3]?.toLowerCase();

        if (period === 'pm' && hours < 12) hours += 12;
        if (period === 'am' && hours === 12) hours = 0;

        date.setHours(hours, minutes, 0, 0);
        return date;
      }
      return date;
    };

    // Check for "today at X" or "today X"
    const todayMatch = lower.match(/^today(?:\s+at)?\s+(.+)$/);
    if (todayMatch) {
      return parseTime(todayMatch[1], now);
    }
    if (lower === 'today') return now;

    // Check for "tomorrow at X" or "tomorrow X"
    const tomorrowMatch = lower.match(/^tomorrow(?:\s+at)?\s+(.+)$/);
    if (tomorrowMatch) {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      return parseTime(tomorrowMatch[1], tomorrow);
    }
    if (lower === 'tomorrow') return new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Check for day of week like "friday at 2pm", "next monday 10am"
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayMatch = lower.match(/^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at)?\s*(.*)$/i);
    if (dayMatch) {
      const targetDay = dayNames.indexOf(dayMatch[1].toLowerCase());
      const timeStr = dayMatch[2];
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7; // Next occurrence
      const targetDate = new Date(now.getTime() + daysUntil * 24 * 60 * 60 * 1000);
      return timeStr ? parseTime(timeStr, targetDate) : targetDate;
    }

    if (lower === 'next week') return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Check for "in X minutes/hours/days/weeks"
    const inMatch = lower.match(/^in\s+(\d+)\s+(minute|hour|day|week)s?$/);
    if (inMatch) {
      const amount = parseInt(inMatch[1]);
      const unit = inMatch[2];
      const multipliers = {
        minute: 60 * 1000,
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000
      };
      return new Date(now.getTime() + amount * multipliers[unit]);
    }

    // Try parsing as ISO date or standard date format
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }

    // Return null if we can't parse it
    return null;
  }

  formatLocalDate(date) {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatLocalEventResponse(event) {
    return {
      id: event._id.toString(),
      title: event.title,
      description: event.description,
      location: event.location,
      start: event.startDate,
      end: event.endDate,
      allDay: event.allDay,
      category: event.category,
      color: event.color,
      priority: event.priority,
      status: event.status,
      reminders: event.reminders,
      isOngoing: event.isOngoing ? event.isOngoing() : false,
      isPast: event.isPast ? event.isPast() : event.endDate < new Date()
    };
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['setCredentials', 'listCalendars', 'getEvents', 'createEvent', 'updateEvent', 'deleteEvent', 'checkAvailability', 'searchEvents', 'getUpcoming', 'getToday', 'status']
      }
    });

    // Handle status action
    if (action === 'status') {
      return {
        success: true,
        mode: this.localMode ? 'local' : 'caldav',
        connected: !this.localMode && !!this.account,
        localMode: this.localMode,
        calendars: this.calendars.length
      };
    }

    // In local mode, route to local MongoDB methods
    if (this.localMode) {
      switch (action) {
        case 'setCredentials':
          return await this.setCredentials(data);
        case 'createEvent':
          return await this.createLocalEvent(data);
        case 'getEvents':
          return await this.getLocalEvents(data);
        case 'updateEvent':
          return await this.updateLocalEvent(data);
        case 'deleteEvent':
          return await this.deleteLocalEvent(data);
        case 'searchEvents':
          return await this.searchLocalEvents(data);
        case 'getUpcoming':
          return await this.getLocalUpcoming(data);
        case 'getToday':
          return await this.getLocalToday();
        case 'listCalendars':
          return {
            success: true,
            calendars: [{ id: 'local', name: 'Local Calendar', description: 'MongoDB-based calendar', primary: true }],
            mode: 'local'
          };
        case 'checkAvailability':
          // For local mode, just return the events for that day
          const dayEvents = await CalendarEvent.findByDay(new Date(data.date));
          return {
            success: true,
            date: data.date,
            busyTimes: dayEvents.map(e => ({ start: e.startDate, end: e.endDate, title: e.title })),
            mode: 'local'
          };
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }

    // CalDAV mode - check if connected
    if (action !== 'setCredentials' && !this.account) {
      return {
        success: false,
        error: 'Calendar not connected. Please configure credentials first or use local mode.'
      };
    }

    // CalDAV mode actions
    switch (action) {
      case 'setCredentials':
        return await this.setCredentials(data);
      case 'listCalendars':
        return await this.listCalendars();
      case 'getEvents':
        return await this.getEvents(data);
      case 'createEvent':
        return await this.createEvent(data);
      case 'updateEvent':
        return await this.updateEvent(data);
      case 'deleteEvent':
        return await this.deleteEvent(data);
      case 'checkAvailability':
        return await this.checkAvailability(data);
      case 'searchEvents':
        return await this.searchEvents(data);
      case 'getUpcoming':
        return await this.getUpcoming(data);
      case 'getToday':
        return await this.getToday();
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async setCredentials(data) {
    this.validateParams(data, {
      username: { required: true, type: 'string' },
      password: { required: true, type: 'string' },
      serverUrl: { required: false, type: 'string' }
    });
    
    const serverUrl = data.serverUrl || this.getServerUrl(data.username);
    
    try {
      await this.connect(data.username, data.password, serverUrl);
      
      // Send notification about successful connection
      await this.notify(`📅 Calendar connected successfully for ${data.username}`);
      
      return {
        success: true,
        message: 'Calendar credentials set successfully',
        calendars: this.calendars.length
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to connect: ${error.message}`
      };
    }
  }

  getServerUrl(username) {
    // Auto-detect server URL based on email domain
    if (username.includes('@gmail.com') || username.includes('@google.com')) {
      // Google Calendar CalDAV URL - use base URL only
      // The dav library will handle the path construction
      return 'https://www.google.com/calendar/dav/';
    } else if (username.includes('@icloud.com') || username.includes('@me.com')) {
      return 'https://caldav.icloud.com/';
    } else if (username.includes('@yahoo.com')) {
      return 'https://caldav.calendar.yahoo.com/';
    } else if (username.includes('@outlook.com') || username.includes('@hotmail.com')) {
      return 'https://caldav.outlook.com/';
    }
    
    // Default to standard CalDAV port
    return 'https://caldav.server.com/';
  }

  async listCalendars() {
    try {
      const calendars = this.calendars.map(cal => ({
        id: cal.url,
        name: cal.displayName,
        description: cal.description,
        color: cal.color,
        primary: cal.url.includes('primary') || cal.displayName.toLowerCase() === 'calendar'
      }));
      
      return {
        success: true,
        calendars: calendars
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getEvents(data) {
    this.calendarLogger.info('=== CALENDAR GET EVENTS START ===');
    this.calendarLogger.info(`getEvents called with params: ${JSON.stringify(data)}`);
    this.calendarLogger.info(`Calendar connected: ${!!this.account}, Calendars available: ${this.calendars.length}`);
    
    this.logger.info('=== CALENDAR GET EVENTS START ===');
    this.logger.info(`getEvents called with params: ${JSON.stringify(data)}`);
    this.logger.info(`Calendar connected: ${!!this.account}, Calendars available: ${this.calendars.length}`);
    
    this.validateParams(data, {
      calendarId: { required: false, type: 'string' },
      startDate: { required: false, type: 'string' },
      endDate: { required: false, type: 'string' },
      limit: { required: false, type: 'number' }
    });
    
    try {
      // Use primary calendar if not specified
      let calendar = data.calendarId ? 
        this.calendars.find(c => c.url === data.calendarId) :
        this.calendars.find(c => c.displayName.toLowerCase() === 'calendar') || this.calendars[0];
      
      if (!calendar) {
        throw new Error('Calendar not found');
      }
      
      this.logger.info(`Getting events from calendar: ${calendar.displayName} (${calendar.url})`);
      
      // Default to next 30 days if no date range specified
      const startDate = data.startDate ? new Date(data.startDate) : new Date();
      const endDate = data.endDate ? new Date(data.endDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      
      // Sync calendar to get latest events
      try {
        this.logger.info(`Starting calendar sync...`);
        
        // First ensure we have the latest calendar object data
        const syncedCalendar = await dav.syncCalendar(calendar, {
          filters: [{
            type: 'comp-filter',
            attrs: { name: 'VEVENT' }
          }],
          xhr: this.client.xhr,
          syncMethod: 'webdav'
        });
        
        // Update the calendar reference with synced data
        if (syncedCalendar) {
          calendar = syncedCalendar;
          // Update in our calendars array as well
          const index = this.calendars.findIndex(c => c.url === calendar.url);
          if (index !== -1) {
            this.calendars[index] = calendar;
          }
        }
        
        // Check if calendar.objects already exists from sync
        if (!calendar.objects || calendar.objects.length === 0) {
          // List calendar objects with their data
          try {
            this.logger.info(`No objects from sync, fetching calendar objects manually...`);
            const calendarObjects = await dav.listCalendarObjects(calendar, {
              xhr: this.client.xhr
            });
            
            if (calendarObjects && calendarObjects.length > 0) {
              calendar.objects = calendarObjects;
              this.logger.info(`Retrieved ${calendarObjects.length} calendar objects`);
            }
          } catch (listError) {
            this.logger.warn(`Failed to list calendar objects: ${listError.message}`);
          }
        } else {
          this.logger.info(`Using ${calendar.objects.length} objects from sync`);
        }
        
        // Now ensure all objects have data
        if (calendar.objects && calendar.objects.length > 0) {
          let fetchCount = 0;
          for (let i = 0; i < calendar.objects.length; i++) {
            const obj = calendar.objects[i];
            if (!obj.data && !obj.calendarData && obj.url && obj.etag) {
              try {
                this.logger.info(`Fetching data for object ${i + 1}/${calendar.objects.length}: ${obj.url}`);
                const fullObject = await dav.getCalendarObject(calendar, obj, {
                  xhr: this.client.xhr
                });
                
                // Try different properties where data might be stored
                if (fullObject) {
                  if (fullObject.calendarData) {
                    calendar.objects[i].data = fullObject.calendarData;
                    fetchCount++;
                    this.logger.info(`Successfully fetched data for object ${i + 1} (calendarData)`);
                  } else if (fullObject.data) {
                    calendar.objects[i].data = fullObject.data;
                    fetchCount++;
                    this.logger.info(`Successfully fetched data for object ${i + 1} (data)`);
                  } else {
                    // Log the structure to understand what we're getting
                    this.logger.info(`Full object structure: ${JSON.stringify(Object.keys(fullObject))}`);
                  }
                }
              } catch (fetchError) {
                this.logger.warn(`Failed to fetch data for object ${obj.url}: ${fetchError.message}`);
              }
            } else if (obj.calendarData && !obj.data) {
              // If data is stored in calendarData property, move it to data
              calendar.objects[i].data = obj.calendarData;
              this.logger.info(`Moved calendarData to data for object ${i + 1}`);
            }
          }
          
          if (fetchCount > 0) {
            this.logger.info(`Fetched data for ${fetchCount} objects`);
          }
        }
        
        this.logger.info(`Sync completed successfully`);
      } catch (syncError) {
        this.logger.warn(`Sync failed: ${syncError.message}`);
      }
      
      // Parse and format events
      const events = [];
      if (calendar.objects && Array.isArray(calendar.objects)) {
        this.logger.info(`Found ${calendar.objects.length} objects in calendar`);
        this.calendarLogger.info(`Found ${calendar.objects.length} objects in calendar`);
        let eventCount = 0;
        
        // Log the structure of the first object for debugging
        if (calendar.objects.length > 0) {
          const firstObj = calendar.objects[0];
          this.logger.info(`First object structure: ${JSON.stringify(Object.keys(firstObj))}`);
          this.logger.info(`First object URL: ${firstObj.url}`);
          this.logger.info(`First object data exists: ${!!firstObj.data}`);
          this.logger.info(`First object calendarData exists: ${!!firstObj.calendarData}`);
          
          this.calendarLogger.info(`First object structure: ${JSON.stringify(Object.keys(firstObj))}`);
          this.calendarLogger.info(`First object URL: ${firstObj.url}`);
          this.calendarLogger.info(`First object data exists: ${!!firstObj.data}`);
          this.calendarLogger.info(`First object calendarData exists: ${!!firstObj.calendarData}`);
          
          // Check all possible data properties
          const dataProps = ['data', 'calendarData', 'icalData', 'rawData'];
          for (const prop of dataProps) {
            if (firstObj[prop]) {
              this.logger.info(`Found data in property '${prop}', type: ${typeof firstObj[prop]}`);
            }
          }
        }
        
        for (let i = 0; i < calendar.objects.length; i++) {
          const obj = calendar.objects[i];
          try {
            // Try to find the actual calendar data in various properties
            let calData = obj.data || obj.calendarData || obj.icalData || obj.rawData;
            
            // If no data found, try to fetch it
            if (!calData && obj.url) {
              this.logger.info(`Object ${i + 1} (${obj.url}) has no data, attempting to fetch...`);
              this.calendarLogger.info(`Object ${i + 1} (${obj.url}) has no data, attempting to fetch...`);
              try {
                const fetchedObj = await dav.getCalendarObject(calendar, obj, {
                  xhr: this.client.xhr
                });
                
                this.logger.info(`Fetched object keys: ${JSON.stringify(Object.keys(fetchedObj || {}))}`);
                
                // Try to extract data from various possible locations
                calData = fetchedObj?.calendarData || fetchedObj?.data || fetchedObj?.icalData || fetchedObj;
                
                if (calData && typeof calData === 'object' && !Buffer.isBuffer(calData) && typeof calData !== 'string') {
                  // If it's still an object, log its structure
                  this.logger.info(`Fetched object is complex, keys: ${JSON.stringify(Object.keys(calData))}`);
                  
                  // Try common property names
                  const possibleDataProps = ['calendarData', 'data', 'icalData', 'body', 'content', 'raw'];
                  for (const prop of possibleDataProps) {
                    if (calData[prop]) {
                      calData = calData[prop];
                      this.logger.info(`Found data in fetched object property: ${prop}`);
                      break;
                    }
                  }
                }
              } catch (fetchError) {
                this.logger.warn(`Failed to fetch data for object ${obj.url}: ${fetchError.message}`);
                continue;
              }
            }
            
            // Now check if we have calendar data to parse
            if (calData) {
              this.calendarLogger.info(`Object ${i + 1} has data, type: ${typeof calData}, isBuffer: ${Buffer.isBuffer(calData)}`);
              if (typeof calData === 'object' && !Buffer.isBuffer(calData)) {
                this.calendarLogger.info(`Object ${i + 1} data keys: ${JSON.stringify(Object.keys(calData))}`);
              }
              // Handle different data types
              let dataStr;
              if (typeof calData === 'string') {
                dataStr = calData;
              } else if (Buffer.isBuffer(calData)) {
                dataStr = calData.toString('utf8');
                this.logger.info(`Converted Buffer to string for object ${i + 1}`);
              } else if (calData.props) {
                // The actual calendar data might be in the props
                this.calendarLogger.info(`Object ${i + 1} checking props for calendar data`);
                // Check common property names for calendar data
                const possibleProps = ['calendar-data', 'calendarData', 'getcontenttype', 'getetag', 'C:calendar-data'];
                for (const propName of possibleProps) {
                  if (calData.props[propName]) {
                    dataStr = calData.props[propName];
                    this.calendarLogger.info(`Found calendar data in props['${propName}']`);
                    break;
                  }
                }
                if (!dataStr) {
                  // Log all available props to see what we have
                  this.calendarLogger.info(`Object ${i + 1} props keys: ${JSON.stringify(Object.keys(calData.props || {}))}`);
                }
              } else if (calData.toString) {
                dataStr = calData.toString();
              } else {
                this.logger.warn(`Object ${i + 1} data is not convertible to string:`, typeof calData);
                continue;
              }
              
              if (dataStr.includes('BEGIN:VEVENT')) {
                eventCount++;
                this.logger.info(`Found VEVENT in object ${i + 1} (${obj.url})`);
                this.calendarLogger.info(`Found VEVENT in object ${i + 1} (${obj.url})`);
                const parsedEvent = this.parseICalEvent(dataStr);
                if (parsedEvent) {
                  // Filter by date range
                  const eventStart = new Date(parsedEvent.start);
                  const eventEnd = new Date(parsedEvent.end);
                  if (eventStart <= endDate && eventEnd >= startDate) {
                    events.push({
                      id: obj.url,
                      ...parsedEvent
                    });
                    this.logger.info(`Added event: ${parsedEvent.title} on ${parsedEvent.start}`);
                  } else {
                    this.logger.info(`Event outside date range: ${parsedEvent.title}`);
                  }
                } else {
                  this.logger.warn('Failed to parse event data');
                }
              } else {
                // Log first 200 chars of data for debugging
                this.logger.info(`Object ${obj.url} data preview: ${dataStr.substring(0, 200)}...`);
              }
            }
          } catch (objError) {
            this.logger.error('Error processing calendar object:', objError);
          }
        }
        this.logger.info(`Processed ${eventCount} events, ${events.length} within date range`);
      } else {
        this.logger.info('No objects found in calendar after sync');
      }
      
      // Sort by start date
      events.sort((a, b) => new Date(a.start) - new Date(b.start));
      
      // Apply limit if specified
      const limitedEvents = data.limit ? events.slice(0, data.limit) : events;
      
      return {
        success: true,
        events: limitedEvents,
        total: events.length
      };
    } catch (error) {
      this.logger.error('Failed to get events:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  parseICalEvent(icalData) {
    try {
      const jcalData = ICAL.parse(icalData);
      const comp = new ICAL.Component(jcalData);
      const vevent = comp.getFirstSubcomponent('vevent');
      
      if (!vevent) return null;
      
      const event = new ICAL.Event(vevent);
      
      return {
        title: event.summary || 'Untitled Event',
        description: event.description || '',
        start: event.startDate.toJSDate().toISOString(),
        end: event.endDate.toJSDate().toISOString(),
        location: event.location || '',
        allDay: event.startDate.isDate,
        attendees: this.parseAttendees(vevent),
        reminders: this.parseAlarms(vevent),
        recurrence: event.isRecurring() ? event.iterator().toJSON() : null
      };
    } catch (error) {
      this.logger.error('Failed to parse iCal event:', error);
      return null;
    }
  }

  parseAttendees(vevent) {
    const attendees = [];
    const attendeeProps = vevent.getAllProperties('attendee');
    
    for (const prop of attendeeProps) {
      const email = prop.getFirstValue().replace('mailto:', '');
      const name = prop.getParameter('cn') || email;
      const status = prop.getParameter('partstat') || 'NEEDS-ACTION';
      
      attendees.push({ name, email, status });
    }
    
    return attendees;
  }

  parseAlarms(vevent) {
    const alarms = [];
    const valarms = vevent.getAllSubcomponents('valarm');
    
    for (const valarm of valarms) {
      const trigger = valarm.getFirstPropertyValue('trigger');
      if (trigger) {
        alarms.push({
          minutes: Math.abs(trigger.toSeconds() / 60),
          type: valarm.getFirstPropertyValue('action') || 'DISPLAY'
        });
      }
    }
    
    return alarms;
  }

  async createEvent(data) {
    this.validateParams(data, {
      title: { required: true, type: 'string' },
      start: { required: true, type: 'string' },
      end: { required: false, type: 'string' },
      description: { required: false, type: 'string' },
      location: { required: false, type: 'string' },
      allDay: { required: false, type: 'boolean' },
      reminders: { required: false, type: 'array' },
      attendees: { required: false, type: 'array' },
      calendarId: { required: false, type: 'string' }
    });
    
    try {
      // Use primary calendar if not specified
      let calendar = data.calendarId ? 
        this.calendars.find(c => c.url === data.calendarId) :
        this.calendars.find(c => c.displayName.toLowerCase() === 'calendar') || this.calendars[0];
      
      if (!calendar) {
        throw new Error('Calendar not found');
      }
      
      this.logger.info(`Creating event in calendar: ${calendar.displayName} (${calendar.url})`);
      
      // Create iCal event
      const vcalendar = new ICAL.Component(['vcalendar', [], []]);
      vcalendar.updatePropertyWithValue('prodid', '-//LANAgent//Calendar Plugin//EN');
      vcalendar.updatePropertyWithValue('version', '2.0');
      
      const vevent = new ICAL.Component('vevent');
      const uid = `${uuidv4()}@lanagent`;
      vevent.updatePropertyWithValue('uid', uid);
      vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
      vevent.updatePropertyWithValue('summary', data.title);
      
      if (data.description) {
        vevent.updatePropertyWithValue('description', data.description);
      }
      
      if (data.location) {
        vevent.updatePropertyWithValue('location', data.location);
      }
      
      // Set start and end times
      const startTime = ICAL.Time.fromJSDate(new Date(data.start));
      const endTime = data.end ? 
        ICAL.Time.fromJSDate(new Date(data.end)) :
        ICAL.Time.fromJSDate(new Date(new Date(data.start).getTime() + 60 * 60 * 1000)); // 1 hour default
      
      if (data.allDay) {
        startTime.isDate = true;
        endTime.isDate = true;
      }
      
      vevent.updatePropertyWithValue('dtstart', startTime);
      vevent.updatePropertyWithValue('dtend', endTime);
      
      // Add attendees
      if (data.attendees && data.attendees.length > 0) {
        for (const attendee of data.attendees) {
          const prop = new ICAL.Property('attendee');
          prop.setValue(`mailto:${attendee.email}`);
          if (attendee.name) prop.setParameter('cn', attendee.name);
          prop.setParameter('partstat', 'NEEDS-ACTION');
          prop.setParameter('rsvp', 'TRUE');
          vevent.addProperty(prop);
        }
      }
      
      // Add reminders
      if (data.reminders && data.reminders.length > 0) {
        for (const reminder of data.reminders) {
          const valarm = new ICAL.Component('valarm');
          valarm.updatePropertyWithValue('action', 'DISPLAY');
          valarm.updatePropertyWithValue('description', 'Reminder');
          
          const trigger = new ICAL.Duration();
          trigger.minutes = -Math.abs(reminder.minutes || 15);
          valarm.updatePropertyWithValue('trigger', trigger);
          
          vevent.addSubcomponent(valarm);
        }
      }
      
      vcalendar.addSubcomponent(vevent);
      const icalData = vcalendar.toString();
      
      // Create event on server
      const response = await this.client.createCalendarObject(calendar, {
        data: icalData,
        filename: `${uid}.ics`
      });
      
      this.logger.info(`Event created with UID: ${uid} in calendar: ${calendar.url}`);
      
      // Force a sync to ensure the calendar is updated
      try {
        const syncedCalendar = await dav.syncCalendar(calendar, {
          xhr: this.client.xhr
        });
        if (syncedCalendar) {
          const index = this.calendars.findIndex(c => c.url === calendar.url);
          if (index !== -1) {
            this.calendars[index] = syncedCalendar;
          }
        }
        this.logger.info('Calendar synced after creating event');
      } catch (syncError) {
        this.logger.warn('Failed to sync calendar after creating event:', syncError.message);
      }
      
      // Send notification
      await this.notify(`📅 Event created: "${data.title}" on ${new Date(data.start).toLocaleDateString()}`);
      
      return {
        success: true,
        message: 'Event created successfully',
        eventId: uid,
        details: {
          title: data.title,
          start: data.start,
          end: data.end || new Date(new Date(data.start).getTime() + 60 * 60 * 1000).toISOString()
        }
      };
    } catch (error) {
      this.logger.error('Failed to create event:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateEvent(data) {
    this.calendarLogger.info(`=== CALENDAR UPDATE EVENT START ===`);
    this.calendarLogger.info(`updateEvent called with eventId: ${data.eventId}`);
    
    this.validateParams(data, {
      eventId: { required: true, type: 'string' },
      calendarId: { required: false, type: 'string' },
      updates: { required: true, type: 'object' }
    });
    
    try {
      const calendar = data.calendarId ? 
        this.calendars.find(c => c.url === data.calendarId) :
        this.calendars[0];
      
      if (!calendar) {
        throw new Error('Calendar not found');
      }
      
      // Sync calendar to ensure we have latest objects
      this.calendarLogger.info('Syncing calendar before update...');
      try {
        const syncedCalendar = await dav.syncCalendar(calendar, {
          filters: [{
            type: 'comp-filter',
            attrs: { name: 'VEVENT' }
          }],
          xhr: this.client.xhr
        });
        
        if (syncedCalendar && syncedCalendar.objects) {
          calendar.objects = syncedCalendar.objects;
          this.calendarLogger.info(`Sync complete, found ${calendar.objects.length} objects`);
        }
      } catch (syncError) {
        this.calendarLogger.warn(`Sync failed: ${syncError.message}`);
      }
      
      // Find the event
      this.calendarLogger.info(`Looking for event in ${calendar.objects.length} objects`);
      const event = calendar.objects.find(obj => {
        // The eventId might be the full URL or just the filename part
        const matches = obj.url === data.eventId || obj.url.includes(data.eventId);
        if (matches) {
          this.calendarLogger.info(`Found matching event: ${obj.url}`);
        }
        return matches;
      });
      
      if (!event) {
        this.calendarLogger.error(`Event not found with ID: ${data.eventId}`);
        this.calendarLogger.info(`Available event URLs:`);
        calendar.objects.forEach(obj => {
          this.calendarLogger.info(`  - ${obj.url}`);
        });
        throw new Error('Event not found');
      }
      
      this.calendarLogger.info(`Found event: ${event.url}`);
      this.calendarLogger.info(`Event etag: ${event.etag}`);
      this.calendarLogger.info(`Event structure: ${JSON.stringify(Object.keys(event))}`);
      
      // Get the actual calendar data
      let eventData = event.data;
      if (eventData && eventData.props && eventData.props.calendarData) {
        eventData = eventData.props.calendarData;
        this.calendarLogger.info('Using calendar data from props.calendarData');
      } else if (event.calendarData) {
        eventData = event.calendarData;
        this.calendarLogger.info('Using calendar data from event.calendarData');
      }
      
      // Parse existing event data
      const existingData = this.parseICalEvent(eventData);
      
      // Merge with updates
      const updatedEvent = { ...existingData, ...data.updates };
      
      // Create updated iCal
      const vcalendar = new ICAL.Component(['vcalendar', [], []]);
      vcalendar.updatePropertyWithValue('prodid', '-//LANAgent//Calendar Plugin//EN');
      vcalendar.updatePropertyWithValue('version', '2.0');
      
      const vevent = new ICAL.Component('vevent');
      vevent.updatePropertyWithValue('uid', data.eventId);
      vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
      vevent.updatePropertyWithValue('summary', updatedEvent.title);
      
      if (updatedEvent.description) {
        vevent.updatePropertyWithValue('description', updatedEvent.description);
      }
      
      if (updatedEvent.location) {
        vevent.updatePropertyWithValue('location', updatedEvent.location);
      }
      
      const startTime = ICAL.Time.fromJSDate(new Date(updatedEvent.start));
      const endTime = ICAL.Time.fromJSDate(new Date(updatedEvent.end));
      
      if (updatedEvent.allDay) {
        startTime.isDate = true;
        endTime.isDate = true;
      }
      
      vevent.updatePropertyWithValue('dtstart', startTime);
      vevent.updatePropertyWithValue('dtend', endTime);
      
      vcalendar.addSubcomponent(vevent);
      const icalData = vcalendar.toString();
      
      // Try a different approach - get the event directly via HTTP request
      this.calendarLogger.info('Fetching latest event data before update...');
      try {
        // Use the DAV transport to get the event directly
        const getResponse = await this.client.xhr.send({
          method: 'GET',
          url: event.url,
          headers: {
            'Content-Type': 'text/calendar'
          }
        });
        
        if (getResponse && getResponse.xhr) {
          const freshEtag = getResponse.xhr.getResponseHeader('etag');
          if (freshEtag) {
            event.etag = freshEtag;
            this.calendarLogger.info(`Got fresh etag from GET request: ${freshEtag}`);
          }
        }
      } catch (fetchError) {
        this.calendarLogger.warn(`Failed to fetch fresh etag: ${fetchError.message}`);
      }
      
      // Update on server
      this.calendarLogger.info('Sending update to server...');
      this.calendarLogger.info(`Using etag: ${event.etag}`);
      try {
        // Update the event object with new calendar data
        event.calendarData = icalData;
        
        // If the event structure has data.props, update that too
        if (event.data && event.data.props) {
          event.data.props.calendarData = icalData;
        }
        
        await dav.updateCalendarObject(event, {
          xhr: this.client.xhr
        });
        this.calendarLogger.info('Event updated successfully on server');
      } catch (updateError) {
        this.calendarLogger.error(`Failed to update event: ${updateError.message}`);
        
        // If still getting 412, try with wildcard etag
        if (updateError.message && updateError.message.includes('412')) {
          this.calendarLogger.info('Retrying with wildcard etag...');
          try {
            event.etag = '*'; // Use wildcard to force update
            await dav.updateCalendarObject(event, {
              xhr: this.client.xhr
            });
            this.calendarLogger.info('Event updated successfully with wildcard etag');
          } catch (retryError) {
            this.calendarLogger.error(`Wildcard etag retry failed: ${retryError.message}`);
            throw updateError;
          }
        } else {
          throw updateError;
        }
      }
      
      await this.notify(`📅 Event "${updatedEvent.title}" updated successfully`);
      
      return {
        success: true,
        message: 'Event updated successfully',
        event: updatedEvent
      };
    } catch (error) {
      this.logger.error('Failed to update event:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async deleteEvent(data) {
    this.calendarLogger.info(`=== CALENDAR DELETE EVENT START ===`);
    this.calendarLogger.info(`deleteEvent called with eventId: ${data.eventId}`);
    
    this.validateParams(data, {
      eventId: { required: true, type: 'string' },
      calendarId: { required: false, type: 'string' }
    });
    
    try {
      const calendar = data.calendarId ? 
        this.calendars.find(c => c.url === data.calendarId) :
        this.calendars[0];
      
      if (!calendar) {
        throw new Error('Calendar not found');
      }
      
      // Sync calendar to ensure we have latest objects
      this.calendarLogger.info('Syncing calendar before delete...');
      try {
        const syncedCalendar = await dav.syncCalendar(calendar, {
          filters: [{
            type: 'comp-filter',
            attrs: { name: 'VEVENT' }
          }],
          xhr: this.client.xhr
        });
        
        if (syncedCalendar && syncedCalendar.objects) {
          calendar.objects = syncedCalendar.objects;
          this.calendarLogger.info(`Sync complete, found ${calendar.objects.length} objects`);
        }
      } catch (syncError) {
        this.calendarLogger.warn(`Sync failed: ${syncError.message}`);
      }
      
      // Find the event
      this.calendarLogger.info(`Looking for event in ${calendar.objects.length} objects`);
      const event = calendar.objects.find(obj => {
        // The eventId might be the full URL or just the filename part
        const matches = obj.url === data.eventId || obj.url.includes(data.eventId);
        if (matches) {
          this.calendarLogger.info(`Found matching event: ${obj.url}`);
        }
        return matches;
      });
      
      if (!event) {
        this.calendarLogger.error(`Event not found with ID: ${data.eventId}`);
        this.calendarLogger.info(`Available event URLs:`);
        calendar.objects.forEach(obj => {
          this.calendarLogger.info(`  - ${obj.url}`);
        });
        throw new Error('Event not found');
      }
      
      // Delete from server
      this.calendarLogger.info('Deleting event from server...');
      
      // Check if the event URL is malformed (contains duplicate paths)
      if (event.url && event.url.includes('events/https://')) {
        this.calendarLogger.warn('Detected malformed event URL with duplicate paths');
        
        // Try to fix the URL by extracting just the filename
        const filename = event.url.split('/').pop();
        const baseUrl = calendar.url;
        const fixedUrl = baseUrl + filename;
        
        this.calendarLogger.info(`Attempting to fix URL: ${event.url} -> ${fixedUrl}`);
        
        // Create a corrected event object
        const correctedEvent = {
          ...event,
          url: fixedUrl
        };
        
        try {
          await dav.deleteCalendarObject(correctedEvent, {
            xhr: this.client.xhr
          });
          this.calendarLogger.info('Event deleted successfully from server using fixed URL');
        } catch (deleteError) {
          this.calendarLogger.error(`Failed with fixed URL, trying original: ${deleteError.message}`);
          
          // If that fails, try with the original malformed URL
          try {
            await dav.deleteCalendarObject(event, {
              xhr: this.client.xhr
            });
            this.calendarLogger.info('Event deleted successfully from server');
          } catch (secondError) {
            this.calendarLogger.error(`Failed to delete event: ${secondError.message}`);
            throw secondError;
          }
        }
      } else {
        // Normal deletion for properly formed URLs
        try {
          await dav.deleteCalendarObject(event, {
            xhr: this.client.xhr
          });
          this.calendarLogger.info('Event deleted successfully from server');
        } catch (deleteError) {
          this.calendarLogger.error(`Failed to delete event: ${deleteError.message}`);
          throw deleteError;
        }
      }
      
      await this.notify(`📅 Event deleted successfully`);
      
      return {
        success: true,
        message: 'Event deleted successfully'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async checkAvailability(data) {
    this.validateParams(data, {
      date: { required: true, type: 'string' },
      duration: { required: false, type: 'number' },
      startHour: { required: false, type: 'number' },
      endHour: { required: false, type: 'number' }
    });
    
    try {
      const checkDate = new Date(data.date);
      const duration = data.duration || 60; // Default 1 hour
      const startHour = data.startHour || 9; // Default 9 AM
      const endHour = data.endHour || 17; // Default 5 PM
      
      // Get all events for the day
      const dayStart = new Date(checkDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(checkDate);
      dayEnd.setHours(23, 59, 59, 999);
      
      const eventsResult = await this.getEvents({
        startDate: dayStart.toISOString(),
        endDate: dayEnd.toISOString()
      });
      
      if (!eventsResult.success) {
        throw new Error(eventsResult.error);
      }
      
      // Find available slots
      const slots = [];
      const events = eventsResult.events;
      
      for (let hour = startHour; hour < endHour; hour++) {
        const slotStart = new Date(checkDate);
        slotStart.setHours(hour, 0, 0, 0);
        const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
        
        // Check if slot conflicts with any event
        const hasConflict = events.some(event => {
          const eventStart = new Date(event.start);
          const eventEnd = new Date(event.end);
          return (slotStart < eventEnd && slotEnd > eventStart);
        });
        
        if (!hasConflict && slotEnd.getHours() <= endHour) {
          slots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString()
          });
        }
      }
      
      return {
        success: true,
        date: data.date,
        availableSlots: slots,
        busyTimes: events.map(e => ({
          start: e.start,
          end: e.end,
          title: e.title
        }))
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async searchEvents(data) {
    // Accept both 'query' and 'keyword' param names
    if (!data.query && data.keyword) {
      data.query = data.keyword;
    }
    this.validateParams(data, {
      query: { required: true, type: 'string' },
      startDate: { required: false, type: 'string' },
      endDate: { required: false, type: 'string' }
    });

    try {
      // Get events in date range
      const eventsResult = await this.getEvents({
        startDate: data.startDate,
        endDate: data.endDate
      });

      if (!eventsResult.success) {
        throw new Error(eventsResult.error);
      }

      // Filter by search query
      const query = data.query.toLowerCase();
      const matches = eventsResult.events.filter(event => 
        event.title.toLowerCase().includes(query) ||
        event.description.toLowerCase().includes(query) ||
        event.location.toLowerCase().includes(query)
      );
      
      return {
        success: true,
        query: data.query,
        matches: matches,
        total: matches.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getUpcoming(data) {
    this.validateParams(data, {
      days: { required: false, type: 'number' },
      limit: { required: false, type: 'number' }
    });
    
    const days = data.days || 7;
    const limit = data.limit || 10;
    
    try {
      const startDate = new Date();
      const endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      
      const eventsResult = await this.getEvents({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        limit: limit
      });
      
      return eventsResult;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getToday() {
    try {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const eventsResult = await this.getEvents({
        startDate: today.toISOString(),
        endDate: tomorrow.toISOString()
      });
      
      if (eventsResult.success) {
        eventsResult.message = `You have ${eventsResult.events.length} events today`;
      }
      
      return eventsResult;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async saveConfig(config) {
    try {
      this.config = { ...this.config, ...config };
      this.emit('configChanged', this.config);
    } catch (error) {
      this.logger.error('Failed to save calendar config:', error);
    }
  }

  async loadConfig() {
    try {
      // Config would be loaded from database in real implementation
      // For now, just use environment variables
      // Clear any serverUrl to ensure we always use the auto-detected one
      this.config = {};
      delete this.config.serverUrl;
    } catch (error) {
      this.logger.error('Failed to load calendar config:', error);
    }
  }

  // Required method for BasePlugin
  getCommands() {
    return {
      'setCredentials': 'Configure calendar credentials',
      'listCalendars': 'List available calendars',
      'getEvents': 'Get events from calendar',
      'createEvent': 'Create a new event',
      'updateEvent': 'Update an existing event',
      'deleteEvent': 'Delete an event',
      'checkAvailability': 'Check available time slots',
      'searchEvents': 'Search for events',
      'getUpcoming': 'Get upcoming events',
      'getToday': 'Get today\'s events'
    };
  }

  // Web interface routes
  getRoutes() {
    return [
      {
        method: 'GET',
        path: '/status',
        handler: async () => {
          return {
            success: true,
            mode: this.localMode ? 'local' : 'caldav',
            localMode: this.localMode,
            connected: this.localMode || !!this.account,
            username: this.credentials?.username || (this.localMode ? 'Local Calendar' : null),
            calendars: this.localMode ? 1 : this.calendars.length
          };
        }
      },
      {
        method: 'GET',
        path: '/calendars',
        handler: async () => {
          if (this.localMode) {
            return {
              success: true,
              calendars: [{ id: 'local', name: 'Local Calendar', description: 'MongoDB-based calendar', primary: true }]
            };
          }
          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }
          return await this.listCalendars();
        }
      },
      {
        method: 'GET',
        path: '/events',
        handler: async (params) => {
          if (this.localMode) {
            return await this.getLocalEvents(params);
          }
          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }
          return await this.getEvents(params);
        }
      },
      {
        method: 'GET',
        path: '/events/month',
        handler: async (params) => {
          const year = parseInt(params.year) || new Date().getFullYear();
          const month = parseInt(params.month) || new Date().getMonth();

          const startDate = new Date(year, month, 1);
          const endDate = new Date(year, month + 1, 0, 23, 59, 59);

          if (this.localMode) {
            const events = await CalendarEvent.findByDateRange(startDate, endDate);
            return {
              success: true,
              events: events.map(e => this.formatLocalEventResponse(e)),
              total: events.length,
              mode: 'local'
            };
          }

          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }

          return await this.getEvents({
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
          });
        }
      },
      {
        method: 'POST',
        path: '/events',
        handler: async (params) => {
          if (this.localMode) {
            return await this.createLocalEvent(params);
          }
          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }
          return await this.createEvent(params);
        }
      },
      {
        method: 'PUT',
        path: '/events/:eventId',
        handler: async (params, req) => {
          const eventId = decodeURIComponent(req.params.eventId);
          if (this.localMode) {
            return await this.updateLocalEvent({ eventId, ...params });
          }
          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }
          return await this.updateEvent({
            eventId: eventId,
            updates: params
          });
        }
      },
      {
        method: 'DELETE',
        path: '/events/:eventId',
        handler: async (params, req) => {
          const eventId = decodeURIComponent(req.params.eventId);
          if (this.localMode) {
            return await this.deleteLocalEvent({ eventId });
          }
          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }
          return await this.deleteEvent({ eventId });
        }
      },
      {
        method: 'PUT',
        path: '/events',
        handler: async (params) => {
          if (!params.eventId) {
            return { success: false, error: 'Missing eventId parameter' };
          }
          if (this.localMode) {
            return await this.updateLocalEvent(params);
          }
          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }
          return await this.updateEvent(params);
        }
      },
      {
        method: 'POST',
        path: '/events/delete',
        handler: async (params) => {
          if (!params.eventId) {
            return { success: false, error: 'Missing eventId parameter' };
          }
          if (this.localMode) {
            return await this.deleteLocalEvent(params);
          }
          if (!this.account) {
            return { success: false, error: 'Calendar not connected' };
          }
          return await this.deleteEvent(params);
        }
      }
    ];
  }
}

