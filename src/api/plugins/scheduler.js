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
      }
    ];
    this.cache = new NodeCache({ stdTTL: 1800 });
  }

  async execute(params) {
    const { action, expression } = params;

    try {
      switch (action) {
        case 'parseCron':
          return await this.parseCronExpression(expression);

        case 'nextRun':
          return await this.getNextRunTime(expression);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Supported actions: parseCron, nextRun' 
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
