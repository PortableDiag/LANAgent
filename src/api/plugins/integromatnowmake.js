import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import NodeCache from 'node-cache';

/**
 * Usage Examples:
 * - Natural language: "use integromatnowmake to [action]"
 * - Command format: api integromatnowmake <action> <params>
 * - Telegram: Just type naturally about integromatnowmake
 */

export default class IntegromatnowMakePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'integromatnowmake';
    this.version = '1.0.0';
    this.description = 'API for automating tasks and connecting apps with complex workflows';
    this.commands = [
      {
        command: 'listScenarios',
        description: 'List all scenarios in your Make account',
        usage: 'listScenarios'
      },
      {
        command: 'getScenario',
        description: 'Get details of a specific scenario',
        usage: 'getScenario [scenarioId]'
      },
      {
        command: 'runScenario',
        description: 'Run a specific scenario manually',
        usage: 'runScenario [scenarioId]'
      },
      {
        command: 'createScenario',
        description: 'Create a new scenario',
        usage: 'createScenario <scenarioDetails>'
      },
      {
        command: 'scheduleScenario',
        description: 'Schedule a scenario to run at specific times',
        usage: 'scheduleScenario [scenarioId] [cronExpression]'
      },
      {
        command: 'listScheduledScenarios',
        description: 'List all scheduled scenarios',
        usage: 'listScheduledScenarios'
      },
      {
        command: 'cancelSchedule',
        description: 'Cancel a scheduled scenario',
        usage: 'cancelSchedule [scenarioId]'
      },
      {
        command: 'listScenarioVersions',
        description: 'List all versions of a scenario',
        usage: 'listScenarioVersions [scenarioId]'
      },
      {
        command: 'rollbackScenario',
        description: 'Rollback to a previous version of a scenario',
        usage: 'rollbackScenario [scenarioId] [versionId]'
      },
      {
        command: 'cloneScenario',
        description: 'Clone an existing scenario with a new ID',
        usage: 'cloneScenario [scenarioId] <newScenarioDetails>'
      }
    ];

    this.apiKey = process.env.INTEGROMAT_NOW_MAKE_API_KEY;
    this.baseUrl = 'https://api.make.com/v2';
    this.scheduledJobs = new Map(); // Track job names for management
    this.versionCache = new NodeCache({ stdTTL: 3600 }); // Cache for scenario versions (1 hour)
  }
  
  async initialize() {
    // Get the scheduler from agent services
    this.scheduler = this.agent?.services?.get('taskScheduler');
    if (!this.scheduler) {
      logger.warn('TaskScheduler service not available, scheduling features disabled');
    } else {
      // Define the job handler
      this.scheduler.agenda.define('integromat-scenario', async (job) => {
        const { scenarioId } = job.attrs.data;
        logger.info(`Running scheduled Integromat scenario: ${scenarioId}`);
        try {
          await this.runScenario(scenarioId);
        } catch (error) {
          logger.error(`Failed to run scheduled scenario ${scenarioId}:`, error);
          throw error; // Let Agenda handle retry
        }
      });
    }
    return true;
  }

  async execute(params) {
    const { action, scenarioId, scenarioDetails, cronExpression, versionId, newScenarioDetails } = params;
    
    try {
      switch(action) {
        case 'listScenarios':
          return await this.listScenarios();
          
        case 'getScenario':
          this.validateParams(params, { scenarioId: { required: true, type: 'string' } });
          return await this.getScenario(scenarioId);
          
        case 'runScenario':
          this.validateParams(params, { scenarioId: { required: true, type: 'string' } });
          return await this.runScenario(scenarioId);

        case 'createScenario':
          this.validateParams(params, { scenarioDetails: { required: true, type: 'object' } });
          return await this.createScenario(scenarioDetails);
          
        case 'scheduleScenario':
          this.validateParams(params, { 
            scenarioId: { required: true, type: 'string' },
            cronExpression: { required: true, type: 'string' }
          });
          return await this.scheduleScenario(scenarioId, cronExpression);
          
        case 'listScheduledScenarios':
          return await this.listScheduledScenarios();
          
        case 'cancelSchedule':
          this.validateParams(params, { scenarioId: { required: true, type: 'string' } });
          return await this.cancelSchedule(scenarioId);

        case 'listScenarioVersions':
          this.validateParams(params, { scenarioId: { required: true, type: 'string' } });
          return await this.listScenarioVersions(scenarioId);

        case 'rollbackScenario':
          this.validateParams(params, {
            scenarioId: { required: true, type: 'string' },
            versionId: { required: true, type: 'string' }
          });
          return await this.rollbackScenario(scenarioId, versionId);

        case 'cloneScenario':
          this.validateParams(params, { 
            scenarioId: { required: true, type: 'string' },
            newScenarioDetails: { required: false, type: 'object' }
          });
          return await this.cloneScenario(scenarioId, newScenarioDetails);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Integromat now Make plugin error:', error);
      return { success: false, error: error.message };
    }
  }
  
  async listScenarios() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Fetching list of scenarios');
      const response = await axios.get(`${this.baseUrl}/scenarios`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching scenarios:', error.message);
      return { success: false, error: 'Failed to fetch scenarios: ' + error.message };
    }
  }

  async getScenario(scenarioId) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching details for scenario ID: ${scenarioId}`);
      const response = await axios.get(`${this.baseUrl}/scenarios/${scenarioId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching scenario details:', error.message);
      return { success: false, error: 'Failed to fetch scenario details: ' + error.message };
    }
  }

  async runScenario(scenarioId) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Running scenario ID: ${scenarioId}`);
      const response = await axios.post(`${this.baseUrl}/scenarios/${scenarioId}/run`, {}, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error running scenario:', error.message);
      return { success: false, error: 'Failed to run scenario: ' + error.message };
    }
  }

  /**
   * Create a new scenario
   * @param {Object} scenarioDetails - The details of the scenario to create
   * @returns {Object} - Result of the scenario creation
   */
  async createScenario(scenarioDetails) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Creating a new scenario');
      const response = await axios.post(`${this.baseUrl}/scenarios`, scenarioDetails, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating scenario:', error.message);
      return { success: false, error: 'Failed to create scenario: ' + error.message };
    }
  }

  /**
   * Schedule a scenario to run at specific times using cron expression
   * @param {string} scenarioId - The ID of the scenario to schedule
   * @param {string} cronExpression - The cron expression (e.g., '0 9 * * *' for daily at 9 AM)
   * @returns {Object} - Result of the scheduling operation
   */
  async scheduleScenario(scenarioId, cronExpression) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    if (!this.scheduler) {
      return { success: false, error: 'Scheduling service not available' };
    }

    try {
      const jobName = `integromat-scenario-${scenarioId}`;
      
      // Cancel existing job if any
      if (this.scheduledJobs.has(scenarioId)) {
        await this.scheduler.agenda.cancel({ name: 'integromat-scenario', 'data.scenarioId': scenarioId });
        logger.info(`Cancelled existing schedule for scenario ${scenarioId}`);
      }

      // Create new scheduled job with Agenda
      const job = await this.scheduler.agenda.every(cronExpression, 'integromat-scenario', 
        { scenarioId },
        { timezone: process.env.TZ || 'America/Los_Angeles' }
      );

      // Track the job
      this.scheduledJobs.set(scenarioId, {
        jobName,
        cronExpression,
        createdAt: new Date()
      });
      
      logger.info(`Scheduled scenario ${scenarioId} with cron: ${cronExpression}`);
      
      // Get next run time
      const nextRun = job.attrs.nextRunAt;
      
      return { 
        success: true, 
        message: `Scenario scheduled successfully`,
        nextRun,
        jobId: job.attrs._id
      };
    } catch (error) {
      logger.error('Error scheduling scenario:', error.message);
      return { success: false, error: 'Failed to schedule scenario: ' + error.message };
    }
  }

  /**
   * List all scheduled scenarios
   * @returns {Object} - List of scheduled scenarios with their details
   */
  async listScheduledScenarios() {
    if (!this.scheduler) {
      return { success: false, error: 'Scheduling service not available' };
    }

    try {
      // Get jobs from Agenda
      const jobs = await this.scheduler.agenda.jobs({ name: 'integromat-scenario' });
      
      const scheduled = jobs.map(job => ({
        scenarioId: job.attrs.data.scenarioId,
        cronExpression: job.attrs.repeatInterval,
        createdAt: job.attrs.lockedAt || job.attrs.lastModifiedBy,
        nextRun: job.attrs.nextRunAt,
        lastRun: job.attrs.lastRunAt,
        isActive: !job.attrs.disabled
      }));
      
      return { 
        success: true, 
        count: scheduled.length,
        scenarios: scheduled 
      };
    } catch (error) {
      logger.error('Error listing scheduled scenarios:', error.message);
      return { success: false, error: 'Failed to list scheduled scenarios: ' + error.message };
    }
  }

  /**
   * Cancel a scheduled scenario
   * @param {string} scenarioId - The ID of the scenario to cancel
   * @returns {Object} - Result of the cancellation
   */
  async cancelSchedule(scenarioId) {
    if (!this.scheduler) {
      return { success: false, error: 'Scheduling service not available' };
    }

    try {
      // Cancel job in Agenda
      const result = await this.scheduler.agenda.cancel({ 
        name: 'integromat-scenario', 
        'data.scenarioId': scenarioId 
      });
      
      if (result > 0) {
        this.scheduledJobs.delete(scenarioId);
        logger.info(`Cancelled schedule for scenario ${scenarioId}`);
        return { 
          success: true, 
          message: `Schedule cancelled for scenario ${scenarioId}`,
          jobsCancelled: result
        };
      } else {
        return { 
          success: false, 
          error: `No schedule found for scenario ${scenarioId}` 
        };
      }
    } catch (error) {
      logger.error('Error cancelling schedule:', error.message);
      return { success: false, error: 'Failed to cancel schedule: ' + error.message };
    }
  }

  /**
   * List all versions of a scenario
   * @param {string} scenarioId - The ID of the scenario
   * @returns {Object} - List of scenario versions
   */
  async listScenarioVersions(scenarioId) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      // Check cache first
      const cached = this.versionCache.get(`versions_${scenarioId}`);
      if (cached) {
        logger.debug(`Cache hit for scenario ${scenarioId} versions`);
        return { success: true, data: cached, fromCache: true };
      }

      logger.info(`Fetching versions for scenario ID: ${scenarioId}`);
      const response = await axios.get(`${this.baseUrl}/scenarios/${scenarioId}/versions`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      // Cache the result
      this.versionCache.set(`versions_${scenarioId}`, response.data);

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching scenario versions:', error.message);
      return { success: false, error: 'Failed to fetch scenario versions: ' + error.message };
    }
  }

  /**
   * Rollback to a previous version of a scenario
   * @param {string} scenarioId - The ID of the scenario
   * @param {string} versionId - The ID of the version to rollback to
   * @returns {Object} - Result of the rollback operation
   */
  async rollbackScenario(scenarioId, versionId) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Rolling back scenario ID: ${scenarioId} to version ID: ${versionId}`);
      const response = await axios.post(`${this.baseUrl}/scenarios/${scenarioId}/versions/${versionId}/rollback`, {}, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      // Invalidate the versions cache for this scenario
      this.versionCache.del(`versions_${scenarioId}`);

      return { success: true, data: response.data, message: `Scenario ${scenarioId} rolled back to version ${versionId}` };
    } catch (error) {
      logger.error('Error rolling back scenario:', error.message);
      return { success: false, error: 'Failed to rollback scenario: ' + error.message };
    }
  }

  /**
   * Clone an existing scenario with a new ID
   * @param {string} scenarioId - The ID of the scenario to clone
   * @param {Object} [newScenarioDetails] - Optional modifications for the new scenario
   * @returns {Object} - Result of the cloning operation
   */
  async cloneScenario(scenarioId, newScenarioDetails = {}) {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Cloning scenario ID: ${scenarioId}`);
      const originalScenario = await this.getScenario(scenarioId);
      if (!originalScenario.success) {
        return { success: false, error: 'Failed to fetch original scenario details' };
      }

      const clonedScenarioDetails = {
        ...originalScenario.data,
        ...newScenarioDetails
      };

      // Remove any properties that should not be copied
      delete clonedScenarioDetails.id;
      delete clonedScenarioDetails.createdAt;
      delete clonedScenarioDetails.updatedAt;

      const response = await this.createScenario(clonedScenarioDetails);
      return { success: true, data: response.data, message: 'Scenario cloned successfully' };
    } catch (error) {
      logger.error('Error cloning scenario:', error.message);
      return { success: false, error: 'Failed to clone scenario: ' + error.message };
    }
  }
}