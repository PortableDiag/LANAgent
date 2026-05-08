import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import NodeCache from 'node-cache';

const CHECKLY_POLL_JOB = 'checkly-scheduled-poll';

export default class ChecklyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'checkly';
    this.version = '1.0.0';
    this.description = 'Browser and API monitoring service with a free tier';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'CHECKLY_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'get_checks',
        description: 'Retrieve all checks from Checkly',
        usage: 'get_checks()',
        examples: [
          'retrieve all checks',
          'get a list of checks',
          'fetch all monitoring checks'
        ]
      },
      {
        command: 'get_check_details',
        description: 'Retrieve details of a specific check by ID',
        usage: 'get_check_details({ checkId: "12345" })',
        examples: [
          'get details of check ID 12345',
          'fetch information for check 67890',
          'retrieve check details by ID'
        ]
      },
      {
        command: 'create_check',
        description: 'Create a new check in Checkly',
        usage: 'create_check({ name: "New Check", type: "API", ... })',
        examples: [
          'create a new API check',
          'add a browser check with specific settings'
        ]
      },
      {
        command: 'delete_check',
        description: 'Delete a check by ID in Checkly',
        usage: 'delete_check({ checkId: "12345" })',
        examples: [
          'delete check with ID 12345',
          'remove a specific monitoring check'
        ]
      },
      {
        command: 'schedule_check',
        description: 'Poll a Checkly check at a recurring interval (Agenda-backed; persists across restarts)',
        usage: 'schedule_check({ checkId: "12345", interval: "5 minutes" })',
        examples: [
          'poll check 12345 every 5 minutes',
          'monitor check 67890 hourly'
        ]
      },
      {
        command: 'list_scheduled_checks',
        description: 'List active recurring polls',
        usage: 'list_scheduled_checks()',
        examples: [
          'show scheduled checks',
          'list checkly polls'
        ]
      },
      {
        command: 'cancel_scheduled_check',
        description: 'Cancel a recurring poll for a Checkly check',
        usage: 'cancel_scheduled_check({ checkId: "12345" })',
        examples: [
          'stop polling check 12345',
          'cancel scheduled check 67890'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'https://api.checklyhq.com/v1',
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    this.scheduler = null;
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.apiKey = credentials.apiKey;
      this.logger.info('Loaded API credentials');

      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      if (!this.config.apiKey) {
        this.logger.warn('API key not configured - plugin will have limited functionality');
      }

      const { apiKey, ...configToCache } = this.config;
      await PluginSettings.setCached(this.name, 'config', configToCache);

      // Wire up the recurring-poll Agenda job. Checks are persisted in the
      // shared scheduled_jobs collection so they survive agent restarts.
      this.scheduler = this.agent?.services?.get('taskScheduler');
      if (this.scheduler?.agenda) {
        this.scheduler.agenda.define(CHECKLY_POLL_JOB, async (job) => {
          const { checkId } = job.attrs.data || {};
          if (!checkId) return;
          this.logger.info(`[checkly] polling scheduled check ${checkId}`);
          // Bypass cache — we want a fresh read on every scheduled poll
          this.cache.del(`check_${checkId}`);
          const result = await this.getCheckDetails(checkId);
          if (!result?.success) {
            throw new Error(result?.error || `Poll for check ${checkId} failed`);
          }
        });
      } else {
        this.logger.warn('[checkly] taskScheduler unavailable; schedule_check disabled');
      }

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      throw error;
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });

    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }

    try {
      switch (action) {
        case 'get_checks':
          return await this.getChecks();
        case 'get_check_details':
          this.validateParams(data, {
            checkId: { required: true, type: 'string' }
          });
          return await this.getCheckDetails(data.checkId);
        case 'create_check':
          this.validateParams(data, {
            name: { required: true, type: 'string' },
            type: { required: true, type: 'string' }
          });
          return await this.createCheck(data);
        case 'delete_check':
          this.validateParams(data, {
            checkId: { required: true, type: 'string' }
          });
          return await this.deleteCheck(data.checkId);
        case 'schedule_check':
          this.validateParams(data, {
            checkId: { required: true, type: 'string' },
            interval: { required: true, type: 'string' }
          });
          return await this.scheduleCheck(data.checkId, data.interval);
        case 'list_scheduled_checks':
          return await this.listScheduledChecks();
        case 'cancel_scheduled_check':
          this.validateParams(data, {
            checkId: { required: true, type: 'string' }
          });
          return await this.cancelScheduledCheck(data.checkId);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async extractParameters(input, action) {
    const prompt = `Extract parameters from: "${input}"
    For ${this.name} plugin action: ${action}

    Return JSON with appropriate parameters based on the action.`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    const parsed = safeJsonParse(response.content, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      this.logger.warn('Failed to parse AI parameters from response');
    }
    return parsed;
  }

  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }

  async getChecks() {
    try {
      const cachedChecks = this.cache.get('checks');
      if (cachedChecks) {
        return { success: true, data: cachedChecks };
      }

      const response = await retryOperation(() => axios.get(`${this.config.baseUrl}/checks`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`
        }
      }), { retries: 3, context: 'Checkly getChecks' });

      this.cache.set('checks', response.data);
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      this.logger.error('get_checks failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getCheckDetails(checkId) {
    try {
      const cacheKey = `check_${checkId}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return { success: true, data: cached };
      }

      const response = await retryOperation(() => axios.get(`${this.config.baseUrl}/checks/${checkId}`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`
        }
      }), { retries: 3, context: 'Checkly getCheckDetails' });

      this.cache.set(cacheKey, response.data);
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      this.logger.error('get_check_details failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async createCheck(data) {
    try {
      const response = await retryOperation(() => axios.post(`${this.config.baseUrl}/checks`, data, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'Checkly createCheck' });

      this.cache.del('checks');

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      this.logger.error('create_check failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async deleteCheck(checkId) {
    try {
      await retryOperation(() => axios.delete(`${this.config.baseUrl}/checks/${checkId}`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`
        }
      }), { retries: 3, context: 'Checkly deleteCheck' });

      this.cache.del('checks');
      this.cache.del(`check_${checkId}`);

      return {
        success: true,
        message: `Check ${checkId} deleted successfully`
      };
    } catch (error) {
      this.logger.error('delete_check failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Schedule a recurring poll for a Checkly check. Uses Agenda's `every()` so
   * the schedule is persisted in MongoDB (survives restarts) and Agenda's
   * existing concurrency / lock semantics apply. Re-scheduling the same
   * checkId replaces the prior schedule (cancel + re-create).
   */
  async scheduleCheck(checkId, interval) {
    if (!this.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }
    // Replace any existing schedule for this checkId so we don't run two pollers.
    await this.scheduler.agenda.cancel({ name: CHECKLY_POLL_JOB, 'data.checkId': checkId });
    const job = await this.scheduler.agenda.every(interval, CHECKLY_POLL_JOB, { checkId });
    this.logger.info(`[checkly] scheduled poll for check ${checkId} every ${interval} (job ${job.attrs._id})`);
    return {
      success: true,
      data: {
        jobId: String(job.attrs._id),
        checkId,
        interval,
        nextRunAt: job.attrs.nextRunAt ? new Date(job.attrs.nextRunAt).toISOString() : null
      },
      message: `Polling check ${checkId} every ${interval}`
    };
  }

  async listScheduledChecks() {
    if (!this.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }
    const jobs = await this.scheduler.agenda.jobs(
      { name: CHECKLY_POLL_JOB },
      { nextRunAt: 1 }
    );
    return {
      success: true,
      data: jobs.map(j => ({
        jobId: String(j.attrs._id),
        checkId: j.attrs.data?.checkId,
        interval: j.attrs.repeatInterval,
        nextRunAt: j.attrs.nextRunAt ? new Date(j.attrs.nextRunAt).toISOString() : null,
        lastRunAt: j.attrs.lastRunAt ? new Date(j.attrs.lastRunAt).toISOString() : null,
        failCount: j.attrs.failCount || 0,
        failReason: j.attrs.failReason
      })),
      count: jobs.length
    };
  }

  async cancelScheduledCheck(checkId) {
    if (!this.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }
    const cancelled = await this.scheduler.agenda.cancel({ name: CHECKLY_POLL_JOB, 'data.checkId': checkId });
    if (!cancelled) {
      return { success: false, error: `No scheduled poll found for check ${checkId}` };
    }
    this.logger.info(`[checkly] cancelled scheduled poll for check ${checkId}`);
    return { success: true, message: `Cancelled scheduled poll for check ${checkId}` };
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.cache.flushAll();
    await PluginSettings.clearCache(this.name);
    this.initialized = false;
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}