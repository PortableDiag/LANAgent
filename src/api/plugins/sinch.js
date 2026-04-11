import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { retryOperation } from '../../utils/retryUtils.js';

export default class SinchPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'sinch';
    this.version = '1.0.0';
    this.description = 'APIs for SMS, voice, video, and verification';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'SINCH_API_KEY', required: true },
      { key: 'apiSecret', label: 'API Secret', envVar: 'SINCH_API_SECRET', required: true }
    ];

    this.commands = [
      {
        command: 'send_sms',
        description: 'Send an SMS message to a specified phone number',
        usage: 'send_sms({ to: "+1234567890", message: "Hello from Sinch!" })',
        examples: [
          'send an SMS to +1234567890 saying "Hello from Sinch!"',
          'text +9876543210 with "This is a test message"',
          'send a message to +1123456789 with "Hi there!"'
        ]
      },
      {
        command: 'make_voice_call',
        description: 'Make a voice call to a specified phone number',
        usage: 'make_voice_call({ to: "+1234567890", from: "YourSinchNumber" })',
        examples: [
          'call +1234567890 from my Sinch number',
          'initiate a voice call to +9876543210',
          'dial +1123456789 from my registered number'
        ]
      },
      {
        command: 'verify_number',
        description: 'Verify a phone number using Sinch verification service',
        usage: 'verify_number({ phoneNumber: "+1234567890" })',
        examples: [
          'verify the number +1234567890',
          'check if +9876543210 is valid',
          'confirm the phone number +1123456789'
        ]
      },
      {
        command: 'schedule_sms',
        description: 'Schedule an SMS message to be sent at a future time',
        usage: 'schedule_sms({ to: "+1234567890", message: "Hello!", scheduleTime: "2025-01-20T10:00:00Z" })',
        examples: [
          'schedule an SMS to +1234567890 saying "Hello!" at 10 AM tomorrow',
          'schedule a text to +9876543210 with "Reminder" in 2 hours'
        ]
      },
      {
        command: 'schedule_voice_call',
        description: 'Schedule a voice call to be made at a future time',
        usage: 'schedule_voice_call({ to: "+1234567890", from: "YourSinchNumber", scheduleTime: "2025-01-20T10:00:00Z" })',
        examples: [
          'schedule a call to +1234567890 at 10 AM tomorrow',
          'schedule a voice call to +9876543210 in 30 minutes'
        ]
      },
      {
        command: 'list_scheduled',
        description: 'List all scheduled SMS messages and voice calls',
        usage: 'list_scheduled()',
        examples: [
          'show my scheduled messages',
          'list pending sinch calls'
        ]
      },
      {
        command: 'cancel_scheduled',
        description: 'Cancel a scheduled SMS or voice call by job ID',
        usage: 'cancel_scheduled({ jobId: "abc123" })',
        examples: [
          'cancel scheduled message abc123',
          'remove the pending call with id xyz789'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      apiSecret: null,
      baseUrl: 'https://api.sinch.com/',
    };

    this.initialized = false;
    this.cache = new Map();
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.apiKey = credentials.apiKey;
      this.config.apiSecret = credentials.apiSecret;
      this.logger.info('Loaded API credentials');

      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        Object.assign(this.config, savedConfig);
        this.logger.info('Loaded cached configuration');
      }

      if (!this.config.apiKey || !this.config.apiSecret) {
        this.logger.warn('API credentials not fully configured - plugin will have limited functionality');
      }

      await PluginSettings.setCached(this.name, 'config', this.config);

      // Define Agenda jobs for scheduled SMS and voice calls
      await this.defineSchedulerJobs();

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      throw error;
    }
  }

  async defineSchedulerJobs() {
    if (!this.agent.scheduler?.agenda) {
      this.logger.warn('Scheduler not available, scheduled SMS/calls will not work');
      return;
    }

    // Define job for scheduled SMS
    this.agent.scheduler.agenda.define('sinch-scheduled-sms', async (job) => {
      const { to, message } = job.attrs.data;
      this.logger.info(`Executing scheduled SMS to ${to}`);
      try {
        await this.sendSms({ to, message });
        this.logger.info(`Scheduled SMS to ${to} sent successfully`);
      } catch (error) {
        this.logger.error(`Scheduled SMS to ${to} failed:`, error);
        throw error;
      }
    });

    // Define job for scheduled voice calls
    this.agent.scheduler.agenda.define('sinch-scheduled-call', async (job) => {
      const { to, from } = job.attrs.data;
      this.logger.info(`Executing scheduled voice call to ${to}`);
      try {
        await this.makeVoiceCall({ to, from });
        this.logger.info(`Scheduled call to ${to} completed successfully`);
      } catch (error) {
        this.logger.error(`Scheduled call to ${to} failed:`, error);
        throw error;
      }
    });

    this.logger.info('Sinch scheduler jobs defined');
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
        case 'send_sms':
          return await this.sendSms(data);
        case 'make_voice_call':
          return await this.makeVoiceCall(data);
        case 'verify_number':
          return await this.verifyNumber(data);
        case 'schedule_sms':
          return await this.scheduleSms(data);
        case 'schedule_voice_call':
          return await this.scheduleVoiceCall(data);
        case 'list_scheduled':
          return await this.listScheduled();
        case 'cancel_scheduled':
          return await this.cancelScheduled(data);
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

  async sendSms({ to, message }) {
    this.validateParams({ to, message }, {
      to: { required: true, type: 'string' },
      message: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}sms/v1/sms`;

    try {
      const response = await retryOperation(() => axios.post(url, {
        to,
        from: 'YourSinchNumber',
        body: message
      }, {
        auth: {
          username: this.config.apiKey,
          password: this.config.apiSecret
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'send_sms' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('send_sms failed:', error);
      return { success: false, error: error.message };
    }
  }

  async makeVoiceCall({ to, from }) {
    this.validateParams({ to, from }, {
      to: { required: true, type: 'string' },
      from: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}calling/v1/callouts`;

    try {
      const response = await retryOperation(() => axios.post(url, {
        to,
        from
      }, {
        auth: {
          username: this.config.apiKey,
          password: this.config.apiSecret
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'make_voice_call' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('make_voice_call failed:', error);
      return { success: false, error: error.message };
    }
  }

  async verifyNumber({ phoneNumber }) {
    this.validateParams({ phoneNumber }, {
      phoneNumber: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}verification/v1/verifications`;

    try {
      const response = await retryOperation(() => axios.post(url, {
        identity: { type: 'number', endpoint: phoneNumber }
      }, {
        auth: {
          username: this.config.apiKey,
          password: this.config.apiSecret
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'verify_number' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('verify_number failed:', error);
      return { success: false, error: error.message };
    }
  }

  async scheduleSms({ to, message, scheduleTime }) {
    this.validateParams({ to, message, scheduleTime }, {
      to: { required: true, type: 'string' },
      message: { required: true, type: 'string' },
      scheduleTime: { required: true, type: 'string' }
    });

    if (!this.agent.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }

    try {
      const sendTime = new Date(scheduleTime);
      if (sendTime <= new Date()) {
        return { success: false, error: 'Schedule time must be in the future' };
      }

      const job = await this.agent.scheduler.agenda.schedule(sendTime, 'sinch-scheduled-sms', {
        to,
        message,
        scheduledBy: 'sinch-plugin'
      });

      this.logger.info(`Scheduled SMS to ${to} at ${sendTime.toISOString()}`);

      return {
        success: true,
        jobId: job.attrs._id.toString(),
        scheduledFor: sendTime.toISOString(),
        to,
        message: message.substring(0, 50) + (message.length > 50 ? '...' : '')
      };
    } catch (error) {
      this.logger.error('schedule_sms failed:', error);
      return { success: false, error: error.message };
    }
  }

  async scheduleVoiceCall({ to, from, scheduleTime }) {
    this.validateParams({ to, scheduleTime }, {
      to: { required: true, type: 'string' },
      scheduleTime: { required: true, type: 'string' }
    });

    if (!this.agent.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }

    try {
      const callTime = new Date(scheduleTime);
      if (callTime <= new Date()) {
        return { success: false, error: 'Schedule time must be in the future' };
      }

      const job = await this.agent.scheduler.agenda.schedule(callTime, 'sinch-scheduled-call', {
        to,
        from: from || 'YourSinchNumber',
        scheduledBy: 'sinch-plugin'
      });

      this.logger.info(`Scheduled voice call to ${to} at ${callTime.toISOString()}`);

      return {
        success: true,
        jobId: job.attrs._id.toString(),
        scheduledFor: callTime.toISOString(),
        to,
        from: from || 'YourSinchNumber'
      };
    } catch (error) {
      this.logger.error('schedule_voice_call failed:', error);
      return { success: false, error: error.message };
    }
  }

  async listScheduled() {
    if (!this.agent.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }

    try {
      const smsJobs = await this.agent.scheduler.agenda.jobs({
        name: 'sinch-scheduled-sms',
        nextRunAt: { $gte: new Date() }
      });

      const callJobs = await this.agent.scheduler.agenda.jobs({
        name: 'sinch-scheduled-call',
        nextRunAt: { $gte: new Date() }
      });

      const scheduled = {
        sms: smsJobs.map(job => ({
          jobId: job.attrs._id.toString(),
          to: job.attrs.data.to,
          message: job.attrs.data.message?.substring(0, 50) + (job.attrs.data.message?.length > 50 ? '...' : ''),
          scheduledFor: job.attrs.nextRunAt
        })),
        calls: callJobs.map(job => ({
          jobId: job.attrs._id.toString(),
          to: job.attrs.data.to,
          from: job.attrs.data.from,
          scheduledFor: job.attrs.nextRunAt
        }))
      };

      return {
        success: true,
        totalScheduled: smsJobs.length + callJobs.length,
        ...scheduled
      };
    } catch (error) {
      this.logger.error('list_scheduled failed:', error);
      return { success: false, error: error.message };
    }
  }

  async cancelScheduled({ jobId }) {
    this.validateParams({ jobId }, {
      jobId: { required: true, type: 'string' }
    });

    if (!this.agent.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }

    try {
      const { ObjectId } = await import('mongodb');
      const numRemoved = await this.agent.scheduler.agenda.cancel({
        _id: new ObjectId(jobId),
        name: { $in: ['sinch-scheduled-sms', 'sinch-scheduled-call'] }
      });

      if (numRemoved > 0) {
        this.logger.info(`Cancelled scheduled job ${jobId}`);
        return { success: true, message: 'Scheduled item cancelled successfully' };
      } else {
        return { success: false, error: 'Job not found or already executed' };
      }
    } catch (error) {
      this.logger.error('cancel_scheduled failed:', error);
      return { success: false, error: error.message };
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

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.cache.clear();
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