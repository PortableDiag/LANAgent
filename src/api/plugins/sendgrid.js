import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

/**
 * Usage Examples:
 * - Natural language: "use sendgrid to send an email"
 * - Command format: api sendgrid <action> <params>
 * - Telegram: Just type naturally about sendgrid
 */

export default class SendGridPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'sendgrid';
    this.version = '1.0.0';
    this.description = 'Email sending APIs with a free tier for limited usage';
    this.commands = [
      {
        command: 'sendEmail',
        description: 'Send an email using SendGrid with optional tracking',
        usage: 'sendEmail to=<recipient> subject=<subject> text=<text> [sendAt=<timestamp>] [attachments=<attachments>] [trackOpens=true] [trackClicks=true]'
      },
      {
        command: 'listTemplates',
        description: 'List all email templates',
        usage: 'listTemplates'
      },
      {
        command: 'getTemplate',
        description: 'Get details of a specific email template',
        usage: 'getTemplate id=<template_id>'
      },
      {
        command: 'cancelScheduledEmail',
        description: 'Cancel a scheduled email batch',
        usage: 'cancelScheduledEmail batchId=<batch_id>'
      },
      {
        command: 'sendDynamicEmail',
        description: 'Send an email using a SendGrid dynamic template',
        usage: 'sendDynamicEmail to=<recipient> templateId=<template_id> dynamicData=<dynamic_data>'
      },
      {
        command: 'getStats',
        description: 'Get email statistics for the account',
        usage: 'getStats [startDate=<date>] [endDate=<date>]'
      }
    ];
    
    this.apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_OF_MASTER;
    this.baseUrl = 'https://api.sendgrid.com/v3';
  }

  async execute(params) {
    const { action } = params;
    
    if (!this.apiKey) {
      return { success: false, error: 'SendGrid API key not configured. Please set SENDGRID_API_KEY in your .env file' };
    }

    if (!this.fromEmail) {
      return { success: false, error: 'Sender email not configured. Please set SENDGRID_FROM_EMAIL or EMAIL_OF_MASTER in your .env file' };
    }

    try {
      switch(action) {
        case 'sendEmail':
          this.validateParams(params, { to: { required: true, type: 'string' }, subject: { required: true, type: 'string' }, text: { required: true, type: 'string' } });
          return await this.sendEmail(params);

        case 'listTemplates':
          return await this.listTemplates();

        case 'getTemplate':
          this.validateParams(params, { id: { required: true, type: 'string' } });
          return await this.getTemplate(params.id);

        case 'cancelScheduledEmail':
          this.validateParams(params, { batchId: { required: true, type: 'string' } });
          return await this.cancelScheduledEmail(params.batchId);

        case 'sendDynamicEmail':
          this.validateParams(params, { to: { required: true, type: 'string' }, templateId: { required: true, type: 'string' }, dynamicData: { required: true, type: 'object' } });
          return await this.sendDynamicEmail(params);

        case 'getStats':
          return await this.getStats(params.startDate, params.endDate);

        default:
          return { success: false, error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ') };
      }
    } catch (error) {
      logger.error('SendGrid plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send an email using SendGrid
   * @param {Object} params - Parameters containing recipient, subject, text, optional html, sendAt, attachments, and tracking settings
   * @returns {Object} - Success or error message
   */
  async sendEmail({ to, subject, text, html, sendAt, attachments, trackOpens = true, trackClicks = true }) {
    try {
      logger.info(`Sending email to ${to} via SendGrid${sendAt ? ` scheduled for ${sendAt}` : ''}`);
      
      const emailContent = [{ type: 'text/plain', value: text }];
      if (html) {
        emailContent.push({ type: 'text/html', value: html });
      }
      
      const personalizations = [{ to: [{ email: to }], subject }];
      
      // Add scheduling if sendAt is provided
      if (sendAt) {
        // Validate the sendAt timestamp
        const sendAtDate = new Date(sendAt);
        if (isNaN(sendAtDate.getTime())) {
          return { success: false, error: 'Invalid sendAt timestamp. Please provide a valid date/time.' };
        }
        
        // Check if the date is in the future
        if (sendAtDate <= new Date()) {
          return { success: false, error: 'sendAt time must be in the future' };
        }
        
        // SendGrid requires Unix timestamp (seconds, not milliseconds)
        const sendAtTimestamp = Math.floor(sendAtDate.getTime() / 1000);
        personalizations[0].send_at = sendAtTimestamp;
      }
      
      // Add batch ID for scheduled emails to allow cancellation
      const mailData = {
        personalizations,
        from: { email: this.fromEmail },
        content: emailContent
      };
      
      // Add attachments if provided
      if (attachments && Array.isArray(attachments)) {
        mailData.attachments = attachments.map(att => ({
          content: att.content,
          filename: att.filename,
          type: att.type || 'application/octet-stream',
          disposition: att.disposition || 'attachment'
        }));
      }
      
      // Add batch ID if scheduling
      if (sendAt) {
        mailData.batch_id = `batch_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      }
      
      // Add tracking settings
      mailData.tracking_settings = {
        click_tracking: {
          enable: trackClicks,
          enable_text: trackClicks
        },
        open_tracking: {
          enable: trackOpens,
          substitution_tag: '%open-track%'
        }
      };
      
      const response = await this.retryRequest(() => axios.post(`${this.baseUrl}/mail/send`, mailData, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      }));

      return { 
        success: true, 
        message: sendAt ? `Email scheduled successfully for ${new Date(sendAt).toLocaleString()}` : `Email sent successfully to ${to}`,
        statusCode: response.status,
        scheduledFor: sendAt ? new Date(sendAt).toISOString() : null,
        batchId: mailData.batch_id || null
      };
    } catch (error) {
      logger.error('Send email error:', error.response?.data || error.message);
      
      // Provide more detailed error messages
      if (error.response?.status === 401) {
        return { success: false, error: 'Invalid API key. Please check your SendGrid credentials' };
      } else if (error.response?.status === 403) {
        return { success: false, error: 'Sender email not verified. Please verify your sender email in SendGrid' };
      }
      
      return { success: false, error: `Failed to send email: ${error.response?.data?.errors?.[0]?.message || error.message}` };
    }
  }

  /**
   * Send an email using a SendGrid dynamic template
   * @param {Object} params - Parameters containing recipient, templateId, and dynamicData
   * @returns {Object} - Success or error message
   */
  async sendDynamicEmail({ to, templateId, dynamicData }) {
    try {
      logger.info(`Sending dynamic email to ${to} using template ID ${templateId}`);
      
      const personalizations = [{
        to: [{ email: to }],
        dynamic_template_data: dynamicData
      }];
      
      const mailData = {
        personalizations,
        from: { email: this.fromEmail },
        template_id: templateId
      };
      
      const response = await this.retryRequest(() => axios.post(`${this.baseUrl}/mail/send`, mailData, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      }));

      return { 
        success: true, 
        message: `Dynamic email sent successfully to ${to}`,
        statusCode: response.status
      };
    } catch (error) {
      logger.error('Send dynamic email error:', error.response?.data || error.message);
      
      if (error.response?.status === 401) {
        return { success: false, error: 'Invalid API key. Please check your SendGrid credentials' };
      } else if (error.response?.status === 403) {
        return { success: false, error: 'Sender email not verified. Please verify your sender email in SendGrid' };
      }
      
      return { success: false, error: `Failed to send dynamic email: ${error.response?.data?.errors?.[0]?.message || error.message}` };
    }
  }

  /**
   * List all email templates
   * @returns {Object} - List of templates or error message
   */
  async listTemplates() {
    try {
      logger.info('Listing all SendGrid email templates');
      
      const response = await this.retryRequest(() => axios.get(`${this.baseUrl}/templates`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        params: {
          generations: 'dynamic',
          page_size: 100
        }
      }));

      const templates = response.data.result || [];
      
      return { 
        success: true, 
        data: templates,
        count: templates.length,
        message: `Found ${templates.length} template(s)`
      };
    } catch (error) {
      logger.error('List templates error:', error.response?.data || error.message);
      return { success: false, error: 'Failed to list templates' };
    }
  }

  /**
   * Get details of a specific email template
   * @param {string} templateId - The template ID
   * @returns {Object} - Template details or error message
   */
  async getTemplate(templateId) {
    try {
      logger.info(`Fetching SendGrid template details for ID: ${templateId}`);
      
      const response = await this.retryRequest(() => axios.get(`${this.baseUrl}/templates/${templateId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      }));

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Get template error:', error.response?.data || error.message);
      
      if (error.response?.status === 404) {
        return { success: false, error: `Template with ID ${templateId} not found` };
      }
      
      return { success: false, error: 'Failed to get template details' };
    }
  }

  /**
   * Cancel a scheduled email batch
   * @param {string} batchId - The batch ID of scheduled emails to cancel
   * @returns {Object} - Success or error message
   */
  async cancelScheduledEmail(batchId) {
    try {
      logger.info(`Cancelling scheduled email batch: ${batchId}`);
      
      const response = await this.retryRequest(() => axios.post(`${this.baseUrl}/user/scheduled_sends`, {
        batch_id: batchId,
        status: 'cancel'
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      }));

      return { 
        success: true, 
        message: `Scheduled email batch ${batchId} has been cancelled`,
        statusCode: response.status 
      };
    } catch (error) {
      logger.error('Cancel scheduled email error:', error.response?.data || error.message);
      
      if (error.response?.status === 404) {
        return { success: false, error: `Scheduled email batch ${batchId} not found` };
      }
      
      return { success: false, error: `Failed to cancel scheduled email: ${error.response?.data?.errors?.[0]?.message || error.message}` };
    }
  }

  /**
   * Retry a request with exponential backoff
   * @param {Function} requestFn - The request function to retry
   * @param {number} retries - Number of retries
   * @param {number} delay - Initial delay in milliseconds
   * @returns {Promise} - The result of the request
   */
  async retryRequest(requestFn, retries = 3, delay = 1000) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        const isTransientError = error.response?.status >= 500 || error.response?.status === 429;
        if (attempt < retries - 1 && isTransientError) {
          const backoffDelay = delay * Math.pow(2, attempt);
          logger.warn(`Request failed with status ${error.response?.status}. Retrying in ${backoffDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Get email statistics from SendGrid
   * @param {string} startDate - Start date for stats (YYYY-MM-DD)
   * @param {string} endDate - End date for stats (YYYY-MM-DD)
   * @returns {Object} - Email statistics or error message
   */
  async getStats(startDate, endDate) {
    try {
      // Default to last 7 days if no dates provided
      if (!endDate) {
        endDate = new Date().toISOString().split('T')[0];
      }
      if (!startDate) {
        const start = new Date();
        start.setDate(start.getDate() - 7);
        startDate = start.toISOString().split('T')[0];
      }
      
      logger.info(`Getting email stats from ${startDate} to ${endDate}`);
      
      const response = await this.retryRequest(() => axios.get(`${this.baseUrl}/stats`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        params: {
          start_date: startDate,
          end_date: endDate,
          aggregated_by: 'day'
        }
      }));

      const stats = response.data;
      
      // Calculate totals
      let totals = {
        requests: 0,
        delivered: 0,
        opens: 0,
        unique_opens: 0,
        clicks: 0,
        unique_clicks: 0,
        bounces: 0,
        blocks: 0,
        spam_reports: 0
      };
      
      stats.forEach(day => {
        if (day.stats && day.stats[0] && day.stats[0].metrics) {
          const metrics = day.stats[0].metrics;
          Object.keys(totals).forEach(key => {
            totals[key] += metrics[key] || 0;
          });
        }
      });
      
      // Calculate rates
      const openRate = totals.delivered > 0 ? ((totals.unique_opens / totals.delivered) * 100).toFixed(2) : 0;
      const clickRate = totals.delivered > 0 ? ((totals.unique_clicks / totals.delivered) * 100).toFixed(2) : 0;
      const bounceRate = totals.requests > 0 ? ((totals.bounces / totals.requests) * 100).toFixed(2) : 0;
      
      return { 
        success: true, 
        data: {
          period: { start: startDate, end: endDate },
          totals,
          rates: {
            open_rate: `${openRate}%`,
            click_rate: `${clickRate}%`,
            bounce_rate: `${bounceRate}%`
          },
          daily_stats: stats
        },
        message: `Email statistics retrieved for ${startDate} to ${endDate}`
      };
    } catch (error) {
      logger.error('Get stats error:', error.response?.data || error.message);
      return { success: false, error: `Failed to retrieve email statistics: ${error.response?.data?.errors?.[0]?.message || error.message}` };
    }
  }
}