import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

export default class SignalWirePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'signalwire';
    this.version = '1.0.0';
    this.description = 'Communication APIs with a developer-friendly approach';
    this.commands = [
      {
        command: 'sendmessage',
        description: 'Send a message using SignalWire',
        usage: 'sendMessage({ from: "+12345678901", to: "+10987654321", body: "Hello from SignalWire!" })'
      },
      {
        command: 'sendmultimediamessage',
        description: 'Send a multimedia message using SignalWire',
        usage: 'sendMultimediaMessage({ from: "+12345678901", to: "+10987654321", mediaUrls: ["http://example.com/image.jpg"] })'
      },
      {
        command: 'getmessages',
        description: 'Retrieve a list of messages sent from your SignalWire account',
        usage: 'getMessages({ limit: 10 })'
      },
      {
        command: 'schedulemessage',
        description: 'Schedule a message to be sent at a future time',
        usage: 'scheduleMessage({ from: "+12345678901", to: "+10987654321", body: "Hello!", sendAt: "tomorrow at 3pm" })'
      },
      {
        command: 'trackmessagestatus',
        description: 'Track the delivery status of a message using SignalWire',
        usage: 'trackMessageStatus({ messageId: "SMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" })'
      },
      {
        command: 'sendtemplatemessage',
        description: 'Send a message using a predefined template',
        usage: 'sendTemplateMessage({ templateId: "greeting", to: "+10987654321", variables: { name: "John" } })'
      },
      {
        command: 'managetemplates',
        description: 'Manage message templates (create, read, update, delete, list)',
        usage: 'manageTemplates({ templateAction: "create", templateId: "greeting", from: "+12345678901", body: "Hello {{name}}!" })'
      },
      {
        command: 'getmessageanalytics',
        description: 'Retrieve analytics data for messages',
        usage: 'getMessageAnalytics({ startDate: "2023-01-01", endDate: "2023-01-31" })'
      },
      {
        command: 'sendbatchmessages',
        description: 'Send multiple messages in a single API call',
        usage: 'sendBatchMessages([{ from: "+12345678901", to: "+10987654321", body: "Hello!" }, { from: "+12345678901", to: "+10987654322", body: "Hi!" }])'
      }
    ];
    
    this.apiKey = process.env.SIGNALWIRE_API_TOKEN;
    this.projectId = process.env.SIGNALWIRE_PROJECT_ID;
    this.spaceUrl = process.env.SIGNALWIRE_SPACE_URL;
    this.templates = {};
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'sendmessage':
          return await this.sendMessage(params);
          
        case 'sendmultimediamessage':
          return await this.sendMultimediaMessage(params);

        case 'getmessages':
          return await this.getMessages(params);
          
        case 'schedulemessage':
          return await this.scheduleMessage(params);

        case 'trackmessagestatus':
          return await this.trackMessageStatus(params);

        case 'sendtemplatemessage':
          return await this.sendTemplateMessage(params);

        case 'managetemplates':
          return this.manageTemplates(params);

        case 'getmessageanalytics':
          return await this.getMessageAnalytics(params);

        case 'sendbatchmessages':
          return await this.sendBatchMessages(params);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('SignalWire plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async sendMessage(params) {
    this.validateParams(params, {
      from: { required: true, type: 'string' },
      to: { required: true, type: 'string' },
      body: { required: true, type: 'string' }
    });

    if (!this.apiKey || !this.projectId || !this.spaceUrl) {
      return { success: false, error: 'API key or project credentials not configured' };
    }
    
    const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Messages.json`;

    try {
      logger.info(`Sending message from ${params.from} to ${params.to}`);
      
      const response = await axios.post(url, null, {
        params: {
          From: params.from,
          To: params.to,
          Body: params.body
        },
        auth: {
          username: this.projectId,
          password: this.apiKey
        }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error sending message:', error.message);
      return { success: false, error: 'Failed to send message: ' + error.message };
    }
  }

  async sendMultimediaMessage(params) {
    this.validateParams(params, {
      from: { required: true, type: 'string' },
      to: { required: true, type: 'string' },
      mediaUrls: { required: true, type: 'array' }
    });

    if (!this.apiKey || !this.projectId || !this.spaceUrl) {
      return { success: false, error: 'API key or project credentials not configured' };
    }
    
    const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Messages.json`;

    try {
      logger.info(`Sending multimedia message from ${params.from} to ${params.to}`);
      
      const response = await axios.post(url, null, {
        params: {
          From: params.from,
          To: params.to,
          MediaUrl: params.mediaUrls
        },
        auth: {
          username: this.projectId,
          password: this.apiKey
        }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error sending multimedia message:', error.message);
      return { success: false, error: 'Failed to send multimedia message: ' + error.message };
    }
  }

  async getMessages(params) {
    this.validateParams(params, {
      limit: { required: false, type: 'number' }
    });

    if (!this.apiKey || !this.projectId || !this.spaceUrl) {
      return { success: false, error: 'API key or project credentials not configured' };
    }
    
    const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Messages.json`;

    try {
      logger.info('Retrieving messages');
      
      const response = await axios.get(url, {
        auth: {
          username: this.projectId,
          password: this.apiKey
        },
        params: {
          PageSize: params.limit || 10
        }
      });

      return { success: true, data: response.data.messages };
      
    } catch (error) {
      logger.error('Error retrieving messages:', error.message);
      return { success: false, error: 'Failed to retrieve messages: ' + error.message };
    }
  }

  async scheduleMessage(params) {
    this.validateParams(params, {
      from: { required: true, type: 'string' },
      to: { required: true, type: 'string' },
      body: { required: true, type: 'string' },
      sendAt: { required: true, type: 'string' }
    });

    try {
      const scheduledTime = await this.scheduler.parseTime(params.sendAt);
      
      if (!scheduledTime) {
        return { 
          success: false, 
          error: 'Invalid time format. Try "in 30 minutes", "tomorrow at 3pm", etc.' 
        };
      }

      const job = await this.scheduler.schedule({
        type: 'plugin-execution',
        data: {
          plugin: 'signalwire',
          action: 'sendmessage',
          params: {
            from: params.from,
            to: params.to,
            body: params.body
          }
        },
        runAt: scheduledTime,
        description: `Send SignalWire message to ${params.to}`
      });

      logger.info(`Scheduled SignalWire message from ${params.from} to ${params.to} at ${scheduledTime}`);
      
      return { 
        success: true, 
        message: `Message scheduled for ${scheduledTime.toLocaleString()}`,
        jobId: job._id
      };
      
    } catch (error) {
      logger.error('Error scheduling message:', error.message);
      return { success: false, error: 'Failed to schedule message: ' + error.message };
    }
  }

  /**
   * Track the delivery status of a message using SignalWire
   * @param {Object} params - Parameters for tracking message status
   * @returns {Promise<Object>}
   */
  async trackMessageStatus(params) {
    this.validateParams(params, {
      messageId: { required: true, type: 'string' }
    });

    if (!this.apiKey || !this.projectId || !this.spaceUrl) {
      return { success: false, error: 'API key or project credentials not configured' };
    }

    const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Messages/${params.messageId}.json`;

    try {
      logger.info(`Tracking message status for ID: ${params.messageId}`);
      
      const response = await axios.get(url, {
        auth: {
          username: this.projectId,
          password: this.apiKey
        }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error tracking message status:', error.message);
      return { success: false, error: 'Failed to track message status: ' + error.message };
    }
  }

  async sendTemplateMessage(params) {
    this.validateParams(params, {
      templateId: { required: true, type: 'string' },
      to: { required: true, type: 'string' },
      variables: { required: false, type: 'object' }
    });

    const template = this.templates[params.templateId];
    if (!template) {
      return { success: false, error: `Template '${params.templateId}' not found` };
    }

    const body = template.body.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return (params.variables && params.variables[key]) || match;
    });

    return await this.sendMessage({ from: template.from, to: params.to, body });
  }

  manageTemplates(params) {
    this.validateParams(params, {
      templateAction: { required: true, type: 'string' }
    });

    const { templateAction, templateId, from, body } = params;

    switch (templateAction) {
      case 'create':
        if (!templateId || !from || !body) {
          return { success: false, error: 'templateId, from, and body are required for create' };
        }
        if (this.templates[templateId]) {
          return { success: false, error: `Template '${templateId}' already exists` };
        }
        this.templates[templateId] = { from, body };
        logger.info(`SignalWire template created: ${templateId}`);
        return { success: true, message: `Template '${templateId}' created` };

      case 'read':
        if (!templateId) {
          return { success: false, error: 'templateId is required for read' };
        }
        if (!this.templates[templateId]) {
          return { success: false, error: `Template '${templateId}' not found` };
        }
        return { success: true, data: { templateId, ...this.templates[templateId] } };

      case 'update':
        if (!templateId) {
          return { success: false, error: 'templateId is required for update' };
        }
        if (!this.templates[templateId]) {
          return { success: false, error: `Template '${templateId}' not found` };
        }
        if (from) this.templates[templateId].from = from;
        if (body) this.templates[templateId].body = body;
        logger.info(`SignalWire template updated: ${templateId}`);
        return { success: true, message: `Template '${templateId}' updated` };

      case 'delete':
        if (!templateId) {
          return { success: false, error: 'templateId is required for delete' };
        }
        if (!this.templates[templateId]) {
          return { success: false, error: `Template '${templateId}' not found` };
        }
        delete this.templates[templateId];
        logger.info(`SignalWire template deleted: ${templateId}`);
        return { success: true, message: `Template '${templateId}' deleted` };

      case 'list':
        return {
          success: true,
          data: Object.entries(this.templates).map(([id, t]) => ({ templateId: id, ...t }))
        };

      default:
        return { success: false, error: 'Invalid templateAction. Use: create, read, update, delete, list' };
    }
  }

  /**
   * Retrieve analytics data for messages
   * @param {Object} params - Parameters for retrieving message analytics
   * @returns {Promise<Object>}
   */
  async getMessageAnalytics(params) {
    this.validateParams(params, {
      startDate: { required: true, type: 'string' },
      endDate: { required: true, type: 'string' }
    });

    if (!this.apiKey || !this.projectId || !this.spaceUrl) {
      return { success: false, error: 'API key or project credentials not configured' };
    }

    const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Messages.json`;

    try {
      logger.info('Retrieving message analytics');
      
      const response = await axios.get(url, {
        auth: {
          username: this.projectId,
          password: this.apiKey
        },
        params: {
          DateSentAfter: params.startDate,
          DateSentBefore: params.endDate
        }
      });

      const messages = response.data.messages;
      const deliveryRates = messages.filter(msg => msg.status === 'delivered').length / messages.length;
      const averageResponseTime = messages.reduce((acc, msg) => acc + (new Date(msg.dateUpdated) - new Date(msg.dateCreated)), 0) / messages.length;
      const engagementMetrics = messages.reduce((acc, msg) => {
        acc[msg.to] = (acc[msg.to] || 0) + 1;
        return acc;
      }, {});

      return { 
        success: true, 
        data: {
          deliveryRates,
          averageResponseTime,
          engagementMetrics
        }
      };
      
    } catch (error) {
      logger.error('Error retrieving message analytics:', error.message);
      return { success: false, error: 'Failed to retrieve message analytics: ' + error.message };
    }
  }

  /**
   * Send multiple messages in a single API call
   * @param {Array} messages - Array of message objects to send
   * @returns {Promise<Object>}
   */
  async sendBatchMessages(params) {
    this.validateParams(params, {
      messages: { required: true, type: 'array' }
    });

    if (!this.apiKey || !this.projectId || !this.spaceUrl) {
      return { success: false, error: 'API key or project credentials not configured' };
    }

    const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Messages.json`;

    try {
      logger.info('Sending batch messages');
      
      const responses = await Promise.all(params.messages.map(async (message) => {
        this.validateParams(message, {
          from: { required: true, type: 'string' },
          to: { required: true, type: 'string' },
          body: { required: true, type: 'string' }
        });

        return axios.post(url, null, {
          params: {
            From: message.from,
            To: message.to,
            Body: message.body
          },
          auth: {
            username: this.projectId,
            password: this.apiKey
          }
        });
      }));

      return { success: true, data: responses.map(response => response.data) };
      
    } catch (error) {
      logger.error('Error sending batch messages:', error.message);
      return { success: false, error: 'Failed to send batch messages: ' + error.message };
    }
  }
}
