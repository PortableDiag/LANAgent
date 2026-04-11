import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import https from 'https';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

/**
 * Usage Examples:
 * - Natural language: "use firebasecloudmessagingfcm to send a message"
 * - Command format: api firebasecloudmessagingfcm <action> <params>
 * - Telegram: Just type naturally about firebasecloudmessagingfcm
 */

export default class FirebaseCloudMessagingFCMPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'firebasecloudmessagingfcm';
    this.version = '1.0.0';
    this.description = 'Notifications and messaging service for Android, iOS, and web';
    this.commands = [
      {
        command: 'sendMessage',
        description: 'Send a notification message to a device with optional priority',
        usage: 'sendMessage <registrationToken> <title> <body> [data] [priority]'
      },
      {
        command: 'sendBulkMessages',
        description: 'Send a notification message to multiple devices with optional priority',
        usage: 'sendBulkMessages <registrationTokens> <title> <body> [data] [priority]'
      },
      {
        command: 'subscribeToTopic',
        description: 'Subscribe a device to a topic',
        usage: 'subscribeToTopic <registrationToken> <topic>'
      },
      {
        command: 'unsubscribeFromTopic',
        description: 'Unsubscribe a device from a topic',
        usage: 'unsubscribeFromTopic <registrationToken> <topic>'
      },
      {
        command: 'scheduleMessage',
        description: 'Schedule a notification message to be sent at a future time',
        usage: 'scheduleMessage <timestamp> <registrationToken> <title> <body> [data]'
      }
    ];

    this.apiKey = process.env.FIREBASE_CLOUD_MESSAGING_FCM_API_KEY;
    this.baseUrl = 'https://fcm.googleapis.com/fcm/send';
    this.httpsAgent = new https.Agent({ keepAlive: true });
    this.scheduler = this.agent?.services?.get('taskScheduler');
    if (this.scheduler?.agenda) {
      this.scheduler.agenda.define('fcm-scheduled-message', async (job) => {
        const { registrationToken, title, body, data } = job.attrs.data;
        await this.sendMessage(registrationToken, title, body, data);
      });
    }
  }

  async execute(params) {
    const { action, registrationToken, registrationTokens, title, body, topic, data, timestamp, priority } = params;

    try {
      switch(action) {
        case 'sendMessage':
          return await this.sendMessage(registrationToken, title, body, data, priority);
        case 'sendBulkMessages':
          return await this.sendBulkMessages(registrationTokens, title, body, data, priority);
        case 'subscribeToTopic':
          return await this.subscribeToTopic(registrationToken, topic);
        case 'unsubscribeFromTopic':
          return await this.unsubscribeFromTopic(registrationToken, topic);
        case 'scheduleMessage':
          return await this.scheduleMessage(timestamp, registrationToken, title, body, data);
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Firebase Cloud Messaging FCM plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send a notification message to a specific device with optional priority.
   * @param {string} registrationToken - The device's registration token.
   * @param {string} title - The title of the notification.
   * @param {string} body - The body of the notification.
   * @param {Object} [data] - Optional key-value pairs to include in the message payload.
   * @param {string} [priority='normal'] - The priority of the message ('high' or 'normal').
   * @returns {Promise<Object>}
   */
  async sendMessage(registrationToken, title, body, data = {}, priority = 'normal') {
    this.validateParams({ registrationToken, title, body }, {
      registrationToken: { required: true, type: 'string' },
      title: { required: true, type: 'string' },
      body: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Sending message to ${registrationToken} with priority ${priority}`);

      const message = {
        to: registrationToken,
        notification: { title, body },
        data,
        android: { priority },
        apns: { headers: { 'apns-priority': priority === 'high' ? '10' : '5' } }
      };

      const response = await retryOperation(
        () => axios.post(this.baseUrl, message, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `key=${this.apiKey}`
          },
          httpsAgent: this.httpsAgent
        }),
        { retries: 3, context: 'fcm:sendMessage' }
      );

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error sending message:', error.message);
      return { success: false, error: `Failed to send message: ${error.message}` };
    }
  }

  /**
   * Send a notification message to multiple devices with optional priority.
   * @param {Array<string>} registrationTokens - The devices' registration tokens.
   * @param {string} title - The title of the notification.
   * @param {string} body - The body of the notification.
   * @param {Object} [data] - Optional key-value pairs to include in the message payload.
   * @param {string} [priority='normal'] - The priority of the message ('high' or 'normal').
   * @returns {Promise<Object>}
   */
  async sendBulkMessages(registrationTokens, title, body, data = {}, priority = 'normal') {
    this.validateParams({ registrationTokens, title, body }, {
      registrationTokens: { required: true, type: 'array' },
      title: { required: true, type: 'string' },
      body: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Sending bulk message to ${registrationTokens.length} devices with priority ${priority}`);

      // FCM has a 1000-token limit per request, batch if needed
      const BATCH_SIZE = 1000;
      const batches = [];
      for (let i = 0; i < registrationTokens.length; i += BATCH_SIZE) {
        batches.push(registrationTokens.slice(i, i + BATCH_SIZE));
      }

      const results = await Promise.allSettled(
        batches.map(batch => {
          const message = {
            registration_ids: batch,
            notification: { title, body },
            data,
            android: { priority },
            apns: { headers: { 'apns-priority': priority === 'high' ? '10' : '5' } }
          };

          return retryOperation(
            () => axios.post(this.baseUrl, message, {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `key=${this.apiKey}`
              },
              httpsAgent: this.httpsAgent
            }),
            { retries: 3, context: 'fcm:sendBulkMessages' }
          );
        })
      );

      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      return {
        success: failed === 0,
        data: {
          totalBatches: batches.length,
          succeeded,
          failed,
          results: results.map(r => r.status === 'fulfilled' ? r.value.data : r.reason?.message)
        }
      };
    } catch (error) {
      logger.error('Error sending bulk messages:', error.message);
      return { success: false, error: `Failed to send bulk messages: ${error.message}` };
    }
  }

  /**
   * Subscribe a device to a topic.
   * @param {string} registrationToken - The device's registration token.
   * @param {string} topic - The topic to subscribe to.
   * @returns {Promise<Object>}
   */
  async subscribeToTopic(registrationToken, topic) {
    this.validateParams({ registrationToken, topic }, {
      registrationToken: { required: true, type: 'string' },
      topic: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Subscribing ${registrationToken} to topic ${topic}`);

      const response = await retryOperation(
        () => axios.post(`https://iid.googleapis.com/iid/v1/${registrationToken}/rel/topics/${topic}`, {}, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `key=${this.apiKey}`
          },
          httpsAgent: this.httpsAgent
        }),
        { retries: 3, context: 'fcm:subscribeToTopic' }
      );

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error subscribing to topic:', error.message);
      return { success: false, error: `Failed to subscribe to topic: ${error.message}` };
    }
  }

  /**
   * Unsubscribe a device from a topic.
   * @param {string} registrationToken - The device's registration token.
   * @param {string} topic - The topic to unsubscribe from.
   * @returns {Promise<Object>}
   */
  async unsubscribeFromTopic(registrationToken, topic) {
    this.validateParams({ registrationToken, topic }, {
      registrationToken: { required: true, type: 'string' },
      topic: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Unsubscribing ${registrationToken} from topic ${topic}`);

      const response = await retryOperation(
        () => axios.post(`https://iid.googleapis.com/iid/v1:batchRemove`, {
          to: `/topics/${topic}`,
          registration_tokens: [registrationToken]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `key=${this.apiKey}`
          },
          httpsAgent: this.httpsAgent
        }),
        { retries: 3, context: 'fcm:unsubscribeFromTopic' }
      );

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error unsubscribing from topic:', error.message);
      return { success: false, error: `Failed to unsubscribe from topic: ${error.message}` };
    }
  }

  /**
   * Schedule a notification message to be sent at a future time.
   * @param {string} timestamp - The time at which the message should be sent (ISO string or Date-parseable).
   * @param {string} registrationToken - The device's registration token.
   * @param {string} title - The title of the notification.
   * @param {string} body - The body of the notification.
   * @param {Object} [data] - Optional key-value pairs to include in the message payload.
   * @returns {Promise<Object>}
   */
  async scheduleMessage(timestamp, registrationToken, title, body, data = {}) {
    this.validateParams({ timestamp, registrationToken, title, body }, {
      timestamp: { required: true, type: 'string' },
      registrationToken: { required: true, type: 'string' },
      title: { required: true, type: 'string' },
      body: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    if (!this.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }

    const sendAt = new Date(timestamp);
    if (isNaN(sendAt.getTime()) || sendAt <= new Date()) {
      return { success: false, error: 'Timestamp must be a valid future date' };
    }

    try {
      logger.info(`Scheduling FCM message to ${registrationToken} at ${sendAt.toISOString()}`);

      await this.scheduler.agenda.schedule(sendAt, 'fcm-scheduled-message', {
        registrationToken, title, body, data
      });

      return { success: true, message: `Message scheduled for ${sendAt.toISOString()}` };
    } catch (error) {
      logger.error('Error scheduling message:', error.message);
      return { success: false, error: `Failed to schedule message: ${error.message}` };
    }
  }
}