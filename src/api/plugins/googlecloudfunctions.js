import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class GoogleCloudFunctionsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'googlecloudfunctions';
    this.version = '1.0.0';
    this.description = 'Event-driven serverless compute service for cloud automation';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'GOOGLE_CLOUD_FUNCTIONS_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'listFunctions',
        description: 'List all Google Cloud Functions in a given project',
        usage: 'listFunctions({ projectId: "your-project-id" })',
        examples: [
          'list all functions in my project',
          'show Google Cloud functions for my app',
          'get functions in the project'
        ]
      },
      {
        command: 'getFunction',
        description: 'Get details of a specific Google Cloud Function',
        usage: 'getFunction({ projectId: "your-project-id", functionName: "myFunction" })',
        examples: [
          'get details of myFunction',
          'show info for myFunction',
          'retrieve function metadata'
        ]
      },
      {
        command: 'deployFunction',
        description: 'Deploy a new Google Cloud Function',
        usage: 'deployFunction({ projectId: "your-project-id", functionName: "newFunction", sourceCode: {...} })',
        examples: [
          'deploy a new function',
          'create and upload newFunction',
          'upload function code to cloud'
        ]
      },
      {
        command: 'updateFunction',
        description: 'Update an existing Google Cloud Function',
        usage: 'updateFunction({ projectId: "your-project-id", functionName: "existingFunction", updates: {...} })',
        examples: [
          'update the code of existingFunction',
          'change configuration of existingFunction',
          'modify existing function settings'
        ]
      },
      {
        command: 'listTriggers',
        description: 'List all triggers for a specific Google Cloud Function',
        usage: 'listTriggers({ projectId: "your-project-id", functionName: "myFunction" })',
        examples: [
          'list triggers for myFunction',
          'show all triggers associated with myFunction'
        ]
      },
      {
        command: 'addTrigger',
        description: 'Add a new trigger to a Google Cloud Function',
        usage: 'addTrigger({ projectId: "your-project-id", functionName: "myFunction", triggerConfig: {...} })',
        examples: [
          'add a new trigger to myFunction',
          'create a trigger for myFunction'
        ]
      },
      {
        command: 'removeTrigger',
        description: 'Remove a trigger from a Google Cloud Function',
        usage: 'removeTrigger({ projectId: "your-project-id", functionName: "myFunction", triggerId: "trigger-id" })',
        examples: [
          'remove a trigger from myFunction',
          'delete trigger from myFunction'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'https://cloudfunctions.googleapis.com/v1/projects',
    };

    this.initialized = false;
    this.cache = new Map();
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

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      if (error && error.message && (error.message.includes('Missing required credentials') || /API[_-]?KEY.*(required|missing|not configured)/i.test(error.message) || /environment variable .* (required|not set)/i.test(error.message) || /credentials? (not configured|missing|required)/i.test(error.message))) {
        this.logger.warn(`Failed to initialize ${this.name} plugin: ${error.message}`);
      } else {
        this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      }
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
        case 'listFunctions':
          return await this.listFunctions(data);
        case 'getFunction':
          return await this.getFunction(data);
        case 'deployFunction':
          return await this.deployFunction(data);
        case 'updateFunction':
          return await this.updateFunction(data);
        case 'listTriggers':
          return await this.listTriggers(data);
        case 'addTrigger':
          return await this.addTrigger(data);
        case 'removeTrigger':
          return await this.removeTrigger(data);
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

  async listFunctions({ projectId }) {
    this.validateParams({ projectId }, {
      projectId: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}/${projectId}/locations/-/functions`;
    try {
      const response = await retryOperation(() => axios.get(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'listFunctions' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error listing functions:', error);
      return { success: false, error: error.message };
    }
  }

  async getFunction({ projectId, functionName }) {
    this.validateParams({ projectId, functionName }, {
      projectId: { required: true, type: 'string' },
      functionName: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}/${projectId}/locations/-/functions/${functionName}`;
    try {
      const response = await retryOperation(() => axios.get(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'getFunction' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error getting function:', error);
      return { success: false, error: error.message };
    }
  }

  async deployFunction({ projectId, functionName, sourceCode }) {
    this.validateParams({ projectId, functionName, sourceCode }, {
      projectId: { required: true, type: 'string' },
      functionName: { required: true, type: 'string' },
      sourceCode: { required: true, type: 'object' }
    });

    const url = `${this.config.baseUrl}/${projectId}/locations/-/functions`;
    try {
      const response = await retryOperation(() => axios.post(url, {
        name: functionName,
        entryPoint: functionName,
        runtime: 'nodejs16',
        sourceCode,
      }, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'deployFunction' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error deploying function:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update an existing Google Cloud Function
   * @param {Object} params - Parameters for updating the function
   * @param {string} params.projectId - The project ID
   * @param {string} params.functionName - The name of the function to update
   * @param {Object} params.updates - The updates to apply to the function
   * @returns {Promise<Object>} - The result of the update operation
   */
  async updateFunction({ projectId, functionName, updates }) {
    this.validateParams({ projectId, functionName, updates }, {
      projectId: { required: true, type: 'string' },
      functionName: { required: true, type: 'string' },
      updates: { required: true, type: 'object' }
    });

    const url = `${this.config.baseUrl}/${projectId}/locations/-/functions/${functionName}`;
    try {
      const response = await retryOperation(() => axios.patch(url, updates, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'updateFunction' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error updating function:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * List all triggers for a specific Google Cloud Function
   * @param {Object} params - Parameters for listing triggers
   * @param {string} params.projectId - The project ID
   * @param {string} params.functionName - The name of the function
   * @returns {Promise<Object>} - The result of the list operation
   */
  async listTriggers({ projectId, functionName }) {
    this.validateParams({ projectId, functionName }, {
      projectId: { required: true, type: 'string' },
      functionName: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}/${projectId}/locations/-/functions/${functionName}/triggers`;
    try {
      const response = await retryOperation(() => axios.get(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'listTriggers' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error listing triggers:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Add a new trigger to a Google Cloud Function
   * @param {Object} params - Parameters for adding a trigger
   * @param {string} params.projectId - The project ID
   * @param {string} params.functionName - The name of the function
   * @param {Object} params.triggerConfig - The configuration for the new trigger
   * @returns {Promise<Object>} - The result of the add operation
   */
  async addTrigger({ projectId, functionName, triggerConfig }) {
    this.validateParams({ projectId, functionName, triggerConfig }, {
      projectId: { required: true, type: 'string' },
      functionName: { required: true, type: 'string' },
      triggerConfig: { required: true, type: 'object' }
    });

    const url = `${this.config.baseUrl}/${projectId}/locations/-/functions/${functionName}/triggers`;
    try {
      const response = await retryOperation(() => axios.post(url, triggerConfig, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        }
      }), { retries: 3, context: 'addTrigger' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error adding trigger:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove a trigger from a Google Cloud Function
   * @param {Object} params - Parameters for removing a trigger
   * @param {string} params.projectId - The project ID
   * @param {string} params.functionName - The name of the function
   * @param {string} params.triggerId - The ID of the trigger to remove
   * @returns {Promise<Object>} - The result of the remove operation
   */
  async removeTrigger({ projectId, functionName, triggerId }) {
    this.validateParams({ projectId, functionName, triggerId }, {
      projectId: { required: true, type: 'string' },
      functionName: { required: true, type: 'string' },
      triggerId: { required: true, type: 'string' }
    });

    const url = `${this.config.baseUrl}/${projectId}/locations/-/functions/${functionName}/triggers/${triggerId}`;
    try {
      const response = await retryOperation(() => axios.delete(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      }), { retries: 3, context: 'removeTrigger' });

      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error removing trigger:', error);
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
