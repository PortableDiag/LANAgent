import { BasePlugin } from '../core/basePlugin.js';
import { Task } from '../../models/Task.js';
import { logger } from '../../utils/logger.js';

export default class TasksPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'tasks';
    this.version = '1.0.0';
    this.description = 'Task management system with reminders and scheduling';
    this.commands = [
      {
        command: 'create',
        description: 'Create a new task with optional reminder',
        usage: 'create({ title: "Task name", description: "Details", priority: "high", dueDate: "tomorrow", reminder: "2024-01-15T10:00:00" })'
      },
      {
        command: 'list',
        description: 'List tasks with optional filters',
        usage: 'list({ status: "pending", priority: "high", today: true, limit: 10 })'
      },
      {
        command: 'get',
        description: 'Get details of a specific task',
        usage: 'get({ taskId: "task123" })'
      },
      {
        command: 'update',
        description: 'Update an existing task',
        usage: 'update({ taskId: "task123", title: "Updated title", priority: "medium" })'
      },
      {
        command: 'delete',
        description: 'Delete a task permanently',
        usage: 'delete({ taskId: "task123" })'
      },
      {
        command: 'complete',
        description: 'Mark a task as completed',
        usage: 'complete({ taskId: "task123" })'
      },
      {
        command: 'search',
        description: 'Search tasks by keyword',
        usage: 'search({ query: "meeting" })'
      },
      {
        command: 'process',
        description: 'Process the next pending task automatically',
        usage: 'process()'
      }
    ];
    
    // Priority mapping from string to number
    this.priorityMap = {
      'low': 3,
      'medium': 5,
      'high': 7,
      'urgent': 9
    };
  }

  async initialize() {
    this.logger.info('Tasks plugin initialized');
    
    // Start background task processor
    this.startTaskProcessor();
  }

  async execute(params) {
    const { action, ...data } = params;
    
    this.validateParams(params, {
      action: { 
        required: true, 
        type: 'string',
        enum: ['create', 'list', 'get', 'update', 'delete', 'complete', 'search', 'process']
      }
    });
    
    switch (action) {
      case 'create':
        return await this.createTask(data);
      case 'list':
        return await this.listTasks(data);
      case 'get':
        return await this.getTask(data);
      case 'update':
        return await this.updateTask(data);
      case 'delete':
        return await this.deleteTask(data);
      case 'complete':
        return await this.completeTask(data);
      
      case 'process':
        return await this.processNextTask();
      case 'search':
        return await this.searchTasks(data);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async createTask(data) {
    this.validateParams(data, {
      title: { required: true, type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      dueDate: { type: 'string' },
      reminder: { type: 'string' },
      category: { type: 'string' },
      tags: { type: 'array' },
      recurring: { type: 'object' }
    });
    
    // Get agent name from config
    const agentName = this.agent.config?.name || process.env.AGENT_NAME || 'LANAgent';
    logger.info('Creating task with agentId:', agentName);
    
    const task = new Task({
      agentId: agentName,
      title: data.title,
      description: data.description || '',
      priority: this.priorityMap[data.priority || 'medium'] || 5,
      status: 'pending',
      category: data.category || 'general',
      tags: data.tags || [],
      metadata: {
        createdBy: data.createdBy || 'user',
        source: data.source || 'manual'
      }
    });
    
    // Parse and set due date
    if (data.dueDate) {
      task.dueDate = this.parseDateString(data.dueDate);
    }
    
    // Parse and set reminder
    if (data.reminder) {
      task.reminder = {
        enabled: true,
        time: this.parseDateString(data.reminder),
        sent: false
      };
    }
    
    // Handle recurring tasks
    if (data.recurring) {
      task.recurring = {
        enabled: true,
        pattern: data.recurring.pattern || 'daily', // daily, weekly, monthly, yearly (legacy)
        interval: data.recurring.interval || 1,
        endDate: data.recurring.endDate ? new Date(data.recurring.endDate) : null,
        nextOccurrence: this.calculateNextOccurrence(task.dueDate, data.recurring),
        // Advanced scheduling support
        rule: data.recurring.rule || null, // RRule string
        timezone: data.recurring.timezone || 'UTC'
      };
      
      // If RRule is provided, use it to calculate next run
      if (data.recurring.rule) {
        task.setRecurrenceRule(data.recurring.rule, data.recurring.timezone || 'UTC');
      }
    }
    
    try {
      await task.save();
      logger.info('Task saved to database:', { id: task._id, title: task.title, agentId: task.agentId });
    } catch (saveError) {
      logger.error('Failed to save task:', saveError);
      throw saveError;
    }
    
    // Notify user
    await this.notify(
      `✅ Task created: *${task.title}*\n` +
      `Priority: ${this.getPriorityEmoji(task.priority)} ${this.getPriorityLabel(task.priority)}\n` +
      (task.dueDate ? `Due: ${task.dueDate.toLocaleDateString()}\n` : '') +
      (task.reminder?.enabled ? `🔔 Reminder set for ${task.reminder.time.toLocaleString()}` : ''),
      { parse_mode: 'Markdown' }
    );
    
    return {
      success: true,
      task: this.formatTask(task)
    };
  }

  async listTasks(data) {
    // Get agent name from config
    const agentName = this.agent.config?.name || process.env.AGENT_NAME || 'LANAgent';
    logger.info('Listing tasks for agentId:', agentName);
    const filter = { agentId: agentName };
    
    // Add filters
    if (data.status) filter.status = data.status;
    if (data.priority) filter.priority = data.priority;
    if (data.category) filter.category = data.category;
    if (data.completed !== undefined) filter.completed = data.completed;
    
    // Handle overdue filter
    if (data.overdue) {
      filter.dueDate = { $lt: new Date() };
      filter.completed = false;
    }
    
    // Handle today filter
    if (data.today) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      filter.dueDate = { $gte: today, $lt: tomorrow };
    }
    
    const tasks = await Task.find(filter)
      .sort({ 
        completed: 1, 
        priority: -1, 
        dueDate: 1, 
        createdAt: -1 
      })
      .limit(data.limit || 50);
    
    return {
      success: true,
      count: tasks.length,
      tasks: tasks.map(task => this.formatTask(task))
    };
  }

  async getTask(data) {
    this.validateParams(data, {
      taskId: { required: true, type: 'string' }
    });
    
    const task = await Task.findById(data.taskId);
    if (!task) {
      throw new Error('Task not found');
    }
    
    return {
      success: true,
      task: this.formatTask(task, true) // Include full details
    };
  }

  async updateTask(data) {
    this.validateParams(data, {
      taskId: { required: true, type: 'string' }
    });
    
    const task = await Task.findById(data.taskId);
    if (!task) {
      throw new Error('Task not found');
    }
    
    // Update allowed fields
    const updateFields = ['title', 'description', 'category', 'tags'];
    updateFields.forEach(field => {
      if (data[field] !== undefined) {
        task[field] = data[field];
      }
    });
    
    // Update priority - need to convert string to number
    if (data.priority !== undefined) {
      if (typeof data.priority === 'string') {
        task.priority = this.priorityMap[data.priority] || 5;
      } else {
        task.priority = data.priority;
      }
    }
    
    // Update dates
    if (data.dueDate !== undefined) {
      task.dueDate = data.dueDate ? this.parseDateString(data.dueDate) : null;
    }
    
    // Update reminder
    if (data.reminder !== undefined) {
      if (data.reminder === null) {
        task.reminder.enabled = false;
      } else {
        task.reminder = {
          enabled: true,
          time: this.parseDateString(data.reminder),
          sent: false
        };
      }
    }
    
    // No metadata field in Task model, using built-in timestamps
    await task.save();
    
    return {
      success: true,
      task: this.formatTask(task)
    };
  }

  async deleteTask(data) {
    this.validateParams(data, {
      taskId: { required: true, type: 'string' }
    });
    
    const task = await Task.findByIdAndDelete(data.taskId);
    if (!task) {
      throw new Error('Task not found');
    }
    
    await this.notify(`🗑️ Task deleted: ${task.title}`);
    
    return {
      success: true,
      message: 'Task deleted successfully'
    };
  }

  async completeTask(data) {
    this.validateParams(data, {
      taskId: { required: true, type: 'string' }
    });
    
    const task = await Task.findById(data.taskId);
    if (!task) {
      throw new Error('Task not found');
    }
    
    task.completed = true;
    task.completedAt = new Date();
    task.status = 'completed';
    
    // Handle recurring tasks
    if (task.recurring?.enabled) {
      // Create next occurrence
      const nextTask = new Task({
        agentId: task.agentId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        category: task.category,
        tags: task.tags,
        dueDate: task.recurring.nextOccurrence,
        recurring: {
          ...task.recurring,
          nextOccurrence: this.calculateNextOccurrence(
            task.recurring.nextOccurrence, 
            task.recurring
          )
        },
        metadata: {
          ...task.metadata,
          previousTaskId: task._id
        }
      });
      
      await nextTask.save();
      task.metadata.nextTaskId = nextTask._id;
    }
    
    await task.save();
    
    await this.notify(
      `✅ Task completed: *${task.title}*\n` +
      (task.recurring?.enabled ? `🔄 Next occurrence created for ${task.recurring.nextOccurrence.toLocaleDateString()}` : ''),
      { parse_mode: 'Markdown' }
    );
    
    return {
      success: true,
      task: this.formatTask(task)
    };
  }

  async searchTasks(data) {
    this.validateParams(data, {
      query: { required: true, type: 'string' }
    });
    
    const tasks = await Task.find({
      agentId: this.agent.config?.name || process.env.AGENT_NAME || 'LANAgent',
      $or: [
        { title: { $regex: data.query, $options: 'i' } },
        { description: { $regex: data.query, $options: 'i' } },
        { tags: { $in: [data.query] } }
      ]
    }).limit(20);
    
    return {
      success: true,
      count: tasks.length,
      tasks: tasks.map(task => this.formatTask(task))
    };
  }

  // Background task processor for reminders
  startTaskProcessor() {
    setInterval(async () => {
      try {
        // Check for due reminders
        const tasksWithReminders = await Task.find({
          agentId: this.agent.config?.name || process.env.AGENT_NAME || 'LANAgent',
          'reminder.enabled': true,
          'reminder.sent': false,
          'reminder.time': { $lte: new Date() },
          completed: false
        });
        
        for (const task of tasksWithReminders) {
          await this.notify(
            `🔔 *Reminder*: ${task.title}\n` +
            `Priority: ${this.getPriorityEmoji(task.priority)} ${this.getPriorityLabel(task.priority)}\n` +
            (task.dueDate ? `Due: ${task.dueDate.toLocaleDateString()}` : ''),
            { parse_mode: 'Markdown' }
          );
          
          task.reminder.sent = true;
          await task.save();
        }
        
        // Check for overdue tasks
        const overdueTasks = await Task.find({
          agentId: this.agent.config?.name || process.env.AGENT_NAME || 'LANAgent',
          dueDate: { $lt: new Date() },
          completed: false,
          'metadata.overdueNotified': { $ne: true }
        });
        
        if (overdueTasks.length > 0) {
          const taskList = overdueTasks.map(t => 
            `• ${t.title} (${this.formatDateRelative(t.dueDate)})`
          ).join('\n');
          
          await this.notify(
            `⚠️ *You have ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''}:*\n\n${taskList}`,
            { parse_mode: 'Markdown' }
          );
          
          // Mark as notified
          for (const task of overdueTasks) {
            task.metadata.overdueNotified = true;
            await task.save();
          }
        }
      } catch (error) {
        this.logger.error('Task processor error:', error);
      }
    }, 60000); // Check every minute
  }

  // Helper methods
  formatTask(task, detailed = false) {
    const formatted = {
      id: task._id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      priorityEmoji: this.getPriorityEmoji(task.priority),
      status: task.status,
      completed: task.completed,
      completedAt: task.completedAt,
      category: task.category,
      tags: task.tags,
      dueDate: task.dueDate,
      dueDateFormatted: task.dueDate ? this.formatDateRelative(task.dueDate) : null,
      recurring: task.recurring?.enabled ? {
        pattern: task.recurring.pattern,
        interval: task.recurring.interval
      } : null,
      createdAt: task.createdAt
    };
    
    if (detailed) {
      formatted.reminder = task.reminder;
      formatted.metadata = task.metadata;
      formatted.dependencies = task.dependencies;
      formatted.attachments = task.attachments;
    }
    
    return formatted;
  }

  getPriorityEmoji(priority) {
    // Handle numeric priorities
    if (typeof priority === 'number') {
      if (priority <= 3) return '🟢'; // low
      if (priority <= 5) return '🟡'; // medium
      if (priority <= 7) return '🟠'; // high
      return '🔴'; // urgent
    }
    
    // Handle string priorities (legacy)
    const emojis = {
      low: '🟢',
      medium: '🟡',
      high: '🟠',
      urgent: '🔴'
    };
    return emojis[priority] || '⚪';
  }

  async processNextTask() {
    try {
      logger.info('ProcessNextTask called');
      
      // First, check for recurring tasks that need to be rescheduled
      const recurringTasks = await Task.findRecurringTasksDue();
      for (const task of recurringTasks) {
        try {
          // Clone the task for the next execution
          const newTask = new Task({
            agentId: task.agentId,
            title: task.title,
            description: task.description,
            type: task.type,
            category: task.category,
            status: 'pending',
            completed: false,
            priority: task.priority,
            command: task.command,
            script: task.script,
            arguments: task.arguments,
            environment: task.environment,
            recurring: task.recurring,
            createdBy: task.createdBy,
            tags: task.tags
          });
          
          // Calculate and set next run time
          const nextRun = task.calculateNextRun();
          if (nextRun) {
            task.recurring.lastRun = new Date();
            task.recurring.nextRun = nextRun;
            await task.save();
            await newTask.save();
            
            logger.info(`Scheduled recurring task "${task.title}" for next run at ${nextRun}`);
          }
        } catch (error) {
          logger.error(`Failed to reschedule recurring task ${task._id}:`, error);
        }
      }
      
      // Get the oldest uncompleted task with highest priority
      const agentName = this.agent.config?.name || process.env.AGENT_NAME || 'LANAgent';
      logger.info(`Looking for tasks with agentId: ${agentName}`);
      const task = await Task.findOne({
        agentId: agentName,
        completed: false,
        status: 'pending'
      }).sort({
        priority: -1,  // Higher priority first
        createdAt: 1   // Older tasks first
      });

      if (!task) {
        return {
          success: true,
          message: 'No pending tasks to process'
        };
      }

      // Mark task as running
      task.status = 'running';
      await task.save();

      // Notify via Telegram that we're starting
      await this.notify(`🔄 Processing task: *${task.title}*\nPriority: ${this.getPriorityEmoji(task.priority)} ${this.getPriorityLabel(task.priority)}`);

      try {
        // For simple notification tasks, handle them directly
        const lowerTitle = task.title.toLowerCase();
        if (lowerTitle.includes('tell me') || lowerTitle.includes('say') || lowerTitle.includes('message me')) {
          // Extract the message to send
          const messageMatch = task.title.match(/(?:tell me|say|message me)\s+(.+?)(?:\s+via\s+telegram)?$/i);
          if (messageMatch) {
            const message = messageMatch[1];
            await this.notify(`📬 Message from task: ${message}`);
            
            // Mark task as completed
            task.completed = true;
            task.completedAt = new Date();
            task.status = 'completed';
            await task.save();

            // Notify success
            await this.notify(
              `✅ Task completed successfully!\n\n` +
              `*Task:* ${task.title}\n` +
              `*Result:* Message sent`
            );
            
            return {
              success: true,
              task: this.formatTask(task),
              result: { response: 'Message sent via Telegram' }
            };
          }
        }
        
        // For other tasks, try to detect intent and execute
        if (this.agent.aiIntentDetector) {
          logger.info(`Detecting intent for task: ${task.title}`);
          const intent = await this.agent.aiIntentDetector.detect(task.title);
          logger.info('Detected intent:', { 
            plugin: intent.plugin, 
            action: intent.action, 
            parameters: intent.parameters 
          });
          
          if (intent.plugin && intent.action) {
            // Prevent infinite loop: don't process tasks that would create more tasks
            const taskCreationActions = ['create', 'add', 'addTodo', 'createTask'];
            if (intent.plugin === 'tasks' && taskCreationActions.includes(intent.action)) {
              logger.info(`Skipping task "${task.title}" - would create another task (infinite loop prevention)`);
              task.status = 'pending'; // Keep as pending, don't auto-process
              task.notes = (task.notes || '') + '\nSkipped auto-processing: task title matches task creation intent';
              await task.save();
              return {
                success: true,
                message: `Task "${task.title}" skipped - appears to be a task creation command, not an executable task`,
                task: this.formatTask(task)
              };
            }

            const plugin = this.agent.apiManager.getPlugin(intent.plugin);
            if (plugin) {
              // Prepare parameters - ensure we don't duplicate action
              const executeParams = { ...intent.parameters };
              if (!executeParams.action) {
                executeParams.action = intent.action;
              }
              logger.info('Executing plugin with params:', executeParams);
              const result = await plugin.execute(executeParams);
              
              // Mark task as completed
              task.completed = true;
              task.completedAt = new Date();
              task.status = 'completed';
              await task.save();

              // Handle different result types
              if (result.pdf && result.format === 'buffer') {
                // PDF result - send as document
                const telegramInterface = this.agent.interfaces.get('telegram');
                if (telegramInterface && telegramInterface.bot) {
                  const fs = await import('fs').then(m => m.promises);
                  const path = await import('path');
                  const tmpDir = '/tmp';
                  const filename = result.filename || `document_${Date.now()}.pdf`;
                  const filePath = path.join(tmpDir, filename);
                  
                  // Write buffer to temporary file
                  await fs.writeFile(filePath, result.pdf);
                  
                  // Send document via Telegram
                  const userId = process.env.TELEGRAM_USER_ID;
                  await telegramInterface.bot.telegram.sendDocument(
                    userId,
                    { source: filePath },
                    { caption: `📄 PDF generated from: ${result.url}` }
                  );
                  
                  // Clean up temp file
                  setTimeout(() => fs.unlink(filePath).catch(() => {}), 5000);
                  
                  await this.notify(`✅ Task completed! PDF sent successfully.`);
                }
              } else {
                // Regular text result
                await this.notify(
                  `✅ Task completed successfully!\n\n` +
                  `*Task:* ${task.title}\n` +
                  `*Result:* ${JSON.stringify(result.response || result.message || 'Task executed')}`
                );
              }
              
              return {
                success: true,
                task: this.formatTask(task),
                result: result
              };
            }
          }
        }
        
        // Fallback to natural language processing with context
        const context = {
          userId: 'task-processor',
          source: 'scheduled-task',
          interface: 'system'
        };
        const result = await this.agent.processNaturalLanguage(task.title, context);
        
        // Mark task as completed
        task.completed = true;
        task.completedAt = new Date();
        task.status = 'completed';
        await task.save();

        // Notify success
        await this.notify(
          `✅ Task completed successfully!\n\n` +
          `*Task:* ${task.title}\n` +
          `*Result:* ${result.content || result.response || 'Task executed'}`
        );

        return {
          success: true,
          task: this.formatTask(task),
          result: result
        };
      } catch (error) {
        // Mark task as failed
        task.status = 'failed';
        // Ensure metadata exists before setting error
        if (!task.metadata) {
          task.metadata = {};
        }
        task.metadata.error = error.message;
        await task.save();

        // Notify failure
        await this.notify(
          `❌ Task failed!\n\n` +
          `*Task:* ${task.title}\n` +
          `*Error:* ${error.message}`
        );

        return {
          success: false,
          task: this.formatTask(task),
          error: error.message
        };
      }
    } catch (error) {
      logger.error('Error processing task:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  getPriorityLabel(priority) {
    // Convert numeric priority to label
    if (typeof priority === 'number') {
      if (priority <= 3) return 'low';
      if (priority <= 5) return 'medium';
      if (priority <= 7) return 'high';
      return 'urgent';
    }
    return priority || 'medium';
  }

  parseDateString(dateStr) {
    // Handle relative dates
    const now = new Date();
    const lower = dateStr.toLowerCase();
    
    if (lower === 'today') {
      return new Date(now.setHours(23, 59, 59, 999));
    } else if (lower === 'tomorrow') {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(23, 59, 59, 999);
      return tomorrow;
    } else if (lower.includes('next week')) {
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + 7);
      return nextWeek;
    } else if (lower.includes('next month')) {
      const nextMonth = new Date(now);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      return nextMonth;
    }
    
    // Try parsing as date
    const parsed = new Date(dateStr);
    if (!isNaN(parsed)) {
      return parsed;
    }
    
    throw new Error(`Invalid date format: ${dateStr}`);
  }

  formatDateRelative(date) {
    const now = new Date();
    const diff = date - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    if (days > 0 && days <= 7) return `In ${days} days`;
    if (days < 0) return `${Math.abs(days)} days overdue`;
    
    return date.toLocaleDateString();
  }

  calculateNextOccurrence(currentDate, recurring) {
    const next = new Date(currentDate);
    
    switch (recurring.pattern) {
      case 'daily':
        next.setDate(next.getDate() + recurring.interval);
        break;
      case 'weekly':
        next.setDate(next.getDate() + (7 * recurring.interval));
        break;
      case 'monthly':
        next.setMonth(next.getMonth() + recurring.interval);
        break;
      case 'yearly':
        next.setFullYear(next.getFullYear() + recurring.interval);
        break;
    }
    
    // Check if we've passed the end date
    if (recurring.endDate && next > recurring.endDate) {
      return null;
    }
    
    return next;
  }

  // Public methods for direct access
  async createTaskDirect(title, options = {}) {
    return await this.createTask({ title, ...options });
  }

  async getTasksDirect(filter = {}) {
    return await this.listTasks(filter);
  }

  async completeTaskDirect(taskId) {
    return await this.completeTask({ taskId });
  }
}