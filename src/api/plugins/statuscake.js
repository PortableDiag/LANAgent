import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

/**
 * Usage Examples:
 * - Natural language: "use statuscake to [action]"
 * - Command format: api statuscake <action> <params>
 * - Telegram: Just type naturally about statuscake
 */

export default class StatusCakePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'statuscake';
    this.version = '1.0.0';
    this.description = 'Uptime monitoring service with performance metrics';
    this.commands = [
      {
        command: 'getuptimetests',
        description: 'Retrieve a list of uptime tests',
        usage: 'getUptimeTests()'
      },
      {
        command: 'gettestdetails',
        description: 'Get details of a specific test',
        usage: 'getTestDetails({ testId: "12345" })'
      },
      {
        command: 'createtest',
        description: 'Create a new uptime test',
        usage: 'createTest({ name: "Test Name", url: "https://example.com" })'
      },
      {
        command: 'deletetest',
        description: 'Delete an existing test',
        usage: 'deleteTest({ testId: "12345" })'
      },
      {
        command: 'updatetest',
        description: 'Update an existing test',
        usage: 'updateTest({ testId: "12345", name: "New Test Name" })'
      },
      {
        command: 'scheduletest',
        description: 'Schedule an uptime test at specific intervals',
        usage: 'scheduleTest({ testId: "12345", schedule: "*/5 * * * *" })'
      },
      {
        command: 'pausetest',
        description: 'Pause an uptime test',
        usage: 'pauseTest({ testId: "12345" })'
      },
      {
        command: 'resumetest',
        description: 'Resume a paused uptime test',
        usage: 'resumeTest({ testId: "12345" })'
      },
      {
        command: 'bulkcreatetests',
        description: 'Create multiple uptime tests in bulk',
        usage: 'bulkCreateTests([{ name: "Test1", url: "https://example1.com" }, { name: "Test2", url: "https://example2.com" }])'
      },
      {
        command: 'bulkdeletetests',
        description: 'Delete multiple tests in bulk',
        usage: 'bulkDeleteTests([{ testId: "12345" }, { testId: "67890" }])'
      },
      {
        command: 'bulkupdatetests',
        description: 'Update multiple tests in bulk',
        usage: 'bulkUpdateTests([{ testId: "12345", name: "New Name 1" }, { testId: "67890", name: "New Name 2" }])'
      }
    ];
    
    this.apiKey = process.env.STATUSCAKE_API_KEY;
    this.baseUrl = 'https://api.statuscake.com/v1';
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'getuptimetests':
          return await this.getUptimeTests();
        
        case 'gettestdetails':
          return await this.getTestDetails(params);
        
        case 'createtest':
          return await this.createTest(params);
        
        case 'deletetest':
          return await this.deleteTest(params);
        
        case 'updatetest':
          return await this.updateTest(params);

        case 'scheduletest':
          return await this.scheduleTest(params);

        case 'pausetest':
          return await this.pauseTest(params);

        case 'resumetest':
          return await this.resumeTest(params);

        case 'bulkcreatetests':
          return await this.bulkCreateTests(params);

        case 'bulkdeletetests':
          return await this.bulkDeleteTests(params);

        case 'bulkupdatetests':
          return await this.bulkUpdateTests(params);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('StatusCake plugin error:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Get a list of all uptime tests.
   */
  async getUptimeTests() {
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info('Fetching uptime tests');
      const response = await axios.get(`${this.baseUrl}/uptime`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching uptime tests:', error.message);
      return { success: false, error: 'Failed to fetch uptime tests' };
    }
  }

  /**
   * Get details of a specific test.
   * @param {Object} params - Parameters for the request.
   * @param {string} params.testId - The ID of the test.
   */
  async getTestDetails(params) {
    this.validateParams(params, { testId: { required: true, type: 'string' } });
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info(`Fetching details for test ID: ${params.testId}`);
      const response = await axios.get(`${this.baseUrl}/uptime/${params.testId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error(`Error fetching test details for ID ${params.testId}:`, error.message);
      return { success: false, error: 'Failed to fetch test details' };
    }
  }

  /**
   * Create a new uptime test.
   * @param {Object} params - Parameters for the request.
   * @param {string} params.name - The name of the test.
   * @param {string} params.url - The URL to be monitored.
   */
  async createTest(params) {
    this.validateParams(params, { name: { required: true, type: 'string' }, url: { required: true, type: 'string' } });
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info(`Creating new uptime test: ${params.name}`);
      const response = await axios.post(`${this.baseUrl}/uptime`, {
        name: params.name,
        website_url: params.url
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating uptime test:', error.message);
      return { success: false, error: 'Failed to create uptime test' };
    }
  }

  /**
   * Delete an existing test.
   * @param {Object} params - Parameters for the request.
   * @param {string} params.testId - The ID of the test to delete.
   */
  async deleteTest(params) {
    this.validateParams(params, { testId: { required: true, type: 'string' } });
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info(`Deleting test with ID: ${params.testId}`);
      await axios.delete(`${this.baseUrl}/uptime/${params.testId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return { success: true, data: `Test ID ${params.testId} deleted successfully` };
    } catch (error) {
      logger.error(`Error deleting test ID ${params.testId}:`, error.message);
      return { success: false, error: 'Failed to delete test' };
    }
  }

  /**
   * Update an existing test.
   * @param {Object} params - Parameters for the request.
   * @param {string} params.testId - The ID of the test to update.
   * @param {string} params.name - The new name of the test.
   */
  async updateTest(params) {
    this.validateParams(params, { testId: { required: true, type: 'string' }, name: { required: true, type: 'string' } });
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info(`Updating test ID ${params.testId} with new name: ${params.name}`);
      const response = await axios.put(`${this.baseUrl}/uptime/${params.testId}`, {
        name: params.name
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error(`Error updating test ID ${params.testId}:`, error.message);
      return { success: false, error: 'Failed to update test' };
    }
  }

  /**
   * Pause an uptime test.
   * @param {Object} params - Parameters for the request.
   * @param {string} params.testId - The ID of the test to pause.
   */
  async pauseTest(params) {
    this.validateParams(params, { testId: { required: true, type: 'string' } });
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info(`Pausing test ID: ${params.testId}`);
      await axios.put(`${this.baseUrl}/uptime/${params.testId}`, {
        paused: true
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return { success: true, data: `Test ID ${params.testId} paused successfully` };
    } catch (error) {
      logger.error(`Error pausing test ID ${params.testId}:`, error.message);
      return { success: false, error: 'Failed to pause test' };
    }
  }

  /**
   * Resume a paused uptime test.
   * @param {Object} params - Parameters for the request.
   * @param {string} params.testId - The ID of the test to resume.
   */
  async resumeTest(params) {
    this.validateParams(params, { testId: { required: true, type: 'string' } });
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info(`Resuming test ID: ${params.testId}`);
      await axios.put(`${this.baseUrl}/uptime/${params.testId}`, {
        paused: false
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return { success: true, data: `Test ID ${params.testId} resumed successfully` };
    } catch (error) {
      logger.error(`Error resuming test ID ${params.testId}:`, error.message);
      return { success: false, error: 'Failed to resume test' };
    }
  }

  /**
   * Schedule an uptime test at specific intervals using Agenda.
   * @param {Object} params - Parameters for the request.
   * @param {string} params.testId - The ID of the test to schedule.
   * @param {string} params.schedule - The cron expression or human-readable interval.
   */
  async scheduleTest(params) {
    this.validateParams(params, { testId: { required: true, type: 'string' }, schedule: { required: true, type: 'string' } });

    try {
      logger.info(`Scheduling test ID ${params.testId} with schedule: ${params.schedule}`);
      const { default: TaskScheduler } = await import('../../services/scheduler.js');
      const scheduler = TaskScheduler.getInstance ? TaskScheduler.getInstance() : new TaskScheduler();
      await scheduler.scheduleJob(params.schedule, async () => {
        logger.info(`Executing scheduled test ID: ${params.testId}`);
        await this.getTestDetails({ testId: params.testId });
      });
      return { success: true, data: `Test ID ${params.testId} scheduled successfully` };
    } catch (error) {
      logger.error(`Error scheduling test ID ${params.testId}:`, error.message);
      return { success: false, error: 'Failed to schedule test' };
    }
  }

  /**
   * Create multiple uptime tests in bulk.
   * @param {Array} tests - Array of test parameters.
   */
  async bulkCreateTests(tests) {
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info('Creating multiple uptime tests in bulk');
      const results = await Promise.all(tests.map(test => this.createTest(test)));
      return { success: true, data: results };
    } catch (error) {
      logger.error('Error creating tests in bulk:', error.message);
      return { success: false, error: 'Failed to create tests in bulk' };
    }
  }

  /**
   * Delete multiple tests in bulk.
   * @param {Array} tests - Array of test parameters.
   */
  async bulkDeleteTests(tests) {
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info('Deleting multiple tests in bulk');
      const results = await Promise.all(tests.map(test => this.deleteTest(test)));
      return { success: true, data: results };
    } catch (error) {
      logger.error('Error deleting tests in bulk:', error.message);
      return { success: false, error: 'Failed to delete tests in bulk' };
    }
  }

  /**
   * Update multiple tests in bulk.
   * @param {Array} tests - Array of test parameters.
   */
  async bulkUpdateTests(tests) {
    if (!this.apiKey) return { success: false, error: 'API key not configured' };

    try {
      logger.info('Updating multiple tests in bulk');
      const results = await Promise.all(tests.map(test => this.updateTest(test)));
      return { success: true, data: results };
    } catch (error) {
      logger.error('Error updating tests in bulk:', error.message);
      return { success: false, error: 'Failed to update tests in bulk' };
    }
  }
}
