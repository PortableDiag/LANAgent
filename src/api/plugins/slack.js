import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

export default class SlackPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'slack';
    this.version = '1.0.0';
    this.description = 'API for sending messages, managing users, and automating workflows';
    this.commands = [
      {
        command: 'sendMessage',
        description: 'Send a message to a Slack channel',
        usage: 'sendMessage [channel] [text]'
      },
      {
        command: 'listChannels',
        description: 'List all channels in the workspace',
        usage: 'listChannels'
      },
      {
        command: 'getUserInfo',
        description: 'Get user information by user ID',
        usage: 'getUserInfo [userId]'
      },
      {
        command: 'scheduleMessage',
        description: 'Schedule a message to be sent at a later time',
        usage: 'scheduleMessage [channel] [text] [sendAt]'
      },
      {
        command: 'replyInThread',
        description: 'Reply to a specific message in a thread',
        usage: 'replyInThread [channel] [text] [threadTs]'
      },
      {
        command: 'addInteractiveButton',
        description: 'Add interactive buttons to a Slack message',
        usage: 'addInteractiveButton [channel] [text] [buttons]'
      },
      {
        command: 'sendFormattedMessage',
        description: 'Send a formatted message using Slack\'s Block Kit',
        usage: 'sendFormattedMessage [channel] [blocks]'
      },
      {
        command: 'addReaction',
        description: 'Add a reaction (emoji) to a message',
        usage: 'addReaction [channel] [timestamp] [emoji]'
      }
    ];
    
    this.apiKey = process.env.SLACK_API_KEY;
    this.baseUrl = 'https://slack.com/api';
  }

  async execute(params) {
    const { action, channel, text, userId, sendAt, threadTs, buttons, blocks, timestamp, emoji } = params;
    
    try {
      switch(action) {
        case 'sendMessage':
          return await this.sendMessage(channel, text);
        case 'listChannels':
          return await this.listChannels();
        case 'getUserInfo':
          return await this.getUserInfo(userId);
        case 'scheduleMessage':
          return await this.scheduleMessage(channel, text, sendAt);
        case 'replyInThread':
          return await this.replyInThread(channel, text, threadTs);
        case 'addInteractiveButton':
          return await this.addInteractiveButton(channel, text, buttons);
        case 'sendFormattedMessage':
          return await this.sendFormattedMessage(channel, blocks);
        case 'addReaction':
          return await this.addReaction(channel, timestamp, emoji);
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Slack plugin error:', error);
      return { success: false, error: error.message };
    }
  }
  
  async sendMessage(channel, text) {
    this.validateParams({ channel, text }, { channel: { required: true, type: 'string' }, text: { required: true, type: 'string' } });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.post(`${this.baseUrl}/chat.postMessage`, {
        channel: channel,
        text: text
      }, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Send message error:', error.message);
      return { success: false, error: `Failed to send message: ${error.message}` };
    }
  }

  async listChannels() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/conversations.list`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });

      return { success: true, data: response.data.channels };
    } catch (error) {
      logger.error('List channels error:', error.message);
      return { success: false, error: `Failed to list channels: ${error.message}` };
    }
  }

  async getUserInfo(userId) {
    this.validateParams({ userId }, { userId: { required: true, type: 'string' } });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/users.info`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        },
        params: {
          user: userId
        }
      });

      return { success: true, data: response.data.user };
    } catch (error) {
      logger.error('Get user info error:', error.message);
      return { success: false, error: `Failed to get user info: ${error.message}` };
    }
  }

  async scheduleMessage(channel, text, sendAt) {
    this.validateParams({ channel, text, sendAt }, { 
      channel: { required: true, type: 'string' }, 
      text: { required: true, type: 'string' }, 
      sendAt: { required: true }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      let postAt;
      
      if (typeof sendAt === 'string' && isNaN(sendAt)) {
        const scheduledTime = await this.scheduler.parseTime(sendAt);
        if (!scheduledTime) {
          return { 
            success: false, 
            error: 'Invalid time format. Try "in 30 minutes", "tomorrow at 3pm", or a unix timestamp' 
          };
        }
        postAt = Math.floor(scheduledTime.getTime() / 1000);
      } else {
        postAt = parseInt(sendAt);
      }

      const now = Math.floor(Date.now() / 1000);
      if (postAt <= now) {
        return { success: false, error: 'Scheduled time must be in the future' };
      }

      const maxFuture = now + (120 * 24 * 60 * 60);
      if (postAt > maxFuture) {
        return { success: false, error: 'Cannot schedule more than 120 days in the future' };
      }

      const response = await axios.post(`${this.baseUrl}/chat.scheduleMessage`, {
        channel: channel,
        text: text,
        post_at: postAt
      }, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      const scheduledDate = new Date(postAt * 1000);
      logger.info(`Scheduled Slack message for ${channel} at ${scheduledDate.toLocaleString()}`);

      return { 
        success: true, 
        data: response.data,
        message: `Message scheduled for ${scheduledDate.toLocaleString()}`
      };
    } catch (error) {
      logger.error('Schedule message error:', error.response?.data || error.message);
      return { success: false, error: `Failed to schedule message: ${error.response?.data?.error || error.message}` };
    }
  }

  /**
   * Reply to a specific message in a thread
   * @param {string} channel - The channel ID or name
   * @param {string} text - The message text to send
   * @param {string} threadTs - The timestamp of the parent message to reply to
   * @returns {Promise<Object>}
   */
  async replyInThread(channel, text, threadTs) {
    this.validateParams({ channel, text, threadTs }, { 
      channel: { required: true, type: 'string' }, 
      text: { required: true, type: 'string' }, 
      threadTs: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.post(`${this.baseUrl}/chat.postMessage`, {
        channel: channel,
        text: text,
        thread_ts: threadTs
      }, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Reply in thread error:', error.message);
      return { success: false, error: `Failed to reply in thread: ${error.message}` };
    }
  }

  /**
   * Add interactive buttons to a Slack message
   * @param {string} channel - The channel ID or name
   * @param {string} text - The message text to send
   * @param {Array} buttons - Array of button objects
   * @returns {Promise<Object>}
   */
  async addInteractiveButton(channel, text, buttons) {
    this.validateParams({ channel, text, buttons }, {
      channel: { required: true, type: 'string' },
      text: { required: true, type: 'string' },
      buttons: { required: true, type: 'array' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.post(`${this.baseUrl}/chat.postMessage`, {
        channel: channel,
        text: text,
        attachments: [
          {
            text: 'Choose an option',
            fallback: 'You are unable to choose an option',
            callback_id: 'interactive_message',
            color: '#3AA3E3',
            attachment_type: 'default',
            actions: buttons
          }
        ]
      }, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Add interactive button error:', error.message);
      return { success: false, error: `Failed to add interactive button: ${error.message}` };
    }
  }

  /**
   * Send a formatted message using Slack's Block Kit
   * @param {string} channel - The channel ID or name
   * @param {Array} blocks - Array of block objects for Block Kit
   * @returns {Promise<Object>}
   */
  async sendFormattedMessage(channel, blocks) {
    this.validateParams({ channel, blocks }, {
      channel: { required: true, type: 'string' },
      blocks: { required: true, type: 'array' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.post(`${this.baseUrl}/chat.postMessage`, {
        channel: channel,
        blocks: blocks
      }, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Send formatted message error:', error.message);
      return { success: false, error: `Failed to send formatted message: ${error.message}` };
    }
  }

  /**
   * Add a reaction (emoji) to a message
   * @param {string} channel - The channel ID or name
   * @param {string} timestamp - The timestamp of the message to react to
   * @param {string} emoji - The name of the emoji to add as a reaction
   * @returns {Promise<Object>}
   */
  async addReaction(channel, timestamp, emoji) {
    this.validateParams({ channel, timestamp, emoji }, {
      channel: { required: true, type: 'string' },
      timestamp: { required: true, type: 'string' },
      emoji: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await axios.post(`${this.baseUrl}/reactions.add`, {
        channel: channel,
        timestamp: timestamp,
        name: emoji
      }, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Add reaction error:', error.message);
      return { success: false, error: `Failed to add reaction: ${error.message}` };
    }
  }
}
