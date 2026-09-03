import { BasePlugin } from '../core/basePlugin.js';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import cronParser from 'cron-parser';

export default class SchedulerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'scheduler';
    this.version = '1.0.0';
    this.description = 'Task scheduler with cron expression support';
    this.commands = [
      {
        command: 'parseCron',
        description: 'Parse and explain a cron expression',
        usage: 'parseCron [expression]'
      },
      {
        command: 'nextRun',
        description: 'Get next scheduled run time for a cron expression',
        usage: 'nextRun [expression]'
      },
      {
        command: 'listScheduledTasks',
        description: 'List all scheduled tasks',
        usage: 'listScheduledTasks'
      },
      {
        command: 'cancelTask',
        description: 'Cancel a scheduled task',
        usage: 'cancelTask [taskId]'
      }
    ];
    this.cache = new NodeCache({ stdTTL: 1800 });
  }

  async execute(params) {
    const { action, expression, taskId } = params;

    try {
      switch (action) {
        case 'parseCron':
          return await this.parseCronExpression(expression);

        case 'nextRun':
          return await this.getNextRunTime(expression);

        case 'listScheduledTasks':
          return await this.listScheduledTasks();

        case 'cancelTask':
          return await this.cancelTask(taskId);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Supported actions: parseCron, nextRun, listScheduledTasks, cancelTask' 
          };
      }
    } catch (error) {
      this.logger.error(`Scheduler plugin error in ${action}:`, error.message);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  async parseCronExpression(expression) {
    if (!expression) {
      throw new Error('Cron expression is required');
    }

    const cacheKey = `cron_parse_${expression}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const interval = cronParser.parseExpression(expression);
      const result = {
        success: true,
        expression,
        description: this.describeCron(expression),
        nextRuns: []
      };

      for (let i = 0; i < 5; i++) {
        result.nextRuns.push(interval.next().toISOString());
      }

      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      throw new Error(`Invalid cron expression: ${err.message}`);
    }
  }

  async getNextRunTime(expression) {
    if (!expression) {
      throw new Error('Cron expression is required');
    }

    const cacheKey = `cron_next_${expression}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const interval = cronParser.parseExpression(expression);
      const nextRun = interval.next().toISOString();
      const result = {
        success: true,
        expression,
        nextRun
      };

      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      throw new Error(`Invalid cron expression: ${err.message}`);
    }
  }

  /**
   * List jobs Agenda is actually holding.
   *
   * Reads the agent's own scheduler rather than constructing a second one. The
   * submitted version did `new TaskScheduler()` in the plugin constructor, which
   * builds a fresh, uninitialised copy — `initialize(agent)` is what connects
   * Agenda and defines the jobs, so that instance had no database and no job
   * definitions behind it. `this.agent.scheduler.agenda` is the established
   * accessor, already used by the email and sinch plugins.
   */
  async listScheduledTasks() {
    const agenda = this.agent?.scheduler?.agenda;
    if (!agenda) {
      return { success: false, error: 'Scheduler is not initialised yet' };
    }

    const jobs = await agenda.jobs({});
    const tasks = jobs.map(job => {
      const a = job.attrs || {};
      return {
        id: a._id?.toString(),
        name: a.name,
        // A repeatInterval is what marks a job as one of the system's standing
        // jobs rather than a one-off someone queued.
        recurring: Boolean(a.repeatInterval),
        repeatInterval: a.repeatInterval || null,
        nextRunAt: a.nextRunAt || null,
        lastRunAt: a.lastRunAt || null,
        lastFinishedAt: a.lastFinishedAt || null,
        failCount: a.failCount || 0,
        failReason: a.failReason || null
      };
    });

    return {
      success: true,
      count: tasks.length,
      recurring: tasks.filter(t => t.recurring).length,
      tasks
    };
  }

  /**
   * Cancel a one-off scheduled job.
   *
   * Recurring jobs are refused on purpose. Agenda holds this agent's standing
   * work here — the crypto heartbeat, health checks, email polling, cleanup —
   * and cancelling one does not raise an error anywhere; the job simply stops
   * running and the capability behind it goes quiet. Silent loss of a scheduled
   * job is exactly the kind of failure that gets noticed days later, so a
   * caller has to go through the scheduler service deliberately to stop one.
   */
  async cancelTask(taskId) {
    if (!taskId) {
      throw new Error('Task ID is required');
    }

    const agenda = this.agent?.scheduler?.agenda;
    if (!agenda) {
      return { success: false, error: 'Scheduler is not initialised yet' };
    }

    let objectId;
    try {
      const { ObjectId } = await import('mongodb');
      objectId = new ObjectId(String(taskId));
    } catch {
      return { success: false, error: `'${taskId}' is not a valid task id` };
    }

    const [job] = await agenda.jobs({ _id: objectId });
    if (!job) {
      return { success: false, error: `No scheduled task with id ${taskId}` };
    }

    if (job.attrs?.repeatInterval) {
      return {
        success: false,
        error: `'${job.attrs.name}' is a recurring system job (${job.attrs.repeatInterval}) and will not be cancelled here. ` +
               'Cancelling it would stop that capability silently.'
      };
    }

    const numRemoved = await agenda.cancel({ _id: objectId });
    return {
      success: numRemoved > 0,
      removed: numRemoved,
      message: numRemoved > 0
        ? `Cancelled '${job.attrs.name}' (${taskId})`
        : `Task ${taskId} was already gone`
    };
  }

  describeCron(expression) {
    const parts = expression.split(' ');
    if (parts.length !== 5) return 'Custom cron expression';
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    let desc = 'Runs ';
    
    if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      return 'Runs every minute';
    }
    
    if (minute !== '*') {
      desc += minute === '0' ? 'at the start of ' : `at ${minute} minute(s) past `;
    } else {
      desc += 'every minute ';
    }
    
    if (hour !== '*') {
      desc += `of ${hour === '0' ? 'midnight' : `${hour} o'clock`} `;
    } else {
      desc += 'of every hour ';
    }
    
    if (dayOfMonth !== '*' && dayOfWeek !== '*') {
      desc += `on day ${dayOfMonth} and ${this.getDayOfWeekName(dayOfWeek)} `;
    } else if (dayOfMonth !== '*') {
      desc += `on day ${dayOfMonth} `;
    } else if (dayOfWeek !== '*') {
      desc += `on ${this.getDayOfWeekName(dayOfWeek)} `;
    } else {
      desc += 'daily ';
    }
    
    if (month !== '*') {
      const monthNames = ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'];
      desc += `in ${monthNames[parseInt(month)-1] || month} `;
    }
    
    return desc.trim();
  }

  getDayOfWeekName(day) {
    const days = {
      '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday',
      '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday'
    };
    return days[day] || `day ${day}`;
  }
}
