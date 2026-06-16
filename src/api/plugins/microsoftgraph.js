import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

export default class MicrosoftGraphPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'microsoftgraph';
    this.version = '1.0.0';
    this.description = 'API providing access to Microsoft 365 services like Outlook, OneDrive, Word, Excel, and Teams';
    this.commands = [
      {
        command: 'getprofile',
        description: 'Get the user profile',
        usage: 'getprofile()'
      },
      {
        command: 'listmails',
        description: 'List the user\'s emails',
        usage: 'listmails({ limit: 10 })'
      },
      {
        command: 'sendmail',
        description: 'Send an email',
        usage: 'sendmail({ to: "user@example.com", subject: "Subject", body: "Message body" })'
      },
      {
        command: 'listcalendarevents',
        description: 'List the user\'s calendar events',
        usage: 'listcalendarevents({ limit: 10 })'
      },
      {
        command: 'createevent',
        description: 'Create a calendar event',
        usage: 'createevent({ subject: "Meeting", start: "2024-01-01T10:00:00", end: "2024-01-01T11:00:00" })'
      },
      {
        command: 'listfiles',
        description: 'List files from OneDrive',
        usage: 'listfiles({ path: "/", limit: 20 })'
      },
      {
        command: 'uploadfile',
        description: 'Upload a file to OneDrive',
        usage: 'uploadfile({ path: "/Documents/file.txt", content: "File content" })'
      },
      {
        command: 'listteams',
        description: 'List Microsoft Teams',
        usage: 'listteams()'
      },
      {
        command: 'createteam',
        description: 'Create a Microsoft Team',
        usage: 'createteam({ displayName: "Team Name", description: "Team Description" })'
      },
      {
        command: 'listchannels',
        description: 'List channels in a Microsoft Team',
        usage: 'listchannels({ teamId: "team-id" })'
      },
      {
        command: 'createchannel',
        description: 'Create a channel in a Microsoft Team',
        usage: 'createchannel({ teamId: "team-id", displayName: "Channel Name", description: "Channel Description" })'
      },
      {
        command: 'listmessages',
        description: 'List messages in a channel',
        usage: 'listmessages({ teamId: "team-id", channelId: "channel-id" })'
      },
      {
        command: 'sendmessage',
        description: 'Send a message to a channel',
        usage: 'sendmessage({ teamId: "team-id", channelId: "channel-id", message: "Hello, World!" })'
      }
    ];
    
    this.accessToken = process.env.MICROSOFT_GRAPH_ACCESS_TOKEN;
    this.baseUrl = 'https://graph.microsoft.com/v1.0';
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'getprofile':
          return await this.getProfile();
        
        case 'listmails':
          return await this.listMails(params);
          
        case 'sendmail':
          return await this.sendMail(params);

        case 'listcalendarevents':
          return await this.listCalendarEvents(params);
          
        case 'createevent':
          return await this.createEvent(params);
          
        case 'listfiles':
          return await this.listFiles(params);
          
        case 'uploadfile':
          return await this.uploadFile(params);

        case 'listteams':
          return await this.listTeams();

        case 'createteam':
          return await this.createTeam(params);

        case 'listchannels':
          return await this.listChannels(params);

        case 'createchannel':
          return await this.createChannel(params);

        case 'listmessages':
          return await this.listMessages(params);

        case 'sendmessage':
          return await this.sendMessage(params);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Microsoft Graph plugin error:', error);
      return { success: false, error: error.message };
    }
  }
  
  async getProfile() {
    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info('Getting user profile');
      const response = await axios.get(`${this.baseUrl}/me`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error getting user profile:', error.message);
      return { success: false, error: 'Failed to get profile: ' + error.message };
    }
  }

  async listMails(params) {
    const { limit = 10, folder = 'inbox' } = params;
    
    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Listing ${limit} emails from ${folder}`);
      
      const response = await axios.get(`${this.baseUrl}/me/mailFolders/${folder}/messages`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        params: {
          '$top': limit,
          '$orderby': 'receivedDateTime desc'
        }
      });

      return { success: true, data: response.data.value };
    } catch (error) {
      logger.error('Error listing emails:', error.message);
      return { success: false, error: 'Failed to list emails: ' + error.message };
    }
  }
  
  async sendMail(params) {
    const { to, subject, body, cc, attachments } = params;
    
    this.validateParams(params, {
      to: { required: true, type: 'string' },
      subject: { required: true, type: 'string' },
      body: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Sending email to ${to}`);
      
      const message = {
        message: {
          subject: subject,
          body: {
            contentType: 'Text',
            content: body
          },
          toRecipients: [
            {
              emailAddress: {
                address: to
              }
            }
          ]
        }
      };
      
      if (cc) {
        message.message.ccRecipients = [{
          emailAddress: { address: cc }
        }];
      }
      
      const response = await axios.post(`${this.baseUrl}/me/sendMail`, message, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, message: 'Email sent successfully' };
    } catch (error) {
      logger.error('Error sending email:', error.message);
      return { success: false, error: 'Failed to send email: ' + error.message };
    }
  }

  async listCalendarEvents(params) {
    const { limit = 10, startDateTime, endDateTime } = params;
    
    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Listing ${limit} calendar events`);
      
      const queryParams = {
        '$top': limit,
        '$orderby': 'start/dateTime'
      };
      
      if (startDateTime && endDateTime) {
        queryParams['$filter'] = `start/dateTime ge '${startDateTime}' and end/dateTime le '${endDateTime}'`;
      }
      
      const response = await axios.get(`${this.baseUrl}/me/events`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        params: queryParams
      });

      return { success: true, data: response.data.value };
    } catch (error) {
      logger.error('Error listing calendar events:', error.message);
      return { success: false, error: 'Failed to list events: ' + error.message };
    }
  }
  
  async createEvent(params) {
    const { subject, start, end, body, location, attendees } = params;
    
    this.validateParams(params, {
      subject: { required: true, type: 'string' },
      start: { required: true, type: 'string' },
      end: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Creating calendar event: ${subject}`);
      
      const event = {
        subject: subject,
        start: {
          dateTime: start,
          timeZone: 'UTC'
        },
        end: {
          dateTime: end,
          timeZone: 'UTC'
        }
      };
      
      if (body) {
        event.body = {
          contentType: 'Text',
          content: body
        };
      }
      
      if (location) {
        event.location = {
          displayName: location
        };
      }
      
      if (attendees && Array.isArray(attendees)) {
        event.attendees = attendees.map(email => ({
          emailAddress: { address: email },
          type: 'required'
        }));
      }
      
      const response = await axios.post(`${this.baseUrl}/me/events`, event, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating event:', error.message);
      return { success: false, error: 'Failed to create event: ' + error.message };
    }
  }
  
  async listFiles(params) {
    const { path = '/', limit = 20 } = params;
    
    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      const drivePath = path === '/' ? '/root' : `/root:${path}:`;
      logger.info(`Listing files from OneDrive path: ${path}`);
      
      const response = await axios.get(`${this.baseUrl}/me/drive${drivePath}/children`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        params: {
          '$top': limit
        }
      });

      return { success: true, data: response.data.value };
    } catch (error) {
      logger.error('Error listing files:', error.message);
      return { success: false, error: 'Failed to list files: ' + error.message };
    }
  }
  
  async uploadFile(params) {
    const { path, content, contentType = 'text/plain' } = params;
    
    this.validateParams(params, {
      path: { required: true, type: 'string' },
      content: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Uploading file to OneDrive: ${path}`);
      
      const response = await axios.put(
        `${this.baseUrl}/me/drive/root:${path}:/content`,
        content,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': contentType
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error uploading file:', error.message);
      return { success: false, error: 'Failed to upload file: ' + error.message };
    }
  }

  async listTeams() {
    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info('Listing Microsoft Teams');
      const response = await axios.get(`${this.baseUrl}/me/joinedTeams`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      return { success: true, data: response.data.value };
    } catch (error) {
      logger.error('Error listing teams:', error.message);
      return { success: false, error: 'Failed to list teams: ' + error.message };
    }
  }

  async createTeam(params) {
    const { displayName, description } = params;
    
    this.validateParams(params, {
      displayName: { required: true, type: 'string' },
      description: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Creating Microsoft Team: ${displayName}`);
      
      const team = {
        displayName: displayName,
        description: description,
        visibility: 'Private',
        members: [],
        owners: []
      };
      
      const response = await axios.post(`${this.baseUrl}/teams`, team, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating team:', error.message);
      return { success: false, error: 'Failed to create team: ' + error.message };
    }
  }

  async listChannels(params) {
    const { teamId } = params;
    
    this.validateParams(params, {
      teamId: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Listing channels for team: ${teamId}`);
      
      const response = await axios.get(`${this.baseUrl}/teams/${teamId}/channels`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      return { success: true, data: response.data.value };
    } catch (error) {
      logger.error('Error listing channels:', error.message);
      return { success: false, error: 'Failed to list channels: ' + error.message };
    }
  }

  async createChannel(params) {
    const { teamId, displayName, description } = params;
    
    this.validateParams(params, {
      teamId: { required: true, type: 'string' },
      displayName: { required: true, type: 'string' },
      description: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Creating channel in team ${teamId}: ${displayName}`);
      
      const channel = {
        displayName: displayName,
        description: description
      };
      
      const response = await axios.post(`${this.baseUrl}/teams/${teamId}/channels`, channel, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating channel:', error.message);
      return { success: false, error: 'Failed to create channel: ' + error.message };
    }
  }

  async listMessages(params) {
    const { teamId, channelId } = params;
    
    this.validateParams(params, {
      teamId: { required: true, type: 'string' },
      channelId: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Listing messages for channel ${channelId} in team ${teamId}`);
      
      const response = await axios.get(`${this.baseUrl}/teams/${teamId}/channels/${channelId}/messages`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      return { success: true, data: response.data.value };
    } catch (error) {
      logger.error('Error listing messages:', error.message);
      return { success: false, error: 'Failed to list messages: ' + error.message };
    }
  }

  async sendMessage(params) {
    const { teamId, channelId, message } = params;
    
    this.validateParams(params, {
      teamId: { required: true, type: 'string' },
      channelId: { required: true, type: 'string' },
      message: { required: true, type: 'string' }
    });

    if (!this.accessToken) {
      return { success: false, error: 'Access token not configured' };
    }

    try {
      logger.info(`Sending message to channel ${channelId} in team ${teamId}`);
      
      const messageContent = {
        body: {
          content: message
        }
      };
      
      const response = await axios.post(`${this.baseUrl}/teams/${teamId}/channels/${channelId}/messages`, messageContent, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error sending message:', error.message);
      return { success: false, error: 'Failed to send message: ' + error.message };
    }
  }
}