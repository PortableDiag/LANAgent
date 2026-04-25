import { logger } from '../utils/logger.js';
import { Task } from '../models/Task.js';
import { retryOperation } from '../utils/retryUtils.js';

// Default reminder thresholds (ordered by hours descending)
const DEFAULT_REMINDERS = [
  { hours: 24, key: '24h', message: '1 day' },
  { hours: 12, key: '12h', message: '12 hours' },
  { hours: 6, key: '6h', message: '6 hours' },
  { hours: 2, key: '2h', message: '2 hours' },
  { hours: 1, key: '1h', message: '1 hour' },
  { hours: 0.5, key: '30m', message: '30 minutes' }
];

export class TaskReminderService {
  constructor(agent, config = {}) {
    this.agent = agent;
    this.sentReminders = new Map(); // Track sent reminders
    this.enabled = true;
    this.checkInterval = config.checkInterval || '5 minutes';
    // Accept custom reminder thresholds (must be array of {hours, key, message})
    this.reminderThresholds = Array.isArray(config.reminders) && config.reminders.length > 0
      ? config.reminders.sort((a, b) => b.hours - a.hours)
      : DEFAULT_REMINDERS;
  }

  /**
   * Initialize with Agenda scheduler
   */
  async initialize() {
    if (!this.agent.scheduler) {
      logger.warn('No scheduler available for task reminders');
      return;
    }

    // Define the reminder check job
    this.agent.scheduler.agenda.define('task-reminder-check', async (job) => {
      await this.checkReminders();
    });

    // Schedule reminder checks at configured interval
    await this.agent.scheduler.agenda.every(this.checkInterval, 'task-reminder-check');
    
    logger.info('Task reminder service initialized with Agenda');
  }

  /**
   * Start the reminder service
   */
  start() {
    this.enabled = true;
    logger.info('Task reminder service enabled');
  }

  /**
   * Stop the reminder service
   */
  stop() {
    this.enabled = false;
    logger.info('Task reminder service disabled');
  }

  /**
   * Check for tasks that need reminders
   */
  async checkReminders() {
    try {
      if (!this.enabled) {
        logger.debug('Task reminder service is disabled');
        return;
      }

      const now = new Date();
      
      // Get tasks with due dates
      const tasks = await Task.find({
        completed: false,
        dueDate: { $exists: true, $ne: null }
      });
      
      logger.debug(`Checking ${tasks.length} tasks for reminders`);
      
      for (const task of tasks) {
        await this.checkTaskReminder(task, now);
      }
      
      // Clean up old sent reminders (older than 24 hours)
      const oneDayAgo = now.getTime() - (24 * 60 * 60 * 1000);
      for (const [key, time] of this.sentReminders.entries()) {
        if (time < oneDayAgo) {
          this.sentReminders.delete(key);
        }
      }
      
    } catch (error) {
      logger.error('Error checking task reminders:', error);
    }
  }

  /**
   * Check if a specific task needs a reminder
   */
  async checkTaskReminder(task, now) {
    const dueDate = new Date(task.dueDate);
    const timeDiff = dueDate.getTime() - now.getTime();
    const hoursDiff = timeDiff / (1000 * 60 * 60);
    
    // Skip if due date has passed
    if (timeDiff < 0) {
      // Send overdue reminder once per day
      const overdueKey = `overdue-${task._id}`;
      if (this.shouldSendReminder(overdueKey, 24)) {
        await this.sendOverdueReminder(task, -hoursDiff);
      }
      return;
    }
    
    // Use configurable reminder thresholds
    const reminders = this.reminderThresholds;
    
    // Find appropriate reminder
    for (const reminder of reminders) {
      if (hoursDiff <= reminder.hours && hoursDiff > 0) {
        const reminderKey = `${task._id}-${reminder.key}`;
        
        // Send reminder if not already sent
        if (this.shouldSendReminder(reminderKey, reminder.hours)) {
          await this.sendReminder(task, reminder.message);
          break; // Only send one reminder per check
        }
      }
    }
  }

  /**
   * Check if we should send a reminder
   */
  shouldSendReminder(key, hoursThreshold) {
    const lastSent = this.sentReminders.get(key);
    const now = Date.now();
    
    if (!lastSent) {
      this.sentReminders.set(key, now);
      return true;
    }
    
    // Don't send same reminder within threshold period
    const hoursSinceLastSent = (now - lastSent) / (1000 * 60 * 60);
    if (hoursSinceLastSent >= hoursThreshold * 0.9) {
      this.sentReminders.set(key, now);
      return true;
    }
    
    return false;
  }

  /**
   * Send task reminder
   */
  async sendReminder(task, timeLeft) {
    const message = `⏰ **Task Reminder**\n\n` +
      `**Task**: ${task.title}\n` +
      `${task.description ? `**Description**: ${task.description}\n` : ''}` +
      `**Due in**: ${timeLeft}\n` +
      `**Priority**: ${task.priority || 'medium'}\n` +
      `**Created**: ${new Date(task.createdAt).toLocaleDateString()}\n\n` +
      `Type "complete task ${task._id.toString().slice(-6)}" to mark as done.`;
    
    await this.retryNotifyUser(message);
    
    // Also send email if configured and email plugin available
    if (this.agent.apiManager && this.agent.apiManager.apis && this.agent.apiManager.apis.has('email') && process.env.EMAIL_OF_MASTER) {
      await this.sendEmailReminder(task, timeLeft);
    }
  }

  /**
   * Send overdue reminder
   */
  async sendOverdueReminder(task, hoursOverdue) {
    const timeOverdue = this.formatOverdueTime(hoursOverdue);
    
    const message = `🚨 **OVERDUE Task**\n\n` +
      `**Task**: ${task.title}\n` +
      `${task.description ? `**Description**: ${task.description}\n` : ''}` +
      `**Overdue by**: ${timeOverdue}\n` +
      `**Priority**: ${task.priority || 'medium'}\n` +
      `**Was due**: ${new Date(task.dueDate).toLocaleString()}\n\n` +
      `Type "complete task ${task._id.toString().slice(-6)}" to mark as done.`;
    
    await this.retryNotifyUser(message);
  }

  /**
   * Format overdue time
   */
  formatOverdueTime(hours) {
    if (hours < 24) {
      return `${Math.round(hours)} hours`;
    } else {
      const days = Math.round(hours / 24);
      return `${days} day${days !== 1 ? 's' : ''}`;
    }
  }

  /**
   * Send email reminder
   */
  async sendEmailReminder(task, timeLeft) {
    try {
      const emailPlugin = this.agent.apiManager?.getPlugin('email');
      if (!emailPlugin || !emailPlugin.enabled) return;
      
      await emailPlugin.instance.sendWithTemplate({
        to: process.env.EMAIL_OF_MASTER,
        template: 'taskReminder',
        variables: {
          taskTitle: task.title,
          taskDescription: task.description || 'No description',
          dueDate: new Date(task.dueDate).toLocaleString(),
          priority: task.priority || 'medium',
          timeLeft: timeLeft
        }
      });
      
    } catch (error) {
      logger.error('Failed to send email reminder:', error);
    }
  }

  /**
   * Notify user via available interfaces with retry logic
   */
  async retryNotifyUser(message) {
    try {
      await retryOperation(() => this.agent.notify(message), { retries: 3 });
    } catch (error) {
      logger.error('Failed to send task reminder after retries:', error);
    }
  }

  /**
   * Get reminder status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      sentReminders: this.sentReminders.size,
      lastCheck: this.lastCheck || null,
      scheduler: !!this.agent.scheduler
    };
  }

  /**
   * Schedule a specific task reminder using Agenda
   */
  async scheduleTaskReminder(taskId, title, dueDate) {
    if (!this.agent.scheduler) {
      logger.warn('No scheduler available for task reminder');
      return;
    }

    const reminderTime = new Date(dueDate);
    reminderTime.setMinutes(reminderTime.getMinutes() - 30); // 30 minutes before

    if (reminderTime > new Date()) {
      await this.agent.scheduler.agenda.schedule(reminderTime, 'task-reminder', {
        taskId,
        title
      });
      logger.info(`Scheduled reminder for task "${title}" at ${reminderTime}`);
    }
  }
}

export default TaskReminderService;