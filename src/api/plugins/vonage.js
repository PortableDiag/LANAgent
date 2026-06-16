import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

/**
 * Usage Examples:
 * - Natural language: "use vonage to send an sms"
 * - Command format: api vonage <action> <params>
 * - Telegram: Just type naturally about vonage
 */

export default class VonagePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'vonage';
    this.version = '1.0.0';
    this.description = 'APIs for SMS, MMS, voice, and phone verifications';
    this.commands = [
      {
        command: 'sendsms',
        description: 'Send an SMS to a phone number',
        usage: 'sendsms({ to: "recipient_number", text: "Your message here" })'
      },
      {
        command: 'sendmms',
        description: 'Send an MMS to a phone number',
        usage: 'sendmms({ to: "recipient_number", text: "Your message here", mediaUrl: "http://example.com/image.jpg" })'
      },
      {
        command: 'getbalance',
        description: 'Get account balance',
        usage: 'getbalance()'
      },
      {
        command: 'verify',
        description: 'Verify a phone number',
        usage: 'verify({ number: "recipient_number", brand: "verification_brand" })'
      },
      {
        command: 'send2fa',
        description: 'Send a one-time password (OTP) for 2FA via SMS',
        usage: 'send2fa({ to: "recipient_number", brand: "AppName" })'
      },
      {
        command: 'scheduleMessage',
        description: 'Schedule an SMS or MMS to be sent at a later time',
        usage: 'scheduleMessage({ to: "recipient_number", text: "Your message here", mediaUrl: "http://example.com/image.jpg", sendAt: "2025-10-10T10:00:00Z" })'
      },
      {
        command: 'trackMessageStatus',
        description: 'Track the delivery status of a message',
        usage: 'trackMessageStatus({ messageId: "message_id_here" })'
      }
    ];

    this.scheduledJobs = new Map();

    this.apiKey = process.env.VONAGE_API_KEY;
    this.apiSecret = process.env.VONAGE_API_SECRET;
    this.baseUrl = 'https://rest.nexmo.com';
  }

  async execute(params) {
    const { action } = params;

    try {
      switch (action) {
        case 'sendsms':
          return await this.sendSms(params);
          
        case 'sendmms':
          return await this.sendMms(params);

        case 'getbalance':
          return await this.getBalance();
          
        case 'verify':
          return await this.verifyNumber(params);

        case 'send2fa':
          return await this.send2fa(params);

        case 'scheduleMessage':
          return await this.scheduleMessage(params);

        case 'trackMessageStatus':
          return await this.trackMessageStatus(params);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Vonage plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send an SMS to a specified number.
   * @param {Object} params - Parameters containing 'to' and 'text'.
   */
  async sendSms(params) {
    const { to, text } = params;
    this.validateParams(params, { to: { required: true, type: 'string' }, text: { required: true, type: 'string' } });

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'API key or secret not configured' };
    }

    try {
      logger.info(`Sending SMS to ${to}`);

      const response = await axios.post(`${this.baseUrl}/sms/json`, {
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        to,
        from: 'VonageAPI',
        text
      });

      if (response.data.messages[0].status === '0') {
        return { success: true, data: 'Message sent successfully.', messageId: response.data.messages[0]['message-id'] };
      } else {
        throw new Error(`Message failed with error: ${response.data.messages[0]['error-text']}`);
      }
    } catch (error) {
      logger.error('SMS sending error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send an MMS to a specified number.
   * @param {Object} params - Parameters containing 'to', 'text', and 'mediaUrl'.
   */
  async sendMms(params) {
    const { to, text, mediaUrl } = params;
    this.validateParams(params, { to: { required: true, type: 'string' }, text: { required: true, type: 'string' }, mediaUrl: { required: true, type: 'string' } });

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'API key or secret not configured' };
    }

    try {
      logger.info(`Sending MMS to ${to}`);

      const response = await axios.post(`${this.baseUrl}/mms/json`, {
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        to,
        from: 'VonageAPI',
        text,
        media: mediaUrl
      });

      if (response.data.messages[0].status === '0') {
        return { success: true, data: 'MMS sent successfully.', messageId: response.data.messages[0]['message-id'] };
      } else {
        throw new Error(`MMS failed with error: ${response.data.messages[0]['error-text']}`);
      }
    } catch (error) {
      logger.error('MMS sending error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieve the account balance.
   */
  async getBalance() {
    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'API key or secret not configured' };
    }

    try {
      logger.info('Fetching account balance');

      const response = await axios.get(`${this.baseUrl}/account/get-balance`, {
        params: {
          api_key: this.apiKey,
          api_secret: this.apiSecret
        }
      });

      return { success: true, data: `Account balance: ${response.data.value}` };
    } catch (error) {
      logger.error('Balance retrieval error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify a phone number.
   * @param {Object} params - Parameters containing 'number' and 'brand'.
   */
  async verifyNumber(params) {
    const { number, brand } = params;
    this.validateParams(params, { number: { required: true, type: 'string' }, brand: { required: true, type: 'string' } });

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'API key or secret not configured' };
    }

    try {
      logger.info(`Starting verification for ${number}`);

      const response = await axios.post(`${this.baseUrl}/verify/json`, {
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        number,
        brand
      });

      return { success: true, data: `Verification request sent. Request ID: ${response.data.request_id}` };
    } catch (error) {
      logger.error('Verification error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send a one-time password (OTP) for 2FA via SMS.
   * @param {Object} params - Parameters containing 'to' and optional 'brand'.
   */
  async send2fa(params) {
    const { to, brand = 'LANAgent' } = params;
    this.validateParams(params, { to: { required: true, type: 'string' } });

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'API key or secret not configured' };
    }

    try {
      const otp = this.generateNumericOtp(6);
      logger.info(`Sending 2FA OTP to ${to}`);

      const response = await axios.post(`${this.baseUrl}/sms/json`, {
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        to,
        from: brand,
        text: `Your ${brand} verification code is: ${otp}. This code expires in 5 minutes.`
      });

      if (response.data.messages[0].status === '0') {
        return {
          success: true,
          data: 'OTP sent successfully. Check your phone for the verification code.',
          messageId: response.data.messages[0]['message-id']
        };
      } else {
        throw new Error(`OTP sending failed: ${response.data.messages[0]['error-text']}`);
      }
    } catch (error) {
      logger.error('2FA OTP sending error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Schedule an SMS or MMS to be sent at a later time.
   * @param {Object} params - Parameters containing 'to', 'text', optional 'mediaUrl', and 'sendAt' (ISO 8601).
   */
  async scheduleMessage(params) {
    const { to, text, mediaUrl, sendAt } = params;
    this.validateParams(params, { to: { required: true, type: 'string' }, sendAt: { required: true, type: 'string' } });

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'API key or secret not configured' };
    }

    try {
      const sendTime = new Date(sendAt);
      if (isNaN(sendTime.getTime())) {
        return { success: false, error: 'Invalid sendAt time format. Use ISO 8601 format.' };
      }

      const delay = sendTime.getTime() - Date.now();
      if (delay <= 0) {
        return { success: false, error: 'sendAt must be in the future' };
      }

      const jobId = crypto.randomUUID();
      const timer = setTimeout(async () => {
        try {
          if (mediaUrl) {
            await this.sendMms({ to, text: text || '', mediaUrl });
          } else {
            await this.sendSms({ to, text });
          }
          logger.info(`Scheduled message ${jobId} sent to ${to}`);
        } catch (error) {
          logger.error(`Scheduled message ${jobId} failed:`, error.message);
        }
        this.scheduledJobs.delete(jobId);
      }, delay);

      this.scheduledJobs.set(jobId, { timer, to, sendAt, type: mediaUrl ? 'mms' : 'sms' });
      logger.info(`Message scheduled to ${to} at ${sendAt} (job: ${jobId})`);
      return { success: true, data: { message: `Message scheduled for ${sendAt}`, jobId } };
    } catch (error) {
      logger.error('Message scheduling error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Track the delivery status of a message.
   * @param {Object} params - Parameters containing 'messageId'.
   */
  async trackMessageStatus(params) {
    const { messageId } = params;
    this.validateParams(params, { messageId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'API key or secret not configured' };
    }

    try {
      logger.info(`Tracking status for message ID: ${messageId}`);

      const response = await axios.get(`${this.baseUrl}/search/message`, {
        params: {
          api_key: this.apiKey,
          api_secret: this.apiSecret,
          id: messageId
        }
      });

      if (response.data.messages && response.data.messages.length > 0) {
        const messageStatus = response.data.messages[0].status;
        return { success: true, data: `Message status: ${messageStatus}` };
      } else {
        throw new Error('Message not found or no status available');
      }
    } catch (error) {
      logger.error('Message status tracking error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate a numeric OTP of specified length.
   * @param {number} length - OTP length (default 6).
   * @returns {string} Numeric OTP string.
   */
  generateNumericOtp(length = 6) {
    const max = Math.pow(10, length);
    const randomValue = crypto.randomInt(0, max);
    return randomValue.toString().padStart(length, '0');
  }
}
