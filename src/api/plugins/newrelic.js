import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

/**
 * Usage Examples:
 * - Natural language: "use newrelic to check my applications"
 * - Command format: api newrelic <action> <params>
 * - Telegram: Just type naturally about new relic monitoring
 */

export default class NewRelicPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'newrelic';
    this.version = '1.0.0';
    this.description = 'Monitoring service with a free tier for application performance insights';
    this.commands = [
      {
        command: 'getApplications',
        description: 'Fetch a list of applications from New Relic',
        usage: 'getApplications()'
      },
      {
        command: 'getApplicationDetails',
        description: 'Fetch details of a specific application by ID',
        usage: 'getApplicationDetails({ applicationId: "12345" })'
      },
      {
        command: 'getAlerts',
        description: 'Fetch alert policies',
        usage: 'getAlerts()'
      },
      {
        command: 'getMetrics',
        description: 'Get application metrics',
        usage: 'getMetrics({ applicationId: "12345", metric: "apdex" })'
      },
      {
        command: 'getTransactions',
        description: 'Get application transactions',
        usage: 'getTransactions({ applicationId: "12345" })'
      },
      {
        command: 'getDeploymentHistory',
        description: 'Fetch deployment history for a specific application',
        usage: 'getDeploymentHistory({ applicationId: "12345" })'
      },
      {
        command: 'getErrorLogs',
        description: 'Fetch error logs for a specific application',
        usage: 'getErrorLogs({ applicationId: "12345" })'
      },
      {
        command: 'getDashboards',
        description: 'Fetch a list of dashboards from New Relic',
        usage: 'getDashboards()'
      },
      {
        command: 'createDashboard',
        description: 'Create a new dashboard in New Relic',
        usage: 'createDashboard({ dashboardData: {...} })'
      },
      {
        command: 'getSyntheticsMonitors',
        description: 'Fetch a list of Synthetics monitors from New Relic',
        usage: 'getSyntheticsMonitors()'
      },
      {
        command: 'createSyntheticsMonitor',
        description: 'Create a new Synthetics monitor in New Relic',
        usage: 'createSyntheticsMonitor({ monitorData: {...} })'
      },
      {
        command: 'executeNRQL',
        description: 'Execute a NRQL query via NerdGraph',
        usage: 'executeNRQL({ query: "SELECT count(*) FROM Transaction", accountId: "1234567" })'
      }
    ];
    
    this.apiKey = process.env.NEW_RELIC_API_KEY;
    this.accountId = process.env.NEW_RELIC_ACCOUNT_ID;
    this.baseUrl = 'https://api.newrelic.com/v2/';
    // NRQL is not part of the REST v2 API — it is only reachable through NerdGraph.
    this.nerdGraphUrl = process.env.NEW_RELIC_NERDGRAPH_URL || 'https://api.newrelic.com/graphql';
    this.syntheticsBaseUrl = 'https://synthetics.newrelic.com/synthetics/api/v3/';
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'getApplications':
          return await this.getApplications();
          
        case 'getApplicationDetails':
          return await this.getApplicationDetails(params);
        
        case 'getAlerts':
          return await this.getAlerts();
          
        case 'getMetrics':
          return await this.getMetrics(params);
          
        case 'getTransactions':
          return await this.getTransactions(params);

        case 'getDeploymentHistory':
          return await this.getDeploymentHistory(params);

        case 'getErrorLogs':
          return await this.getErrorLogs(params);

        case 'getDashboards':
          return await this.getDashboards();

        case 'createDashboard':
          return await this.createDashboard(params);

        case 'getSyntheticsMonitors':
          return await this.getSyntheticsMonitors();

        case 'createSyntheticsMonitor':
          return await this.createSyntheticsMonitor(params);

        case 'executeNRQL':
          return await this.executeNRQL(params);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('New Relic plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fetch a list of applications from New Relic.
   * @returns {Object} Result object with applications data or error message.
   */
  async getApplications() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Fetching applications list from New Relic');
      
      const response = await axios.get(`${this.baseUrl}applications.json`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error fetching applications:', error.message);
      return { success: false, error: 'Failed to fetch applications: ' + error.message };
    }
  }

  /**
   * Fetch details of a specific application by ID.
   * @param {Object} params - Parameters containing applicationId.
   * @returns {Object} Result object with application details or error message.
   */
  async getApplicationDetails(params) {
    const { applicationId } = params;
    
    this.validateParams(params, { 
      applicationId: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching details for application ID: ${applicationId}`);
      
      const response = await axios.get(`${this.baseUrl}applications/${applicationId}.json`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error(`Error fetching application ${applicationId} details:`, error.message);
      return { success: false, error: `Failed to fetch details for application ID ${applicationId}: ${error.message}` };
    }
  }

  /**
   * Fetch alert policies from New Relic.
   * @returns {Object} Result object with alerts data or error message.
   */
  async getAlerts() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Fetching alerts from New Relic');
      
      const response = await axios.get(`${this.baseUrl}alerts_policies.json`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error fetching alerts:', error.message);
      return { success: false, error: 'Failed to fetch alerts: ' + error.message };
    }
  }
  
  /**
   * Get application metrics
   * @param {Object} params - Parameters containing applicationId and metric name
   * @returns {Object} Result object with metrics data
   */
  async getMetrics(params) {
    const { applicationId, metric = 'apdex' } = params;
    
    this.validateParams(params, {
      applicationId: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching ${metric} metrics for application ${applicationId}`);
      
      const response = await axios.get(`${this.baseUrl}applications/${applicationId}/metrics/data.json`, {
        headers: { 'Api-Key': this.apiKey },
        params: {
          'names[]': metric,
          from: new Date(Date.now() - 3600000).toISOString(), // Last hour
          to: new Date().toISOString()
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching metrics:', error.message);
      return { success: false, error: 'Failed to fetch metrics: ' + error.message };
    }
  }
  
  /**
   * Get application transactions
   * @param {Object} params - Parameters containing applicationId
   * @returns {Object} Result object with transactions data
   */
  async getTransactions(params) {
    const { applicationId } = params;
    
    this.validateParams(params, {
      applicationId: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching transactions for application ${applicationId}`);
      
      const response = await axios.get(`${this.baseUrl}applications/${applicationId}/transactions.json`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching transactions:', error.message);
      return { success: false, error: 'Failed to fetch transactions: ' + error.message };
    }
  }

  /**
   * Fetch deployment history for a specific application by ID.
   * @param {Object} params - Parameters containing applicationId.
   * @returns {Object} Result object with deployment history data or error message.
   */
  async getDeploymentHistory(params) {
    const { applicationId } = params;

    this.validateParams(params, {
      applicationId: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching deployment history for application ${applicationId}`);

      const response = await axios.get(`${this.baseUrl}applications/${applicationId}/deployments.json`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error(`Error fetching deployment history for application ${applicationId}:`, error.message);
      return { success: false, error: `Failed to fetch deployment history: ${error.message}` };
    }
  }

  /**
   * Fetch error logs for a specific application by ID.
   * @param {Object} params - Parameters containing applicationId.
   * @returns {Object} Result object with error logs data or error message.
   */
  async getErrorLogs(params) {
    const { applicationId } = params;

    this.validateParams(params, {
      applicationId: { required: true, type: 'string' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching error logs for application ${applicationId}`);

      const response = await axios.get(`${this.baseUrl}applications/${applicationId}/errors.json`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error(`Error fetching error logs for application ${applicationId}:`, error.message);
      return { success: false, error: `Failed to fetch error logs: ${error.message}` };
    }
  }

  /**
   * Fetch a list of dashboards from New Relic.
   * @returns {Object} Result object with dashboards data or error message.
   */
  async getDashboards() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Fetching dashboards list from New Relic');
      
      const response = await axios.get(`${this.baseUrl}dashboards.json`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error fetching dashboards:', error.message);
      return { success: false, error: 'Failed to fetch dashboards: ' + error.message };
    }
  }

  /**
   * Create a new dashboard in New Relic.
   * @param {Object} params - Parameters containing dashboardData.
   * @returns {Object} Result object with creation status or error message.
   */
  async createDashboard(params) {
    const { dashboardData } = params;

    this.validateParams(params, {
      dashboardData: { required: true, type: 'object' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Creating a new dashboard in New Relic');
      
      const response = await axios.post(`${this.baseUrl}dashboards.json`, dashboardData, {
        headers: { 'Api-Key': this.apiKey, 'Content-Type': 'application/json' }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error creating dashboard:', error.message);
      return { success: false, error: 'Failed to create dashboard: ' + error.message };
    }
  }

  /**
   * Fetch a list of Synthetics monitors from New Relic.
   * @returns {Object} Result object with Synthetics monitors data or error message.
   */
  async getSyntheticsMonitors() {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Fetching Synthetics monitors list from New Relic');
      
      const response = await axios.get(`${this.syntheticsBaseUrl}monitors`, {
        headers: { 'Api-Key': this.apiKey }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error fetching Synthetics monitors:', error.message);
      return { success: false, error: 'Failed to fetch Synthetics monitors: ' + error.message };
    }
  }

  /**
   * Create a new Synthetics monitor in New Relic.
   * @param {Object} params - Parameters containing monitorData.
   * @returns {Object} Result object with creation status or error message.
   */
  async createSyntheticsMonitor(params) {
    const { monitorData } = params;

    this.validateParams(params, {
      monitorData: { required: true, type: 'object' }
    });

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info('Creating a new Synthetics monitor in New Relic');
      
      const response = await axios.post(`${this.syntheticsBaseUrl}monitors`, monitorData, {
        headers: { 'Api-Key': this.apiKey, 'Content-Type': 'application/json' }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error creating Synthetics monitor:', error.message);
      return { success: false, error: 'Failed to create Synthetics monitor: ' + error.message };
    }
  }

  /**
   * Execute a NRQL query through NerdGraph.
   *
   * NRQL has no REST v2 endpoint; the only supported transport is the
   * NerdGraph GraphQL API, which needs a numeric account id in addition to
   * the API key. NerdGraph answers 200 with an `errors` array on a bad
   * query, so a 2xx alone does not mean the query ran.
   *
   * @param {Object} params - { query, accountId? }
   * @returns {Object} { success, data: { results, metadata }, ... } or an error
   */
  async executeNRQL(params) {
    this.validateParams(params, {
      query: { required: true, type: 'string' }
    });

    const { query } = params;
    const accountId = params.accountId ?? this.accountId;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    if (!accountId) {
      return {
        success: false,
        error: 'Account ID not configured. Set NEW_RELIC_ACCOUNT_ID or pass accountId.'
      };
    }

    const numericAccountId = Number(accountId);
    if (!Number.isInteger(numericAccountId) || numericAccountId <= 0) {
      return { success: false, error: `Invalid account ID: ${accountId}` };
    }

    const graphqlQuery = `
      query($accountId: Int!, $nrql: Nrql!) {
        actor {
          account(id: $accountId) {
            nrql(query: $nrql) {
              results
              totalResult
            }
          }
        }
      }
    `;

    try {
      logger.info(`Executing NRQL query on account ${numericAccountId}`);

      const response = await axios.post(
        this.nerdGraphUrl,
        { query: graphqlQuery, variables: { accountId: numericAccountId, nrql: query } },
        {
          headers: {
            'Api-Key': this.apiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      const body = response.data;

      // GraphQL reports failures in-band with HTTP 200 — do not report success.
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const message = body.errors.map(e => e?.message || String(e)).join('; ');
        logger.error('NRQL query rejected by NerdGraph:', message);
        return { success: false, error: 'NRQL query failed: ' + message };
      }

      const nrql = body?.data?.actor?.account?.nrql;
      if (!nrql) {
        return { success: false, error: 'NerdGraph returned no NRQL payload (check the account ID and key permissions)' };
      }

      return {
        success: true,
        data: {
          results: nrql.results ?? [],
          totalResult: nrql.totalResult ?? null
        }
      };
    } catch (error) {
      logger.error('Error executing NRQL query:', error.message);
      return { success: false, error: 'Failed to execute NRQL query: ' + error.message };
    }
  }
}
